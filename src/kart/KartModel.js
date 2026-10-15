import * as THREE from 'three';

/**
 * A chunky low-poly kart built from primitives. Local axes: forward = -Z, up = +Y.
 * Exposes the bits the driving code animates: wheels, front wheels (steer), body (tilt),
 * exhaust glow, and an under-glow light.
 */
export class KartModel extends THREE.Group {
  constructor({ color = 0xff3cac } = {}) {
    super();

    const body = new THREE.Group();
    this.body = body;
    this.add(body);

    const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1430, roughness: 0.6, metalness: 0.4 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xd8d8ff, roughness: 0.15, metalness: 0.9 });
    const glow = new THREE.MeshStandardMaterial({
      color: 0x2bd2ff,
      emissive: 0x2bd2ff,
      emissiveIntensity: 2.2,
      roughness: 0.3,
    });
    this.paint = paint;
    this.glow = glow;

    // chassis
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.35, 2.6), dark);
    chassis.position.y = 0.42;
    body.add(chassis);

    // main hull
    const hull = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.42, 2.0), paint);
    hull.position.set(0, 0.72, 0.05);
    body.add(hull);

    // nose
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.0, 4), paint);
    nose.rotation.x = -Math.PI / 2;
    nose.rotation.z = Math.PI / 4;
    nose.position.set(0, 0.68, -1.4);
    body.add(nose);

    // side pods
    for (const side of [-1, 1]) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.3, 1.3), paint);
      pod.position.set(side * 0.78, 0.6, 0.35);
      body.add(pod);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.37, 0.06, 1.0), glow);
      stripe.position.set(side * 0.78, 0.78, 0.3);
      body.add(stripe);
    }

    // seat + driver
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 0.35), dark);
    seat.position.set(0, 1.05, 0.75);
    body.add(seat);
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.34, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0xfff1a8, roughness: 0.25, metalness: 0.2 }),
    );
    helmet.position.set(0, 1.3, 0.45);
    body.add(helmet);
    const visor = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 16, 8, Math.PI * 1.15, Math.PI * 0.7, Math.PI * 0.35, Math.PI * 0.3),
      new THREE.MeshStandardMaterial({ color: 0x120a2a, roughness: 0.1, metalness: 0.8 }),
    );
    visor.position.copy(helmet.position);
    body.add(visor);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.45, 0.4), paint);
    torso.position.set(0, 0.95, 0.5);
    body.add(torso);

    // steering wheel
    const wheelRing = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.03, 8, 16), chrome);
    wheelRing.rotation.x = -Math.PI / 3;
    wheelRing.position.set(0, 1.05, 0.05);
    body.add(wheelRing);

    // rear spoiler
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.4), paint);
    spoiler.position.set(0, 1.25, 1.2);
    body.add(spoiler);
    for (const side of [-1, 1]) {
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.1), dark);
      strut.position.set(side * 0.6, 1.0, 1.2);
      body.add(strut);
    }
    const spoilerGlow = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.04, 0.06), glow);
    spoilerGlow.position.set(0, 1.25, 1.4);
    body.add(spoilerGlow);

    // exhausts
    this.exhausts = [];
    for (const side of [-1, 1]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.5, 10), chrome);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(side * 0.4, 0.55, 1.45);
      body.add(pipe);
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(0.11, 0.8, 8),
        new THREE.MeshBasicMaterial({ color: 0x9be8ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      flame.rotation.x = -Math.PI / 2;
      flame.position.set(side * 0.4, 0.55, 2.0);
      flame.scale.set(1, 0.001, 1);
      body.add(flame);
      this.exhausts.push(flame);
    }

    // wheels
    const tyre = new THREE.MeshStandardMaterial({ color: 0x14101f, roughness: 0.9 });
    const rim = new THREE.MeshStandardMaterial({ color: 0xffe36b, roughness: 0.3, metalness: 0.7 });
    this.wheels = [];
    this.frontWheels = [];
    const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.34, 16);
    wheelGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.36, 12);
    rimGeo.rotateZ(Math.PI / 2);
    for (const [x, z, front] of [
      [-0.82, -0.85, true],
      [0.82, -0.85, true],
      [-0.86, 0.95, false],
      [0.86, 0.95, false],
    ]) {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.36, z);
      const w = new THREE.Mesh(wheelGeo, tyre);
      const r = new THREE.Mesh(rimGeo, rim);
      pivot.add(w, r);
      this.add(pivot);
      this.wheels.push(pivot);
      if (front) this.frontWheels.push(pivot);
      pivot.userData.spin = new THREE.Group();
    }

    // under-glow
    const light = new THREE.PointLight(0xff3cac, 18, 14, 2);
    light.position.set(0, 0.3, 0);
    this.add(light);
    this.light = light;

    // shadow blob
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1.4, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    shadow.scale.set(1, 1.3, 1);
    this.add(shadow);
    this.shadow = shadow;

    this.spin = 0;
  }

  /**
   * @param {number} dt
   * @param {{ speed:number, steer:number, drift:number, boost:number, hue:number }} s
   */
  animate(dt, s) {
    this.spin += (s.speed / 0.36) * dt;
    for (const w of this.wheels) {
      w.rotation.x = this.spin;
    }
    for (const w of this.frontWheels) {
      w.rotation.y = -s.steer * 0.45;
      // keep spin visible after yaw: rotate order yaw then roll
      w.rotation.order = 'YXZ';
    }
    // body lean + slight bounce
    this.body.rotation.z = THREE.MathUtils.lerp(this.body.rotation.z, -s.steer * 0.12 - s.drift * 0.05, Math.min(1, dt * 10));
    this.body.rotation.x = THREE.MathUtils.lerp(this.body.rotation.x, -s.boost * 0.05, Math.min(1, dt * 6));

    // exhaust flames scale with speed / boost
    const flame = Math.min(1, s.speed / 40) * 0.6 + s.boost * 1.6;
    for (const f of this.exhausts) {
      f.scale.set(1, Math.max(0.001, flame * (0.8 + 0.4 * Math.random())), 1);
    }

    // under-glow hue cycles with the road
    this.light.color.setHSL(s.hue, 0.9, 0.6);
    this.light.intensity = 14 + s.boost * 30;
    this.glow.emissive.setHSL(s.hue + 0.5, 0.9, 0.6);
    this.glow.color.copy(this.glow.emissive);
  }
}
