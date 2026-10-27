import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import './style.css';
import { Settings } from './core/settings.js';
import { TrackPath, validateTrackData } from './track/TrackPath.js';
import { TrackMesh } from './track/TrackMesh.js';
import { createSharedUniforms } from './track/slatShader.js';
import { Space } from './world/Space.js';
import { Kart } from './kart/Kart.js';
import { Rivals } from './kart/Rivals.js';
import { ItemSystem } from './items/ItemSystem.js';
import { Input } from './kart/Input.js';
import { ChaseCamera } from './camera/ChaseCamera.js';
import { VideoPool } from './video/VideoPool.js';
import { pickVideoFolder, filesFromDrop, prepareVideoFiles, supportsDirectoryPicker } from './video/folderPicker.js';
import { Hud, formatTime, ordinal } from './ui/Hud.js';
import { SettingsPanel } from './ui/SettingsPanel.js';
import { TrackEditor } from './editor/TrackEditor.js';
import { loadActiveSource, storeActiveSource, decodeTrackFromHash } from './track/trackStore.js';

const $ = (sel) => document.querySelector(sel);

class Game {
  constructor() {
    this.settings = new Settings();
    this.state = 'menu'; // 'menu' | 'countdown' | 'racing' | 'paused' | 'editor'
    this.clock = new THREE.Clock();
    this.time = 0;

    // Which track to build: the last one used, or the seeded default.
    /** @type {import('./track/trackStore.js').TrackSource} */
    this.trackSource = loadActiveSource() || { type: 'generated', seed: this.settings.get('seed') };

    this.#setupRenderer();
    this.#setupScene();
    this.#setupUI();
    this.#bindSettings();
    this.#onResize();
    window.addEventListener('resize', () => this.#onResize());

    this.renderer.setAnimationLoop(() => this.#frame());
    this.#loadSharedTrack();
  }

  /** A track in the URL hash (share link) wins over the remembered one. */
  async #loadSharedTrack() {
    try {
      const data = await decodeTrackFromHash();
      if (!data) return;
      this.setTrackSource({ type: 'custom', data });
      this.folderStatus.textContent = `Loaded shared track “${data.name}” — open the editor to save it.`;
      this.folderStatus.classList.remove('error');
    } catch (err) {
      console.warn('[track] bad share link', err);
      this.folderStatus.textContent = `That share link didn't work: ${err.message}`;
      this.folderStatus.classList.add('error');
    }
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

    this.items = new ItemSystem(this.scene);
    this.items.onEvent = (kart, what) => this.#onItemEvent(kart, what);

    this.rivals = new Rivals(this.scene);
    this.rivals.items = this.items;
    this.rivals.enabled = s.get('rivals');
    this.rivals.setPace(s.get('rivalPace'));
    this.rivals.setRails(s.get('rails'));
    this.rivals.ready.then(() => {
      // Models arrive after the first frame; join a race that is still counting down.
      if (this.state === 'countdown') this.#placeGrid(this.race.startS);
      this.#setKartsVisible(this.#kartsShown());
    });

    this.#buildTrack();
    this.#setKartsVisible(false);
  }

  /** Every kart on the road: the player first, then the rivals taking part. */
  #karts() {
    return [this.kart, ...this.rivals.active.map((r) => r.kart)];
  }

  /** Item happenings worth a toast (only the player's own). */
  #onItemEvent(kart, what) {
    if (kart !== this.kart) return;
    const text = {
      boost: 'Boost!',
      shield: 'Shield!',
      block: 'Ouch!',
      lasered: 'Zapped!',
      'laser-hit': 'Direct hit!',
      'shield-pop': 'Shield took the hit',
    }[what];
    if (text) this.hud.toast(text, 900);
  }

  /** Karts are hidden on the menu and in the editor. */
  #kartsShown() {
    return this.state !== 'menu' && this.state !== 'editor';
  }

  #setKartsVisible(visible) {
    this.kart.model.visible = visible;
    this.kart.rescuer.visible = visible && this.kart.rescuer.active;
    this.rivals.setVisible(visible);
  }

  /**
   * Starting grid: two staggered columns behind `startS`, rivals in front and the
   * player at the back. Returns the player's slot.
   */
  #placeGrid(startS) {
    const count = this.rivals.active.length + 1;
    const side = Math.min(3, this.path.halfWidth - 2);
    const slots = Array.from({ length: count }, (_, k) => ({ s: startS - k * 6, lateral: (k % 2 ? 1 : -1) * side }));
    const mine = slots[count - 1];
    this.rivals.placeOnGrid(slots);
    return mine;
  }

  /** Build a TrackPath for a track source (may throw for invalid custom data). */
  #pathFor(source) {
    return source.type === 'custom' ? TrackPath.fromJSON(source.data) : TrackPath.generate(source.seed);
  }

  /** Switch tracks: rebuild the world, remember the choice, update the menu. */
  setTrackSource(source) {
    const path = this.#pathFor(source); // validate before tearing anything down
    this.trackSource = source;
    if (this.state === 'editor') this._storePending = true; // the editor rebuilds on every drag; persist on exit
    else storeActiveSource(source);
    this.#buildTrack(path);
    if (this.state === 'racing' || this.state === 'countdown') this.startRace();
    else this.#setKartsVisible(this.#kartsShown());
    return path;
  }

  /** (Re)build the path, the road mesh, and reposition the kart. */
  #buildTrack(path = this.#pathFor(this.trackSource)) {
    const s = this.settings;
    if (this.track) {
      this.scene.remove(this.track);
      this.track.dispose();
    }
    if (this.kart) this.scene.remove(this.kart.model, this.kart.rescuer);

    this.path = path;
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
    this.scene.add(this.kart.model, this.kart.rescuer);
    this.rivals.setPath(this.path);
    this.items.build(this.path);

    this.chase.setPath(this.path);
    this.chase.flyS = 0;
    this.#updateTrackLine();
  }

  #updateTrackLine() {
    const el = $('#track-name');
    if (el) el.textContent = this.path.name || (this.trackSource.type === 'generated' ? `Generated #${this.trackSource.seed}` : 'Custom track');
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
    $('#open-editor').addEventListener('click', () => this.openEditor());
    $('#open-editor-2').addEventListener('click', () => this.openEditor());

    this.editor = new TrackEditor({
      root: $('#editor'),
      scene: this.scene,
      camera: this.camera,
      canvas3d: this.canvas,
      hooks: {
        applyTrack: (data) => this.setTrackSource({ type: 'custom', data: validateTrackData(data) }),
        testDrive: (startS) => {
          this.editor.close();
          this.startRace({ startS });
        },
        close: () => this.toMenu(),
        generate: () => TrackPath.generate(Math.floor(Math.random() * 1_000_000)).toJSON(),
      },
    });

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
        else this.#setKartsVisible(this.#kartsShown());
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
          rebuild();
          break;
        case 'seed':
          this.trackSource = { type: 'generated', seed: value };
          storeActiveSource(this.trackSource);
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
          this.rivals.setRails(value);
          break;
        case 'rivals':
          this.rivals.enabled = value;
          if (this.state === 'racing' || this.state === 'countdown') this.startRace({ startS: this.race.startS });
          else this.#setKartsVisible(this.#kartsShown());
          break;
        case 'rivalPace':
          this.rivals.setPace(value);
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

  startRace({ startS = 0 } = {}) {
    this.hud.cancelCountdown();
    this.menu.classList.add('hidden');
    this.pauseMenu.classList.add('hidden');
    this.hud.show();
    this.settingsPanel.hide();
    if (this.editor?.isOpen) this.editor.close();
    this.#setFog('near');
    this.#flushTrackStore();

    startS = this.path.wrap(startS);
    this.items.reset();
    const slot = this.#placeGrid(startS);
    this.kart.reset(this.path.wrap(slot.s), slot.lateral);
    this.#setKartsVisible(true);
    this.chase.snap = true;
    this.race = {
      startS,
      lap: 1,
      lapsTotal: this.settings.get('laps'),
      time: 0,
      lapTime: 0,
      best: null,
      finished: false,
      finishTime: null,
      prevS: this.kart.s,
      lapDistance: slot.s, // starting mid-track counts as having driven from the line
      progress: slot.s, // total distance driven, for race positions (never reset)
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
    if (this.editor?.isOpen) this.editor.close();
    this.#setFog('near');
    this.#flushTrackStore();
    this.state = 'menu';
    this.pauseMenu.classList.add('hidden');
    this.hud.hide();
    this.menu.classList.remove('hidden');
    this.#setKartsVisible(false);
    this.chase.snap = true;
    this.#updateTrackLine();
  }

  openEditor() {
    this.hud.cancelCountdown();
    this.menu.classList.add('hidden');
    this.pauseMenu.classList.add('hidden');
    this.hud.hide();
    this.settingsPanel.hide();
    this.#setKartsVisible(false);
    this.state = 'editor';
    this.#setFog('far'); // the overview camera is far away; don't fog the whole track out
    this.editor.open(this.path, { savedId: this.trackSource.savedId || null });
  }

  #flushTrackStore() {
    if (this._storePending) {
      this._storePending = false;
      storeActiveSource(this.trackSource);
    }
  }

  /** Road fog distances: 'near' for driving, 'far' for the editor's overview camera. */
  #setFog(mode) {
    const u = this.shared;
    if (mode === 'far') {
      u.uFogNear.value = 1400;
      u.uFogFar.value = 3200;
    } else {
      u.uFogNear.value = 140;
      u.uFogFar.value = 420;
    }
    this.items.viewDistance = u.uFogFar.value + 10; // items vanish where the road fogs out
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
        this.items.update(dt, [], this.camera.position, this.time * this.settings.get('hueSpeed'));
        break;
      case 'countdown':
        this.kart.update(dt, this.input, false);
        this.rivals.update(dt, this.kart, this.race, false);
        this.items.update(dt, this.#karts(), this.camera.position, this.kart.hue);
        this.chase.follow(this.kart, dt);
        break;
      case 'racing':
        this.kart.update(dt, this.input, true);
        this.rivals.update(dt, this.kart, this.race, true);
        this.items.update(dt, this.#karts(), this.camera.position, this.kart.hue);
        this.#updateRace(dt);
        this.chase.follow(this.kart, dt);
        break;
      case 'paused':
        break;
      case 'editor':
        this.editor.update(dt);
        this.items.update(dt, [], this.camera.position, this.time * this.settings.get('hueSpeed'));
        break;
      default:
        break;
    }

    if (this.state !== 'menu' && this.state !== 'editor') {
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
        place: this.rivals.placeOf(r.progress, r.finishTime),
        racers: this.rivals.active.length + 1,
        item: this.kart.held && { type: this.kart.held.type, charges: this.kart.held.charges, rolling: this.kart.rolling > 0 },
        coins: this.kart.coins,
        shield: this.kart.shield,
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
      else if (this.state === 'editor') this.toMenu();
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
    if (a.item && this.state === 'racing') this.items.useItem(this.kart, this.#karts());
    if (a.camera && this.state !== 'menu' && this.state !== 'editor') {
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
    r.progress += delta;
    const crossedForward = r.prevS > L * 0.75 && this.kart.s < L * 0.25;
    const crossedBackward = r.prevS < L * 0.25 && this.kart.s > L * 0.75;
    r.prevS = this.kart.s;

    if (crossedForward && !r.finished && r.lapDistance > L * 0.8) {
      r.lapDistance = 0;
      if (r.best == null || r.lapTime < r.best) r.best = r.lapTime;
      r.lapTime = 0;
      if (r.lap >= r.lapsTotal) {
        r.finished = true;
        r.finishTime = r.time;
        const racers = this.rivals.active.length + 1;
        const place = racers > 1 ? ` · ${ordinal(this.rivals.placeOf(r.progress, r.finishTime))} of ${racers}` : '';
        this.hud.toast(`Finish${place} · ${formatTime(r.time)}`, 4000);
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
