import * as THREE from 'three';

/**
 * Things that bolt onto any kart model while an item is active: a shield bubble and
 * a pair of side-mounted laser cannons (shown while the kart holds a laser). Sized
 * from the model's bounding box, so it fits the built-in kart and imported ones.
 * Emissive only, no lights.
 */
export class KartGear extends THREE.Group {
  constructor(model) {
    super();
    // measure the kart itself, not its (wider) shadow blob
    const shadow = model.shadow;
    if (shadow) model.remove(shadow);
    const box = new THREE.Box3().setFromObject(model);
    if (shadow) model.add(shadow);
    const size = box.getSize(new THREE.Vector3());
    const halfW = Math.max(0.8, size.x / 2);
    const len = Math.max(2.4, size.z);
    const height = Math.max(1.2, size.y);

    // shield: a soft additive bubble round the whole kart
    this.shieldMat = new THREE.MeshBasicMaterial({
      color: 0x8f7bff,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const bubble = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), this.shieldMat);
    bubble.scale.set(halfW + 0.7, height * 0.75 + 0.4, len / 2 + 0.6);
    bubble.position.y = height * 0.45;
    bubble.visible = false;
    this.bubble = bubble;
    this.add(bubble);

    // laser cannons: one each side, a barrel with a glowing tip
    this.laserMat = new THREE.MeshStandardMaterial({ color: 0x1a1430, metalness: 0.6, roughness: 0.35 });
    this.tipMat = new THREE.MeshBasicMaterial({ color: 0xff2a6d });
    this.cannons = new THREE.Group();
    const barrelGeo = new THREE.CylinderGeometry(0.12, 0.16, 1.4, 10);
    barrelGeo.rotateX(Math.PI / 2);
    const tipGeo = new THREE.SphereGeometry(0.15, 10, 8);
    this.muzzles = [];
    for (const side of [-1, 1]) {
      const mount = new THREE.Group();
      mount.position.set(side * (halfW + 0.12), Math.min(0.75, height * 0.4), -len * 0.15);
      mount.userData.z = mount.position.z;
      const barrel = new THREE.Mesh(barrelGeo, this.laserMat);
      const tip = new THREE.Mesh(tipGeo, this.tipMat);
      tip.position.z = -0.75;
      mount.add(barrel, tip);
      this.cannons.add(mount);
      this.muzzles.push(tip);
    }
    this.cannons.visible = false;
    this.add(this.cannons);

    this.time = 0;
    this.recoil = 0;
  }

  /** Where the beams start, in world space (midpoint of the two muzzles). */
  muzzleWorld(out) {
    const a = this.muzzles[0].getWorldPosition(_a);
    const b = this.muzzles[1].getWorldPosition(_b);
    return out.copy(a).add(b).multiplyScalar(0.5);
  }

  fired() {
    this.recoil = 1;
  }

  /**
   * @param {number} dt
   * @param {{ shield:number, laser:boolean, hue:number }} s shield = seconds left
   */
  update(dt, s) {
    this.time += dt;
    const shielded = s.shield > 0;
    this.bubble.visible = shielded;
    if (shielded) {
      // pulse, and flicker in the last second to warn it's running out
      const ending = s.shield < 1 && Math.floor(s.shield * 10) % 2 === 0;
      this.shieldMat.opacity = ending ? 0.08 : 0.22 + Math.sin(this.time * 8) * 0.08;
      this.shieldMat.color.setHSL((0.72 + Math.sin(this.time * 2) * 0.08) % 1, 0.9, 0.6);
      this.bubble.rotation.y += dt * 0.8;
    }
    this.cannons.visible = s.laser;
    if (s.laser) {
      this.recoil = Math.max(0, this.recoil - dt * 6);
      for (const m of this.cannons.children) m.position.z = m.userData.z + this.recoil * 0.25;
      this.tipMat.color.setHSL(0.95, 1, 0.5 + Math.sin(this.time * 12) * 0.15 + this.recoil * 0.3);
    }
  }
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
