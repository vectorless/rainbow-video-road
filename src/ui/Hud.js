/** Heads-up display: speed, laps, timers, video status, toasts and the countdown. */
export class Hud {
  constructor(root) {
    this.root = root;
    this.el = {
      speed: root.querySelector('#speed'),
      lap: root.querySelector('#lap'),
      placeBox: root.querySelector('.place'),
      place: root.querySelector('#place'),
      racers: root.querySelector('#racers'),
      lapsTotal: root.querySelector('#laps-total'),
      time: root.querySelector('#time'),
      best: root.querySelector('#best'),
      boost: root.querySelector('#boost-bar i'),
      video: root.querySelector('#video-status'),
      toast: root.querySelector('#toast'),
      itemSlot: root.querySelector('#item-slot'),
      itemIcon: root.querySelector('#item-icon'),
      itemCharges: root.querySelector('#item-charges'),
      coins: root.querySelector('#coins'),
    };
    this._lastCoins = 0;
    this.countdownEl = document.getElementById('countdown');
    this._toastTimer = 0;
    this._lastSpeed = -1;
  }

  show() {
    this.root.classList.remove('hidden');
  }

  hide() {
    this.root.classList.add('hidden');
  }

  update({ speed, lap, lapsTotal, time, best, boost, finished, place = 1, racers = 1, item = null, coins = 0 }) {
    const kmh = Math.round(Math.abs(speed) * 3.1);
    if (kmh !== this._lastSpeed) {
      this.el.speed.textContent = String(kmh);
      this._lastSpeed = kmh;
    }
    this.el.lap.textContent = finished ? '✓' : String(Math.min(lap, lapsTotal));
    this.el.lapsTotal.textContent = String(lapsTotal);
    this.el.time.textContent = formatTime(time);
    this.el.best.textContent = best == null ? '—' : formatTime(best);
    this.el.boost.style.width = `${Math.round(boost * 100)}%`;
    this.el.placeBox.hidden = racers < 2;
    this.el.place.textContent = ordinal(place);
    this.el.racers.textContent = String(racers);
    this.#updateItem(item);
    if (coins !== this._lastCoins) {
      this.el.coins.textContent = String(coins);
      const box = this.el.coins.parentElement;
      box.classList.remove('bump');
      void box.offsetWidth; // restart the animation
      if (coins > this._lastCoins) box.classList.add('bump');
      this._lastCoins = coins;
    }
  }

  /** Held item slot; while the roulette runs, flick through the icons. */
  #updateItem(item) {
    const slot = this.el.itemSlot;
    slot.classList.toggle('empty', !item);
    slot.classList.toggle('rolling', Boolean(item?.rolling));
    let icon = '';
    if (item) icon = item.rolling ? ROLL_ICONS[Math.floor(performance.now() / 70) % ROLL_ICONS.length] : ITEM_ICONS[item.type] || '?';
    if (this.el.itemIcon.textContent !== icon) this.el.itemIcon.textContent = icon;
    const charges = item && !item.rolling && item.charges > 1 ? `×${item.charges}` : '';
    if (this.el.itemCharges.textContent !== charges) this.el.itemCharges.textContent = charges;
  }

  setVideoStatus(text) {
    this.el.video.textContent = text;
  }

  toast(text, ms = 1600) {
    const el = this.el.toast;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  /** Shows "3", "2", "1", "GO!" — resolves when GO appears (racing may begin). */
  countdown(onTick) {
    const el = this.countdownEl;
    el.classList.remove('hidden');
    const steps = ['3', '2', '1', 'GO!'];
    return new Promise((resolve) => {
      let i = 0;
      const tick = () => {
        if (i >= steps.length) {
          el.classList.add('hidden');
          return;
        }
        el.textContent = steps[i];
        el.classList.remove('pop');
        // restart the CSS animation
        void el.offsetWidth;
        el.classList.add('pop');
        onTick?.(steps[i]);
        if (steps[i] === 'GO!') resolve();
        i++;
        this._countdownTimer = setTimeout(tick, i === steps.length ? 900 : 1000);
      };
      tick();
    });
  }

  cancelCountdown() {
    clearTimeout(this._countdownTimer);
    this.countdownEl.classList.add('hidden');
  }
}

const ITEM_ICONS = { boost: '⚡', shield: '🛡️', laser: '🔫', cone: '🚧', mud: '🟤' };
const ROLL_ICONS = Object.values(ITEM_ICONS);

/** 1 → "1st", 2 → "2nd", 11 → "11th" … */
export function ordinal(n) {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return `${n}${suffix}`;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}
