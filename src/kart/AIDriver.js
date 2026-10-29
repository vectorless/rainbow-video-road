import * as THREE from 'three';
import { TrackFrame } from '../track/TrackPath.js';
import { MAX_SPEED } from './Kart.js';

const PASS_LOOKAHEAD = 14; // how far ahead (world units) another kart makes us change line
const PASS_GAP = 2.7; // lateral distance to keep when going round someone
const HAZARD_LOOKAHEAD = 24; // how far ahead obstacles are noticed
const PICKUP_LOOKAHEAD = 32; // …and pickups
const PICKUP_DETOUR = 4; // most we'll leave the line for a pickup
const GRUDGE_COOLING = 0.04; // grudge heat lost per second (1 → 0 in 25 s)

/**
 * Drives a Kart by producing the same {throttle, steer, drift} input the player's
 * controls do, so AI karts obey exactly the same physics.
 *
 * Each frame it picks a target lateral offset (a racing line that hugs the inside
 * of upcoming bends, a personal offset that slowly wanders, a detour round any kart
 * close ahead, round obstacles, or toward a pickup), works out the heading that closes
 * the gap while cancelling the bend's sideways push, and converts that heading back
 * into a steering input. It also decides when to use a held item (`input.useItem`).
 *
 * How it drives depends on:
 *  - its personality (0..1 traits): aggression (bumps, attacks), consistency (how
 *    tidy its line is), defend (blocks karts tailing it), trigger (how quickly it
 *    uses items);
 *  - `intensity` (-1..1), set by the race director in Rivals from the gap to the
 *    player: negative = easing off (well ahead of the player), positive = fighting
 *    (the player is ahead). It shifts pace (`paceScale`) and behaviour;
 *  - a grudge: the kart that last hurt it, with a heat that cools over time. Hot
 *    grudges get lasered, bumped and have hazards dropped in front of them.
 */
export class AIDriver {
  /**
   * @param {import('./Kart.js').Kart} kart
   * @param {object} [opts]
   * @param {number} [opts.lineOffset] preferred offset from the racing line (world units)
   * @param {number} [opts.talent] personal top-speed multiplier, ~1
   * @param {{ aggression?:number, consistency?:number, defend?:number, trigger?:number }} [opts.personality]
   */
  constructor(kart, { lineOffset = 0, talent = 1, personality = {} } = {}) {
    this.kart = kart;
    this.lineOffset = lineOffset;
    this.talent = talent;
    this.traits = { aggression: 0.5, consistency: 0.6, defend: 0.3, trigger: 0.5, ...personality };
    this.pace = 1; // global rival pace (settings)
    this.paceScale = 1; // from the race director
    this.intensity = 0; // from the race director, -1 (easing off) .. 1 (fighting)
    /** @type {{ kart: import('./Kart.js').Kart, heat: number } | null} */
    this.grudge = null;
    this.input = { throttle: 0, steer: 0, drift: false, useItem: false };
    this.heldFor = 0; // seconds the current item has been ready
    this.time = Math.random() * 100;
    this._frame = new TrackFrame();
  }

  /** New race: no grudges, neutral mood. */
  reset() {
    this.intensity = 0;
    this.paceScale = 1;
    this.grudge = null;
    this.heldFor = 0;
  }

  /**
   * Remember who hurt us. Heat adds up (repeat offenders become the nemesis), but only
   * up to `cap`, so mere rubbing can't build the grudge an actual attack does.
   */
  holdGrudge(kart, heat, cap = 1) {
    if (!kart || kart === this.kart) return;
    if (this.grudge?.kart === kart) this.grudge.heat = Math.max(this.grudge.heat, Math.min(cap, this.grudge.heat + heat));
    else if (!this.grudge || this.grudge.heat < heat) this.grudge = { kart, heat: Math.min(cap, heat) };
  }

  /** The kart we currently want to beat up: a hot grudge, or the leading player when fighting. */
  #victim(player) {
    if (this.grudge && this.grudge.heat > 0.3 && this.grudge.kart.state === 'driving') return this.grudge.kart;
    if (this.intensity > 0.35 && player?.state === 'driving') return player;
    return null;
  }

  /**
   * @param {number} dt
   * @param {import('./Kart.js').Kart[]} others every other kart on the track (player included)
   * @param {import('./Kart.js').Kart} player
   * @param {import('../items/ItemSystem.js').ItemSystem} [items] track items, to dodge and collect
   */
  update(dt, others, player, items = null) {
    const k = this.kart;
    const path = k.path;
    const input = this.input;
    const t = this.traits;
    this.time += dt;
    if (this.grudge) {
      this.grudge.heat -= dt * GRUDGE_COOLING;
      if (this.grudge.heat <= 0) this.grudge = null;
    }

    k.topSpeedScale = this.pace * this.talent * this.paceScale;

    input.useItem = false;
    if (k.state !== 'driving') {
      input.throttle = 0;
      input.steer = 0;
      return;
    }

    const fight = Math.max(0, this.intensity); // 0..1 when the player is ahead
    const ease = Math.max(0, -this.intensity); // 0..1 when we're well ahead
    const aggression = Math.min(1, t.aggression + fight * 0.4 + (this.grudge?.heat ?? 0) * 0.5 - ease * 0.3);
    const tidiness = Math.min(1, t.consistency + fight * 0.3 - ease * 0.3);

    const speed = Math.max(Math.abs(k.speed), 4);
    const limit = Math.max(0.5, path.halfWidth - 1.6);

    // --- racing line: inside of the bends coming up, with a wander that tidier drivers keep small
    let curv = 0;
    const reach = 10 + speed * 0.9;
    for (let i = 1; i <= 4; i++) curv += path.frameAt(k.s + (reach * i) / 4, this._frame).curvature;
    curv /= 4;
    // positive curvature = left turn; the inside of a left turn is negative lateral
    let target = -THREE.MathUtils.clamp(curv * 70, -1, 1) * limit * 0.75;
    target += this.lineOffset + Math.sin(this.time * 0.23) * THREE.MathUtils.lerp(1.5, 0.3, tidiness);

    // --- other karts: attack a victim alongside, aim a laser at it, or go round whoever is ahead
    const victim = this.#victim(player);
    let busy = false;
    if (victim) {
      const d = this.#ahead(victim.s);
      if (aggression > 0.55 && Math.abs(d) < 3.5 && Math.abs(victim.lateral - k.lateral) < 4.5) {
        target = victim.lateral; // lean in for a shove
        busy = true;
      } else if (k.itemReady && k.held.type === 'laser' && d > 6 && d < 50) {
        target = victim.lateral; // line up the shot
        busy = true;
      }
    }
    if (!busy) {
      const nearest = this.#nearestAhead(others, target);
      if (nearest) {
        // go round on the side we're already on, or the roomier side if we're dead behind
        let side = Math.sign(k.lateral - nearest.lateral);
        if (Math.abs(k.lateral - nearest.lateral) < 0.3) side = nearest.lateral > 0 ? -1 : 1;
        target = nearest.lateral + side * PASS_GAP;
      } else if (t.defend > 0.4) {
        // defend: drift across in front of someone tailing us
        const follower = this.#closeBehind(others);
        if (follower) target = THREE.MathUtils.lerp(target, follower.lateral, 0.6 * t.defend);
      }
    }
    if (items) target = this.#itemLine(items, target, limit);
    target = THREE.MathUtils.clamp(target, -limit, limit);
    if (items) this.#decideItem(dt, others, items, player, victim);

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

    // lift off when the bend needs more steering than the kart has at this speed;
    // fighting drivers commit later, relaxed ones lift earlier
    const commit = 0.95 + fight * 0.03 - ease * 0.05;
    input.throttle = Math.abs(wantHeading) > maxAngle * commit ? 0.2 : 1;
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

  #nearestAhead(others, target) {
    let nearest = null;
    let nearestD = PASS_LOOKAHEAD;
    for (const o of others) {
      if (o === this.kart || o.state !== 'driving') continue;
      const d = this.#ahead(o.s);
      if (d <= 0 || d >= nearestD || Math.abs(o.lateral - target) > PASS_GAP) continue;
      nearest = o;
      nearestD = d;
    }
    return nearest;
  }

  #closeBehind(others) {
    for (const o of others) {
      if (o === this.kart || o.state !== 'driving') continue;
      const d = this.#ahead(o.s);
      if (d < -2 && d > -12 && Math.abs(o.lateral - this.kart.lateral) < 4) return o;
    }
    return null;
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

  /**
   * When to use the held item. Trigger-happy drivers fire sooner; while easing off
   * (well ahead of the player) they hold on longer and leave the player alone.
   */
  #decideItem(dt, others, items, player, victim) {
    const k = this.kart;
    if (!k.itemReady) {
      this.heldFor = 0;
      return;
    }
    this.heldFor += dt;
    const ease = Math.max(0, -this.intensity);
    const spare = (o) => ease > 0.3 && o === player; // don't pick on a player who is already behind
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
        if (o === k || o.state !== 'driving' || spare(o)) return false;
        const d = this.#ahead(o.s);
        const tolerance = o === victim ? 1.6 : 1.2;
        return d > 2 && d < 60 && Math.abs(o.lateral - (k.lateral + aim * d)) < tolerance;
      });
      use ||= this.heldFor > 14;
    } else {
      // cone / mud: drop it in front of someone close behind (a grudge doesn't need to be quite so lined up)
      use = others.some((o) => {
        if (o === k || o.state !== 'driving' || spare(o)) return false;
        const d = this.#ahead(o.s);
        if (o === victim) return d < -3 && d > -35 && Math.abs(o.lateral - k.lateral) < 5;
        return d < -3 && d > -25 && Math.abs(o.lateral - k.lateral) < 3;
      });
      use ||= this.heldFor > 10;
    }
    // hesitation: trigger-happy drivers barely wait, relaxed ones sit on it
    const wait = 0.3 + (1 - this.traits.trigger) * 1.2 + ease * 2;
    this.input.useItem = use && this.heldFor > wait;
  }
}
