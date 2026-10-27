/**
 * Keyboard + gamepad input, reduced to a few analog axes and edge-triggered actions.
 *
 *   throttle  -1..1  (gas / brake-reverse)
 *   steer     -1..1  (left / right)
 *   drift     bool
 *   actions   { pause, reset, camera, confirm, item }  — true for exactly one poll after pressing
 */
export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.throttle = 0;
    this.steer = 0;
    this.drift = false;
    this.actions = { pause: false, reset: false, camera: false, confirm: false, item: false };
    this.anyInputAt = 0;

    this._pendingActions = new Set();
    this._prevButtons = new Map();

    this._onKeyDown = (e) => {
      if (isTextInput(e.target)) return;
      if (e.repeat) {
        return;
      }
      this.keys.add(e.code);
      this.anyInputAt = performance.now();
      switch (e.code) {
        case 'Escape':
        case 'KeyP':
          this._pendingActions.add('pause');
          break;
        case 'KeyR':
          this._pendingActions.add('reset');
          break;
        case 'KeyC':
          this._pendingActions.add('camera');
          break;
        case 'Enter':
          this._pendingActions.add('confirm');
          break;
        case 'KeyE':
          this._pendingActions.add('item');
          break;
        default:
          break;
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    };
    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
    };
    this._onBlur = () => this.keys.clear();

    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
    this.target = target;
    /** @type {import('../ui/TouchControls.js').TouchControls | null} on-screen controls, if any */
    this.touch = null;
  }

  dispose() {
    this.target.removeEventListener('keydown', this._onKeyDown);
    this.target.removeEventListener('keyup', this._onKeyUp);
    this.target.removeEventListener('blur', this._onBlur);
  }

  /** Call once per frame. */
  poll() {
    const k = this.keys;
    let throttle = 0;
    let steer = 0;
    let drift = false;

    if (k.has('KeyW') || k.has('ArrowUp')) throttle += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) throttle -= 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) steer -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) steer += 1;
    if (k.has('ShiftLeft') || k.has('ShiftRight') || k.has('Space')) drift = true;

    // Gamepad (standard mapping)
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const lx = deadzone(pad.axes[0] ?? 0);
      if (Math.abs(lx) > Math.abs(steer)) steer = lx;
      const gas = buttonValue(pad.buttons[7]);
      const brake = buttonValue(pad.buttons[6]);
      const padThrottle = gas - brake;
      if (Math.abs(padThrottle) > Math.abs(throttle)) throttle = padThrottle;
      if (buttonValue(pad.buttons[0]) > 0.5 || buttonValue(pad.buttons[1]) > 0.5) drift = true;
      this._edge(pad.index, 9, pad.buttons[9], 'pause');
      this._edge(pad.index, 3, pad.buttons[3], 'reset');
      this._edge(pad.index, 2, pad.buttons[2], 'camera');
      this._edge(pad.index, 0, pad.buttons[0], 'confirm');
      this._edge(pad.index, 4, pad.buttons[4], 'item');
      this._edge(pad.index, 5, pad.buttons[5], 'item');
      if (Math.abs(lx) > 0 || Math.abs(padThrottle) > 0) this.anyInputAt = performance.now();
    }

    // On-screen touch controls (phones / tablets)
    const touch = this.touch;
    if (touch?.active) {
      for (const action of touch.poll()) this._pendingActions.add(action);
      if (Math.abs(touch.steer) > Math.abs(steer)) steer = touch.steer;
      if (throttle === 0) throttle = touch.throttle;
      if (touch.drift) drift = true;
    }

    this.throttle = clamp(throttle, -1, 1);
    this.steer = clamp(steer, -1, 1);
    this.drift = drift;

    for (const key of Object.keys(this.actions)) {
      this.actions[key] = this._pendingActions.has(key);
    }
    this._pendingActions.clear();
  }

  _edge(padIndex, buttonIndex, button, action) {
    const key = `${padIndex}:${buttonIndex}`;
    const pressed = buttonValue(button) > 0.5;
    const was = this._prevButtons.get(key) || false;
    if (pressed && !was) this._pendingActions.add(action);
    this._prevButtons.set(key, pressed);
  }
}

function buttonValue(b) {
  if (!b) return 0;
  if (typeof b === 'number') return b;
  return b.value ?? (b.pressed ? 1 : 0);
}

function deadzone(v, dz = 0.12) {
  if (Math.abs(v) < dz) return 0;
  return (Math.sign(v) * (Math.abs(v) - dz)) / (1 - dz);
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function isTextInput(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
