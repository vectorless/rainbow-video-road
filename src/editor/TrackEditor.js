import * as THREE from 'three';
import { MIN_POINTS, MAX_POINTS, MAX_POINT_BANK, validateTrackData } from '../track/TrackPath.js';
import {
  ITEM_TYPES,
  MAX_ITEMS,
  itemTrackPos,
  itemAnchor,
  remapItemsForInsert,
  remapItemsForDelete,
  remapItemsForRotate,
  generateItems,
} from '../track/trackItems.js';
import {
  listSavedTracks,
  saveTrack,
  deleteSavedTrack,
  downloadTrackFile,
  readTrackFile,
  encodeTrackToHash,
} from '../track/trackStore.js';

const POINT_HIT_PX = 10;
const ITEM_HIT_PX = 8;
const MAX_HISTORY = 100;
const MIN_TURN_RADIUS_FACTOR = 1.15; // × half width: below this the inner edge folds over itself
const MAX_SLOPE = 0.7; // rise/run (~35°)
const MIN_CROSSING_CLEARANCE = 10; // world units between two roads that cross

/**
 * Top-down track editor: a map canvas for X/Z, an elevation strip for Y, with the
 * real 3D track rebuilding live behind it. Owns the editing state (control points,
 * width, banking — overall and per point — name, items), undo/redo, validation
 * warnings, the 3D control-point markers and the overview camera used while editing.
 *
 * Items (pickups and obstacles) are placed with the tool row under the map: pick a
 * tool, click the road. Items can be dragged or right-clicked away with any tool.
 *
 * It talks to the game through `hooks`:
 *   applyTrack(data) → TrackPath   rebuild the world from track JSON, return the new path
 *   testDrive(startS)              leave the editor and race from distance `startS`
 *   close()                        leave the editor
 *   generate() → data              fresh procedural track JSON
 */
export class TrackEditor {
  constructor({ root, scene, camera, canvas3d, hooks }) {
    this.root = root;
    this.scene = scene;
    this.camera = camera;
    this.canvas3d = canvas3d;
    this.hooks = hooks;

    this.isOpen = false;
    this.state = null; // track JSON being edited
    this.path = null; // TrackPath built from `state`
    this.selected = -1;
    this.hover = -1;
    this.tool = 'select'; // 'select' or an item type to place
    this.selectedItem = -1;
    this.hoverItem = -1;
    this.history = [];
    this.future = [];
    this.dirty = false;
    this.needsDraw = true;
    this.warnings = [];
    this.crossings = [];
    this.savedId = null;

    this.view = { scale: 1, cx: 0, cz: 0 };
    this.orbit = { angle: 0.8, elev: 0.6, dist: 1, lastInteract: -Infinity };
    this.drag = null;

    this.#bindDom();
    this.#buildMarkers();
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  open(path, { savedId = null } = {}) {
    this.state = path.toJSON();
    if (!this.state.name || /^Generated #/.test(this.state.name)) this.state.name = 'My track';
    this.path = path;
    this.savedId = savedId;
    this.selected = -1;
    this.hover = -1;
    this.selectedItem = -1;
    this.hoverItem = -1;
    this.history = [];
    this.future = [];
    this.dirty = false;
    this.isOpen = true;

    this.root.classList.remove('hidden');
    this.scene.add(this.markers);
    this.#attach3d();
    this.#syncControls();
    this.#refreshLoadList();
    this.#resizeCanvases();
    this.#fitView();
    this.#validate();
    this.#setStatus('');
    this.needsDraw = true;
    this.orbit.lastInteract = -Infinity;
    this.#updateMarkers();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.add('hidden');
    this.scene.remove(this.markers);
    this.#detach3d();
    this.drag = null;
    this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /** Per frame while open. */
  update(dt) {
    if (!this.isOpen) return;
    if (this.dirty) this.#rebuild();
    this.#updateCamera(dt, performance.now() / 1000);
    this.#updateMarkers();
    if (this.needsDraw) {
      this.#drawMap();
      this.#drawElevation();
      this.needsDraw = false;
    }
  }

  /** Current track JSON (deep copy). */
  data() {
    return JSON.parse(JSON.stringify(this.state));
  }

  dispose() {
    this.close();
    this.resizeObserver?.disconnect();
    window.removeEventListener('keydown', this._onKey);
  }

  /* ------------------------------------------------------------------ */
  /* editing operations                                                  */
  /* ------------------------------------------------------------------ */

  #snapshot() {
    this.history.push(JSON.stringify(this.state));
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.future = [];
    this.#syncUndoButtons();
  }

  undo() {
    if (!this.history.length) return;
    this.future.push(JSON.stringify(this.state));
    this.state = JSON.parse(this.history.pop());
    this.#afterStateChange();
  }

  redo() {
    if (!this.future.length) return;
    this.history.push(JSON.stringify(this.state));
    this.state = JSON.parse(this.future.pop());
    this.#afterStateChange();
  }

  #afterStateChange() {
    this.selected = Math.min(this.selected, this.state.points.length - 1);
    this.selectedItem = Math.min(this.selectedItem, this.state.items.length - 1);
    this.dirty = true;
    this.#syncControls();
    this.#syncUndoButtons();
  }

  #movePoint(i, x, z) {
    const p = this.state.points[i];
    p[0] = round1(x);
    p[2] = round1(z);
    this.dirty = true;
  }

  #setHeight(i, y) {
    this.state.points[i][1] = round1(THREE.MathUtils.clamp(y, -200, 200));
    this.dirty = true;
  }

  #insertPoint(x, z) {
    if (this.state.points.length >= MAX_POINTS) {
      this.#setStatus(`Maximum of ${MAX_POINTS} points reached`, true);
      return;
    }
    this.#snapshot();
    const sample = this.path.closestSample(x, z);
    const seg = this.path.segmentOfSample(sample);
    const pts = this.state.points;
    const a = pts[seg];
    const b = pts[(seg + 1) % pts.length];
    const y = this.path.positions[sample * 3 + 1] ?? (a[1] + b[1]) / 2;
    remapItemsForInsert(this.state.items, this.path, seg, (sample / this.path.sampleCount) * this.path.length);
    pts.splice(seg + 1, 0, [round1(x), round1(y), round1(z)]);
    this.selected = seg + 1;
    this.dirty = true;
    this.#setStatus(`Added point ${this.selected}`);
  }

  #deletePoint(i) {
    if (this.state.points.length <= MIN_POINTS) {
      this.#setStatus(`A track needs at least ${MIN_POINTS} points`, true);
      return;
    }
    this.#snapshot();
    remapItemsForDelete(this.state.items, this.path, i);
    this.state.points.splice(i, 1);
    if (this.selected >= this.state.points.length) this.selected = this.state.points.length - 1;
    this.hover = -1;
    this.dirty = true;
  }

  #setStartHere() {
    if (this.selected < 0) {
      this.#setStatus('Select a point first, then set the start there', true);
      return;
    }
    if (this.selected === 0) return;
    this.#snapshot();
    const pts = this.state.points;
    remapItemsForRotate(this.state.items, pts.length, this.selected);
    this.state.points = pts.slice(this.selected).concat(pts.slice(0, this.selected));
    this.selected = 0;
    this.dirty = true;
    this.#setStatus('Start/finish moved');
  }

  /* ------------------------------- items ------------------------------- */

  /** Track-space position under a map pixel, or null when it isn't on the road. */
  #roadAt(px, py) {
    const path = this.path;
    const [x, z] = this.#mapToWorld(px, py);
    const i = path.closestSample(x, z);
    const dx = x - path.positions[i * 3];
    const dz = z - path.positions[i * 3 + 2];
    const rx = path.rights[i * 3];
    const rz = path.rights[i * 3 + 2];
    // the road's right vector tilts with banking; undo that to get distance across the road
    const lateral = (dx * rx + dz * rz) / Math.max(1e-6, rx * rx + rz * rz);
    if (Math.abs(lateral) > path.halfWidth) return null;
    return { s: (i / path.sampleCount) * path.length, lateral };
  }

  #setTool(tool) {
    this.tool = tool;
    for (const b of this.el.tools.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    this.el.toolHint.textContent =
      tool === 'select'
        ? 'Pick an item, then click the road to place it. Drag items to move them; right‑click or ⌫ removes one.'
        : `Click the road to place a ${ITEM_TYPES[tool].label.toLowerCase()} · right‑click removes · “Select” to stop placing`;
    this.el.map.style.cursor = tool === 'select' ? '' : 'copy';
  }

  #placeItem(px, py) {
    if (this.state.items.length >= MAX_ITEMS) {
      this.#setStatus(`Maximum of ${MAX_ITEMS} items reached`, true);
      return;
    }
    const at = this.#roadAt(px, py);
    if (!at) {
      this.#setStatus('Click on the road to place an item', true);
      return;
    }
    this.#snapshot();
    // keep it fully on the road
    const def = ITEM_TYPES[this.tool];
    const room = Math.max(0, this.path.halfWidth - def.hitL);
    const lateral = Math.max(-room, Math.min(room, at.lateral));
    this.state.items.push({ type: this.tool, ...itemAnchor(this.path, at.s, lateral) });
    this.selectedItem = this.state.items.length - 1;
    this.selected = -1;
    this.dirty = true;
    this.#setStatus(`Placed ${def.label.toLowerCase()}`);
  }

  #moveItem(i, px, py) {
    const at = this.#roadAt(px, py);
    if (!at) return;
    const item = this.state.items[i];
    const room = Math.max(0, this.path.halfWidth - ITEM_TYPES[item.type].hitL);
    Object.assign(item, itemAnchor(this.path, at.s, Math.max(-room, Math.min(room, at.lateral))));
    this.dirty = true;
  }

  #deleteItem(i) {
    this.#snapshot();
    const [item] = this.state.items.splice(i, 1);
    this.selectedItem = -1;
    this.hoverItem = -1;
    this.dirty = true;
    this.#setStatus(`Removed ${ITEM_TYPES[item.type].label.toLowerCase()}`);
  }

  #hitItem(px, py) {
    let best = -1;
    let bestD = ITEM_HIT_PX * ITEM_HIT_PX;
    this.state.items.forEach((item, i) => {
      const [mx, my] = this.#itemOnMap(item);
      const d = (mx - px) ** 2 + (my - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  #itemOnMap(item) {
    const { s, lateral } = itemTrackPos(this.path, item);
    this.path.pointAt(s, lateral, 0, _tmp);
    return this.#worldToMap(_tmp.x, _tmp.z);
  }

  /* ---------------------------- point banking ---------------------------- */

  #setPointBank(i, deg) {
    const p = this.state.points[i];
    if (deg == null) p.length = 3;
    else p[3] = Math.round(Math.max(-MAX_POINT_BANK, Math.min(MAX_POINT_BANK, deg)));
    this.dirty = true;
  }

  #syncPointBank() {
    const i = this.selected;
    const p = i >= 0 ? this.state.points[i] : null;
    const box = this.el.pointBank;
    box.classList.toggle('disabled', !p);
    this.el.pbOn.disabled = !p;
    this.el.pbIndex.textContent = p ? String(i) : '—';
    const manual = p && p.length > 3;
    this.el.pbOn.checked = Boolean(manual);
    this.el.pb.disabled = !manual;
    if (manual) this.el.pb.value = p[3];
    this.el.pbOut.textContent = manual ? bankLabel(p[3]) : 'auto';
  }

  #replaceTrack(data, { keepHistory = true, savedId = null } = {}) {
    if (keepHistory) this.#snapshot();
    this.state = validateTrackData(data);
    this.savedId = savedId;
    this.selected = -1;
    this.selectedItem = -1;
    this.dirty = true;
    this.#syncControls();
    this.#rebuild();
    this.#fitView();
  }

  #rebuild() {
    this.dirty = false;
    try {
      this.path = this.hooks.applyTrack(this.data());
      this.#validate();
      if (this.el.status.classList.contains('error')) this.#setStatus(''); // previous build error is gone
    } catch (err) {
      console.error(err);
      this.#setStatus(`Can't build track: ${err.message}`, true);
    }
    this.needsDraw = true;
  }

  /* ------------------------------------------------------------------ */
  /* validation                                                          */
  /* ------------------------------------------------------------------ */

  #validate() {
    const path = this.path;
    const warnings = [];
    const halfW = path.halfWidth;
    const N = path.sampleCount;
    const ds = path.length / N;

    // Tight corners: the inner edge of the road folds over itself.
    const tight = new Set();
    for (let i = 0; i < N; i++) {
      const k = Math.abs(path.curvatures[i]);
      if (k > 1e-6 && 1 / k < halfW * MIN_TURN_RADIUS_FACTOR) tight.add(this.#nearestPointToS((i / N) * path.length));
    }
    for (const p of tight) warnings.push({ kind: 'tight', point: p, text: `Corner at point ${p} is too tight for the road width — the inside edge folds over.` });

    // Steep slopes.
    const steep = new Set();
    for (let i = 0; i < N; i++) {
      const y0 = path.positions[i * 3 + 1];
      const y1 = path.positions[((i + 1) % N) * 3 + 1];
      if (Math.abs(y1 - y0) / ds > MAX_SLOPE) steep.add(this.#nearestPointToS((i / N) * path.length));
    }
    for (const p of steep) warnings.push({ kind: 'steep', point: p, text: `Slope near point ${p} is very steep (over 35°).` });

    // Crossings: fine as bridges, a problem when the two roads are too close vertically.
    this.crossings = findCrossings(path, 220);
    for (const c of this.crossings) {
      if (c.clearance < MIN_CROSSING_CLEARANCE) {
        const p = this.#nearestPointToS(c.s1);
        warnings.push({
          kind: 'crossing',
          point: p,
          text: `Track crosses itself near point ${p} with only ${c.clearance.toFixed(0)} units of clearance — raise or lower one side (needs ${MIN_CROSSING_CLEARANCE}).`,
        });
      }
    }

    this.warnings = warnings;
    this.#renderWarnings();
    this.#renderStats();
  }

  #nearestPointToS(s) {
    const arr = this.path.pointArcLengths;
    const L = this.path.length;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < arr.length; i++) {
      let d = Math.abs(arr[i] - s);
      d = Math.min(d, L - d);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  #renderWarnings() {
    const el = this.el.warnings;
    el.innerHTML = '';
    if (!this.warnings.length) {
      el.innerHTML = '<div class="ed-ok">✓ Track looks drivable</div>';
      return;
    }
    for (const w of this.warnings.slice(0, 6)) {
      const div = document.createElement('button');
      div.type = 'button';
      div.className = 'ed-warning';
      div.textContent = `⚠ ${w.text}`;
      div.addEventListener('click', () => {
        this.selected = w.point;
        this.needsDraw = true;
      });
      el.appendChild(div);
    }
    if (this.warnings.length > 6) {
      const more = document.createElement('div');
      more.className = 'ed-hint';
      more.textContent = `…and ${this.warnings.length - 6} more`;
      el.appendChild(more);
    }
  }

  #renderStats() {
    const p = this.path;
    const bridges = this.crossings.filter((c) => c.clearance >= MIN_CROSSING_CLEARANCE).length;
    const parts = [
      `${p.points.length} points`,
      `${Math.round(p.length)} m long`,
      `${Math.round((p.maxY - p.minY) * 10) / 10} m of climb`,
    ];
    if (bridges) parts.push(`${bridges} bridge${bridges === 1 ? '' : 's'}`);
    const items = this.state.items.length;
    parts.push(`${items} item${items === 1 ? '' : 's'}`);
    this.el.stats.textContent = parts.join(' · ');
  }

  /* ------------------------------------------------------------------ */
  /* DOM                                                                 */
  /* ------------------------------------------------------------------ */

  #bindDom() {
    const q = (sel) => this.root.querySelector(sel);
    this.el = {
      map: q('#ed-map'),
      elev: q('#ed-elev'),
      name: q('#ed-name'),
      width: q('#ed-width'),
      widthOut: q('[data-ed-out="width"]'),
      bank: q('#ed-bank'),
      bankOut: q('[data-ed-out="bank"]'),
      stats: q('#ed-stats'),
      warnings: q('#ed-warnings'),
      status: q('#ed-status'),
      undo: q('#ed-undo'),
      redo: q('#ed-redo'),
      load: q('#ed-load'),
      tools: q('#ed-tools'),
      toolHint: q('#ed-tool-hint'),
      pointBank: q('#ed-point-bank'),
      pbOn: q('#ed-pb-on'),
      pb: q('#ed-pb'),
      pbOut: q('[data-ed-out="pb"]'),
      pbIndex: q('#ed-pb-index'),
    };
    this.mapCtx = this.el.map.getContext('2d');
    this.elevCtx = this.el.elev.getContext('2d');

    q('#ed-close').addEventListener('click', () => this.hooks.close());
    this.el.undo.addEventListener('click', () => this.undo());
    this.el.redo.addEventListener('click', () => this.redo());

    this.el.name.addEventListener('input', () => {
      this.state.name = this.el.name.value.slice(0, 60);
    });
    this.el.width.addEventListener('input', () => {
      this.state.width = Number(this.el.width.value);
      this.el.widthOut.textContent = `${this.state.width} m`;
      this.dirty = true;
    });
    this.el.width.addEventListener('pointerdown', () => this.#snapshot());
    this.el.bank.addEventListener('input', () => {
      this.state.bankStrength = Number(this.el.bank.value);
      this.el.bankOut.textContent = `${Math.round(this.state.bankStrength * 100)}%`;
      this.dirty = true;
    });
    this.el.bank.addEventListener('pointerdown', () => this.#snapshot());

    // item tools
    const tools = [['select', 'Select', null], ...Object.entries(ITEM_TYPES).map(([type, d]) => [type, d.label, d])];
    for (const [tool, label, def] of tools) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ed-tool${def?.kind === 'obstacle' ? ' obstacle' : ''}`;
      b.dataset.tool = tool;
      b.innerHTML = def ? `<i style="--c:${def.color}"></i>${label}` : label;
      b.addEventListener('click', () => this.#setTool(tool));
      this.el.tools.appendChild(b);
    }
    this.#setTool('select');
    q('#ed-auto-items').addEventListener('click', () => {
      this.#snapshot();
      this.state.items = generateItems(this.path, (Math.random() * 1e9) >>> 0);
      this.selectedItem = -1;
      this.dirty = true;
      this.#setStatus(`Placed ${this.state.items.length} items — undo to get yours back`);
    });
    q('#ed-clear-items').addEventListener('click', () => {
      if (!this.state.items.length) return;
      this.#snapshot();
      this.state.items = [];
      this.selectedItem = -1;
      this.dirty = true;
      this.#setStatus('Items cleared');
    });

    // banking at the selected point
    this.el.pbOn.addEventListener('change', () => {
      if (this.selected < 0) return;
      this.#snapshot();
      // start a hand-set point at the automatic bank it had, so turning it on changes nothing yet
      const auto = THREE.MathUtils.radToDeg(this.path.frameAt(this.path.pointArcLengths[this.selected]).bank);
      this.#setPointBank(this.selected, this.el.pbOn.checked ? auto : null);
      this.#syncPointBank();
    });
    this.el.pb.addEventListener('pointerdown', () => this.#snapshot());
    this.el.pb.addEventListener('input', () => {
      if (this.selected < 0) return;
      this.#setPointBank(this.selected, Number(this.el.pb.value));
      this.el.pbOut.textContent = bankLabel(Number(this.el.pb.value));
      this.needsDraw = true;
    });

    q('#ed-test').addEventListener('click', () => {
      if (this.dirty) this.#rebuild();
      const startS = this.selected >= 0 ? this.path.pointArcLengths[this.selected] : 0;
      this.hooks.testDrive(startS);
    });
    q('#ed-start').addEventListener('click', () => this.#setStartHere());
    q('#ed-generate').addEventListener('click', () => {
      this.#replaceTrack(this.hooks.generate());
      this.#setStatus('New random layout — edit away');
    });
    q('#ed-save').addEventListener('click', () => this.#save());
    q('#ed-delete-saved').addEventListener('click', () => this.#deleteSaved());
    this.el.load.addEventListener('change', () => this.#loadSelected());
    q('#ed-export').addEventListener('click', () => {
      downloadTrackFile(this.state);
      this.#setStatus('Track file downloaded');
    });
    const importInput = document.getElementById('track-import');
    q('#ed-import').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      importInput.value = '';
      if (!file) return;
      try {
        const data = await readTrackFile(file);
        this.#replaceTrack(data);
        this.#setStatus(`Imported “${data.name}”`);
      } catch (err) {
        this.#setStatus(`Couldn't import: ${err.message}`, true);
      }
    });
    q('#ed-share').addEventListener('click', () => this.#share());

    this.el.map.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.map.addEventListener('pointerdown', (e) => this.#mapPointerDown(e));
    this.el.map.addEventListener('pointermove', (e) => this.#mapPointerMove(e));
    this.el.map.addEventListener('pointerup', (e) => this.#mapPointerUp(e));
    this.el.map.addEventListener('pointercancel', (e) => this.#mapPointerUp(e));
    this.el.map.addEventListener('dblclick', (e) => this.#mapDoubleClick(e));
    this.el.map.addEventListener('wheel', (e) => this.#mapWheel(e), { passive: false });
    this.el.map.addEventListener('pointerleave', () => {
      if (this.hover !== -1 || this.hoverItem !== -1) {
        this.hover = -1;
        this.hoverItem = -1;
        this.needsDraw = true;
      }
    });

    this.el.elev.addEventListener('pointerdown', (e) => this.#elevPointerDown(e));
    this.el.elev.addEventListener('pointermove', (e) => this.#elevPointerMove(e));
    this.el.elev.addEventListener('pointerup', (e) => this.#elevPointerUp(e));
    this.el.elev.addEventListener('pointercancel', (e) => this.#elevPointerUp(e));

    this._onKey = (e) => this.#onKey(e);
    window.addEventListener('keydown', this._onKey);

    this.resizeObserver = new ResizeObserver(() => {
      if (!this.isOpen) return;
      this.#resizeCanvases();
      this.#fitView();
      this.needsDraw = true;
    });
    this.resizeObserver.observe(this.root);
  }

  #onKey(e) {
    if (!this.isOpen) return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && e.code === 'KeyY') {
      e.preventDefault();
      this.redo();
    } else if ((e.code === 'Delete' || e.code === 'Backspace') && this.selectedItem >= 0) {
      e.preventDefault();
      this.#deleteItem(this.selectedItem);
    } else if ((e.code === 'Delete' || e.code === 'Backspace') && this.selected >= 0) {
      e.preventDefault();
      this.#deletePoint(this.selected);
    } else if (e.code === 'KeyF') {
      this.#fitView();
      this.needsDraw = true;
    }
  }

  #syncControls() {
    const s = this.state;
    this.el.name.value = s.name;
    this.el.width.value = s.width;
    this.el.widthOut.textContent = `${s.width} m`;
    this.el.bank.value = s.bankStrength;
    this.el.bankOut.textContent = `${Math.round(s.bankStrength * 100)}%`;
    this.#syncUndoButtons();
  }

  #syncUndoButtons() {
    this.el.undo.disabled = this.history.length === 0;
    this.el.redo.disabled = this.future.length === 0;
  }

  #setStatus(text, isError = false) {
    this.el.status.textContent = text;
    this.el.status.classList.toggle('error', isError);
  }

  /* --------------------------- library / sharing --------------------------- */

  #refreshLoadList() {
    const sel = this.el.load;
    sel.innerHTML = '<option value="">Load a saved track…</option>';
    for (const t of listSavedTracks()) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      sel.appendChild(opt);
    }
  }

  #save() {
    try {
      const entry = saveTrack(this.state, this.savedId);
      this.savedId = entry.id;
      this.#refreshLoadList();
      this.el.load.value = entry.id;
      this.#setStatus(`Saved “${entry.name}”`);
    } catch (err) {
      this.#setStatus(`Couldn't save: ${err.message}`, true);
    }
  }

  #loadSelected() {
    const id = this.el.load.value;
    if (!id) return;
    const entry = listSavedTracks().find((t) => t.id === id);
    if (!entry) return;
    this.#replaceTrack(entry.data, { savedId: entry.id });
    this.#setStatus(`Loaded “${entry.name}”`);
  }

  #deleteSaved() {
    const id = this.el.load.value || this.savedId;
    if (!id) {
      this.#setStatus('Pick a saved track to delete first', true);
      return;
    }
    const entry = listSavedTracks().find((t) => t.id === id);
    deleteSavedTrack(id);
    if (this.savedId === id) this.savedId = null;
    this.#refreshLoadList();
    this.#setStatus(entry ? `Deleted “${entry.name}” from saved tracks` : 'Deleted');
  }

  async #share() {
    try {
      const hash = await encodeTrackToHash(this.state);
      const url = `${location.origin}${location.pathname}${hash}`;
      history.replaceState(null, '', hash);
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch {
        /* clipboard may be unavailable; the URL bar now holds the link anyway */
      }
      this.#setStatus(copied ? 'Share link copied to the clipboard (it is also in the address bar)' : 'Share link is in the address bar — copy it from there');
    } catch (err) {
      this.#setStatus(`Couldn't make a link: ${err.message}`, true);
    }
  }

  /* ------------------------------------------------------------------ */
  /* map canvas                                                          */
  /* ------------------------------------------------------------------ */

  #resizeCanvases() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [this.el.map, this.el.elev]) {
      const rect = c.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (c.width !== w * dpr || c.height !== h * dpr) {
        c.width = w * dpr;
        c.height = h * dpr;
      }
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
      c._cssW = w;
      c._cssH = h;
    }
  }

  #fitView() {
    const pts = this.state.points;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [x, , z] of pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    const pad = this.state.width + 30;
    const w = this.el.map._cssW || 300;
    const h = this.el.map._cssH || 300;
    const spanX = maxX - minX + pad * 2;
    const spanZ = maxZ - minZ + pad * 2;
    this.view.scale = Math.min(w / spanX, h / spanZ);
    this.view.cx = (minX + maxX) / 2;
    this.view.cz = (minZ + maxZ) / 2;
  }

  #worldToMap(x, z) {
    const c = this.el.map;
    return [(x - this.view.cx) * this.view.scale + c._cssW / 2, (z - this.view.cz) * this.view.scale + c._cssH / 2];
  }

  #mapToWorld(px, py) {
    const c = this.el.map;
    return [(px - c._cssW / 2) / this.view.scale + this.view.cx, (py - c._cssH / 2) / this.view.scale + this.view.cz];
  }

  #eventPos(e, canvas) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  #hitPoint(px, py) {
    let best = -1;
    let bestD = POINT_HIT_PX * POINT_HIT_PX;
    this.state.points.forEach(([x, , z], i) => {
      const [mx, my] = this.#worldToMap(x, z);
      const d = (mx - px) ** 2 + (my - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  #mapPointerDown(e) {
    const [px, py] = this.#eventPos(e, this.el.map);
    const hit = this.#hitPoint(px, py);
    const itemHit = hit < 0 ? this.#hitItem(px, py) : -1;
    this.el.map.setPointerCapture(e.pointerId);
    if (e.button === 2) {
      if (hit >= 0) this.#deletePoint(hit);
      else if (itemHit >= 0) this.#deleteItem(itemHit);
      return;
    }
    if (hit >= 0) {
      this.selected = hit;
      this.selectedItem = -1;
      this.#snapshot();
      this.drag = { type: 'point', index: hit, moved: false };
    } else if (itemHit >= 0) {
      this.selectedItem = itemHit;
      this.selected = -1;
      this.#snapshot();
      this.drag = { type: 'item', index: itemHit, moved: false };
    } else if (this.tool !== 'select' && this.#roadAt(px, py)) {
      this.#placeItem(px, py);
    } else {
      this.selectedItem = -1;
      this.drag = { type: 'pan', startX: px, startY: py, cx: this.view.cx, cz: this.view.cz };
    }
    this.needsDraw = true;
  }

  #mapPointerMove(e) {
    const [px, py] = this.#eventPos(e, this.el.map);
    if (this.drag?.type === 'point') {
      const [x, z] = this.#mapToWorld(px, py);
      this.#movePoint(this.drag.index, x, z);
      this.drag.moved = true;
      this.needsDraw = true;
    } else if (this.drag?.type === 'item') {
      this.#moveItem(this.drag.index, px, py);
      this.drag.moved = true;
      this.needsDraw = true;
    } else if (this.drag?.type === 'pan') {
      this.view.cx = this.drag.cx - (px - this.drag.startX) / this.view.scale;
      this.view.cz = this.drag.cz - (py - this.drag.startY) / this.view.scale;
      this.needsDraw = true;
    } else {
      const hit = this.#hitPoint(px, py);
      const itemHit = hit < 0 ? this.#hitItem(px, py) : -1;
      if (hit !== this.hover || itemHit !== this.hoverItem) {
        this.hover = hit;
        this.hoverItem = itemHit;
        this.needsDraw = true;
      }
      this.el.map.style.cursor = hit >= 0 || itemHit >= 0 ? 'grab' : this.tool !== 'select' ? 'copy' : 'crosshair';
    }
  }

  #mapPointerUp(e) {
    if ((this.drag?.type === 'point' || this.drag?.type === 'item') && !this.drag.moved) {
      // a click without movement shouldn't leave an undo entry
      this.history.pop();
      this.#syncUndoButtons();
    }
    this.drag = null;
    try {
      this.el.map.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  #mapDoubleClick(e) {
    const [px, py] = this.#eventPos(e, this.el.map);
    if (this.tool !== 'select') return; // double-clicks while placing are just two placements
    if (this.#hitPoint(px, py) >= 0 || this.#hitItem(px, py) >= 0) return;
    const [x, z] = this.#mapToWorld(px, py);
    this.#insertPoint(x, z);
  }

  #mapWheel(e) {
    e.preventDefault();
    const [px, py] = this.#eventPos(e, this.el.map);
    const [wx, wz] = this.#mapToWorld(px, py);
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.view.scale = THREE.MathUtils.clamp(this.view.scale * factor, 0.05, 20);
    // keep the world point under the cursor fixed
    const c = this.el.map;
    this.view.cx = wx - (px - c._cssW / 2) / this.view.scale;
    this.view.cz = wz - (py - c._cssH / 2) / this.view.scale;
    this.needsDraw = true;
  }

  #drawMap() {
    const ctx = this.mapCtx;
    const c = this.el.map;
    const W = c._cssW;
    const H = c._cssH;
    const path = this.path;
    const pts = this.state.points;
    ctx.clearRect(0, 0, W, H);

    // grid
    const step = niceStep(60 / this.view.scale);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    const [x0, z0] = this.#mapToWorld(0, 0);
    const [x1, z1] = this.#mapToWorld(W, H);
    ctx.beginPath();
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
      const [mx] = this.#worldToMap(x, 0);
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, H);
    }
    for (let z = Math.floor(z0 / step) * step; z <= z1; z += step) {
      const [, my] = this.#worldToMap(0, z);
      ctx.moveTo(0, my);
      ctx.lineTo(W, my);
    }
    ctx.stroke();

    if (!path) return;

    // road ribbon, coloured by hue along the track
    const N = path.sampleCount;
    const stride = Math.max(1, Math.floor(N / 500));
    const roadPx = Math.max(2, this.state.width * this.view.scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i < N; i += stride) {
      const j = (i + stride) % N;
      const [ax, ay] = this.#worldToMap(path.positions[i * 3], path.positions[i * 3 + 2]);
      const [bx, by] = this.#worldToMap(path.positions[j * 3], path.positions[j * 3 + 2]);
      const hue = ((i / N) * path.length) / 140; // roughly one rainbow per 36 slats of 4 m
      const y = path.positions[i * 3 + 1];
      const light = 42 + THREE.MathUtils.clamp((y - path.minY) / Math.max(1, path.maxY - path.minY), 0, 1) * 22;
      ctx.strokeStyle = `hsl(${(hue * 360) % 360} 85% ${light}%)`;
      ctx.lineWidth = roadPx;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    // centre line
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    for (let i = 0; i <= N; i += stride) {
      const k = i % N;
      const [mx, my] = this.#worldToMap(path.positions[k * 3], path.positions[k * 3 + 2]);
      if (i === 0) ctx.moveTo(mx, my);
      else ctx.lineTo(mx, my);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // crossings
    for (const cr of this.crossings) {
      const [mx, my] = this.#worldToMap(cr.x, cr.z);
      const ok = cr.clearance >= MIN_CROSSING_CLEARANCE;
      ctx.strokeStyle = ok ? 'rgba(80,200,255,0.9)' : 'rgba(255,80,110,0.95)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(mx, my, roadPx * 0.9 + 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    // direction arrow a little after the start
    {
      const i = Math.min(N - 1, Math.round((20 / path.length) * N));
      const [mx, my] = this.#worldToMap(path.positions[i * 3], path.positions[i * 3 + 2]);
      const ang = Math.atan2(path.tangents[i * 3 + 2], path.tangents[i * 3]);
      drawArrow(ctx, mx, my, ang, Math.max(8, roadPx * 0.6));
    }

    this.#drawItems(ctx);

    // control points
    pts.forEach(([x, , z], i) => {
      const [mx, my] = this.#worldToMap(x, z);
      const isSel = i === this.selected;
      const isHover = i === this.hover;
      const warn = this.warnings.some((w) => w.point === i);
      const r = isSel ? 8 : isHover ? 7 : 5.5;
      ctx.beginPath();
      ctx.arc(mx, my, r, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#ffffff' : warn ? '#ff5a78' : isSel ? '#ffe36b' : '#f3f0ff';
      ctx.fill();
      ctx.lineWidth = isSel ? 3 : 1.5;
      ctx.strokeStyle = isSel ? '#2bd2ff' : 'rgba(10,7,24,0.9)';
      ctx.stroke();
      if (isSel || isHover || this.view.scale > 0.6) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '600 10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(i), mx, my - r - 4);
      }
      // hand-set banking
      if (pts[i].length > 3) {
        ctx.fillStyle = '#2bd2ff';
        ctx.font = '700 9px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${pts[i][3]}°`, mx, my + r + 11);
      }
    });
    this.#syncPointBank();

    // start flag at point 0
    {
      const [mx, my] = this.#worldToMap(pts[0][0], pts[0][2]);
      drawFlag(ctx, mx + 7, my - 7);
    }
  }

  #drawItems(ctx) {
    const scale = this.view.scale;
    this.state.items.forEach((item, i) => {
      const def = ITEM_TYPES[item.type];
      const [mx, my] = this.#itemOnMap(item);
      const sel = i === this.selectedItem;
      const hov = i === this.hoverItem;
      ctx.fillStyle = def.color;
      ctx.strokeStyle = sel ? '#2bd2ff' : hov ? '#ffffff' : 'rgba(10,7,24,0.9)';
      ctx.lineWidth = sel ? 2.5 : 1;
      ctx.beginPath();
      if (item.type === 'mud') {
        // to scale, along the road
        const { s } = itemTrackPos(this.path, item);
        const f = this.path.frameAt(s);
        const ang = Math.atan2(f.tangent.z, f.tangent.x);
        ctx.ellipse(mx, my, Math.max(4, def.hitS * scale), Math.max(3, def.hitL * scale), ang, 0, Math.PI * 2);
      } else if (def.kind === 'obstacle') {
        const r = Math.max(3, def.hitL * scale);
        ctx.rect(mx - r, my - r, r * 2, r * 2);
      } else {
        ctx.arc(mx, my, Math.max(3, Math.min(6, def.hitL * scale)), 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
    });
  }

  /* ------------------------------------------------------------------ */
  /* elevation strip                                                     */
  /* ------------------------------------------------------------------ */

  #elevRange() {
    const pts = this.state.points;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    if (this.path) {
      minY = Math.min(minY, this.path.minY);
      maxY = Math.max(maxY, this.path.maxY);
    }
    const mid = (minY + maxY) / 2;
    const half = Math.max(18, (maxY - minY) / 2 + 6);
    return { lo: mid - half, hi: mid + half };
  }

  #elevToCanvas(s, y) {
    const c = this.el.elev;
    const { lo, hi } = this.#elevRange();
    const padX = 10;
    const padY = 8;
    const x = padX + (s / this.path.length) * (c._cssW - padX * 2);
    const cy = padY + (1 - (y - lo) / (hi - lo)) * (c._cssH - padY * 2);
    return [x, cy];
  }

  #elevCanvasToY(cy) {
    const c = this.el.elev;
    const { lo, hi } = this.#elevRange();
    const padY = 8;
    return lo + (1 - (cy - padY) / (c._cssH - padY * 2)) * (hi - lo);
  }

  #hitElevMarker(px, py) {
    let best = -1;
    let bestD = 12 * 12;
    this.state.points.forEach((p, i) => {
      const [mx, my] = this.#elevToCanvas(this.path.pointArcLengths[i], p[1]);
      const d = (mx - px) ** 2 + (my - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  #elevPointerDown(e) {
    if (!this.path) return;
    const [px, py] = this.#eventPos(e, this.el.elev);
    const hit = this.#hitElevMarker(px, py);
    if (hit < 0) return;
    this.selected = hit;
    this.#snapshot();
    this.el.elev.setPointerCapture(e.pointerId);
    this.drag = { type: 'height', index: hit, startY: this.state.points[hit][1], startPy: py };
    this.needsDraw = true;
  }

  #elevPointerMove(e) {
    if (this.drag?.type !== 'height') {
      if (!this.path) return;
      const [px, py] = this.#eventPos(e, this.el.elev);
      this.el.elev.style.cursor = this.#hitElevMarker(px, py) >= 0 ? 'ns-resize' : 'default';
      return;
    }
    const [, py] = this.#eventPos(e, this.el.elev);
    const { lo, hi } = this.#elevRange();
    const c = this.el.elev;
    const unitsPerPx = (hi - lo) / (c._cssH - 16);
    this.#setHeight(this.drag.index, this.drag.startY - (py - this.drag.startPy) * unitsPerPx);
    this.needsDraw = true;
  }

  #elevPointerUp(e) {
    if (this.drag?.type === 'height') {
      this.drag = null;
      try {
        this.el.elev.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  }

  #drawElevation() {
    const ctx = this.elevCtx;
    const c = this.el.elev;
    const W = c._cssW;
    const H = c._cssH;
    ctx.clearRect(0, 0, W, H);
    const path = this.path;
    if (!path) return;

    const { lo, hi } = this.#elevRange();
    // zero line + a few height ticks
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    const tick = niceStep((hi - lo) / 4);
    for (let y = Math.ceil(lo / tick) * tick; y <= hi; y += tick) {
      const [, cy] = this.#elevToCanvas(0, y);
      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(W, cy);
      ctx.stroke();
      ctx.fillText(`${y}`, 2, cy - 2);
    }

    // profile
    const N = path.sampleCount;
    const stride = Math.max(1, Math.floor(N / 400));
    ctx.beginPath();
    for (let i = 0; i <= N; i += stride) {
      const k = Math.min(i, N - 1);
      const [x, y] = this.#elevToCanvas((k / N) * path.length, path.positions[k * 3 + 1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const [xEnd, yEnd] = this.#elevToCanvas(path.length, path.positions[1]);
    ctx.lineTo(xEnd, yEnd);
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${(i * 60) % 360} 85% 55%)`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineTo(xEnd, H);
    ctx.lineTo(this.#elevToCanvas(0, 0)[0], H);
    ctx.closePath();
    ctx.fillStyle = 'rgba(120, 75, 255, 0.18)';
    ctx.fill();

    // markers
    this.state.points.forEach((p, i) => {
      const [x, y] = this.#elevToCanvas(path.pointArcLengths[i], p[1]);
      const isSel = i === this.selected;
      ctx.beginPath();
      ctx.arc(x, y, isSel ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#ffffff' : isSel ? '#ffe36b' : '#f3f0ff';
      ctx.fill();
      ctx.lineWidth = isSel ? 2.5 : 1;
      ctx.strokeStyle = isSel ? '#2bd2ff' : 'rgba(10,7,24,0.9)';
      ctx.stroke();
    });
  }

  /* ------------------------------------------------------------------ */
  /* 3D: markers + overview camera                                       */
  /* ------------------------------------------------------------------ */

  #buildMarkers() {
    this.markers = new THREE.Group();
    this.markers.name = 'editor-markers';
    this.markerGeo = new THREE.SphereGeometry(1, 16, 12);
    this.markerPool = [];
  }

  #updateMarkers() {
    const pts = this.state.points;
    while (this.markerPool.length < pts.length) {
      const m = new THREE.Mesh(
        this.markerGeo,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }),
      );
      m.renderOrder = 10;
      this.markers.add(m);
      this.markerPool.push(m);
    }
    const camDist = this.camera.position.distanceTo(this.#trackCenter());
    const base = Math.max(1.5, camDist * 0.009);
    for (let i = 0; i < this.markerPool.length; i++) {
      const m = this.markerPool[i];
      if (i >= pts.length) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      m.position.set(pts[i][0], pts[i][1] + 0.5, pts[i][2]);
      const isSel = i === this.selected;
      const warn = this.warnings.some((w) => w.point === i);
      m.scale.setScalar(isSel ? base * 1.6 : base);
      m.material.color.set(i === 0 ? 0xffffff : warn ? 0xff5a78 : isSel ? 0xffe36b : 0x2bd2ff);
    }
  }

  #trackCenter() {
    const pts = this.state.points;
    const c = this._center || (this._center = new THREE.Vector3());
    c.set(0, 0, 0);
    for (const p of pts) c.add(_tmp.set(p[0], p[1], p[2]));
    return c.multiplyScalar(1 / pts.length);
  }

  #trackRadius(center) {
    let r = 0;
    for (const p of this.state.points) r = Math.max(r, _tmp.set(p[0], p[1], p[2]).distanceTo(center));
    return r;
  }

  #updateCamera(dt, time) {
    const o = this.orbit;
    if (time - o.lastInteract > 4) o.angle += dt * 0.06; // gentle auto-orbit when idle
    const center = this.#trackCenter();
    const R = this.#trackRadius(center) + this.state.width;

    // The panel covers the left of the screen: shift the projection so the track is
    // centred in the visible part, and back off far enough for all of it to fit there.
    const W = window.innerWidth;
    const H = window.innerHeight;
    const panelW = Math.min(this.root.getBoundingClientRect().width, W * 0.8);
    const visibleW = Math.max(W * 0.2, W - panelW);
    this.camera.setViewOffset(W, H, -panelW / 2, 0, W, H);
    const fov = THREE.MathUtils.degToRad(55);
    const fit = Math.min(1, (visibleW / H) * 1.0);
    const dist = ((R * 1.1) / Math.tan(fov / 2) / fit) * o.dist;
    const target = _tmp2.set(
      center.x + Math.cos(o.angle) * dist * Math.cos(o.elev),
      center.y + Math.sin(o.elev) * dist,
      center.z + Math.sin(o.angle) * dist * Math.cos(o.elev),
    );
    const k = 1 - Math.exp(-dt * 4);
    this.camera.position.lerp(target, this._camSnapped ? k : 1);
    this._camSnapped = true;
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(center);
    this.camera.fov += (55 - this.camera.fov) * Math.min(1, dt * 4);
    this.camera.updateProjectionMatrix();
  }

  #attach3d() {
    this._camSnapped = false;
    const c = this.canvas3d;
    let drag = null;
    this._on3dDown = (e) => {
      drag = { x: e.clientX, y: e.clientY };
      c.setPointerCapture(e.pointerId);
    };
    this._on3dMove = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      this.orbit.angle += dx * 0.006;
      this.orbit.elev = THREE.MathUtils.clamp(this.orbit.elev - dy * 0.005, 0.12, 1.45);
      this.orbit.lastInteract = performance.now() / 1000;
    };
    this._on3dUp = (e) => {
      drag = null;
      try {
        c.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    this._on3dWheel = (e) => {
      e.preventDefault();
      this.orbit.dist = THREE.MathUtils.clamp(this.orbit.dist * Math.exp(e.deltaY * 0.001), 0.35, 3);
      this.orbit.lastInteract = performance.now() / 1000;
    };
    c.addEventListener('pointerdown', this._on3dDown);
    c.addEventListener('pointermove', this._on3dMove);
    c.addEventListener('pointerup', this._on3dUp);
    c.addEventListener('pointercancel', this._on3dUp);
    c.addEventListener('wheel', this._on3dWheel, { passive: false });
  }

  #detach3d() {
    const c = this.canvas3d;
    c.removeEventListener('pointerdown', this._on3dDown);
    c.removeEventListener('pointermove', this._on3dMove);
    c.removeEventListener('pointerup', this._on3dUp);
    c.removeEventListener('pointercancel', this._on3dUp);
    c.removeEventListener('wheel', this._on3dWheel);
  }
}

/* ---------------------------------------------------------------------- */
/* helpers                                                                 */
/* ---------------------------------------------------------------------- */

const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();

const round1 = (v) => Math.round(v * 10) / 10;

/** Point banking label: positive lifts the right edge, so the road leans left. */
function bankLabel(deg) {
  if (!deg) return '0° flat';
  return `${Math.abs(deg)}° ${deg > 0 ? 'leans left' : 'leans right'}`;
}

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const step = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return step * pow;
}

function drawArrow(ctx, x, y, ang, size) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.6, size * 0.6);
  ctx.lineTo(-size * 0.25, 0);
  ctx.lineTo(-size * 0.6, -size * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawFlag(ctx, x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -14);
  ctx.stroke();
  const s = 3;
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? '#fff' : '#120c22';
      ctx.fillRect(1 + c * s, -14 + r * s, s, s);
    }
  }
  ctx.restore();
}

/**
 * Find places where the track crosses over itself (in the ground plane) and how much
 * vertical clearance there is between the two roads.
 */
function findCrossings(path, segments) {
  const N = path.sampleCount;
  const pts = [];
  for (let k = 0; k < segments; k++) {
    const i = Math.floor((k / segments) * N);
    pts.push({ x: path.positions[i * 3], y: path.positions[i * 3 + 1], z: path.positions[i * 3 + 2], s: (i / N) * path.length });
  }
  const out = [];
  const M = pts.length;
  for (let a = 0; a < M; a++) {
    const a2 = (a + 1) % M;
    for (let b = a + 2; b < M; b++) {
      const b2 = (b + 1) % M;
      if (b2 === a) continue; // adjacent (wrap-around)
      const hit = segmentIntersect(pts[a], pts[a2], pts[b], pts[b2]);
      if (!hit) continue;
      const y1 = pts[a].y + (pts[a2].y - pts[a].y) * hit.t;
      const y2 = pts[b].y + (pts[b2].y - pts[b].y) * hit.u;
      out.push({
        x: pts[a].x + (pts[a2].x - pts[a].x) * hit.t,
        z: pts[a].z + (pts[a2].z - pts[a].z) * hit.t,
        s1: pts[a].s,
        s2: pts[b].s,
        clearance: Math.abs(y1 - y2),
      });
    }
  }
  return out;
}

function segmentIntersect(p, p2, q, q2) {
  const rx = p2.x - p.x;
  const rz = p2.z - p.z;
  const sx = q2.x - q.x;
  const sz = q2.z - q.z;
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const qpx = q.x - p.x;
  const qpz = q.z - p.z;
  const t = (qpx * sz - qpz * sx) / denom;
  const u = (qpx * rz - qpz * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}
