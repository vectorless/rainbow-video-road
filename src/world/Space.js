import * as THREE from 'three';
import { makeRandom } from '../core/prng.js';

/**
 * The void the road floats in: a starfield, a few soft nebula sprites, a couple
 * of planets, and the lights that shade the kart.
 */
export class Space extends THREE.Group {
  constructor(seed = 1) {
    super();
    const rnd = makeRandom(seed ^ 0x9e3779b9);

    this.add(makeStars(rnd, 5000, 900, 1700));
    this.add(makeNebulae(rnd));
    this.add(makePlanets(rnd));

    const hemi = new THREE.HemisphereLight(0x9fb4ff, 0x3b1550, 1.4);
    this.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1e0, 2.2);
    sun.position.set(300, 500, -200);
    this.add(sun);
    this.sun = sun;
  }

  update(time) {
    this.planets.rotation.y = time * 0.004;
  }
}

function makeStars(rnd, count, rMin, rMax) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    // uniform on a shell
    const u = rnd.next() * 2 - 1;
    const phi = rnd.next() * Math.PI * 2;
    const r = rnd.range(rMin, rMax);
    const sq = Math.sqrt(1 - u * u);
    pos[i * 3] = r * sq * Math.cos(phi);
    pos[i * 3 + 1] = r * u;
    pos[i * 3 + 2] = r * sq * Math.sin(phi);
    // mostly white, some warm/cool tints, a few saturated sparks
    const t = rnd.next();
    if (t < 0.08) c.setHSL(rnd.next(), 0.9, 0.7);
    else if (t < 0.4) c.setHSL(0.6, 0.5, 0.85);
    else if (t < 0.6) c.setHSL(0.08, 0.5, 0.85);
    else c.setHSL(0, 0, 0.95);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
    size[i] = rnd.next() < 0.1 ? rnd.range(4, 7) : rnd.range(1.2, 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      varying vec3 vColor;
      varying float vTwinkle;
      uniform float uTime;
      uniform float uPixelRatio;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float tw = 0.75 + 0.25 * sin(uTime * (1.5 + aSize) + position.x * 0.1 + position.y * 0.07);
        vTwinkle = tw;
        gl_PointSize = aSize * uPixelRatio * tw;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vTwinkle;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.2, d);
        gl_FragColor = vec4(vColor * (0.8 + 0.6 * vTwinkle), a);
        #include <colorspace_fragment>
      }
    `,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.name = 'stars';
  return points;
}

function makeNebulae(rnd) {
  const group = new THREE.Group();
  const palette = [0x6a2cff, 0xff3cac, 0x2bd2ff, 0xff8a3c, 0x3cffb0];
  for (let i = 0; i < 7; i++) {
    const tex = makeGlowTexture(new THREE.Color(rnd.pick(palette)));
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: rnd.range(0.18, 0.32),
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(mat);
    const u = rnd.range(-0.5, 0.6);
    const phi = rnd.next() * Math.PI * 2;
    const r = rnd.range(1100, 1500);
    const sq = Math.sqrt(1 - u * u);
    sprite.position.set(r * sq * Math.cos(phi), r * u, r * sq * Math.sin(phi));
    const s = rnd.range(700, 1300);
    sprite.scale.set(s, s * rnd.range(0.5, 1), 1);
    group.add(sprite);
  }
  return group;
}

function makePlanets(rnd) {
  const group = new THREE.Group();
  const defs = [
    { r: 110, color: 0xffb36b, emissive: 0x3a1a05, dist: 1500 },
    { r: 55, color: 0x7aa9ff, emissive: 0x0a1030, dist: 1300 },
  ];
  for (const d of defs) {
    const mat = new THREE.MeshStandardMaterial({
      color: d.color,
      emissive: d.emissive,
      roughness: 0.9,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(d.r, 40, 28), mat);
    const u = rnd.range(-0.1, 0.5);
    const phi = rnd.next() * Math.PI * 2;
    const sq = Math.sqrt(1 - u * u);
    mesh.position.set(d.dist * sq * Math.cos(phi), d.dist * u, d.dist * sq * Math.sin(phi));
    group.add(mesh);

    // ring for the first planet
    if (d.r > 100) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(d.r * 1.35, d.r * 2.1, 64),
        new THREE.MeshBasicMaterial({
          color: 0xffd9b0,
          transparent: true,
          opacity: 0.35,
          side: THREE.DoubleSide,
        }),
      );
      ring.position.copy(mesh.position);
      ring.rotation.set(Math.PI / 2.6, 0.3, 0.2);
      group.add(ring);
    }
  }
  group.name = 'planets';
  return group;
}

function makeGlowTexture(color) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const c = color.getStyle();
  g.addColorStop(0, c.replace('rgb', 'rgba').replace(')', ',0.9)'));
  g.addColorStop(0.4, c.replace('rgb', 'rgba').replace(')', ',0.35)'));
  g.addColorStop(1, c.replace('rgb', 'rgba').replace(')', ',0)'));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Expose planets for the slow rotation in update()
Object.defineProperty(Space.prototype, 'planets', {
  get() {
    return this.getObjectByName('planets');
  },
});
