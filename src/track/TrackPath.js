import * as THREE from 'three';
import { makeRandom } from '../core/prng.js';

const UP = new THREE.Vector3(0, 1, 0);
const MAX_BANK = THREE.MathUtils.degToRad(34);
const BANK_GAIN = 30; // radians of bank per unit of signed curvature (before clamping)

export const TRACK_FORMAT_VERSION = 1;
export const DEFAULT_WIDTH = 14;
export const MIN_POINTS = 4;
export const MAX_POINTS = 64;

/**
 * A closed race line through space.
 *
 * The path is a centripetal Catmull-Rom spline through control points (either
 * procedurally generated from a seed, or authored in the track editor). We pre-sample
 * it once per world unit and store a moving frame (tangent, right, normal) at each
 * sample, with the frame rolled about the tangent to bank into turns. Everything else
 * (slats, rails, kart, camera) is positioned by `frameAt(s)`.
 */
export class TrackPath {
  /**
   * @param {THREE.Vector3[]} points control points (the spline passes through each)
   * @param {object} [opts]
   * @param {number} [opts.width]
   * @param {number} [opts.seed] used for slat/tile randomisation
   * @param {number} [opts.bankStrength] 0 = flat road, 1 = default auto-banking
   * @param {string} [opts.name]
   * @param {string} [opts.kind] informational ("loop", "figure8", "custom")
   */
  constructor(points, { width = DEFAULT_WIDTH, seed = 1, bankStrength = 1, name = '', kind = 'custom' } = {}) {
    if (!Array.isArray(points) || points.length < MIN_POINTS) {
      throw new Error(`A track needs at least ${MIN_POINTS} control points`);
    }
    this.points = points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    this.width = width;
    this.halfWidth = width / 2;
    this.seed = seed >>> 0;
    this.bankStrength = bankStrength;
    this.name = name;
    this.kind = kind;

    this.curve = new THREE.CatmullRomCurve3(this.points, true, 'centripetal', 0.5);
    this.curve.arcLengthDivisions = 4000;
    this.length = this.curve.getLength();

    this.sampleCount = Math.max(600, Math.round(this.length));
    this.#sample();
    this.#computePointArcLengths();
  }

  /** Procedural track from a seed (the classic "shuffle" layouts). */
  static generate(seed, opts = {}) {
    const { points, kind } = buildControlPoints(seed);
    return new TrackPath(points, { seed, kind, name: `Generated #${seed}`, ...opts });
  }

  /** Build from the JSON track format (see `toJSON`). Throws on invalid data. */
  static fromJSON(data) {
    const t = validateTrackData(data);
    return new TrackPath(
      t.points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      { width: t.width, seed: t.seed, bankStrength: t.bankStrength, name: t.name, kind: 'custom' },
    );
  }

  /** Plain-data snapshot of this track (what the editor saves, exports and shares). */
  toJSON() {
    return {
      version: TRACK_FORMAT_VERSION,
      name: this.name,
      width: round1(this.width),
      bankStrength: round2(this.bankStrength),
      seed: this.seed,
      points: this.points.map((p) => [round1(p.x), round1(p.y), round1(p.z)]),
    };
  }

  /** Wrap a distance into [0, length). */
  wrap(s) {
    const L = this.length;
    return ((s % L) + L) % L;
  }

  /**
   * Interpolated frame at distance `s` along the track.
   * @param {number} s distance along the track (any real number, wrapped)
   * @param {TrackFrame} [out]
   */
  frameAt(s, out = new TrackFrame()) {
    const N = this.sampleCount;
    const f = (this.wrap(s) / this.length) * N;
    const i0 = Math.floor(f) % N;
    const i1 = (i0 + 1) % N;
    const t = f - Math.floor(f);

    lerp3(this.positions, i0, i1, t, out.position);
    lerp3(this.tangents, i0, i1, t, out.tangent).normalize();
    lerp3(this.rights, i0, i1, t, out.right).normalize();
    lerp3(this.normals, i0, i1, t, out.normal).normalize();
    out.bank = this.banks[i0] * (1 - t) + this.banks[i1] * t;
    out.curvature = this.curvatures[i0] * (1 - t) + this.curvatures[i1] * t;
    out.s = s;
    return out;
  }

  /** World position for a track-space coordinate (distance, lateral offset, height). */
  pointAt(s, lateral = 0, height = 0, out = new THREE.Vector3(), frame = this.frameAt(s, _frame)) {
    return out
      .copy(frame.position)
      .addScaledVector(frame.right, lateral)
      .addScaledVector(frame.normal, height);
  }

  /** Index of the sample closest to a ground-plane position (ignores height). */
  closestSample(x, z) {
    const p = this.positions;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.sampleCount; i++) {
      const dx = p[i * 3] - x;
      const dz = p[i * 3 + 2] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Which control-point segment (i → i+1) a sample index falls in. */
  segmentOfSample(sampleIndex) {
    const n = this.points.length;
    const t = sampleIndex / this.sampleCount; // samples are uniform in arc length, not t,
    // so refine using the per-point arc lengths:
    const s = t * this.length;
    for (let i = 0; i < n; i++) {
      const s0 = this.pointArcLengths[i];
      const s1 = i + 1 < n ? this.pointArcLengths[i + 1] : this.length;
      if (s >= s0 && s < s1) return i;
    }
    return n - 1;
  }

  #sample() {
    const N = this.sampleCount;
    const positions = new Float32Array(N * 3);
    const tangents = new Float32Array(N * 3);
    const rights = new Float32Array(N * 3);
    const normals = new Float32Array(N * 3);
    const banks = new Float32Array(N);
    const curvatures = new Float32Array(N);

    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    const tNext = new THREE.Vector3();
    const cross = new THREE.Vector3();
    const ds = this.length / N;

    // Pass 1: positions, tangents, signed curvature (positive = turning left).
    for (let i = 0; i < N; i++) {
      const u = i / N;
      this.curve.getPointAt(u, p);
      this.curve.getTangentAt(u, t).normalize();
      this.curve.getTangentAt(((i + 1) % N) / N, tNext).normalize();
      cross.crossVectors(t, tNext);
      curvatures[i] = cross.dot(UP) / ds;
      positions.set([p.x, p.y, p.z], i * 3);
      tangents.set([t.x, t.y, t.z], i * 3);
    }

    // Pass 2: banking = smoothed curvature, so the road leans into every turn.
    const window = 18;
    const gain = BANK_GAIN * this.bankStrength;
    for (let i = 0; i < N; i++) {
      let acc = 0;
      for (let k = -window; k <= window; k++) {
        const w = 1 - Math.abs(k) / (window + 1); // triangle filter
        acc += curvatures[(i + k + N) % N] * w;
      }
      acc /= window + 1; // triangle filter weights sum to (window + 1)
      banks[i] = THREE.MathUtils.clamp(acc * gain, -MAX_BANK, MAX_BANK);
    }

    // Pass 3: moving frame. right0 = T × up, then roll about T by the bank angle.
    const right0 = new THREE.Vector3();
    const normal0 = new THREE.Vector3();
    const right = new THREE.Vector3();
    const normal = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      t.fromArray(tangents, i * 3);
      right0.crossVectors(t, UP);
      if (right0.lengthSq() < 1e-6) right0.set(1, 0, 0); // vertical tangent: pick any right
      right0.normalize();
      normal0.crossVectors(right0, t).normalize();
      const b = banks[i];
      // Positive curvature (left turn) lifts the right (outer) edge.
      right.copy(right0).multiplyScalar(Math.cos(b)).addScaledVector(normal0, Math.sin(b)).normalize();
      normal.crossVectors(right, t).normalize();
      rights.set([right.x, right.y, right.z], i * 3);
      normals.set([normal.x, normal.y, normal.z], i * 3);
    }

    this.positions = positions;
    this.tangents = tangents;
    this.rights = rights;
    this.normals = normals;
    this.banks = banks;
    this.curvatures = curvatures;

    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < N; i++) {
      minY = Math.min(minY, positions[i * 3 + 1]);
      maxY = Math.max(maxY, positions[i * 3 + 1]);
    }
    this.minY = minY;
    this.maxY = maxY;
  }

  /** Arc-length position of every control point (the spline passes through point i at t = i/n). */
  #computePointArcLengths() {
    const n = this.points.length;
    const lengths = this.curve.getLengths(this.curve.arcLengthDivisions); // cumulative, uniform in t
    const divisions = lengths.length - 1;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const f = (i / n) * divisions;
      const a = Math.floor(f);
      const b = Math.min(divisions, a + 1);
      out[i] = lengths[a] + (lengths[b] - lengths[a]) * (f - a);
    }
    this.pointArcLengths = out;
  }
}

export class TrackFrame {
  constructor() {
    this.position = new THREE.Vector3();
    this.tangent = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.normal = new THREE.Vector3();
    this.bank = 0;
    this.curvature = 0;
    this.s = 0;
  }
}

const _frame = new TrackFrame();

function lerp3(arr, i0, i1, t, out) {
  const a = i0 * 3;
  const b = i1 * 3;
  return out.set(
    arr[a] + (arr[b] - arr[a]) * t,
    arr[a + 1] + (arr[b + 1] - arr[a + 1]) * t,
    arr[a + 2] + (arr[b + 2] - arr[a + 2]) * t,
  );
}

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Check and normalise track JSON. Returns a clean copy or throws a descriptive Error.
 */
export function validateTrackData(data) {
  if (!data || typeof data !== 'object') throw new Error('Track file is not an object');
  if (!Array.isArray(data.points)) throw new Error('Track has no "points" array');
  if (data.points.length < MIN_POINTS) throw new Error(`Track needs at least ${MIN_POINTS} points`);
  if (data.points.length > MAX_POINTS) throw new Error(`Track has too many points (max ${MAX_POINTS})`);
  const points = data.points.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => Number.isFinite(v))) {
      throw new Error(`Point ${i} is not [x, y, z]`);
    }
    return [clampNum(p[0], -5000, 5000), clampNum(p[1], -500, 500), clampNum(p[2], -5000, 5000)];
  });
  const width = Number.isFinite(data.width) ? clampNum(data.width, 6, 40) : DEFAULT_WIDTH;
  const bankStrength = Number.isFinite(data.bankStrength) ? clampNum(data.bankStrength, 0, 2) : 1;
  const seed = Number.isFinite(data.seed) ? data.seed >>> 0 : 1;
  const name = typeof data.name === 'string' ? data.name.slice(0, 60) : 'Untitled track';
  return { version: TRACK_FORMAT_VERSION, name, width, bankStrength, seed, points };
}

function clampNum(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/**
 * Seeded control points. Two families of layout:
 *  - "loop":    a wobbly ring with hills
 *  - "figure8": a lemniscate whose crossing is separated vertically, so the
 *               track bridges over itself
 */
export function buildControlPoints(seed) {
  const rnd = makeRandom(seed);
  const kind = rnd.next() < 0.4 ? 'figure8' : 'loop';
  const n = kind === 'figure8' ? 22 : rnd.int(13, 17);
  const R = rnd.range(190, 240);

  const wobbles = [1, 2, 3].map((k) => ({ k, amp: rnd.range(0.05, 0.16) / k, ph: rnd.range(0, Math.PI * 2) }));
  const hillScale = kind === 'figure8' ? 0.45 : 1;
  const hills = [1, 2, 3, 5].map((k) => ({
    k,
    amp: (rnd.range(4, 14) / Math.sqrt(k)) * hillScale,
    ph: rnd.range(0, Math.PI * 2),
  }));

  const points = [];
  for (let i = 0; i < n; i++) {
    const base = (i / n) * Math.PI * 2;
    const t = kind === 'loop' ? base + rnd.range(-0.1, 0.1) : base;
    let x;
    let z;
    if (kind === 'loop') {
      let r = R;
      for (const w of wobbles) r *= 1 + w.amp * Math.sin(w.k * t + w.ph);
      x = Math.cos(t) * r;
      z = Math.sin(t) * r;
    } else {
      const r = R * 1.3;
      x = Math.cos(t) * r + Math.sin(2 * t + wobbles[0].ph) * R * 0.05;
      z = Math.sin(t) * Math.cos(t) * r * 1.15 + Math.cos(3 * t + wobbles[1].ph) * R * 0.04;
    }
    let y = 0;
    for (const h of hills) y += h.amp * Math.sin(h.k * t + h.ph);
    if (kind === 'figure8') y += 17 * Math.sin(t); // crossing at t = π/2 (high) and 3π/2 (low)
    points.push(new THREE.Vector3(x, y, z));
  }
  return { points, kind };
}
