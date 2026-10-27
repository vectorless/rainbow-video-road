import * as THREE from 'three';
import { TrackFrame } from '../track/TrackPath.js';
import { MAX_SPEED } from './Kart.js';

const PASS_LOOKAHEAD = 14; // how far ahead (world units) another kart makes us change line
const PASS_GAP = 2.7; // lateral distance to keep when going round someone
const HAZARD_LOOKAHEAD = 24; // how far ahead obstacles are noticed
const PICKUP_LOOKAHEAD = 32; // …and pickups
const PICKUP_DETOUR = 4; // most we'll leave the line for a pickup

/**
 * Drives a Kart by producing the same {throttle, steer, drift} input the player's
 * controls do, so AI karts obey exactly the same physics.
 *
 * Each frame it picks a target lateral offset (a racing line that hugs the inside
 * of upcoming bends, a personal offset that slowly wanders, a detour round any kart
 * close ahead, round obstacles, or toward a pickup), works out the heading that closes
 * the gap while cancelling the bend's sideways push, and converts that heading back
 * into a steering input. It also decides when to use a held item (`input.useItem`).
 */
export class AIDriver {
  /**
   * @param {import('./Kart.js').Kart} kart
   * @param {object} [opts]
   * @param {number} [opts.lineOffset] preferred offset from the racing line (world units)
   * @param {number} [opts.talent] personal top-speed multiplier, ~1
   */
  constructor(kart, { lineOffset = 0, talent = 1 } = {}) {
    this.kart = kart;
    this.lineOffset = lineOffset;
    this.talent = talent;
    this.pace = 1; // global rival pace (settings)
    this.input = { throttle: 0, steer: 0, drift: false, useItem: false };
    this.heldFor = 0; // seconds the current item has been ready
    this.time = Math.random() * 100;
    this.rubberBand = 1;
    this._frame = new TrackFrame();
  }

  /**
   * @param {number} dt
   * @param {import('./Kart.js').Kart[]} others every other kart on the track (player included)
   * @param {number} gapToPlayer how far ahead of the player this kart is (negative = behind)
   * @param {import('../items/ItemSystem.js').ItemSystem} [items] track items, to dodge and collect
   */
  update(dt, others, gapToPlayer, items = null) {
    const k = this.kart;
    const path = k.path;
    const input = this.input;
    this.time += dt;

    // Rubber-banding: ease off when well ahead of the player, push a little when far behind.
    const band = 1 - THREE.MathUtils.clamp(gapToPlayer / 500, -0.06, 0.12);
    this.rubberBand += (band - this.rubberBand) * Math.min(1, dt * 0.5);
    k.topSpeedScale = this.pace * this.talent * this.rubberBand;

    input.useItem = false;
    if (k.state !== 'driving') {
      input.throttle = 0;
      input.steer = 0;
      return;
    }

    const speed = Math.max(Math.abs(k.speed), 4);
    const limit = Math.max(0.5, path.halfWidth - 1.6);

    // --- racing line: inside of the bends coming up
    let curv = 0;
    const reach = 10 + speed * 0.9;
    for (let i = 1; i <= 4; i++) curv += path.frameAt(k.s + (reach * i) / 4, this._frame).curvature;
    curv /= 4;
    // positive curvature = left turn; the inside of a left turn is negative lateral
    let target = -THREE.MathUtils.clamp(curv * 70, -1, 1) * limit * 0.75;
    target += this.lineOffset + Math.sin(this.time * 0.23) * 0.8;

    // --- overtaking: steer round the nearest kart just ahead in our lane
    const L = path.length;
    let nearest = null;
    let nearestD = PASS_LOOKAHEAD;
    for (const o of others) {
      if (o === k || o.state !== 'driving') continue;
      let ds = o.s - k.s;
      if (ds > L / 2) ds -= L;
      if (ds < -L / 2) ds += L;
      if (ds <= 0 || ds >= nearestD) continue;
      if (Math.abs(o.lateral - target) > PASS_GAP) continue;
      nearest = o;
      nearestD = ds;
    }
    if (nearest) {
      // go round on the side we're already on, or the roomier side if we're dead behind
      let side = Math.sign(k.lateral - nearest.lateral);
      if (Math.abs(k.lateral - nearest.lateral) < 0.3) side = nearest.lateral > 0 ? -1 : 1;
      target = nearest.lateral + side * PASS_GAP;
    }
    if (items) target = this.#itemLine(items, target, limit);
    target = THREE.MathUtils.clamp(target, -limit, limit);
    if (items) this.#decideItem(dt, others, items);

    // --- steering: the heading whose sideways speed closes the gap, minus the bend's push
    const frame = path.frameAt(k.s, this._frame);
    const bankRelief = 1 - Math.min(1, Math.abs(frame.bank) / 0.6) * 0.8;
    const push = frame.curvature * k.speed * k.speed * 0.02 * bankRelief; // mirrors Kart.update
    const wantLatVel = THREE.MathUtils.clamp((target - k.lateral) * 1.8, -9, 9);
    const sinH = THREE.MathUtils.clamp((wantLatVel - push) / speed, -0.95, 0.95);
    const wantHeading = Math.asin(sinH);

    const speedRatio = THREE.MathUtils.clamp(Math.abs(k.speed) / MAX_SPEED, 0, 1);
    const maxAngle = THREE.MathUtils.lerp(0.55, 0.26, speedRatio); // mirrors Kart.update
    input.steer = THREE.MathUtils.clamp(wantHeading / maxAngle, -1, 1);

    // lift off when the bend needs more steering than the kart has at this speed
    input.throttle = Math.abs(wantHeading) > maxAngle * 0.95 ? 0.2 : 1;
    input.drift = false;
  }

  /** Signed distance from this kart forward to `s` (negative = behind). */
  #ahead(s) {
    const L = this.kart.path.length;
    let ds = s - this.kart.s;
    if (ds > L / 2) ds -= L;
    if (ds < -L / 2) ds += L;
    return ds;
  }

  /** Adjust the target line: steer round the nearest obstacle in the way, else toward a pickup. */
  #itemLine(items, target, limit) {
    const k = this.kart;
    let hazard = null;
    let hazardD = HAZARD_LOOKAHEAD;
    let pickup = null;
    let pickupD = PICKUP_LOOKAHEAD;
    for (const e of items.entries) {
      if (!e.active) continue;
      const d = this.#ahead(e.s);
      if (d <= 0) continue;
      if (e.def.kind === 'obstacle') {
        if (e.type === 'mud' && k.shield > 0) continue;
        if (d < hazardD && Math.abs(e.lateral - target) < e.def.hitL + 1.6) {
          hazard = e;
          hazardD = d;
        }
      } else if (d < pickupD && Math.abs(e.lateral - target) < PICKUP_DETOUR && this.#wants(e.type)) {
        pickup = e;
        pickupD = d;
      }
    }
    if (hazard) {
      // pass on the side the line already favours; if that runs off the road, the other side
      const gap = hazard.def.hitL + 1.9;
      let side = Math.sign(target - hazard.lateral) || (hazard.lateral > 0 ? -1 : 1);
      if (Math.abs(hazard.lateral + side * gap) > limit) side = -side;
      return hazard.lateral + side * gap;
    }
    return pickup ? pickup.lateral : target;
  }

  #wants(type) {
    if (type === 'itembox') return !this.kart.held;
    if (type === 'coin') return this.kart.coins < 10;
    return true; // boost, shield
  }

  /** When to use the held item. */
  #decideItem(dt, others, items) {
    const k = this.kart;
    if (!k.itemReady) {
      this.heldFor = 0;
      return;
    }
    this.heldFor += dt;
    const type = k.held.type;
    let use = false;
    if (type === 'boost') {
      // on a straight-ish bit
      const curv = Math.abs(k.path.frameAt(k.s + 20, this._frame).curvature);
      use = curv < 0.005 && k.speed > 15;
    } else if (type === 'shield') {
      use = this.heldFor > 5 || items.entries.some((e) => e.active && e.def.kind === 'obstacle' && e.type !== 'mud' && this.#ahead(e.s) > 0 && this.#ahead(e.s) < 12);
    } else if (type === 'laser') {
      const aim = Math.tan(THREE.MathUtils.clamp(k.heading, -0.6, 0.6));
      use = others.some((o) => {
        if (o === k || o.state !== 'driving') return false;
        const d = this.#ahead(o.s);
        return d > 2 && d < 60 && Math.abs(o.lateral - (k.lateral + aim * d)) < 1.2;
      });
      use ||= this.heldFor > 14;
    } else {
      // cone / mud: drop it in front of someone following close behind
      use = others.some((o) => {
        if (o === k || o.state !== 'driving') return false;
        const d = this.#ahead(o.s);
        return d < -3 && d > -25 && Math.abs(o.lateral - k.lateral) < 3;
      });
      use ||= this.heldFor > 10;
    }
    // a little hesitation so it doesn't fire the instant it can
    this.input.useItem = use && this.heldFor > 0.4;
  }
}
