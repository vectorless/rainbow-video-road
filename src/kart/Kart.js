import * as THREE from 'three';
import { TrackFrame } from '../track/TrackPath.js';
import { KartModel } from './KartModel.js';

export const MAX_SPEED = 64; // world units / s at full throttle, no boost
const ACCEL = 30;
const DRAG = ACCEL / MAX_SPEED; // so terminal velocity == MAX_SPEED
const BRAKE = 55;
const REVERSE_MAX = 16;
const KART_HALF_WIDTH = 0.95;
const FALL_RESPAWN_SECONDS = 2.2;

/**
 * Arcade kart that lives in track space: a distance `s` along the path and a
 * lateral offset from the centreline. Steering changes the heading angle relative
 * to the road, which converts speed into lateral motion. Falling off switches to a
 * free-fall ballistic state until the kart is put back on the road.
 */
export class Kart {
  constructor(path) {
    this.path = path;
    this.model = new KartModel();
    this.frame = new TrackFrame();

    this.state = 'driving'; // 'driving' | 'falling'
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

    this._tmpM = new THREE.Matrix4();
    this._tmpQ = new THREE.Quaternion();
    this._tmpV = new THREE.Vector3();
  }

  reset(s = 0) {
    this.state = 'driving';
    this.s = s;
    this.lateral = 0;
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
    this.model.scale.setScalar(1);
    this.model.visible = true;
    this.syncModel();
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

    const path = this.path;
    const throttle = controlsEnabled ? input.throttle : 0;
    const steerIn = controlsEnabled ? input.steer : 0;
    const driftIn = controlsEnabled && input.drift;

    // --- longitudinal
    const boosting = this.boost > 0;
    if (boosting) this.boost -= dt;
    const maxSpeed = MAX_SPEED * (boosting ? 1.35 : 1);
    const accel = ACCEL * (boosting ? 1.8 : 1);

    if (throttle > 0) {
      this.speed += throttle * accel * dt;
    } else if (throttle < 0) {
      if (this.speed > 0.5) this.speed += throttle * BRAKE * dt;
      else this.speed = Math.max(-REVERSE_MAX, this.speed + throttle * ACCEL * 0.6 * dt);
    }
    // drag (quadratic-ish feel: stronger near the top)
    const dragCoef = DRAG * (this.drifting ? 1.25 : 1);
    this.speed -= this.speed * dragCoef * dt;
    if (this.speed > maxSpeed) this.speed = THREE.MathUtils.lerp(this.speed, maxSpeed, Math.min(1, dt * 3));
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
    this.model.visible = this.respawnFlash <= 0 || Math.floor(this.respawnFlash * 12) % 2 === 0;
  }

  /** Put the model where track-space says it is. */
  syncModel() {
    const frame = this.path.frameAt(this.s, this.frame);
    const m = this.model;
    this.path.pointAt(this.s, this.lateral, 0, m.position, frame);

    // basis: x = right, y = normal, z = right × normal (= backwards)
    const z = this._tmpV.crossVectors(frame.right, frame.normal);
    this._tmpM.makeBasis(frame.right, frame.normal, z);
    m.quaternion.setFromRotationMatrix(this._tmpM);
    // yaw by heading (+ a bit of drift exaggeration)
    const yaw = -(this.heading + (this.drifting ? this.driftDir * 0.25 : 0));
    this._tmpQ.setFromAxisAngle(frame.normal, yaw);
    m.quaternion.premultiply(this._tmpQ);
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
  }

  #updateFalling(dt) {
    this.fallTime += dt;
    this.fallVelocity.y -= 38 * dt;
    this.model.position.addScaledVector(this.fallVelocity, dt);
    this.model.rotateX(dt * 1.2);
    this.model.rotateZ(dt * 0.8);
    this.model.animate(dt, { speed: this.speed, steer: 0, drift: 0, boost: 0, hue: this.hue });
    if (this.fallTime > FALL_RESPAWN_SECONDS) {
      this.respawn();
    }
  }

  respawn() {
    this.state = 'driving';
    this.s = this.lastSafeS;
    this.lateral = 0;
    this.speed = 0;
    this.heading = 0;
    this.steer = 0;
    this.lateralVel = 0;
    this.respawnFlash = 1.2;
    this.syncModel();
  }
}
