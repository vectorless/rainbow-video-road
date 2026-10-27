import * as THREE from 'three';

/**
 * A kart built from an imported model (driver + kart in one static mesh). Same
 * interface and local axes as KartModel (forward = -Z, up = +Y, wheels on y = 0),
 * so a Kart can drive either. The mesh has no rig, so "animation" is body lean,
 * a little road bounce and the shadow blob.
 */
export class FigureKartModel extends THREE.Group {
  /**
   * @param {THREE.Object3D} source loaded model; it is cloned, so one load can serve several karts
   * @param {object} [opts]
   * @param {number} [opts.length] nose-to-tail length to scale the model to (world units)
   * @param {number} [opts.yaw] rotation that turns the model's forward into -Z
   */
  constructor(source, { length = 3.0, yaw = -Math.PI / 2 } = {}) {
    super();

    const body = new THREE.Group();
    this.body = body;
    this.add(body);

    // Normalise: face -Z, scale to `length`, sit the wheels on y = 0, centre on the origin.
    const fit = new THREE.Group();
    const mesh = source.clone(true);
    mesh.rotation.y = yaw;
    fit.add(mesh);
    const box = new THREE.Box3().setFromObject(fit);
    const size = box.getSize(new THREE.Vector3());
    const scale = length / size.z;
    fit.scale.setScalar(scale);
    const centre = box.getCenter(new THREE.Vector3());
    fit.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale);
    body.add(fit);
    this.halfWidth = (size.x * scale) / 2;

    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    shadow.scale.set(this.halfWidth * 1.3, length * 0.6, 1);
    this.add(shadow);
    this.shadow = shadow;

    this.bounce = Math.random() * Math.PI * 2;
  }

  /**
   * @param {number} dt
   * @param {{ speed:number, steer:number, drift:number, boost:number, hue:number }} s
   */
  animate(dt, s) {
    this.body.rotation.z = THREE.MathUtils.lerp(this.body.rotation.z, -s.steer * 0.1 - s.drift * 0.05, Math.min(1, dt * 10));
    this.body.rotation.x = THREE.MathUtils.lerp(this.body.rotation.x, -s.boost * 0.05, Math.min(1, dt * 6));
    this.bounce += dt * (6 + Math.abs(s.speed) * 0.4);
    this.body.position.y = Math.abs(Math.sin(this.bounce)) * Math.min(1, Math.abs(s.speed) / 20) * 0.04;
  }
}

/**
 * Imported models get no environment map here, so the fully metallic materials
 * the generator exports would render almost black. Cap the metalness.
 */
export function tameMaterials(root, maxMetalness = 0.3) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if ('metalness' in m) m.metalness = Math.min(m.metalness, maxMetalness);
    }
  });
  return root;
}
