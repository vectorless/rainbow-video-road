/**
 * Game settings with localStorage persistence and change notifications.
 * Every value here is tunable from the in-game settings panel.
 */
const STORAGE_KEY = 'rainbow-video-road.settings.v1';

export const DEFAULTS = Object.freeze({
  // Video slat look
  pixelCells: 48, // pixelation: cells across one tile
  hueSpeed: 0.08, // rainbow cycles per second
  slatsPerRainbow: 36, // one full rainbow cycle every N slat rows
  saturation: 1.35, // saturation boost applied to the video
  videoMix: 0.6, // 0 = video colourised to the slat hue, 1 = video's own hues rotated by it
  tilesAcross: 2, // video tiles per slat row
  fit: 'cover', // 'cover' | 'stretch'

  // Video streaming
  poolSize: 8, // simultaneous <video> decoders
  clipSeconds: 20, // seconds each stream plays a clip before rotating
  randomStart: true,

  // Race
  rails: true,
  laps: 3,
  seed: 1337,

  // Graphics
  bloom: true,
  renderScale: 1.0,
});

export class Settings {
  constructor() {
    this.values = { ...DEFAULTS, ...load() };
    this.listeners = new Set();
  }

  get(key) {
    return this.values[key];
  }

  set(key, value, { silent = false } = {}) {
    if (!(key in DEFAULTS)) return;
    const coerced = coerce(key, value);
    if (this.values[key] === coerced) return;
    this.values[key] = coerced;
    save(this.values);
    if (!silent) this.emit(key, coerced);
  }

  reset() {
    this.values = { ...DEFAULTS };
    save(this.values);
    for (const key of Object.keys(DEFAULTS)) this.emit(key, this.values[key]);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(key, value) {
    for (const fn of this.listeners) fn(key, value, this.values);
  }
}

function coerce(key, value) {
  const def = DEFAULTS[key];
  if (typeof def === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : def;
  }
  if (typeof def === 'boolean') return Boolean(value);
  return String(value);
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (key in parsed) out[key] = coerce(key, parsed[key]);
    }
    return out;
  } catch {
    return {};
  }
}

function save(values) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    /* storage unavailable (private mode etc.) — settings just won't persist */
  }
}
