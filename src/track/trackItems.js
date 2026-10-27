import { makeRandom } from '../core/prng.js';

/**
 * Pickups and obstacles placed on a track.
 *
 * An item is stored as `{ type, seg, u, x }`: the control-point segment it sits on
 * (seg i runs from point i to point i+1), how far along that segment (u, 0..1 of its
 * arc length) and where across the road (x, -1..1 of the half width). Anchoring to a
 * segment keeps items in place while other parts of the track are edited, and x as a
 * fraction keeps them on the road when the width changes. The editor remaps `seg`/`u`
 * when points are inserted, deleted or the start is moved (see the remap helpers).
 */

export const MAX_ITEMS = 400;

/**
 * kind: 'pickup' (collected by driving through, comes back after `respawn` seconds)
 *       'obstacle' (stays; cones get knocked away and come back)
 * hitS / hitL: half-extents of the trigger box along / across the road (world units)
 */
export const ITEM_TYPES = {
  itembox: { kind: 'pickup', label: 'Item box', hitS: 1.2, hitL: 1.2, respawn: 3, color: '#ff3cac' },
  boost: { kind: 'pickup', label: 'Boost', hitS: 1.2, hitL: 1.2, respawn: 4, color: '#2bd2ff' },
  shield: { kind: 'pickup', label: 'Shield', hitS: 1.1, hitL: 1.1, respawn: 8, color: '#8f7bff' },
  coin: { kind: 'pickup', label: 'Coin', hitS: 0.9, hitL: 0.9, respawn: 10, color: '#ffd24a' },
  block: { kind: 'obstacle', label: 'Block', hitS: 1.3, hitL: 1.3, color: '#c04bff' },
  cone: { kind: 'obstacle', label: 'Cone', hitS: 0.6, hitL: 0.6, respawn: 10, color: '#ff8a1f' },
  mud: { kind: 'obstacle', label: 'Mud', hitS: 3.4, hitL: 2.6, color: '#8a5a2b' },
};

/** Check and normalise an items array for a track with `nPoints` control points. */
export function validateItems(items, nPoints) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object' || !(it.type in ITEM_TYPES)) continue;
    if (!Number.isInteger(it.seg) || it.seg < 0 || it.seg >= nPoints) continue;
    if (!Number.isFinite(it.u) || !Number.isFinite(it.x)) continue;
    out.push({ type: it.type, seg: it.seg, u: round4(clamp(it.u, 0, 1)), x: round2(clamp(it.x, -1, 1)) });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** Arc length of segment j (point j → point j+1, wrapping). */
export function segmentLength(path, j) {
  const a = path.pointArcLengths;
  const end = j + 1 < a.length ? a[j + 1] : path.length;
  return end - a[j];
}

/** Track-space position of an item: { s, lateral }. */
export function itemTrackPos(path, item) {
  const seg = Math.min(item.seg, path.points.length - 1);
  return {
    s: path.wrap(path.pointArcLengths[seg] + item.u * segmentLength(path, seg)),
    lateral: item.x * path.halfWidth,
  };
}

/** Item anchoring ({ seg, u, x }) for a track-space position. */
export function itemAnchor(path, s, lateral) {
  s = path.wrap(s);
  const a = path.pointArcLengths;
  let seg = a.length - 1;
  for (let i = 0; i < a.length - 1; i++) {
    if (s < a[i + 1]) {
      seg = i;
      break;
    }
  }
  const len = segmentLength(path, seg);
  return {
    seg,
    u: round4(clamp(len > 0 ? (s - a[seg]) / len : 0, 0, 1)),
    x: round2(clamp(lateral / path.halfWidth, -1, 1)),
  };
}

/* ------------------------- remapping for point edits ------------------------- */

/**
 * A point was inserted after `seg`, at distance `splitS` along the old track: the
 * segment splits in two, and later segments shift up by one.
 */
export function remapItemsForInsert(items, oldPath, seg, splitS) {
  const len = segmentLength(oldPath, seg);
  const f = len > 0 ? clamp((oldPath.wrap(splitS) - oldPath.pointArcLengths[seg]) / len, 0.01, 0.99) : 0.5;
  for (const it of items) {
    if (it.seg > seg) it.seg++;
    else if (it.seg === seg) {
      if (it.u < f) it.u = round4(it.u / f);
      else {
        it.seg = seg + 1;
        it.u = round4((it.u - f) / (1 - f));
      }
    }
  }
}

/** Point `i` was deleted: the segments either side of it merge, later ones shift down. */
export function remapItemsForDelete(items, oldPath, i) {
  const n = oldPath.points.length;
  const prev = (i - 1 + n) % n;
  const a = segmentLength(oldPath, prev);
  const b = segmentLength(oldPath, i);
  const newIndex = (j) => (j < i ? j : j - 1);
  const merged = newIndex(prev);
  for (const it of items) {
    if (it.seg === prev) {
      it.u = round4((it.u * a) / (a + b));
      it.seg = merged;
    } else if (it.seg === i) {
      it.u = round4((a + it.u * b) / (a + b));
      it.seg = merged;
    } else {
      it.seg = newIndex(it.seg);
    }
  }
}

/** The start moved to point `k`: point (and segment) j becomes j - k. */
export function remapItemsForRotate(items, n, k) {
  for (const it of items) it.seg = (it.seg - k + n) % n;
}

/* --------------------------- generated tracks --------------------------- */

/**
 * A seeded sprinkle of items for a generated track: rows of item boxes, boosts, coin
 * lines, a shield, and a few blocks, cone clusters and mud patches, kept clear of
 * the start and spread out along the lap.
 */
export function generateItems(path, seed) {
  const rnd = makeRandom((seed ^ 0x9e3779b9) >>> 0);
  const L = path.length;
  const half = path.halfWidth;
  const taken = []; // s positions already used, to keep things spread out
  const items = [];
  const put = (type, s, lateral) => items.push({ type, ...itemAnchor(path, s, lateral) });
  const free = (s, gap) => taken.every((t) => {
    const d = Math.abs(t - s);
    return Math.min(d, L - d) > gap;
  });
  // somewhere in [from, to] of the lap that is at least `gap` from everything else
  const spot = (gap, from = 0.08, to = 0.95) => {
    for (let tries = 0; tries < 40; tries++) {
      const s = rnd.range(from, to) * L;
      if (free(s, gap)) {
        taken.push(s);
        return s;
      }
    }
    return null;
  };

  // item box rows, roughly evenly through the lap
  const rows = L > 1600 ? [0.3, 0.6, 0.86] : [0.32, 0.68];
  for (const f of rows) {
    const s = f * L;
    taken.push(s);
    for (const x of [-0.6, -0.2, 0.2, 0.6]) put('itembox', s, x * half);
  }
  for (let i = 0; i < 3; i++) {
    const s = spot(30);
    if (s != null) put('boost', s, rnd.range(-0.5, 0.5) * half);
  }
  for (let i = 0; i < 3; i++) {
    const s = spot(40);
    if (s == null) continue;
    const x = rnd.range(-0.5, 0.5) * half;
    for (let k = 0; k < 5; k++) put('coin', s + k * 5, x);
  }
  {
    const s = spot(40);
    if (s != null) put('shield', s, rnd.range(-0.4, 0.4) * half);
  }
  for (let i = 0; i < 3; i++) {
    const s = spot(35, 0.12);
    if (s != null) put('block', s, rnd.sign() * rnd.range(0.25, 0.55) * half);
  }
  for (let i = 0; i < 2; i++) {
    const s = spot(35, 0.12);
    if (s == null) continue;
    const x = rnd.range(-0.4, 0.4) * half;
    put('cone', s, x);
    put('cone', s + 2.5, x - 1.4);
    put('cone', s + 2.5, x + 1.4);
  }
  for (let i = 0; i < 2; i++) {
    const s = spot(35, 0.12);
    if (s != null) put('mud', s, rnd.range(-0.45, 0.45) * half);
  }
  return validateItems(items, path.points.length);
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round2 = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 10000) / 10000;
