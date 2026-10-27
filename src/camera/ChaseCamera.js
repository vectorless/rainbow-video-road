import * as THREE from 'three';
import { TrackFrame } from '../track/TrackPath.js';
import { MAX_SPEED } from '../kart/Kart.js';

const MODES = [
  { name: 'chase', back: 9.5, up: 3.6, lookAhead: 10, lookUp: 1.2, lateral: 0.35, speedPull: 2.5 },
  { name: 'far', back: 15, up: 6.5, lookAhead: 14, lookUp: 1.0, lateral: 0.2, speedPull: 3 },
  { name: 'hood', back: -0.7, up: 1.8, lookAhead: 30, lookUp: 0.6, lateral: 1.0, speedPull: 0 },
];

/**
 * Camera that rides the track frame behind the kart (so it banks with the road),
 * smoothed, with a speed-sensitive field of view. Also provides the slow fly-over
 * used by the menu / attract mode.
 */
export class ChaseCamera {
  constructor(camera, path) {
    this.camera = camera;
    this.path = path;
    this.modeIndex = 0;
    this.frame = new TrackFrame();
    this.pos = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.desiredPos = new THREE.Vector3();
    this.desiredTarget = new THREE.Vector3();
    this.baseFov = 68;
    this.flyS = 0;
    this.snap = true;
  }

  setPath(path) {
    this.path = path;
    this.snap = true;
  }

  get mode() {
    return MODES[this.modeIndex];
  }

  nextMode() {
    this.modeIndex = (this.modeIndex + 1) % MODES.length;
    this.snap = true;
    return this.mode.name;
  }

  /** Follow the kart. */
  follow(kart, dt) {
    const mode = this.mode;
    const path = this.path;
    const speedRatio = THREE.MathUtils.clamp(Math.abs(kart.speed) / MAX_SPEED, 0, 1);

    if (kart.state === 'falling') {
      // keep looking at the tumbling kart from where we were, drifting gently upward
      this.desiredTarget.copy(kart.position);
      this.desiredPos.y += dt * 1.5;
      this.#apply(dt, 2.5);
      return;
    }
    if (kart.state === 'rescue') {
      // drift back to a high spot behind the drop point, watching the kart being carried
      const s = kart.rescueTargetS - mode.back * 1.4;
      path.pointAt(s, 0, mode.up + 5, this.desiredPos, path.frameAt(s, this.frame));
      // aim between the kart and the god so both stay in frame
      this.desiredTarget.copy(kart.position).lerp(kart.rescuer.position, 0.35);
      this.up.lerp(this.frame.normal, Math.min(1, dt * 2)).normalize();
      this.#apply(dt, 1.6);
      return;
    }

    // camera sits behind the kart along the track frame, a little further back the faster we go
    const back = mode.back + speedRatio * mode.speedPull;
    const camS = kart.s - back;
    const frame = path.frameAt(camS, this.frame);
    const camLateral = kart.lateral * mode.lateral;
    path.pointAt(camS, camLateral, mode.up, this.desiredPos, frame);

    const lookS = kart.s + mode.lookAhead;
    const lookFrame = path.frameAt(lookS, this.frame);
    path.pointAt(lookS, kart.lateral * 0.6, mode.lookUp, this.desiredTarget, lookFrame);

    // frame normal as up so banking tilts the view (smoothed)
    const upTarget = path.frameAt(kart.s, this.frame).normal;
    this.up.lerp(upTarget, this.snap ? 1 : Math.min(1, dt * 4)).normalize();

    const fovTarget = this.baseFov + speedRatio * 14 + kart.boostLevel * 10;
    this.camera.fov += (fovTarget - this.camera.fov) * Math.min(1, dt * 4);
    this.camera.updateProjectionMatrix();

    this.#apply(dt, mode.name === 'hood' ? 30 : 8);
  }

  /** Slow fly-over of the track for the menu. */
  flyOver(dt, time) {
    const path = this.path;
    this.flyS = path.wrap(this.flyS + dt * 22);
    const frame = path.frameAt(this.flyS, this.frame);
    const sway = Math.sin(time * 0.35) * 4;
    path.pointAt(this.flyS, sway, 7 + Math.sin(time * 0.5) * 1.5, this.desiredPos, frame);
    const lookFrame = path.frameAt(this.flyS + 26, this.frame);
    path.pointAt(this.flyS + 26, 0, 0.5, this.desiredTarget, lookFrame);
    this.up.lerp(frame.normal, this.snap ? 1 : Math.min(1, dt * 2)).normalize();
    this.camera.fov += (62 - this.camera.fov) * Math.min(1, dt * 2);
    this.camera.updateProjectionMatrix();
    this.#apply(dt, 3);
  }

  #apply(dt, stiffness) {
    if (this.snap) {
      this.pos.copy(this.desiredPos);
      this.target.copy(this.desiredTarget);
      this.snap = false;
    } else {
      const k = 1 - Math.exp(-dt * stiffness);
      this.pos.lerp(this.desiredPos, k);
      this.target.lerp(this.desiredTarget, Math.min(1, k * 1.5));
    }
    this.camera.position.copy(this.pos);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.target);
  }
}
