import * as THREE from 'three';
import { TrackFrame } from '../track/TrackPath.js';
import { KartModel } from './KartModel.js';
import { SpaceGod } from './SpaceGod.js';
import { KartGear } from './KartGear.js';

export const MAX_SPEED = 32; // world units / s at full throttle, no boost (halved for now; was 64)
const ACCEL = 30;
const DRAG = ACCEL / MAX_SPEED; // so terminal velocity == MAX_SPEED
const BRAKE = 55;
const REVERSE_MAX = 16;
const KART_HALF_WIDTH = 0.95;
const FALL_RESCUE_DELAY = 0.4; // seconds of falling before the space god swoops in (soon, before the kart drops out of sight under the road)
const LANDING_SPEED = 6; // speed the kart is set down with, so it rolls straight off
const MAX_COINS = 10;
const COIN_BONUS = 0.012; // top speed per coin
const MUD_SPEED = 0.45; // top speed in mud
const ITEM_ROLL_SECONDS = 0.8; // item box roulette before the item can be used
export const LASER_SHOTS = 3;

/**
 * Arcade kart that lives in track space: a distance `s` along the path and a
 * lateral offset from the centreline. Steering changes the heading angle relative
 * to the road, which converts speed into lateral motion. Falling off switches to a
 * free-fall ballistic state; then the kart's space god (`rescuer`, which the owner
 * adds to the scene) carries it back to the last safe spot on the road.
 *
 * Item effects live here too (shield, spin-out, coins, mud, the held item); the
 * ItemSystem decides when they happen.
 */
export class Kart {
  /**
   * @param {import('../track/TrackPath.js').TrackPath} path
   * @param {object} [opts]
   * @param {THREE.Object3D & { animate(dt:number, s:object):void }} [opts.model] defaults to the built-in kart
   */
  constructor(path, { model = new KartModel() } = {}) {
    this.path = path;
    this.model = model;
    this.gear = new KartGear(model);
    model.add(this.gear);
    this.rescuer = new SpaceGod();
    this.frame = new TrackFrame();

    this.state = 'driving'; // 'driving' | 'falling' | 'rescue'
    this.s = 0;
    this.lateral = 0;
    this.speed = 0;
    this.steer = 0; // smoothed steering input
    this.heading = 0; // angle relative to track direction (rad)
    this.lateralVel = 0;

    this.drifting = false;
    this.driftTime = 0;
    this.driftDir = 0;
    this.boost = 0; // seconds of boost remaining
    this.boostLevel = 0; // 0..1 visual intensity

    this.fallVelocity = new THREE.Vector3();
    this.fallTime = 0;
    this.lastSafeS = 0;
    this.respawnFlash = 0;

    this.rails = true;
    this.hue = 0;
    this.topSpeedScale = 1; // AI pace / rubber-banding; the player stays at 1

    // item effects
    this.shield = 0; // seconds of shield left
    this.spinTime = 0; // seconds of spin-out left (no control)
    this.spinDuration = 1;
    this.spinDir = 1;
    this.spinYaw = 0;
    this.coins = 0;
    this.inMud = false; // set each frame by the ItemSystem
    /** @type {{ type:string, charges:number } | null} */
    this.held = null;
    this.rolling = 0; // item box roulette time left; `held` is usable when it reaches 0

    this._tmpM = new THREE.Matrix4();
    this._tmpQ = new THREE.Quaternion();
    this._tmpV = new THREE.Vector3();
  }

  reset(s = 0, lateral = 0) {
    this.state = 'driving';
    this.s = s;
    this.lateral = lateral;
    this.speed = 0;
    this.steer = 0;
    this.heading = 0;
    this.lateralVel = 0;
    this.drifting = false;
    this.driftTime = 0;
    this.boost = 0;
    this.boostLevel = 0;
    this.fallTime = 0;
    this.lastSafeS = s;
    this.shield = 0;
    this.spinTime = 0;
    this.spinYaw = 0;
    this.coins = 0;
    this.inMud = false;
    this.held = null;
    this.rolling = 0;
    this.model.scale.setScalar(1);
    this.model.visible = true;
    this.rescuer.cancel();
    this.syncModel();
  }

  /* ------------------------------ item effects ------------------------------ */

  /** Knocked into a spin: no control for a moment, speed bleeds away. False if shielded. */
  spinOut(duration = 1.1) {
    if (this.shield > 0 || this.state !== 'driving') return false;
    if (this.spinTime <= 0) this.spinDir = Math.random() < 0.5 ? -1 : 1;
    this.spinTime = this.spinDuration = duration;
    this.drifting = false;
    this.boost = 0;
    this.coins = Math.max(0, this.coins - 2);
    return true;
  }

  giveBoost(seconds = 1.2) {
    this.boost = Math.max(this.boost, seconds);
  }

  giveShield(seconds = 6) {
    this.shield = Math.max(this.shield, seconds);
  }

  addCoin() {
    this.coins = Math.min(MAX_COINS, this.coins + 1);
  }

  /** Start the item roulette that ends with `type` in hand. False if already holding something. */
  rollItem(type) {
    if (this.held) return false;
    this.held = { type, charges: type === 'laser' ? LASER_SHOTS : 1 };
    this.rolling = ITEM_ROLL_SECONDS;
    return true;
  }

  /** Item ready to use (held and done rolling)? */
  get itemReady() {
    return this.held != null && this.rolling <= 0;
  }

  /** Use one charge of the held item; returns its type, or null. */
  takeItem() {
    if (!this.itemReady || this.state !== 'driving') return null;
    const type = this.held.type;
    if (--this.held.charges <= 0) this.held = null;
    return type;
  }

  get position() {
    return this.model.position;
  }

  /**
   * @param {number} dt
   * @param {{throttle:number, steer:number, drift:boolean}} input
   * @param {boolean} controlsEnabled
   */
  update(dt, input, controlsEnabled = true) {
    if (this.state === 'falling') {
      this.#updateFalling(dt);
      return;
    }
    if (this.state === 'rescue') {
      this.#updateRescue(dt);
      return;
    }
    this.rescuer.update(dt, this.model, this.hue); // flying off after a rescue

    const path = this.path;
    if (this.shield > 0) this.shield -= dt;
    if (this.rolling > 0) this.rolling -= dt;
    const spinning = this.spinTime > 0;
    if (spinning) this.spinTime -= dt;
    const control = controlsEnabled && !spinning;
    const throttle = control ? input.throttle : 0;
    const steerIn = control ? input.steer : 0;
    const driftIn = control && input.drift;

    // --- longitudinal
    const boosting = this.boost > 0;
    if (boosting) this.boost -= dt;
    const mud = this.inMud && this.shield <= 0 && !boosting;
    const speedScale = this.topSpeedScale * (1 + this.coins * COIN_BONUS) * (mud ? MUD_SPEED : 1);
    const maxSpeed = MAX_SPEED * speedScale * (boosting ? 1.35 : 1);
    const accel = ACCEL * speedScale * (boosting ? 1.8 : 1);

    if (throttle > 0) {
      this.speed += throttle * accel * dt;
    } else if (throttle < 0) {
      if (this.speed > 0.5) this.speed += throttle * BRAKE * dt;
      else this.speed = Math.max(-REVERSE_MAX, this.speed + throttle * ACCEL * 0.6 * dt);
    }
    // drag (quadratic-ish feel: stronger near the top)
    const dragCoef = DRAG * (this.drifting ? 1.25 : 1);
    this.speed -= this.speed * dragCoef * dt;
    if (this.speed > maxSpeed) this.speed = THREE.MathUtils.lerp(this.speed, maxSpeed, Math.min(1, dt * (mud ? 5 : 3)));
    if (spinning) this.speed -= this.speed * Math.min(1, dt * 2.5); // spin to a stop
    if (Math.abs(this.speed) < 0.02 && throttle === 0) this.speed = 0;

    // --- steering
    this.steer += (steerIn - this.steer) * Math.min(1, dt * 9);
    const speedRatio = THREE.MathUtils.clamp(Math.abs(this.speed) / MAX_SPEED, 0, 1);
    let maxAngle = THREE.MathUtils.lerp(0.55, 0.26, speedRatio);

    // drift: hold to carve harder, release after a while for a mini-turbo
    const wantDrift = driftIn && Math.abs(this.speed) > MAX_SPEED * 0.35 && Math.abs(this.steer) > 0.2;
    if (wantDrift && !this.drifting) {
      this.drifting = true;
      this.driftDir = Math.sign(this.steer) || 1;
      this.driftTime = 0;
    }
    if (this.drifting) {
      this.driftTime += dt;
      maxAngle *= 1.7;
      const stillHeld = driftIn && Math.abs(this.speed) > MAX_SPEED * 0.25;
      if (!stillHeld) {
        this.drifting = false;
        if (this.driftTime > 0.75) this.boost = Math.max(this.boost, 0.9 + Math.min(1.2, this.driftTime * 0.5));
      }
    }

    const targetHeading = this.steer * maxAngle * Math.sign(this.speed || 1);
    this.heading += (targetHeading - this.heading) * Math.min(1, dt * 7);

    // spin-out: two turns that wind down (ending facing forward again)
    if (spinning) {
      const u = 1 - Math.max(0, this.spinTime) / this.spinDuration;
      this.spinYaw = this.spinDir * Math.PI * 4 * (1 - (1 - u) ** 2);
    } else {
      this.spinYaw = 0;
    }

    // --- motion in track space
    const forward = this.speed * Math.cos(this.heading);
    let lateralVel = this.speed * Math.sin(this.heading);

    // centrifugal push on bends, softened by banking
    const frame = path.frameAt(this.s, this.frame);
    const bankRelief = 1 - Math.min(1, Math.abs(frame.bank) / 0.6) * 0.8;
    lateralVel += frame.curvature * this.speed * this.speed * 0.02 * bankRelief;
    if (this.drifting) lateralVel += this.driftDir * 2.5;

    this.lateralVel = lateralVel;
    this.s = path.wrap(this.s + forward * dt);
    this.lateral += lateralVel * dt;

    // --- edges
    const limit = path.halfWidth - KART_HALF_WIDTH;
    if (Math.abs(this.lateral) > limit) {
      if (this.rails) {
        this.lateral = Math.sign(this.lateral) * limit;
        if (Math.sign(this.lateralVel) === Math.sign(this.lateral)) {
          // scrape: lose some speed, kick the nose back toward the road
          this.speed *= 1 - Math.min(0.5, Math.abs(Math.sin(this.heading)) * 1.2) * 0.4;
          this.heading *= -0.3;
          this.drifting = false;
        }
      } else if (Math.abs(this.lateral) > path.halfWidth + 0.5) {
        this.#startFalling(frame);
        return;
      }
    } else {
      this.lastSafeS = this.s;
    }

    this.boostLevel = THREE.MathUtils.lerp(this.boostLevel, this.boost > 0 ? 1 : 0, Math.min(1, dt * 6));
    if (this.respawnFlash > 0) this.respawnFlash -= dt;

    this.syncModel();
    this.model.animate(dt, {
      speed: this.speed,
      steer: this.steer,
      drift: this.drifting ? this.driftDir : 0,
      boost: this.boostLevel,
      hue: this.hue,
    });
    this.gear.update(dt, { shield: this.shield, laser: this.held?.type === 'laser' && this.rolling <= 0, hue: this.hue });
    this.model.visible = this.respawnFlash <= 0 || Math.floor(this.respawnFlash * 12) % 2 === 0;
  }

  /** Put the model where track-space says it is. */
  syncModel() {
    const frame = this.path.frameAt(this.s, this.frame);
    const m = this.model;
    this.path.pointAt(this.s, this.lateral, 0, m.position, frame);
    // yaw by heading (+ a bit of drift exaggeration, + any spin-out)
    this.#roadQuaternion(frame, -(this.heading + (this.drifting ? this.driftDir * 0.25 : 0)) + this.spinYaw, m.quaternion);
  }

  /** Orientation of a kart sitting on the road at `frame`, turned by `yaw`. */
  #roadQuaternion(frame, yaw, out) {
    // basis: x = right, y = normal, z = right × normal (= backwards)
    const z = this._tmpV.crossVectors(frame.right, frame.normal);
    this._tmpM.makeBasis(frame.right, frame.normal, z);
    out.setFromRotationMatrix(this._tmpM);
    this._tmpQ.setFromAxisAngle(frame.normal, yaw);
    return out.premultiply(this._tmpQ);
  }

  #startFalling(frame) {
    this.state = 'falling';
    this.fallTime = 0;
    // world velocity: along track + lateral + a little drop
    this.fallVelocity
      .copy(frame.tangent)
      .multiplyScalar(this.speed * Math.cos(this.heading))
      .addScaledVector(frame.right, this.lateralVel)
      .addScaledVector(frame.normal, -2);
    this.drifting = false;
    this.boost = 0;
    this.spinTime = 0;
    this.spinYaw = 0;
    this.coins = Math.floor(this.coins / 2); // falling off costs half your coins
  }

  #updateFalling(dt) {
    this.fallTime += dt;
    this.fallVelocity.y -= 38 * dt;
    this.model.position.addScaledVector(this.fallVelocity, dt);
    this.model.rotateX(dt * 1.2);
    this.model.rotateZ(dt * 0.8);
    this.model.animate(dt, { speed: this.speed, steer: 0, drift: 0, boost: 0, hue: this.hue });
    this.rescuer.update(dt, this.model, this.hue); // a previous rescue may still be flying off
    if (this.fallTime > FALL_RESCUE_DELAY) this.#beginRescue();
  }

  #beginRescue() {
    this.state = 'rescue';
    const frame = this.path.frameAt(this.lastSafeS, this.frame);
    const dropoff = this.path.pointAt(this.lastSafeS, 0, 0, new THREE.Vector3(), frame);
    const dropQuat = this.#roadQuaternion(frame, 0, new THREE.Quaternion());
    this.rescuer.begin(this.model, dropoff, dropQuat, frame.normal);
  }

  #updateRescue(dt) {
    this.speed *= Math.max(0, 1 - dt * 3); // wheels spin down while carried
    this.model.animate(dt, { speed: this.speed, steer: 0, drift: 0, boost: 0, hue: this.hue });
    if (this.rescuer.update(dt, this.model, this.hue)) {
      this.respawn({ keepRescuer: true });
      this.speed = LANDING_SPEED;
    }
  }

  /** Where a rescued kart is heading back to (camera uses this). */
  get rescueTargetS() {
    return this.lastSafeS;
  }

  /** Put the kart back on the road at the last safe spot, at once. */
  respawn({ keepRescuer = false } = {}) {
    if (!keepRescuer) this.rescuer.cancel();
    this.state = 'driving';
    this.s = this.lastSafeS;
    this.lateral = 0;
    this.speed = 0;
    this.heading = 0;
    this.steer = 0;
    this.lateralVel = 0;
    this.respawnFlash = keepRescuer ? 0.5 : 1.2;
    this.syncModel();
  }
}
