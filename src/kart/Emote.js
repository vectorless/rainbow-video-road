import * as THREE from 'three';

const SHOW_SECONDS = 1.8;
const textures = new Map();

/** One canvas texture per emoji, shared by every bubble. */
function emojiTexture(emoji) {
  if (textures.has(emoji)) return textures.get(emoji);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  // speech-bubble disc with a little tail
  g.fillStyle = 'rgba(255, 255, 255, 0.92)';
  g.beginPath();
  g.arc(64, 56, 50, 0, Math.PI * 2);
  g.moveTo(50, 98);
  g.lineTo(64, 124);
  g.lineTo(78, 98);
  g.fill();
  g.font = '64px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(emoji, 64, 60);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  textures.set(emoji, t);
  return t;
}

/**
 * A speech bubble with an emoji that pops up over a kart for a moment, so the
 * rivals' reactions (hit, revenge, overtaking…) are visible. Attach it to the kart
 * model; it always faces the camera.
 */
export class Emote extends THREE.Sprite {
  constructor(height = 3.4) {
    super(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false }));
    this.position.y = height;
    this.renderOrder = 5;
    this.visible = false;
    this.life = 0;
    this.cooldown = 0;
  }

  /** Show an emoji; returns false if one was shown too recently (unless forced). */
  show(emoji, { force = false } = {}) {
    if (this.cooldown > 0 && !force) return false;
    this.material.map = emojiTexture(emoji);
    this.material.needsUpdate = true;
    this.life = SHOW_SECONDS;
    this.cooldown = SHOW_SECONDS + 1.2;
    this.visible = true;
    return true;
  }

  hide() {
    this.life = 0;
    this.visible = false;
  }

  update(dt) {
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.life <= 0) return;
    this.life -= dt;
    const age = SHOW_SECONDS - this.life;
    // pop in, hold, shrink away
    const pop = Math.min(1, age / 0.15) * (1 + 0.25 * Math.max(0, 1 - age / 0.3));
    const out = Math.min(1, this.life / 0.25);
    this.scale.setScalar(1.7 * pop * out);
    this.material.opacity = out;
    if (this.life <= 0) this.visible = false;
  }
}
