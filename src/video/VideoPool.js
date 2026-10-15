import * as THREE from 'three';
import { FallbackTexture } from './fallbackTextures.js';

/**
 * A fixed number of <video> "streams", each backed by a VideoTexture. The chosen
 * folder's clips are dealt out to the streams round-robin; every `clipSeconds` a
 * stream moves on to the next clip (optionally starting at a random point) so, over
 * time, every clip in the folder gets its turn on the road.
 *
 * Streams with nothing to play fall back to a procedural animated texture, so the
 * track is never blank.
 *
 * Events: 'textures' (texture list changed → rebind materials), 'status' (HUD text).
 */
export class VideoPool extends EventTarget {
  constructor({ size = 8, clipSeconds = 20, randomStart = true } = {}) {
    super();
    this.clipSeconds = clipSeconds;
    this.randomStart = randomStart;
    this.files = [];
    this.badFiles = new Set();
    this.nextFile = 0;
    this.streams = [];
    this.fallbacks = [];
    this.folderName = '';
    this.setSize(size);
  }

  /* ----------------------------- public API ----------------------------- */

  get size() {
    return this.streams.length;
  }

  get hasVideos() {
    return this.files.length > 0 && this.badFiles.size < this.files.length;
  }

  textures() {
    return this.streams.map((s) => (s.active ? s.texture : this.fallbacks[s.index].texture));
  }

  aspects() {
    return this.streams.map((s) => (s.active ? s.aspect : this.fallbacks[s.index].aspect));
  }

  setSize(n) {
    n = Math.max(1, Math.min(16, Math.round(n)));
    while (this.fallbacks.length < n) this.fallbacks.push(new FallbackTexture(this.fallbacks.length));
    while (this.streams.length > n) this.#destroyStream(this.streams.pop());
    while (this.streams.length < n) {
      const stream = this.#createStream(this.streams.length);
      this.streams.push(stream);
      if (this.files.length) this.#loadNext(stream);
    }
    this.#emitTextures();
  }

  /** Replace the clip list (from the folder picker) and start playing. */
  setFiles(files, folderName = '') {
    this.files = files.slice();
    this.badFiles = new Set();
    this.nextFile = 0;
    this.folderName = folderName;
    for (const s of this.streams) this.#loadNext(s);
    this.#emitTextures();
    this.#emitStatus();
  }

  clearFiles() {
    this.files = [];
    this.badFiles = new Set();
    for (const s of this.streams) this.#unload(s);
    this.#emitTextures();
    this.#emitStatus();
  }

  /** Browsers may refuse play() until a gesture happened — call this from a click/keydown. */
  resumeAll() {
    for (const s of this.streams) {
      if (s.active && s.video.paused) s.video.play().catch(() => {});
    }
  }

  /** Per frame. Rotates clips whose segment has elapsed, animates fallbacks. */
  update(time) {
    const now = performance.now();
    const anyActive = this.streams.some((s) => s.active);
    for (const s of this.streams) {
      if (s.active) {
        if (now - s.startedAt > this.clipSeconds * 1000 && this.files.length > 1) this.#loadNext(s);
        else if (s.video.paused && s.video.readyState >= 2 && !s.video.ended) s.video.play().catch(() => {});
      } else if (!anyActive || this.files.length === 0) {
        // animate fallbacks only when they're visible; stagger to spread the cost
        if ((Math.floor(time * 30) + s.index) % 2 === 0) this.fallbacks[s.index].draw(time);
      } else {
        this.fallbacks[s.index].draw(time);
      }
    }
  }

  statusText() {
    if (!this.files.length) return `no videos · demo textures · ${this.size} streams`;
    const good = this.files.length - this.badFiles.size;
    const playing = this.streams.filter((s) => s.active).length;
    const bad = this.badFiles.size ? ` · ${this.badFiles.size} unplayable` : '';
    return `${this.folderName ? '“' + this.folderName + '” — ' : ''}${good} clip${good === 1 ? '' : 's'} · ${playing}/${this.size} playing${bad}`;
  }

  dispose() {
    for (const s of this.streams) this.#destroyStream(s);
    this.streams = [];
    for (const f of this.fallbacks) f.dispose();
    this.fallbacks = [];
  }

  /* ------------------------------ internals ----------------------------- */

  #createStream(index) {
    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    // No native looping: a loop seek briefly leaves the element without a frame, which
    // makes WebGL complain. When a clip ends we move on to the next one instead.
    video.loop = false;
    video.disablePictureInPicture = true;
    video.style.display = 'none';

    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;

    const stream = {
      index,
      video,
      texture,
      url: null,
      file: null,
      active: false,
      aspect: 16 / 9,
      startedAt: 0,
      token: 0,
    };

    video.addEventListener('loadedmetadata', () => {
      if (video.videoWidth && video.videoHeight) stream.aspect = video.videoWidth / video.videoHeight;
      if (this.randomStart && Number.isFinite(video.duration) && video.duration > this.clipSeconds + 1) {
        const maxStart = Math.max(0, video.duration - this.clipSeconds);
        try {
          video.currentTime = Math.random() * maxStart;
        } catch {
          /* ignore seek errors */
        }
      }
    });
    video.addEventListener('canplay', () => {
      if (!stream.active) {
        stream.active = true;
        this.#emitTextures();
        this.#emitStatus();
      }
      video.play().catch(() => {});
    });
    video.addEventListener('error', () => {
      if (!stream.file) return; // error from unloading (empty source) — not a bad clip
      this.badFiles.add(stream.file);
      console.warn('[VideoPool] cannot play', stream.file.name, video.error?.message);
      this.#emitStatus();
      this.#loadNext(stream);
    });
    video.addEventListener('ended', () => {
      if (!stream.file) return;
      if (this.files.length > 1) {
        this.#loadNext(stream);
      } else {
        video.currentTime = 0;
        video.play().catch(() => {});
      }
    });

    return stream;
  }

  #destroyStream(stream) {
    this.#unload(stream);
    stream.texture.dispose();
    stream.video.remove();
  }

  #unload(stream) {
    stream.active = false;
    stream.file = null;
    const v = stream.video;
    v.pause();
    v.removeAttribute('src');
    v.load();
    if (stream.url) {
      URL.revokeObjectURL(stream.url);
      stream.url = null;
    }
  }

  /** Pick the next clip for a stream (round-robin over the folder, skipping bad files). */
  #loadNext(stream) {
    const file = this.#nextPlayableFile();
    if (!file) {
      this.#unload(stream);
      this.#emitTextures();
      return;
    }
    // Note: `active` is left as-is while the next clip buffers. The GPU texture keeps
    // showing the previous clip's last frame until new frames arrive, which is much
    // nicer than flashing the fallback pattern between clips.
    stream.file = file;
    stream.startedAt = performance.now();
    if (stream.url) URL.revokeObjectURL(stream.url);
    stream.url = URL.createObjectURL(file);
    const v = stream.video;
    v.src = stream.url;
    v.load();
    v.play().catch(() => {});
  }

  #nextPlayableFile() {
    const n = this.files.length;
    if (!n) return null;
    for (let i = 0; i < n; i++) {
      const file = this.files[this.nextFile % n];
      this.nextFile = (this.nextFile + 1) % n;
      if (!this.badFiles.has(file)) return file;
    }
    return null;
  }

  #emitTextures() {
    this.dispatchEvent(new Event('textures'));
  }

  #emitStatus() {
    this.dispatchEvent(new Event('status'));
  }
}
