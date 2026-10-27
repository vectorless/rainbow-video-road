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
    };
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

  update({ speed, lap, lapsTotal, time, best, boost, finished, place = 1, racers = 1 }) {
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
