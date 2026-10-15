import * as THREE from 'three';
import { makeRandom } from '../core/prng.js';
import { TrackFrame } from './TrackPath.js';
import { createSlatMaterial, createRailMaterial } from './slatShader.js';

export const SLAT_LENGTH = 4; // world units along the track per slat row
const ROW_GAP = 0.32; // void between slat rows
const TILE_GAP = 0.26; // void between tiles across a row

/**
 * Builds the visible road from a TrackPath: slat tiles grouped per video stream,
 * glowing edge rails, and the start gate.
 */
export class TrackMesh extends THREE.Group {
  /**
   * @param {import('./TrackPath.js').TrackPath} path
   * @param {object} opts
   * @param {THREE.Texture[]} opts.textures one texture per video stream
   * @param {number} opts.tilesAcross
   * @param {number} opts.slatsPerRainbow rows per full hue cycle
   * @param {object} opts.shared shared slat uniforms
   * @param {boolean} opts.rails
   */
  constructor(path, { textures, tilesAcross, slatsPerRainbow, shared, rails }) {
    super();
    this.path = path;
    this.shared = shared;
    this.tilesAcross = tilesAcross;
    this.slatsPerRainbow = Math.max(1, slatsPerRainbow);
    this.slatMeshes = [];
    this.railMeshes = [];

    this.rows = Math.max(8, Math.round(path.length / SLAT_LENGTH));
    this.rowLength = path.length / this.rows;
    const tileWidth = (path.width - TILE_GAP * (tilesAcross - 1)) / tilesAcross;
    shared.uTileSize.value.set(tileWidth, this.rowLength - ROW_GAP);

    this.#buildSlats(textures);
    this.#buildRails(rails);
    this.#buildGate();
  }

  /** Swap the stream textures (e.g. a new folder was chosen or the pool was resized). */
  setTextures(textures) {
    const n = this.slatMeshes.length;
    for (let i = 0; i < n; i++) {
      const tex = textures[i % textures.length];
      this.slatMeshes[i].material.uniforms.uMap.value = tex;
    }
  }

  /** Per-frame: push each stream's aspect ratio into its material. */
  updateAspects(aspects) {
    const n = this.slatMeshes.length;
    for (let i = 0; i < n; i++) {
      this.slatMeshes[i].material.uniforms.uVideoAspect.value = aspects[i % aspects.length] || 16 / 9;
    }
  }

  setRails(enabled) {
    for (const m of this.railMeshes) {
      this.remove(m);
      m.geometry.dispose();
    }
    this.railMeshes = [];
    this.#buildRails(enabled);
  }

  dispose() {
    this.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m.map && m.map.isCanvasTexture) m.map.dispose();
          m.dispose();
        }
      }
    });
  }

  /* ------------------------------------------------------------------ */

  #buildSlats(textures) {
    const { path, rows, rowLength, tilesAcross } = this;
    const slotCount = textures.length;
    const rnd = makeRandom(path.seed ^ 0x5bd1e995);

    // One geometry per video stream; tiles are dealt out so neighbours differ.
    const buckets = Array.from({ length: slotCount }, () => ({ pos: [], uv: [], hue: [], rand: [], idx: [] }));

    const f0 = new TrackFrame();
    const f1 = new TrackFrame();
    const corner = new THREE.Vector3();
    const halfW = path.halfWidth;
    const tileWidth = (path.width - TILE_GAP * (tilesAcross - 1)) / tilesAcross;

    for (let r = 0; r < rows; r++) {
      const s0 = r * rowLength + ROW_GAP / 2;
      const s1 = (r + 1) * rowLength - ROW_GAP / 2;
      path.frameAt(s0, f0);
      path.frameAt(s1, f1);
      const rowOffset = Math.floor(rnd.next() * slotCount);

      for (let c = 0; c < tilesAcross; c++) {
        const l0 = -halfW + c * (tileWidth + TILE_GAP);
        const l1 = l0 + tileWidth;
        const slot = (r * tilesAcross + c + rowOffset) % slotCount;
        const b = buckets[slot];
        const base = b.pos.length / 3;

        // 4 corners: (s0,l0) (s0,l1) (s1,l1) (s1,l0)
        pushCorner(b, path, f0, l0, corner, 0, 0);
        pushCorner(b, path, f0, l1, corner, 1, 0);
        pushCorner(b, path, f1, l1, corner, 1, 1);
        pushCorner(b, path, f1, l0, corner, 0, 1);

        // Rainbow runs along the track; tiles across a row are offset a little.
        const hue = r / this.slatsPerRainbow + c * (0.06 / tilesAcross) + rnd.next() * 0.015;
        const rand = rnd.next();
        for (let k = 0; k < 4; k++) {
          b.hue.push(hue);
          b.rand.push(rand);
        }
        b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }

    for (let i = 0; i < slotCount; i++) {
      const b = buckets[i];
      if (b.idx.length === 0) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      geo.setAttribute('aHue', new THREE.Float32BufferAttribute(b.hue, 1));
      geo.setAttribute('aRand', new THREE.Float32BufferAttribute(b.rand, 1));
      geo.setIndex(b.idx);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, createSlatMaterial(textures[i], this.shared));
      mesh.frustumCulled = false; // the track surrounds the camera; culling buys nothing
      mesh.userData.slot = i;
      this.add(mesh);
      this.slatMeshes.push(mesh);
    }
  }

  #buildRails(enabled) {
    const height = enabled ? 1.2 : 0.26;
    const opacity = enabled ? 0.5 : 0.9;
    for (const side of [-1, 1]) {
      const geo = buildRailGeometry(this.path, side, height, this.rowLength * this.slatsPerRainbow);
      const mat = createRailMaterial(this.shared);
      mat.uniforms.uOpacity.value = opacity;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      this.add(mesh);
      this.railMeshes.push(mesh);
    }
  }

  #buildGate() {
    const { path } = this;
    const frame = path.frameAt(0);
    const gate = new THREE.Group();

    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0x15102a,
      emissive: 0x6a3cff,
      emissiveIntensity: 0.45,
      roughness: 0.35,
      metalness: 0.6,
    });
    const pillarGeo = new THREE.CylinderGeometry(0.28, 0.4, 9, 10);
    const h = 9;
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(pillarGeo, pillarMat);
      pillar.position.set(side * (path.halfWidth + 1.1), h / 2, 0);
      gate.add(pillar);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 10), pillarMat);
      cap.position.set(side * (path.halfWidth + 1.1), h + 0.4, 0);
      gate.add(cap);
    }

    const beamTex = makeCheckerTexture(16, 2);
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(path.width + 2.2, 1.6, 0.6),
      new THREE.MeshBasicMaterial({ map: beamTex }),
    );
    beam.position.set(0, h - 0.4, 0);
    gate.add(beam);

    // Orient: x = right, y = normal, z = right × normal (= -tangent)
    const m = new THREE.Matrix4().makeBasis(
      frame.right,
      frame.normal,
      new THREE.Vector3().crossVectors(frame.right, frame.normal),
    );
    gate.quaternion.setFromRotationMatrix(m);
    gate.position.copy(frame.position);
    this.add(gate);
    this.gate = gate;

    // Checkered start line on the road itself.
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(path.width, 1.6),
      new THREE.MeshBasicMaterial({ map: makeCheckerTexture(14, 2), transparent: true, opacity: 0.95 }),
    );
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.03, 0);
    gate.add(line);
  }
}

function pushCorner(bucket, path, frame, lateral, tmp, u, v) {
  path.pointAt(frame.s, lateral, 0, tmp, frame);
  bucket.pos.push(tmp.x, tmp.y, tmp.z);
  bucket.uv.push(u, v);
}

function buildRailGeometry(path, side, height, rainbowLength) {
  const step = 2;
  const n = Math.ceil(path.length / step);
  const pos = [];
  const uv = [];
  const hue = [];
  const idx = [];
  const f = new TrackFrame();
  const p = new THREE.Vector3();
  const lateral = side * (path.halfWidth + 0.12);

  for (let i = 0; i <= n; i++) {
    const s = (i / n) * path.length;
    path.frameAt(s, f);
    path.pointAt(s, lateral, -0.05, p, f);
    pos.push(p.x, p.y, p.z);
    path.pointAt(s, lateral, height, p, f);
    pos.push(p.x, p.y, p.z);
    uv.push(i / n, 0, i / n, 1);
    const hh = s / rainbowLength;
    hue.push(hh, hh);
    if (i < n) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aHue', new THREE.Float32BufferAttribute(hue, 1));
  geo.setIndex(idx);
  return geo;
}

function makeCheckerTexture(cols, rows) {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = cols * size;
  canvas.height = rows * size;
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#d9d4ee' : '#120c22';
      ctx.fillRect(x * size, y * size, size, size);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
