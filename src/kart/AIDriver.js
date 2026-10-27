import * as THREE from 'three';
import { TrackFrame } from '../track/TrackPath.js';
import { MAX_SPEED } from './Kart.js';

const PASS_LOOKAHEAD = 14; // how far ahead (world units) another kart makes us change line
const PASS_GAP = 2.7; // lateral distance to keep when going round someone

/**
 * Drives a Kart by producing the same {throttle, steer, drift} input the player's
 * controls do, so AI karts obey exactly the same physics.
 *
 * Each frame it picks a target lateral offset (a racing line that hugs the inside
 * of upcoming bends, a personal offset that slowly wanders, and a detour round
 * any kart close ahead), works out the heading that closes the gap while cancelling
 * the bend's sideways push, and converts that heading back into a steering input.
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
    this.input = { throttle: 0, steer: 0, drift: false };
    this.time = Math.random() * 100;
    this.rubberBand = 1;
    this._frame = new TrackFrame();
  }

  /**
   * @param {number} dt
   * @param {import('./Kart.js').Kart[]} others every other kart on the track (player included)
   * @param {number} gapToPlayer how far ahead of the player this kart is (negative = behind)
   */
  update(dt, others, gapToPlayer) {
    const k = this.kart;
    const path = k.path;
    const input = this.input;
    this.time += dt;

    // Rubber-banding: ease off when well ahead of the player, push a little when far behind.
    const band = 1 - THREE.MathUtils.clamp(gapToPlayer / 500, -0.06, 0.12);
    this.rubberBand += (band - this.rubberBand) * Math.min(1, dt * 0.5);
    k.topSpeedScale = this.pace * this.talent * this.rubberBand;

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
    target = THREE.MathUtils.clamp(target, -limit, limit);

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
}
