import * as THREE from 'three';

/**
 * Procedural "test card" textures used before a video folder is chosen (and for any
 * stream that has nothing to play). Each one is a tiny animated canvas with its own
 * pattern so the road already looks alive in the menu.
 */
export class FallbackTexture {
  constructor(index) {
    this.index = index;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 96;
    this.canvas.height = 54;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.texture = new THREE.CanvasTexture(this.canvas);
    // Raw (undecoded) upload, like three.js does for video textures: the slat shader
    // works in display space and decodes once at the end.
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.kind = index % 4;
    this.phase = index * 1.7;
    this.aspect = 16 / 9;
    this.draw(0);
  }

  draw(time) {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    const t = time + this.phase;
    switch (this.kind) {
      case 0: {
        // scrolling colour bars
        const bars = 8;
        for (let i = 0; i < bars + 1; i++) {
          const x = ((i / bars) * w + ((t * 30) % (w / bars))) - w / bars;
          ctx.fillStyle = `hsl(${(i * 45 + t * 20) % 360} 90% 55%)`;
          ctx.fillRect(x, 0, w / bars + 1, h);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(0, h * 0.7, w, h * 0.3);
        break;
      }
      case 1: {
        // bouncing circles
        ctx.fillStyle = '#101020';
        ctx.fillRect(0, 0, w, h);
        for (let i = 0; i < 5; i++) {
          const x = w * (0.5 + 0.42 * Math.sin(t * (0.7 + i * 0.13) + i));
          const y = h * (0.5 + 0.42 * Math.cos(t * (0.9 + i * 0.11) + i * 2));
          ctx.fillStyle = `hsl(${(i * 70 + t * 40) % 360} 95% 60%)`;
          ctx.beginPath();
          ctx.arc(x, y, 7 + 4 * Math.sin(t + i), 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 2: {
        // plasma
        const img = ctx.getImageData(0, 0, w, h);
        const d = img.data;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const v =
              Math.sin(x * 0.12 + t) +
              Math.sin((y * 0.17 + t * 0.8)) +
              Math.sin((x * 0.08 + y * 0.1 + t * 0.5)) +
              Math.sin(Math.hypot(x - w / 2, y - h / 2) * 0.15 - t);
            const k = (y * w + x) * 4;
            d[k] = 128 + 127 * Math.sin(v * 1.2);
            d[k + 1] = 128 + 127 * Math.sin(v * 1.2 + 2.1);
            d[k + 2] = 128 + 127 * Math.sin(v * 1.2 + 4.2);
            d[k + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);
        break;
      }
      default: {
        // zooming grid
        ctx.fillStyle = '#0b0718';
        ctx.fillRect(0, 0, w, h);
        const cell = 8 + ((t * 6) % 8);
        ctx.strokeStyle = `hsl(${(t * 30) % 360} 90% 60%)`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let x = (t * 10) % cell; x < w; x += cell) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
        }
        for (let y = (t * 7) % cell; y < h; y += cell) {
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
        }
        ctx.stroke();
        ctx.fillStyle = `hsl(${(t * 30 + 180) % 360} 90% 60%)`;
        const s = 10 + 6 * Math.sin(t * 2);
        ctx.fillRect(w / 2 - s / 2, h / 2 - s / 2, s, s);
      }
    }
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }
}
