import * as THREE from 'three';
import { ITEM_TYPES } from '../track/trackItems.js';

/**
 * Meshes for track items. Each builder returns a Group in road-local axes
 * (x = right, y = road normal, -z = forward, origin on the road surface); its
 * `userData.animate(dt, time, hue)` spins / bobs / recolours it. Geometry and most
 * materials are shared between all items of a type (they're created on first use).
 */

const shared = {};
const once = (key, make) => shared[key] || (shared[key] = make());

function questionTexture() {
  return once('qtex', () => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.font = '900 104px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 10;
    g.strokeStyle = 'rgba(20, 8, 40, 0.9)';
    g.strokeText('?', 64, 70);
    g.fillStyle = '#ffffff';
    g.fillText('?', 64, 70);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

function mudTexture() {
  return once('mudtex', () => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 10, 64, 64, 64);
    grad.addColorStop(0, 'rgba(92, 56, 26, 1)');
    grad.addColorStop(0.75, 'rgba(70, 42, 20, 0.95)');
    grad.addColorStop(1, 'rgba(60, 36, 18, 0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    // wet blotches
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 26; i++) {
      const x = 20 + rnd() * 88;
      const y = 20 + rnd() * 88;
      g.fillStyle = rnd() < 0.5 ? 'rgba(40, 22, 10, 0.55)' : 'rgba(140, 96, 52, 0.35)';
      g.beginPath();
      g.ellipse(x, y, 4 + rnd() * 10, 3 + rnd() * 7, rnd() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

const BUILDERS = {
  itembox() {
    const g = new THREE.Group();
    const spin = new THREE.Group();
    spin.position.y = 1.4;
    g.add(spin);
    const mat = once('box-mat', () => new THREE.MeshBasicMaterial({ color: 0xff3cac, transparent: true, opacity: 0.4, depthWrite: false }));
    const box = new THREE.Mesh(once('box-geo', () => new THREE.BoxGeometry(1.5, 1.5, 1.5)), mat);
    const edges = new THREE.LineSegments(
      once('box-edges', () => new THREE.EdgesGeometry(new THREE.BoxGeometry(1.5, 1.5, 1.5))),
      once('box-edge-mat', () => new THREE.LineBasicMaterial({ color: 0xffffff })),
    );
    spin.add(box, edges);
    const q = new THREE.Sprite(once('q-mat', () => new THREE.SpriteMaterial({ map: questionTexture(), depthWrite: false })));
    q.scale.setScalar(1.1);
    q.position.y = 1.4;
    g.add(q);
    g.userData.animate = (dt, t, hue) => {
      spin.rotation.y += dt * 1.2;
      spin.rotation.x = Math.sin(t * 0.9) * 0.4;
      spin.position.y = q.position.y = 1.4 + Math.sin(t * 2.2) * 0.15;
      mat.color.setHSL((hue + t * 0.25) % 1, 0.95, 0.6);
    };
    return g;
  },

  boost() {
    const g = new THREE.Group();
    const orb = new THREE.Mesh(
      once('boost-geo', () => new THREE.SphereGeometry(0.6, 20, 14)),
      once('boost-mat', () => new THREE.MeshBasicMaterial({ color: 0x8ff3ff })),
    );
    const ring = new THREE.Mesh(
      once('boost-ring', () => new THREE.TorusGeometry(0.95, 0.07, 8, 32)),
      once('boost-ring-mat', () => new THREE.MeshBasicMaterial({ color: 0x2bd2ff })),
    );
    orb.position.y = ring.position.y = 1.2;
    g.add(orb, ring);
    g.userData.animate = (dt, t) => {
      ring.rotation.y += dt * 3;
      ring.rotation.x = Math.PI / 2 + Math.sin(t * 3) * 0.5;
      const bob = 1.2 + Math.sin(t * 3) * 0.12;
      orb.position.y = ring.position.y = bob;
      orb.scale.setScalar(1 + Math.sin(t * 9) * 0.08);
    };
    return g;
  },

  shield() {
    const g = new THREE.Group();
    const shell = new THREE.Mesh(
      once('shield-geo', () => new THREE.IcosahedronGeometry(0.8, 1)),
      once('shield-mat', () => new THREE.MeshBasicMaterial({ color: 0xb0a2ff, wireframe: true })),
    );
    const core = new THREE.Mesh(
      once('shield-core', () => new THREE.SphereGeometry(0.42, 16, 12)),
      once('shield-core-mat', () => new THREE.MeshBasicMaterial({ color: 0x8f7bff, transparent: true, opacity: 0.8 })),
    );
    shell.position.y = core.position.y = 1.25;
    g.add(shell, core);
    g.userData.animate = (dt, t) => {
      shell.rotation.y += dt * 1.5;
      shell.rotation.z += dt * 0.7;
      shell.position.y = core.position.y = 1.25 + Math.sin(t * 2.5) * 0.12;
    };
    return g;
  },

  coin() {
    const g = new THREE.Group();
    const coin = new THREE.Mesh(
      once('coin-geo', () => new THREE.CylinderGeometry(0.5, 0.5, 0.12, 24).rotateX(Math.PI / 2)),
      once(
        'coin-mat',
        () => new THREE.MeshStandardMaterial({ color: 0xffd24a, emissive: 0xffa000, emissiveIntensity: 0.7, metalness: 0.3, roughness: 0.3 }),
      ),
    );
    coin.position.y = 0.95;
    g.add(coin);
    g.userData.animate = (dt, t) => {
      coin.rotation.y += dt * 3.5;
      coin.position.y = 0.95 + Math.sin(t * 3) * 0.1;
    };
    return g;
  },

  block() {
    const g = new THREE.Group();
    const size = ITEM_TYPES.block.hitS * 2;
    const box = new THREE.Mesh(
      once('block-geo', () => new THREE.BoxGeometry(size, size, size)),
      once('block-mat', () => new THREE.MeshStandardMaterial({ color: 0x2a1450, emissive: 0x3b1080, emissiveIntensity: 0.6, roughness: 0.5, metalness: 0.4 })),
    );
    const edgeMat = once('block-edge-mat', () => new THREE.LineBasicMaterial({ color: 0xff3cac }));
    const edges = new THREE.LineSegments(once('block-edges', () => new THREE.EdgesGeometry(new THREE.BoxGeometry(size, size, size))), edgeMat);
    box.position.y = edges.position.y = size / 2;
    g.add(box, edges);
    g.userData.animate = (dt, t, hue) => {
      edgeMat.color.setHSL((hue + 0.85 + Math.sin(t) * 0.05) % 1, 1, 0.6);
    };
    return g;
  },

  cone() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      once('cone-geo', () => new THREE.ConeGeometry(0.5, 1.4, 18).translate(0, 0.8, 0)),
      once('cone-mat', () => new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff5a00, emissiveIntensity: 0.45, roughness: 0.5 })),
    );
    const stripe = new THREE.Mesh(
      once('cone-stripe', () => new THREE.CylinderGeometry(0.27, 0.33, 0.2, 18, 1, true).translate(0, 0.85, 0)),
      once('cone-stripe-mat', () => new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.5, side: THREE.DoubleSide })),
    );
    const base = new THREE.Mesh(
      once('cone-base', () => new THREE.BoxGeometry(1.1, 0.12, 1.1).translate(0, 0.06, 0)),
      once('cone-base-mat', () => new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.8 })),
    );
    g.add(body, stripe, base);
    g.userData.animate = () => {};
    return g;
  },

  mud() {
    const g = new THREE.Group();
    const patch = new THREE.Mesh(
      once('mud-geo', () => new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2)),
      once(
        'mud-mat',
        () =>
          new THREE.MeshStandardMaterial({
            map: mudTexture(),
            transparent: true,
            roughness: 0.35,
            metalness: 0.1,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
          }),
      ),
    );
    const { hitS, hitL } = ITEM_TYPES.mud;
    patch.scale.set(hitL * 1.1, 1, hitS * 1.05);
    patch.position.y = 0.05;
    patch.renderOrder = 1;
    g.add(patch);
    g.userData.animate = () => {};
    return g;
  },
};

/** A fresh mesh group for an item type. */
export function createItemMesh(type) {
  return BUILDERS[type]();
}

/** The laser beam: a glowing tube along `points` (world space), built per shot. */
export function createBeamMesh(points) {
  const curve = new THREE.CatmullRomCurve3(points);
  const geo = new THREE.TubeGeometry(curve, Math.max(4, points.length * 3), 0.18, 6, false);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff2a6d, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
  const core = new THREE.Mesh(geo, mat);
  const glowGeo = new THREE.TubeGeometry(curve, Math.max(4, points.length * 3), 0.55, 8, false);
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xff7aa8, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  const g = new THREE.Group();
  g.add(core, glow);
  g.userData.materials = [mat, glowMat];
  g.userData.dispose = () => {
    geo.dispose();
    glowGeo.dispose();
    mat.dispose();
    glowMat.dispose();
  };
  return g;
}
