import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Kart } from './Kart.js';
import { FigureKartModel, tameMaterials } from './FigureKartModel.js';
import { AIDriver } from './AIDriver.js';
import { Emote } from './Emote.js';

/**
 * The computer-driven racers. Models live in public/models (shrunk with gltf-transform).
 *
 * targetGap: where this racer likes to be relative to the player (world units, + = ahead).
 * The race director nudges each racer toward its own target, so they spread out
 * instead of all clumping on the player.
 */
const ROSTER = [
  {
    name: 'Princess', // clean and quick; likes to lead and blocks anyone tailing her
    file: 'models/blonde.glb',
    lineOffset: -1.2,
    talent: 1.02,
    targetGap: 25,
    personality: { aggression: 0.25, consistency: 0.9, defend: 0.8, trigger: 0.4 },
  },
  {
    name: 'Gorilla', // a brawler: bumps, holds grudges, wants to be right on your bumper
    file: 'models/gorilla.glb',
    lineOffset: 1.4,
    talent: 0.98,
    targetGap: 0,
    personality: { aggression: 0.85, consistency: 0.5, defend: 0.3, trigger: 0.6 },
  },
  {
    name: 'Mushroom', // erratic and trigger-happy, hangs back and snipes
    file: 'models/mushroom.glb',
    lineOffset: 0.2,
    talent: 1.0,
    targetGap: -20,
    personality: { aggression: 0.45, consistency: 0.55, defend: 0.2, trigger: 0.95 },
  },
];

const KART_LENGTH = 3.0; // bump box, along the track
const KART_WIDTH = 1.8; // bump box, across the track

// Race director: hidden, bounded, gradual pace changes (see docs/SPEC.md, "Rival behaviour")
const START_GRACE = 6; // seconds before the director starts adjusting anyone
const EASE_FROM = 30; // ahead of its target gap by this much, a racer starts easing off…
const EASE_FULL = 250; // …fully by this much
const FIGHT_FROM = 15; // behind its target gap by this much, it starts fighting…
const FIGHT_FULL = 195; // …fully by this much
const EASE_PACE = 0.09; // most top speed given up when easing off
const FIGHT_PACE = 0.06; // most top speed added when fighting
const FINAL_STRETCH = 0.8; // from here (fraction of the race) the fighting pace bonus fades…
const FINAL_FIGHT = 0.35; // …to this share of itself at the line, so the finish is down to driving
const MOOD_RATE = 0.4; // how quickly intensity follows the race (per second)

const EMOTES = {
  hit: '😠',
  scored: '😎',
  dizzy: '😵',
  passed: '😜',
  overtaken: '😤',
  grudge: '💢',
};

const kartIds = new WeakMap();
let nextKartId = 1;
function pairId(a, b) {
  for (const k of [a, b]) if (!kartIds.has(k)) kartIds.set(k, nextKartId++);
  const x = kartIds.get(a);
  const y = kartIds.get(b);
  return x < y ? `${x}:${y}` : `${y}:${x}`;
}

/**
 * Loads the rival karts, puts them on the grid, drives them, keeps score of how
 * far each has gone, and resolves bumps between every kart on the road (player
 * included).
 */
export class Rivals {
  constructor(scene) {
    this.scene = scene;
    /** @type {{ name:string, spec:object, kart:Kart, driver:AIDriver, emote:Emote, progress:number, prevS:number, finishTime:number|null, aheadOfPlayer:boolean, warned:boolean }[]} */
    this.racers = [];
    this.enabled = true;
    this.catchUp = true; // race director pace adjustments (behaviour changes stay either way)
    /** Called as onRivalEvent(racer, what) for things worth telling the player (e.g. 'nemesis'). */
    this.onRivalEvent = null;
    this._contactCooldown = new Map();
    this.path = null;
    this.rails = true;
    this.pace = 1;
    this.visible = false;
    /** @type {import('../items/ItemSystem.js').ItemSystem | null} */
    this.items = null;
    this.ready = this.#load();
  }

  async #load() {
    const loader = new GLTFLoader();
    const results = await Promise.allSettled(
      ROSTER.map((r) => loader.loadAsync(import.meta.env.BASE_URL + r.file)),
    );
    results.forEach((res, i) => {
      const spec = ROSTER[i];
      if (res.status !== 'fulfilled') {
        console.warn(`[rivals] couldn't load ${spec.file}`, res.reason);
        return;
      }
      const model = new FigureKartModel(tameMaterials(res.value.scene), { length: KART_LENGTH });
      const kart = new Kart(this.path, { model });
      kart.rails = this.rails;
      const driver = new AIDriver(kart, { lineOffset: spec.lineOffset, talent: spec.talent, personality: spec.personality });
      driver.pace = this.pace;
      const emote = new Emote();
      model.add(emote);
      model.visible = false;
      this.scene.add(model, kart.rescuer);
      this.racers.push({ name: spec.name, spec, kart, driver, emote, progress: 0, prevS: 0, finishTime: null, aheadOfPlayer: true, warned: false });
    });
    this.setVisible(this.visible);
    return this.racers.length;
  }

  /** Racers taking part (none when rivals are switched off). */
  get active() {
    return this.enabled && this.path ? this.racers : [];
  }

  setPath(path) {
    this.path = path;
    for (const r of this.racers) r.kart.path = path;
  }

  setRails(on) {
    this.rails = on;
    for (const r of this.racers) r.kart.rails = on;
  }

  setPace(pace) {
    this.pace = pace;
    for (const r of this.racers) r.driver.pace = pace;
  }

  setVisible(visible) {
    this.visible = visible;
    const active = new Set(this.active);
    for (const r of this.racers) {
      const shown = visible && active.has(r);
      r.kart.model.visible = shown;
      r.kart.rescuer.visible = shown && r.kart.rescuer.active;
      if (!active.has(r)) r.kart.rescuer.cancel();
    }
  }

  /**
   * Line the rivals up. `slots[i]` is racer i's grid spot; `s` is unwrapped
   * (negative = behind the line), which is also their starting race progress.
   * @param {{ s:number, lateral:number }[]} slots
   */
  placeOnGrid(slots) {
    this.active.forEach((r, i) => {
      const slot = slots[i];
      r.kart.reset(this.path.wrap(slot.s), slot.lateral);
      r.progress = slot.s;
      r.prevS = r.kart.s;
      r.finishTime = null;
      r.aheadOfPlayer = true; // rivals start ahead on the grid
      r.warned = false;
      r.driver.reset();
      r.emote.hide();
    });
    this._contactCooldown.clear();
    this.setVisible(this.visible);
  }

  /**
   * @param {number} dt
   * @param {Kart} player
   * @param {{ progress:number, lapsTotal:number, time:number, finishTime:number|null }} race
   * @param {boolean} controlsEnabled false during the countdown
   */
  update(dt, player, race, controlsEnabled) {
    const racers = this.active;
    if (!racers.length) return;
    const karts = [player, ...racers.map((r) => r.kart)];
    const L = this.path.length;

    for (const r of racers) {
      if (controlsEnabled) this.#direct(dt, r, race);
      r.driver.update(dt, karts, player, this.items);
      r.kart.update(dt, r.driver.input, controlsEnabled);
      if (controlsEnabled && r.driver.input.useItem) this.items?.useItem(r.kart, karts);

      let delta = r.kart.s - r.prevS;
      if (delta > L / 2) delta -= L;
      if (delta < -L / 2) delta += L;
      r.progress += delta;
      r.prevS = r.kart.s;
      if (r.finishTime == null && r.progress >= race.lapsTotal * L) r.finishTime = race.time;

      // overtakes on the player get a reaction
      const ahead = r.progress > race.progress;
      if (controlsEnabled && ahead !== r.aheadOfPlayer && Math.abs(r.progress - race.progress) < 20) {
        r.emote.show(ahead ? EMOTES.passed : r.driver.intensity > 0.2 ? EMOTES.overtaken : EMOTES.hit);
      }
      r.aheadOfPlayer = ahead;

      // a rival that has properly fallen out with the player says so (once a race)
      const g = r.driver.grudge;
      if (g && g.kart === player && g.heat > 0.7 && !r.warned) {
        r.warned = true;
        r.emote.show(EMOTES.grudge, { force: true });
        this.onRivalEvent?.(r, 'nemesis');
      }
      r.emote.update(dt);
    }

    this.#bump(karts);
  }

  /**
   * Race director. Each racer has a target gap to the player; how far it is from that
   * sets its intensity: well ahead → ease off (a little slower, tidier with items,
   * leaves the player alone), behind → fight (a little faster, braver, more
   * aggressive). Changes are bounded and gradual, nothing happens in the first
   * seconds, and the fighting pace bonus fades over the final stretch.
   */
  #direct(dt, r, race) {
    const d = r.driver;
    const L = this.path.length;
    const g = r.progress - race.progress - r.spec.targetGap;
    let want = 0;
    if (race.time > START_GRACE && r.finishTime == null && race.finishTime == null) {
      if (g > EASE_FROM) want = -THREE.MathUtils.smoothstep(g, EASE_FROM, EASE_FULL);
      else if (g < -FIGHT_FROM) want = THREE.MathUtils.smoothstep(-g, FIGHT_FROM, FIGHT_FULL);
    }
    d.intensity += (want - d.intensity) * Math.min(1, dt * MOOD_RATE);
    if (!this.catchUp) {
      d.paceScale = 1;
      return;
    }
    const raceFrac = THREE.MathUtils.clamp(race.progress / (race.lapsTotal * L), 0, 1);
    const fade = raceFrac > FINAL_STRETCH ? THREE.MathUtils.lerp(1, FINAL_FIGHT, (raceFrac - FINAL_STRETCH) / (1 - FINAL_STRETCH)) : 1;
    d.paceScale = 1 + (d.intensity > 0 ? d.intensity * FIGHT_PACE * fade : d.intensity * EASE_PACE);
  }

  /** The racer driving `kart`, if it's a rival. */
  racerOf(kart) {
    return this.racers.find((r) => r.kart === kart) || null;
  }

  /**
   * Item happenings from the ItemSystem: victims hold grudges against whoever did it,
   * and everyone involved reacts.
   * @param {Kart} kart who it happened to
   * @param {string} what
   * @param {Kart|null} by who caused it, if anyone
   */
  onItemEvent(kart, what, by = null) {
    const victim = this.racerOf(kart);
    const attacker = by && this.racerOf(by);
    switch (what) {
      case 'lasered':
        victim?.driver.holdGrudge(by, 0.6);
        victim?.emote.show(EMOTES.hit, { force: true });
        attacker?.emote.show(EMOTES.scored);
        break;
      case 'hit-drop':
        victim?.driver.holdGrudge(by, 0.35);
        victim?.emote.show(EMOTES.hit);
        attacker?.emote.show(EMOTES.scored);
        break;
      case 'block':
        victim?.emote.show(EMOTES.dizzy);
        break;
      default:
        break;
    }
  }

  /** Karts rubbing side by side build a little grudge both ways (a nemesis is made by repeat contact). */
  #contact(a, b) {
    const now = performance.now();
    const pair = this._contactCooldown;
    const id = pairId(a, b);
    if ((pair.get(id) || 0) > now) return;
    pair.set(id, now + 1500);
    this.racerOf(a)?.driver.holdGrudge(b, 0.08, 0.6);
    this.racerOf(b)?.driver.holdGrudge(a, 0.08, 0.6);
  }

  /** Player's position (1 = leading) given their progress and finish time. */
  placeOf(progress, finishTime) {
    let place = 1;
    for (const r of this.active) {
      const ahead =
        r.finishTime != null ? finishTime == null || r.finishTime < finishTime : finishTime == null && r.progress > progress;
      if (ahead) place++;
    }
    return place;
  }

  /** Push overlapping karts apart in track space; the kart behind loses speed to the one in front. */
  #bump(karts) {
    const L = this.path.length;
    for (let i = 0; i < karts.length; i++) {
      for (let j = i + 1; j < karts.length; j++) {
        const a = karts[i];
        const b = karts[j];
        if (a.state !== 'driving' || b.state !== 'driving') continue;
        let ds = b.s - a.s;
        if (ds > L / 2) ds -= L;
        if (ds < -L / 2) ds += L;
        const dl = b.lateral - a.lateral;
        const overlapS = KART_LENGTH - Math.abs(ds);
        const overlapL = KART_WIDTH - Math.abs(dl);
        if (overlapS <= 0 || overlapL <= 0) continue;

        if (overlapS < overlapL) {
          // nose-to-tail: separate along the road and share out the speed
          const [front, back] = ds >= 0 ? [b, a] : [a, b];
          front.s = this.path.wrap(front.s + overlapS / 2);
          back.s = this.path.wrap(back.s - overlapS / 2);
          if (back.speed > front.speed) {
            const shared = (back.speed + front.speed) / 2;
            front.speed = shared;
            back.speed = shared * 0.94;
          }
        } else {
          // side by side: shove apart
          const push = (overlapL / 2) * (Math.sign(dl) || 1);
          a.lateral -= push;
          b.lateral += push;
          a.speed *= 0.995;
          b.speed *= 0.995;
          this.#contact(a, b);
        }
        a.syncModel();
        b.syncModel();
      }
    }
  }
}
