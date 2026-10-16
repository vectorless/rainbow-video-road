import { validateTrackData } from './TrackPath.js';

/**
 * Where tracks live outside the running game:
 *  - a small library in localStorage ("My tracks")
 *  - the "active" track source the game should restore on reload
 *  - .json files (export / import)
 *  - share links: the track JSON deflated + base64url'd into the URL hash
 */

const LIBRARY_KEY = 'rainbow-video-road.tracks.v1';
const ACTIVE_KEY = 'rainbow-video-road.activeTrack.v1';

/* ------------------------------- library ------------------------------- */

export function listSavedTracks() {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((t) => t && t.id && t.data) : [];
  } catch {
    return [];
  }
}

export function saveTrack(data, id = null) {
  const clean = validateTrackData(data);
  const list = listSavedTracks();
  const entry = {
    id: id || `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: clean.name,
    savedAt: Date.now(),
    data: clean,
  };
  const idx = list.findIndex((t) => t.id === entry.id);
  if (idx >= 0) list[idx] = entry;
  else list.unshift(entry);
  writeLibrary(list.slice(0, 100));
  return entry;
}

export function deleteSavedTrack(id) {
  writeLibrary(listSavedTracks().filter((t) => t.id !== id));
}

function writeLibrary(list) {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('[trackStore] could not save library', err);
  }
}

/* ---------------------------- active track ----------------------------- */

/** @typedef {{ type: 'generated', seed: number } | { type: 'custom', data: object, savedId?: string }} TrackSource */

/** @returns {TrackSource | null} */
export function loadActiveSource() {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const src = JSON.parse(raw);
    if (src?.type === 'generated' && Number.isFinite(src.seed)) return { type: 'generated', seed: src.seed };
    if (src?.type === 'custom' && src.data) return { type: 'custom', data: validateTrackData(src.data), savedId: src.savedId };
    return null;
  } catch {
    return null;
  }
}

export function storeActiveSource(source) {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(source));
  } catch {
    /* ignore */
  }
}

/* ------------------------------- files --------------------------------- */

export function downloadTrackFile(data) {
  const clean = validateTrackData(data);
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug(clean.name) || 'track'}.rvr-track.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readTrackFile(file) {
  const text = await file.text();
  return validateTrackData(JSON.parse(text));
}

function slug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/* ----------------------------- share links ----------------------------- */

const HASH_PREFIX = '#track=';

export async function encodeTrackToHash(data) {
  const json = JSON.stringify(validateTrackData(data));
  const bytes = new TextEncoder().encode(json);
  if (typeof CompressionStream === 'function') {
    try {
      const deflated = await pipeThrough(bytes, new CompressionStream('deflate-raw'));
      return `${HASH_PREFIX}d.${base64url(deflated)}`;
    } catch {
      /* fall through to plain */
    }
  }
  return `${HASH_PREFIX}j.${base64url(bytes)}`;
}

/** @returns {Promise<object | null>} the track data in the current URL hash, if any */
export async function decodeTrackFromHash(hash = location.hash) {
  if (!hash || !hash.startsWith(HASH_PREFIX)) return null;
  const payload = hash.slice(HASH_PREFIX.length);
  const dot = payload.indexOf('.');
  if (dot < 0) return null;
  const mode = payload.slice(0, dot);
  const bytes = fromBase64url(payload.slice(dot + 1));
  let jsonBytes = bytes;
  if (mode === 'd') {
    if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot open compressed track links');
    jsonBytes = await pipeThrough(bytes, new DecompressionStream('deflate-raw'));
  }
  return validateTrackData(JSON.parse(new TextDecoder().decode(jsonBytes)));
}

async function pipeThrough(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function base64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
