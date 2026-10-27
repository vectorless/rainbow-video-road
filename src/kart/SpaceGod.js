import * as THREE from 'three';

const HOVER = 6.5; // how far above the kart the god floats while carrying it
const HANG = 3.2; // kart hangs this far below the god's hands

// Rescue timeline (seconds from the start of the rescue)
const ARRIVE = 0.55; // swoop down to the fallen kart
const LIFT = 0.65; // beam it up
const CARRY = 1.3; // fly it back over the road
const LOWER = 0.55; // set it down
const DEPART = 0.9; // fly off after letting go
export const RESCUE_SECONDS = ARRIVE + LIFT + CARRY + LOWER;

const smooth = (t) => t * t * (3 - 2 * t);
const clamp01 = (t) => Math.min(1, Math.max(0, t));

/**
 * A cosmic figure that swoops in when a kart falls off the road, beams it up,
 * carries it back to the last safe spot and puts it down. Built from primitives
 * (emissive, so bloom makes it glow); no lights, so showing and hiding it never
 * changes the scene's light count.
 *
 * Driven by its kart: `begin()` when the kart has fallen, then `update()` every
 * frame, which also moves the kart's model and tells the kart when to let go.
 */
export class SpaceGod extends THREE.Group {
  constructor() {
    super();
    this.visible = false;
    this.active = false; // anything on screen (rescuing or departing)
    this.phase = 'idle'; // 'idle' | 'rescue' | 'depart'
    this.t = 0;

    const figure = new THREE.Group();
    this.figure = figure;
    this.add(figure);

    this.materials = [];
    const mat = (params, Ctor = THREE.MeshStandardMaterial) => {
      const m = new Ctor({ transparent: true, ...params });
      m.userData.baseOpacity = params.opacity ?? 1;
      this.materials.push(m);
      return m;
    };

    // robe: a tall cone that fades into space at the hem
    const robeMat = mat({ color: 0x2a0f5c, emissive: 0x5b2bd6, emissiveIntensity: 0.9, roughness: 0.6, opacity: 0.92 });
    const robe = new THREE.Mesh(new THREE.ConeGeometry(1.5, 4.2, 20, 1, true), robeMat);
    robe.position.y = 1.0;
    robe.rotation.x = Math.PI; // wide end down
    figure.add(robe);

    // head
    const head = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.95, 2),
      mat({ color: 0xfff2d0, emissive: 0xffd27a, emissiveIntensity: 1.6, roughness: 0.3 }),
    );
    head.position.y = 3.7;
    figure.add(head);
    const eyeMat = mat({ color: 0xffffff, emissive: 0x7ff6ff, emissiveIntensity: 4 }, THREE.MeshStandardMaterial);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), eyeMat);
      // eyes look forward and down, at whoever is in the beam
      eye.position.set(side * 0.34, 3.55, -0.82);
      figure.add(eye);
    }

    // halo
    const haloMat = mat({ color: 0xff3cac, emissive: 0xff3cac, emissiveIntensity: 3.5 });
    this.haloMat = haloMat;
    const halo = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.09, 8, 40), haloMat);
    halo.position.y = 5.0;
    halo.rotation.x = Math.PI / 2;
    figure.add(halo);
    this.halo = halo;

    // arms reaching down, hands together below the robe
    const armMat = mat({ color: 0x3a1a7a, emissive: 0x7b4bff, emissiveIntensity: 1.0, roughness: 0.5 });
    const handMat = mat({ color: 0xfff2d0, emissive: 0xffd27a, emissiveIntensity: 1.8 });
    this.arms = [];
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.9, 2.7, 0);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 2.6, 10), armMat);
      arm.position.y = -1.3;
      shoulder.add(arm);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 10), handMat);
      hand.position.y = -2.7;
      shoulder.add(hand);
      figure.add(shoulder);
      this.arms.push({ shoulder, side });
    }

    // tractor beam from the hands down to the kart
    const beamMat = mat(
      { color: 0x9be8ff, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide },
      THREE.MeshBasicMaterial,
    );
    this.beamMat = beamMat;
    const beamGeo = new THREE.CylinderGeometry(0.35, 1.7, 1, 24, 1, true);
    beamGeo.translate(0, -0.5, 0); // top at the origin, extends down 1 unit (scaled to length)
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.y = 0;
    this.beam = beam;
    this.add(beam);

    this.pickup = new THREE.Vector3(); // where the god grabs the kart
    this.dropoff = new THREE.Vector3(); // road point the kart goes back to
    this.dropQuat = new THREE.Quaternion(); // kart orientation on the road there
    this.dropUp = new THREE.Vector3(0, 1, 0);
    this.kartStart = new THREE.Vector3();
    this.kartQuatStart = new THREE.Quaternion();
    this.entry = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this.fade = 0;
  }

  /**
   * Start a rescue of a kart model that has fallen.
   * @param {THREE.Object3D} kartModel
   * @param {THREE.Vector3} dropoff road position to put it back on
   * @param {THREE.Quaternion} dropQuat its orientation there
   * @param {THREE.Vector3} dropUp road normal there
   */
  begin(kartModel, dropoff, dropQuat, dropUp) {
    this.phase = 'rescue';
    this.active = true;
    this.visible = true;
    this.t = 0;
    this.dropoff.copy(dropoff);
    this.dropQuat.copy(dropQuat);
    this.dropUp.copy(dropUp);
    this.kartStart.copy(kartModel.position);
    this.kartQuatStart.copy(kartModel.quaternion);
    this.pickup.copy(kartModel.position).y += HOVER;
    // swoop in from high above, behind the drop point so it reads as coming from the road side
    this.entry.copy(this.pickup).lerp(dropoff, 0.3).y += 40;
    this.position.copy(this.entry);
    this.fade = 0;
    this.#face(this.pickup, dropoff);
  }

  /** Stop at once (kart reset, track rebuilt, …). */
  cancel() {
    this.phase = 'idle';
    this.active = false;
    this.visible = false;
  }

  /**
   * Advance the animation; while rescuing, also places `kartModel`.
   * @returns {boolean} true on the frame the kart should be released onto the road
   */
  update(dt, kartModel, hue = 0) {
    if (!this.active) return false;
    this.t += dt;
    const t = this.t;
    let release = false;

    this.halo.rotation.z += dt * 1.5;
    this.haloMat.emissive.setHSL((hue + t * 0.3) % 1, 0.9, 0.6);
    this.haloMat.color.copy(this.haloMat.emissive);
    this.beamMat.color.setHSL((hue + 0.5 + t * 0.5) % 1, 0.8, 0.65);
    this.figure.position.y = Math.sin(t * 2.4) * 0.15; // gentle hover bob

    let beam = 0; // beam strength 0..1
    let reach = 0; // arms 0 = hanging, 1 = reaching down to the kart

    if (this.phase === 'rescue') {
      this.fade = Math.min(1, this.fade + dt * 4);
      const tLift = t - ARRIVE;
      const tCarry = tLift - LIFT;
      const tLower = tCarry - CARRY;

      if (tLift < 0) {
        // arrive: swoop from the sky to above the kart, whose fall the beam catches
        const u = smooth(clamp01(t / ARRIVE));
        this.position.lerpVectors(this.entry, this.pickup, u);
        kartModel.position.copy(this.kartStart).y -= Math.sin(u * Math.PI * 0.5) * 0.8;
        beam = u * 0.6;
        reach = u;
      } else if (tCarry < 0) {
        // lift: beam the kart up under the hands and turn it upright
        const u = smooth(clamp01(tLift / LIFT));
        this.position.copy(this.pickup);
        const from = this._v.copy(this.kartStart).setY(this.kartStart.y - 0.8);
        kartModel.position.lerpVectors(from, this.#hangPoint(this.pickup, this.dropUp, new THREE.Vector3()), u);
        kartModel.quaternion.slerpQuaternions(this.kartQuatStart, this.dropQuat, u * 0.6);
        beam = Math.min(1, tLift / 0.15);
        reach = 1;
      } else if (tLower < 0) {
        // carry: arc over to above the drop point
        const u = smooth(clamp01(tCarry / CARRY));
        const above = this._v.copy(this.dropoff).addScaledVector(this.dropUp, HOVER + HANG);
        this.position.lerpVectors(this.pickup, above, u);
        this.position.y += Math.sin(u * Math.PI) * 6;
        this.#hangPoint(this.position, this.dropUp, kartModel.position);
        this._q.copy(this.kartQuatStart).slerp(this.dropQuat, 0.6);
        kartModel.quaternion.slerpQuaternions(this._q, this.dropQuat, u);
        this.#face(this.position, above);
        beam = 1;
        reach = 1;
      } else {
        // lower: the beam sets the kart down on the road
        const u = smooth(clamp01(tLower / LOWER));
        this.position.copy(this.dropoff).addScaledVector(this.dropUp, HOVER + HANG);
        const hang = this.#hangPoint(this.position, this.dropUp, this._v);
        kartModel.position.lerpVectors(hang, this.dropoff, u);
        kartModel.quaternion.copy(this.dropQuat);
        beam = 1 - smooth(clamp01((tLower - LOWER * 0.6) / (LOWER * 0.4)));
        reach = 1 - u * 0.5;
        if (tLower >= LOWER) {
          release = true;
          this.phase = 'depart';
          this.t = 0;
          this.entry.copy(this.position); // depart from here
        }
      }
    } else if (this.phase === 'depart') {
      // rise up and away, fading out
      const u = clamp01(t / DEPART);
      this.position.copy(this.entry).addScaledVector(this.dropUp, u * u * 30);
      this.fade = 1 - u;
      reach = 0.5 * (1 - u);
      if (u >= 1) this.cancel();
    }

    for (const { shoulder, side } of this.arms) {
      // hanging: arms out to the side; reaching: straight down, hands together
      shoulder.rotation.z = side * THREE.MathUtils.lerp(0.55, 0.18, reach);
      shoulder.rotation.x = THREE.MathUtils.lerp(-0.25, 0.15, reach);
    }

    // beam from the hands down to the kart
    const hands = this.figure.position.y - 0.2;
    const length = Math.max(0.01, this.position.y + hands - kartModel.position.y);
    this.beam.position.y = hands;
    this.beam.scale.set(1, length, 1);
    this.beam.visible = beam > 0.01;
    this.beamMat.opacity = 0.35 * beam * this.fade;

    for (const m of this.materials) {
      if (m === this.beamMat) continue;
      m.opacity = m.userData.baseOpacity * this.fade;
    }
    return release;
  }

  /** Where a carried kart hangs below a god at `godPos`. */
  #hangPoint(godPos, up, out) {
    return out.copy(godPos).addScaledVector(up, -HANG);
  }

  /** Turn to face along the direction of travel (eyes are on -Z). */
  #face(from, to) {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    if (dx * dx + dz * dz > 0.01) this.rotation.y = Math.atan2(-dx, -dz);
  }
}
