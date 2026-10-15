import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import './style.css';
import { Settings } from './core/settings.js';
import { TrackPath } from './track/TrackPath.js';
import { TrackMesh } from './track/TrackMesh.js';
import { createSharedUniforms } from './track/slatShader.js';
import { Space } from './world/Space.js';
import { Kart } from './kart/Kart.js';
import { Input } from './kart/Input.js';
import { ChaseCamera } from './camera/ChaseCamera.js';
import { VideoPool } from './video/VideoPool.js';
import { pickVideoFolder, filesFromDrop, prepareVideoFiles, supportsDirectoryPicker } from './video/folderPicker.js';
import { Hud, formatTime } from './ui/Hud.js';
import { SettingsPanel } from './ui/SettingsPanel.js';

const $ = (sel) => document.querySelector(sel);

class Game {
  constructor() {
    this.settings = new Settings();
    this.state = 'menu'; // 'menu' | 'countdown' | 'racing' | 'paused'
    this.clock = new THREE.Clock();
    this.time = 0;

    this.#setupRenderer();
    this.#setupScene();
    this.#setupUI();
    this.#bindSettings();
    this.#onResize();
    window.addEventListener('resize', () => this.#onResize());

    this.renderer.setAnimationLoop(() => this.#frame());
  }

  /* ------------------------------------------------------------------ */
  /* setup                                                               */
  /* ------------------------------------------------------------------ */

  #setupRenderer() {
    this.canvas = $('#game');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07050f);
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.1, 5000);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.38, 0.35, 0.82);
    this.bloomPass.enabled = this.settings.get('bloom');
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  #setupScene() {
    const s = this.settings;
    this.shared = createSharedUniforms(s);

    this.videoPool = new VideoPool({
      size: s.get('poolSize'),
      clipSeconds: s.get('clipSeconds'),
      randomStart: s.get('randomStart'),
    });
    this.videoPool.addEventListener('textures', () => this.track?.setTextures(this.videoPool.textures()));
    this.videoPool.addEventListener('status', () => this.hud?.setVideoStatus(this.videoPool.statusText()));

    this.space = new Space(s.get('seed'));
    this.scene.add(this.space);

    this.input = new Input(window);
    this.chase = new ChaseCamera(this.camera, null);

    this.#buildTrack();
    this.kart.model.visible = false;
  }

  /** (Re)build the path, the road mesh, and reposition the kart. */
  #buildTrack() {
    const s = this.settings;
    if (this.track) {
      this.scene.remove(this.track);
      this.track.dispose();
    }
    if (this.kart) this.scene.remove(this.kart.model);

    this.path = new TrackPath(s.get('seed'));
    this.track = new TrackMesh(this.path, {
      textures: this.videoPool.textures(),
      tilesAcross: s.get('tilesAcross'),
      slatsPerRainbow: s.get('slatsPerRainbow'),
      shared: this.shared,
      rails: s.get('rails'),
    });
    this.scene.add(this.track);

    if (!this.kart) this.kart = new Kart(this.path);
    else this.kart.path = this.path;
    this.kart.rails = s.get('rails');
    this.kart.reset(0);
    this.scene.add(this.kart.model);

    this.chase.setPath(this.path);
    this.chase.flyS = 0;
  }

  #setupUI() {
    this.hud = new Hud($('#hud'));
    this.hud.setVideoStatus(this.videoPool.statusText());
    this.menu = $('#menu');
    this.pauseMenu = $('#pause');
    this.folderStatus = $('#folder-status');
    this.folderInput = $('#folder-input');
    this.dropOverlay = $('#drop-overlay');

    this.settingsPanel = new SettingsPanel(this.settings, {
      root: $('#settings'),
      toggle: $('#settings-toggle'),
      close: $('#settings-close'),
      randomizeSeed: $('#randomize-seed'),
      reset: $('#reset-settings'),
    });

    const pick = () => this.chooseFolder();
    $('#pick-folder').addEventListener('click', pick);
    $('#pick-folder-2').addEventListener('click', pick);
    $('#start-demo').addEventListener('click', () => this.startRace());
    $('#resume').addEventListener('click', () => this.resume());
    $('#regen-track').addEventListener('click', () => {
      this.settings.set('seed', Math.floor(Math.random() * 1_000_000));
      this.startRace();
    });
    $('#back-to-menu').addEventListener('click', () => this.toMenu());

    if (!supportsDirectoryPicker) {
      $('.fineprint').textContent =
        'Clips never leave your machine — they are read straight from the folder by your browser. ' +
        'This browser will show a standard file dialog; pick the folder (or select all the clips in it).';
    }

    // Autoplay policies: any gesture on the page is a good moment to (re)start videos.
    const unlock = () => this.videoPool.resumeAll();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    // Drag & drop a folder anywhere.
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragDepth++;
      this.dropOverlay.classList.remove('hidden');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) this.dropOverlay.classList.add('hidden');
    });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      this.dropOverlay.classList.add('hidden');
      const result = await filesFromDrop(e.dataTransfer);
      this.#useFolder(result);
    });

    // Debug/automation hook (used by the smoke test): load files programmatically.
    window.__rainbowRoad = {
      loadFiles: (files, name = 'test') => this.#useFolder({ files: prepareVideoFiles(Array.from(files)), name, method: 'api' }),
      game: this,
    };
    this.folderInput.addEventListener('change', () => {
      // Only used when the picker promise isn't listening (e.g. automation); harmless otherwise.
      if (this._pickingWithInput) return;
      const all = Array.from(this.folderInput.files || []);
      if (!all.length) return;
      const name = all[0].webkitRelativePath?.split('/')[0] || 'files';
      this.folderInput.value = '';
      this.#useFolder({ files: prepareVideoFiles(all), name, method: 'input' });
    });
  }

  #bindSettings() {
    let rebuildTimer = 0;
    const rebuild = () => {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => {
        const racing = this.state === 'racing' || this.state === 'countdown';
        this.#buildTrack();
        if (racing) this.startRace();
        else this.kart.model.visible = this.state !== 'menu';
      }, 150);
    };

    this.settings.onChange((key, value) => {
      const u = this.shared;
      switch (key) {
        case 'pixelCells':
          u.uPixelCells.value = value;
          break;
        case 'hueSpeed':
          u.uHueSpeed.value = value;
          break;
        case 'saturation':
          u.uSaturation.value = value;
          break;
        case 'videoMix':
          u.uVideoMix.value = value;
          break;
        case 'fit':
          u.uFit.value = value === 'cover' ? 1 : 0;
          break;
        case 'tilesAcross':
        case 'slatsPerRainbow':
        case 'seed':
          rebuild();
          break;
        case 'poolSize':
          this.videoPool.setSize(value);
          rebuild(); // tile → stream assignment depends on the stream count
          this.hud.setVideoStatus(this.videoPool.statusText());
          break;
        case 'clipSeconds':
          this.videoPool.clipSeconds = value;
          break;
        case 'randomStart':
          this.videoPool.randomStart = value;
          break;
        case 'rails':
          this.track.setRails(value);
          this.kart.rails = value;
          break;
        case 'laps':
          if (this.race) this.race.lapsTotal = value;
          break;
        case 'bloom':
          this.bloomPass.enabled = value;
          break;
        case 'renderScale':
          this.#onResize();
          break;
        default:
          break;
      }
    });
  }

  #onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2) * this.settings.get('renderScale');
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const stars = this.space.getObjectByName('stars');
    if (stars) stars.material.uniforms.uPixelRatio.value = ratio;
  }

  /* ------------------------------------------------------------------ */
  /* folder → videos                                                     */
  /* ------------------------------------------------------------------ */

  async chooseFolder() {
    this.folderStatus.textContent = 'Opening folder picker…';
    this.folderStatus.classList.remove('error');
    this._pickingWithInput = !supportsDirectoryPicker;
    let result = null;
    try {
      result = await pickVideoFolder(this.folderInput);
    } catch (err) {
      console.error(err);
      this.folderStatus.textContent = `Couldn't read that folder: ${err.message || err}`;
      this.folderStatus.classList.add('error');
    } finally {
      this._pickingWithInput = false;
    }
    if (!result) {
      this.folderStatus.textContent = '';
      return;
    }
    this.#useFolder(result);
  }

  #useFolder({ files, name }) {
    if (!files.length) {
      this.folderStatus.textContent = `No video clips found in “${name}”. Try a folder with .mp4, .webm or .mov files.`;
      this.folderStatus.classList.add('error');
      return;
    }
    this.videoPool.setFiles(files, name);
    this.folderStatus.classList.remove('error');
    this.folderStatus.textContent = `${files.length} clip${files.length === 1 ? '' : 's'} from “${name}”`;
    this.hud.setVideoStatus(this.videoPool.statusText());
    if (this.state === 'menu') this.startRace();
    else if (this.state === 'paused') this.resume();
    else this.hud.toast(`${files.length} clips loaded`);
  }

  /* ------------------------------------------------------------------ */
  /* state                                                               */
  /* ------------------------------------------------------------------ */

  startRace() {
    this.hud.cancelCountdown();
    this.menu.classList.add('hidden');
    this.pauseMenu.classList.add('hidden');
    this.hud.show();
    this.settingsPanel.hide();

    this.kart.reset(0);
    this.kart.model.visible = true;
    this.chase.snap = true;
    this.race = {
      lap: 1,
      lapsTotal: this.settings.get('laps'),
      time: 0,
      lapTime: 0,
      best: null,
      finished: false,
      prevS: 0,
      lapDistance: 0,
    };
    this.state = 'countdown';
    this.hud.countdown().then(() => {
      if (this.state === 'countdown') this.state = 'racing';
    });
  }

  pause() {
    if (this.state !== 'racing' && this.state !== 'countdown') return;
    this.hud.cancelCountdown();
    this.state = 'paused';
    this.pauseMenu.classList.remove('hidden');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.pauseMenu.classList.add('hidden');
    this.state = 'racing';
    this.clock.getDelta(); // drop the time spent paused
  }

  toMenu() {
    this.hud.cancelCountdown();
    this.state = 'menu';
    this.pauseMenu.classList.add('hidden');
    this.hud.hide();
    this.menu.classList.remove('hidden');
    this.kart.model.visible = false;
    this.chase.snap = true;
  }

  /* ------------------------------------------------------------------ */
  /* frame                                                               */
  /* ------------------------------------------------------------------ */

  #frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;
    this.shared.uTime.value = this.time;
    this.input.poll();
    this.#handleActions();

    this.videoPool.update(this.time);
    this.track.updateAspects(this.videoPool.aspects());
    this.space.update(this.time);
    const stars = this.space.getObjectByName('stars');
    if (stars) stars.material.uniforms.uTime.value = this.time;

    switch (this.state) {
      case 'menu':
        this.chase.flyOver(dt, this.time);
        break;
      case 'countdown':
        this.kart.update(dt, this.input, false);
        this.chase.follow(this.kart, dt);
        break;
      case 'racing':
        this.kart.update(dt, this.input, true);
        this.#updateRace(dt);
        this.chase.follow(this.kart, dt);
        break;
      case 'paused':
        break;
      default:
        break;
    }

    if (this.state !== 'menu') {
      this.kart.hue = this.kart.s / (this.track.rowLength * this.settings.get('slatsPerRainbow')) + this.time * this.settings.get('hueSpeed');
      const r = this.race;
      this.hud.update({
        speed: this.kart.speed,
        lap: r.lap,
        lapsTotal: r.lapsTotal,
        time: r.time,
        best: r.best,
        boost: this.kart.drifting ? Math.min(1, this.kart.driftTime / 0.75) : this.kart.boostLevel,
        finished: r.finished,
      });
    }

    // periodic status refresh (playing counts change as clips buffer)
    if ((this.time | 0) !== this._lastStatusSecond) {
      this._lastStatusSecond = this.time | 0;
      this.hud.setVideoStatus(this.videoPool.statusText());
    }

    this.composer.render();
  }

  #handleActions() {
    const a = this.input.actions;
    if (a.pause) {
      if (this.state === 'racing' || this.state === 'countdown') this.pause();
      else if (this.state === 'paused') this.resume();
      else if (this.settingsPanel.visible) this.settingsPanel.hide();
    }
    if (a.confirm) {
      if (this.state === 'menu') this.startRace();
      else if (this.state === 'paused') this.resume();
      else if (this.state === 'racing' && this.race?.finished) this.startRace();
    }
    if (a.reset && (this.state === 'racing' || this.state === 'countdown')) {
      if (this.race?.finished) this.startRace();
      else {
        this.kart.respawn();
        this.hud.toast('Reset', 700);
      }
    }
    if (a.camera && this.state !== 'menu') {
      const name = this.chase.nextMode();
      this.hud.toast(`${name} cam`, 800);
    }
  }

  #updateRace(dt) {
    const r = this.race;
    const L = this.path.length;
    if (!r.finished) {
      r.time += dt;
      r.lapTime += dt;
    }
    // signed progress since last frame (wraps)
    let delta = this.kart.s - r.prevS;
    if (delta > L / 2) delta -= L;
    if (delta < -L / 2) delta += L;
    r.lapDistance += delta;
    const crossedForward = r.prevS > L * 0.75 && this.kart.s < L * 0.25;
    const crossedBackward = r.prevS < L * 0.25 && this.kart.s > L * 0.75;
    r.prevS = this.kart.s;

    if (crossedForward && !r.finished && r.lapDistance > L * 0.8) {
      r.lapDistance = 0;
      if (r.best == null || r.lapTime < r.best) r.best = r.lapTime;
      r.lapTime = 0;
      if (r.lap >= r.lapsTotal) {
        r.finished = true;
        this.hud.toast(`Finish · ${formatTime(r.time)}`, 4000);
      } else {
        r.lap++;
        this.hud.toast(r.lap === r.lapsTotal ? 'Final lap!' : `Lap ${r.lap}`, 1400);
      }
    } else if (crossedBackward) {
      r.lapDistance = -L * 0.1; // discourage the shortcut
    }
  }
}

new Game();
