import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Kart } from './Kart.js';
import { FigureKartModel, tameMaterials } from './FigureKartModel.js';
import { AIDriver } from './AIDriver.js';

/** The computer-driven racers. Models live in public/models (shrunk with gltf-transform). */
const ROSTER = [
  { name: 'Princess', file: 'models/blonde.glb', lineOffset: -1.2, talent: 1.02 },
  { name: 'Gorilla', file: 'models/gorilla.glb', lineOffset: 1.4, talent: 0.98 },
];

const KART_LENGTH = 3.0; // bump box, along the track
const KART_WIDTH = 1.8; // bump box, across the track

/**
 * Loads the rival karts, puts them on the grid, drives them, keeps score of how
 * far each has gone, and resolves bumps between every kart on the road (player
 * included).
 */
export class Rivals {
  constructor(scene) {
    this.scene = scene;
    /** @type {{ name:string, kart:Kart, driver:AIDriver, progress:number, prevS:number, finishTime:number|null }[]} */
    this.racers = [];
    this.enabled = true;
    this.path = null;
    this.rails = true;
    this.pace = 1;
    this.visible = false;
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
      const driver = new AIDriver(kart, { lineOffset: spec.lineOffset, talent: spec.talent });
      driver.pace = this.pace;
      model.visible = false;
      this.scene.add(model, kart.rescuer);
      this.racers.push({ name: spec.name, kart, driver, progress: 0, prevS: 0, finishTime: null });
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
    });
    this.setVisible(this.visible);
  }

  /**
   * @param {number} dt
   * @param {Kart} player
   * @param {{ progress:number, lapsTotal:number, time:number }} race
   * @param {boolean} controlsEnabled false during the countdown
   */
  update(dt, player, race, controlsEnabled) {
    const racers = this.active;
    if (!racers.length) return;
    const karts = [player, ...racers.map((r) => r.kart)];
    const L = this.path.length;

    for (const r of racers) {
      r.driver.update(dt, karts, r.progress - race.progress);
      r.kart.update(dt, r.driver.input, controlsEnabled);

      let delta = r.kart.s - r.prevS;
      if (delta > L / 2) delta -= L;
      if (delta < -L / 2) delta += L;
      r.progress += delta;
      r.prevS = r.kart.s;
      if (r.finishTime == null && r.progress >= race.lapsTotal * L) r.finishTime = race.time;
    }

    this.#bump(karts);
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
        }
        a.syncModel();
        b.syncModel();
      }
    }
  }
}
