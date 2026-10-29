import * as THREE from 'three';
import { ITEM_TYPES, itemTrackPos } from '../track/trackItems.js';
import { TrackFrame } from '../track/TrackPath.js';
import { createItemMesh, createBeamMesh } from './itemMeshes.js';

const KART_HALF_LENGTH = 1.5; // kart's trigger box along the road
const KART_HALF_WIDTH = 0.9; // …and across it

/**
 * What an item box can give, with relative odds for the race leader (front) and the
 * last racer (back); everyone in between gets a blend. Leaders get things to defend
 * with, the back of the pack gets things to catch up with (the same rule for everyone,
 * player included).
 */
const ROULETTE = [
  // type, front, back
  ['boost', 14, 34],
  ['shield', 16, 18],
  ['laser', 12, 34],
  ['cone', 30, 7],
  ['mud', 28, 7],
];
export const HELD_ITEMS = ROULETTE.map(([type]) => type);

const LASER_RANGE = 75;
const LASER_HIT_WIDTH = 1.8; // how close (across the road) a target must be to the beam
const DROPPED_MUD_SECONDS = 25;
const DROPPED_CONE_SECONDS = 40;

/**
 * Runtime side of a track's pickups and obstacles: builds a mesh for every item,
 * checks every kart against them in track space each frame and applies the effects,
 * brings collected pickups back, flies knocked cones, keeps items karts drop, and
 * fires lasers.
 *
 * Each live item is an entry { type, def, s, lateral, mesh, active, timer, ... }.
 * `entries` is public so the AI can look at what's ahead.
 */
export class ItemSystem {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'items';
    scene.add(this.group);
    this.path = null;
    this.entries = [];
    this.flying = []; // knocked cones in flight
    this.beams = [];
    this.time = 0;
    this.viewDistance = 430; // hide items past the road fog
    /** Called as onEvent(kart, what, by) — what happened to `kart`, and who caused it (or null). */
    this.onEvent = null;
    /** Race position of a kart as 0 (leading) .. 1 (last); weights the item box roulette. */
    this.rankOf = null;
    this._frame = new TrackFrame();
    this._m = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
  }

  /** (Re)build from a track's item list. */
  build(path) {
    this.clear();
    this.path = path;
    for (const item of path.items) {
      const { s, lateral } = itemTrackPos(path, item);
      this.#add(item.type, s, lateral, { dropped: false });
    }
  }

  clear() {
    for (const e of this.entries) this.group.remove(e.mesh);
    for (const b of this.beams) this.#removeBeam(b);
    this.entries = [];
    this.flying = [];
    this.beams = [];
  }

  /** New race: everything back in place, dropped items gone. */
  reset() {
    for (const e of this.entries.filter((x) => x.dropped)) this.#remove(e);
    for (const b of this.beams) this.#removeBeam(b);
    this.beams = [];
    this.flying = [];
    for (const e of this.entries) {
      e.active = true;
      e.timer = 0;
      e.s = e.homeS;
      e.lateral = e.homeLateral;
      e.mesh.scale.setScalar(1);
      this.#place(e);
    }
  }

  /**
   * @param {number} dt
   * @param {import('../kart/Kart.js').Kart[]} karts karts on the road (empty in menus / editor)
   * @param {THREE.Vector3} cameraPos for distance culling
   * @param {number} hue current road hue, for colouring
   */
  update(dt, karts, cameraPos, hue = 0) {
    this.time += dt;
    const t = this.time;

    for (const e of this.entries) {
      if (!e.active && !e.flyingNow) {
        // waiting to come back
        if (e.def.respawn && !e.dropped) {
          e.timer -= dt;
          if (e.timer <= 0) {
            e.active = true;
            e.s = e.homeS;
            e.lateral = e.homeLateral;
            e.grow = 0;
            this.#place(e);
          }
        }
      }
      if (e.ownerGrace > 0) e.ownerGrace -= dt;
      if (e.dropped && e.life != null) {
        e.life -= dt;
        if (e.life <= 0) e.expired = true;
      }
      if (e.grow != null) {
        e.grow = Math.min(1, e.grow + dt * 3);
        e.mesh.scale.setScalar(e.grow);
        if (e.grow >= 1) e.grow = null;
      }
      const show = (e.active || e.flyingNow) && e.mesh.position.distanceToSquared(cameraPos) < this.viewDistance ** 2;
      e.mesh.visible = show;
      if (show) e.mesh.userData.animate(dt, t + e.phase, hue);
    }
    for (const e of this.entries.filter((x) => x.expired)) this.#remove(e);

    this.#updateFlying(dt);
    this.#updateBeams(dt);
    for (const k of karts) this.#collide(k);
  }

  /** Use the kart's held item (if ready). `karts` are possible laser targets. */
  useItem(kart, karts) {
    const type = kart.takeItem();
    if (!type) return null;
    const path = this.path;
    switch (type) {
      case 'boost':
        kart.giveBoost(1.6);
        break;
      case 'shield':
        kart.giveShield(6);
        break;
      case 'cone':
        this.#add('cone', path.wrap(kart.s - 3.5), kart.lateral, { dropped: true, life: DROPPED_CONE_SECONDS, owner: kart });
        break;
      case 'mud':
        this.#add('mud', path.wrap(kart.s - 6), kart.lateral, { dropped: true, life: DROPPED_MUD_SECONDS, owner: kart });
        break;
      case 'laser':
        this.#fireLaser(kart, karts);
        break;
      default:
        break;
    }
    return type;
  }

  /** A random item from the roulette, for a racer at `rank` (0 = leading, 1 = last). */
  static rollType(random = Math.random, rank = 0.5) {
    const weights = ROULETTE.map(([type, front, back]) => [type, front + (back - front) * rank]);
    const total = weights.reduce((a, [, w]) => a + w, 0);
    let r = random() * total;
    for (const [type, w] of weights) {
      r -= w;
      if (r < 0) return type;
    }
    return weights[0][0];
  }

  /* ------------------------------------------------------------------ */

  #add(type, s, lateral, { dropped, life = null, owner = null }) {
    const mesh = createItemMesh(type);
    const e = {
      type,
      def: ITEM_TYPES[type],
      s,
      lateral,
      homeS: s,
      homeLateral: lateral,
      mesh,
      active: true,
      timer: 0,
      dropped,
      life,
      owner, // the kart that dropped it can't be hit by it for a moment
      ownerGrace: owner ? 1.0 : 0,
      phase: Math.random() * 10,
      grow: dropped ? 0 : null,
      flyingNow: false,
    };
    this.#place(e);
    this.group.add(mesh);
    this.entries.push(e);
    return e;
  }

  #remove(e) {
    this.group.remove(e.mesh);
    this.entries.splice(this.entries.indexOf(e), 1);
    const f = this.flying.indexOf(e);
    if (f >= 0) this.flying.splice(f, 1);
  }

  /** Position + orient a mesh on the road at (s, lateral, height). */
  #placeMesh(mesh, s, lateral, height = 0) {
    const frame = this.path.frameAt(s, this._frame);
    this.path.pointAt(s, lateral, height, mesh.position, frame);
    const z = this._v.crossVectors(frame.right, frame.normal);
    this._m.makeBasis(frame.right, frame.normal, z);
    mesh.quaternion.setFromRotationMatrix(this._m);
    return frame;
  }

  #place(e) {
    this.#placeMesh(e.mesh, e.s, e.lateral);
  }

  #collide(kart) {
    kart.inMud = false;
    if (kart.state !== 'driving') return;
    const L = this.path.length;
    for (const e of this.entries) {
      if (!e.active) continue;
      if (e.owner === kart && e.ownerGrace > 0) continue;
      let ds = e.s - kart.s;
      if (ds > L / 2) ds -= L;
      if (ds < -L / 2) ds += L;
      const dl = e.lateral - kart.lateral;
      const overS = e.def.hitS + KART_HALF_LENGTH - Math.abs(ds);
      const overL = e.def.hitL + KART_HALF_WIDTH - Math.abs(dl);
      if (overS <= 0 || overL <= 0) continue;
      this.#hit(kart, e, ds, dl, overS, overL);
    }
  }

  #hit(kart, e, ds, dl, overS, overL) {
    switch (e.type) {
      case 'itembox':
        this.#collect(e);
        if (kart.rollItem(ItemSystem.rollType(Math.random, this.rankOf?.(kart) ?? 0.5))) this.onEvent?.(kart, 'itembox');
        break;
      case 'boost':
        this.#collect(e);
        kart.giveBoost(1.3);
        this.onEvent?.(kart, 'boost');
        break;
      case 'shield':
        this.#collect(e);
        kart.giveShield(6);
        this.onEvent?.(kart, 'shield');
        break;
      case 'coin':
        this.#collect(e);
        kart.addCoin();
        this.onEvent?.(kart, 'coin');
        break;
      case 'mud':
        kart.inMud = true;
        // someone else's mud: tell on them (once per kart per patch)
        if (e.owner && e.owner !== kart && !(e.splashed ||= new Set()).has(kart)) {
          e.splashed.add(kart);
          this.onEvent?.(kart, 'hit-drop', e.owner);
        }
        break;
      case 'cone':
        this.#knockCone(e, kart);
        if (kart.shield <= 0) kart.speed *= 0.88;
        if (e.owner && e.owner !== kart) this.onEvent?.(kart, 'hit-drop', e.owner);
        break;
      case 'block':
        this.#hitBlock(kart, ds, dl, overS, overL);
        break;
      default:
        break;
    }
  }

  #collect(e) {
    e.active = false;
    e.timer = e.def.respawn || 0;
    e.mesh.visible = false;
  }

  /** Solid: push the kart out; if it was driving into the block, it ricochets and spins to a stop. */
  #hitBlock(kart, ds, dl, overS, overL) {
    const path = this.path;
    if (overS < overL) {
      // nose (or tail) into the block
      const into = Math.sign(ds) * kart.speed > 0;
      kart.s = path.wrap(kart.s - Math.sign(ds || 1) * overS);
      if (into) {
        const impact = Math.abs(kart.speed);
        kart.speed = -kart.speed * (kart.shield > 0 ? 0.2 : 0.45);
        if (impact > 6 && kart.spinOut(1.2)) this.onEvent?.(kart, 'block');
      }
    } else {
      // scraped the side
      kart.lateral -= Math.sign(dl || 1) * overL;
      kart.heading = -kart.heading * 0.6;
      if (Math.abs(kart.speed) > 10 && kart.shield <= 0) {
        kart.speed *= 0.7;
        if (kart.spinOut(0.8)) this.onEvent?.(kart, 'block');
      }
    }
    kart.syncModel();
  }

  /** Send a cone flying: it bounces along the road and drops off the edge. */
  #knockCone(e, by) {
    e.active = false;
    e.flyingNow = true;
    e.timer = e.def.respawn;
    const side = Math.sign(e.lateral - by.lateral) || (Math.random() < 0.5 ? -1 : 1);
    e.fly = {
      s: e.s,
      lateral: e.lateral,
      h: 0.2,
      vs: Math.max(6, by.speed * 1.15 + 3),
      vl: side * (4 + Math.random() * 5) + by.lateralVel * 0.5,
      vh: 7 + Math.random() * 3,
      spinAxis: new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.3, Math.random() - 0.5).normalize(),
      spin: 0,
      age: 0,
    };
    this.flying.push(e);
  }

  #updateFlying(dt) {
    const half = this.path.halfWidth;
    for (const e of this.flying.slice()) {
      const f = e.fly;
      f.age += dt;
      f.vh -= 30 * dt;
      f.s = this.path.wrap(f.s + f.vs * dt);
      f.lateral += f.vl * dt;
      f.h += f.vh * dt;
      if (f.h < 0 && Math.abs(f.lateral) < half && f.vh < 0) {
        // bounce on the road
        f.h = 0;
        f.vh = -f.vh * 0.45;
        f.vs *= 0.7;
        f.vl *= 0.85;
      }
      f.spin += dt * (8 + f.vs * 0.3);
      this.#placeMesh(e.mesh, f.s, f.lateral, f.h);
      e.mesh.quaternion.multiply(this._q.setFromAxisAngle(f.spinAxis, f.spin));
      if (f.age > 3.5 || f.h < -40) {
        // gone: placed cones wait to come back, dropped ones are done
        e.flyingNow = false;
        this.flying.splice(this.flying.indexOf(e), 1);
        if (e.dropped) e.expired = true;
        else e.mesh.visible = false;
      }
    }
  }

  /* ------------------------------- laser ------------------------------- */

  /**
   * Hitscan along the road ahead, following the kart's aim: the first kart, cone or
   * block within reach of the beam is hit. Karts spin out (a shield absorbs the shot
   * and pops), cones get knocked flying, blocks just stop the beam.
   */
  #fireLaser(kart, karts) {
    const path = this.path;
    const L = path.length;
    const aim = Math.tan(THREE.MathUtils.clamp(kart.heading, -0.6, 0.6));
    const laneAt = (d) => kart.lateral + aim * d;
    const ahead = (s) => {
      let ds = s - kart.s;
      if (ds < -L / 2) ds += L;
      if (ds > L / 2) ds -= L;
      return ds;
    };

    let hitD = LASER_RANGE;
    let target = null;
    for (const k of karts) {
      if (k === kart || k.state !== 'driving') continue;
      const d = ahead(k.s);
      if (d > 0 && d < hitD && Math.abs(k.lateral - laneAt(d)) < LASER_HIT_WIDTH) {
        hitD = d;
        target = { kart: k };
      }
    }
    for (const e of this.entries) {
      if (!e.active || (e.type !== 'cone' && e.type !== 'block')) continue;
      const d = ahead(e.s) - e.def.hitS;
      if (d > 0 && d < hitD && Math.abs(e.lateral - laneAt(d)) < LASER_HIT_WIDTH + e.def.hitL * 0.5) {
        hitD = d;
        target = { entry: e };
      }
    }

    if (target?.kart) {
      const k = target.kart;
      if (k.shield > 0) {
        k.shield = 0;
        this.onEvent?.(k, 'shield-pop', kart);
      } else {
        k.spinOut(1.3);
        k.speed *= 0.5;
        this.onEvent?.(k, 'lasered', kart);
      }
      this.onEvent?.(kart, 'laser-hit', k);
    } else if (target?.entry?.type === 'cone') {
      this.#knockCone(target.entry, kart);
    }

    // beam: a curve following the road from the muzzles to the hit point
    const points = [kart.gear.muzzleWorld(new THREE.Vector3())];
    const steps = Math.max(2, Math.ceil(hitD / 8));
    for (let i = 1; i <= steps; i++) {
      const d = (hitD * i) / steps;
      points.push(path.pointAt(kart.s + d, laneAt(d), 0.8, new THREE.Vector3()));
    }
    const beam = createBeamMesh(points);
    beam.userData.life = 0.22;
    this.group.add(beam);
    this.beams.push(beam);
    kart.gear.fired();
  }

  #updateBeams(dt) {
    for (const b of this.beams.slice()) {
      b.userData.life -= dt;
      const a = Math.max(0, b.userData.life / 0.22);
      b.userData.materials[0].opacity = a;
      b.userData.materials[1].opacity = 0.45 * a;
      if (b.userData.life <= 0) {
        this.#removeBeam(b);
        this.beams.splice(this.beams.indexOf(b), 1);
      }
    }
  }

  #removeBeam(b) {
    this.group.remove(b);
    b.userData.dispose();
  }
}
