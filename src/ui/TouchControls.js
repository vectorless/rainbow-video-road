/**
 * On-screen controls for phones and tablets.
 *
 *   left half of the screen   drag sideways to steer (analog; a knob follows the thumb)
 *   Brake / Drift             hold
 *   Item / Pause / Camera     tap
 *
 * Gas is automatic while touch controls are in use (brake overrides it, and reverses
 * when stopped). Input.poll() merges this with the keyboard and gamepad, so the game
 * sees one set of axes and actions.
 *
 * The controls show when the device has a coarse pointer, or after the first touch,
 * by putting `touch-ui` on <body>; CSS hides them otherwise.
 */
const STEER_RANGE_PX = 70; // thumb travel for full lock

export class TouchControls {
  constructor(root) {
    this.root = root;
    this.steer = 0;
    this.throttle = 0;
    this.drift = false;
    this.active = false;
    this._actions = new Set();
    this._held = new Set(); // 'brake' | 'drift'
    this._steerPointer = null;

    this.zone = root.querySelector('.touch-steer');
    this.base = root.querySelector('.touch-knob-base');
    this.knob = root.querySelector('.touch-knob');

    if (window.matchMedia?.('(pointer: coarse)').matches) this.#activate();
    window.addEventListener('touchstart', () => this.#activate(), { passive: true, once: true });

    // steering: the first finger down in the zone owns it until lifted
    this.zone.addEventListener('pointerdown', (e) => {
      if (this._steerPointer != null) return;
      e.preventDefault();
      this._steerPointer = e.pointerId;
      this.zone.setPointerCapture(e.pointerId);
      this._originX = e.clientX;
      const r = this.zone.getBoundingClientRect();
      this.base.style.left = `${e.clientX - r.left}px`;
      this.base.style.top = `${e.clientY - r.top}px`;
      this.base.classList.add('live');
      this.#setSteer(0);
    });
    this.zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._steerPointer) return;
      this.#setSteer((e.clientX - this._originX) / STEER_RANGE_PX);
    });
    const release = (e) => {
      if (e.pointerId !== this._steerPointer) return;
      this._steerPointer = null;
      this.base.classList.remove('live');
      this.base.style.left = '';
      this.base.style.top = '';
      this.#setSteer(0);
    };
    this.zone.addEventListener('pointerup', release);
    this.zone.addEventListener('pointercancel', release);

    // buttons
    for (const b of root.querySelectorAll('[data-touch]')) {
      const action = b.dataset.touch;
      const hold = action === 'brake' || action === 'drift';
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        b.classList.add('down');
        if (hold) this._held.add(action);
        else this._actions.add(action);
        navigator.vibrate?.(8);
      });
      const up = () => {
        b.classList.remove('down');
        if (hold) this._held.delete(action);
      };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  #activate() {
    if (this.active) return;
    this.active = true;
    document.body.classList.add('touch-ui');
    window.dispatchEvent(new Event('resize')); // the renderer picks a phone-friendly pixel ratio
  }

  #setSteer(v) {
    this.steer = Math.max(-1, Math.min(1, v));
    this.knob.style.transform = `translateX(${this.steer * STEER_RANGE_PX * 0.6}px)`;
  }

  /** Refresh axes for this frame and hand over tapped actions (pause, camera, item). */
  poll() {
    this.throttle = this._held.has('brake') ? -1 : 1;
    this.drift = this._held.has('drift');
    const actions = [...this._actions];
    this._actions.clear();
    return actions;
  }
}
