/**
 * Binds the settings <aside> to the Settings store: every control with
 * data-setting="key" reads from and writes to the store, outputs show the value.
 */
export class SettingsPanel {
  constructor(settings, { root, toggle, close, randomizeSeed, reset }) {
    this.settings = settings;
    this.root = root;
    this.controls = Array.from(root.querySelectorAll('[data-setting]'));
    this.outputs = new Map(Array.from(root.querySelectorAll('output[data-out]')).map((o) => [o.dataset.out, o]));

    for (const el of this.controls) {
      const key = el.dataset.setting;
      const apply = () => {
        const value = el.type === 'checkbox' ? el.checked : el.value;
        settings.set(key, value);
      };
      el.addEventListener(el.type === 'range' ? 'input' : 'change', apply);
    }

    toggle.addEventListener('click', () => this.toggle());
    close.addEventListener('click', () => this.hide());
    randomizeSeed.addEventListener('click', () => settings.set('seed', Math.floor(Math.random() * 1_000_000)));
    reset.addEventListener('click', () => settings.reset());

    settings.onChange((key) => this.#refresh(key));
    for (const el of this.controls) this.#refresh(el.dataset.setting);
  }

  get visible() {
    return !this.root.classList.contains('hidden');
  }

  toggle() {
    this.root.classList.toggle('hidden');
  }

  show() {
    this.root.classList.remove('hidden');
  }

  hide() {
    this.root.classList.add('hidden');
  }

  #refresh(key) {
    const value = this.settings.get(key);
    for (const el of this.controls) {
      if (el.dataset.setting !== key) continue;
      if (el.type === 'checkbox') el.checked = Boolean(value);
      else if (String(el.value) !== String(value)) el.value = value;
    }
    const out = this.outputs.get(key);
    if (out) out.textContent = formatValue(key, value);
  }
}

function formatValue(key, value) {
  switch (key) {
    case 'hueSpeed':
      return `${(Number(value) * 360).toFixed(0)}°/s`;
    case 'slatsPerRainbow':
      return `${value} slats`;
    case 'saturation':
      return `${Math.round(Number(value) * 100)}%`;
    case 'videoMix':
      return `${Math.round(Number(value) * 100)}%`;
    case 'renderScale':
      return `${Math.round(Number(value) * 100)}%`;
    case 'clipSeconds':
      return `${value}s`;
    case 'pixelCells':
      return `${value} px`;
    default:
      return String(value);
  }
}
