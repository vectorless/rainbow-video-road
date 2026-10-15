import * as THREE from 'three';

/**
 * The look of the road. Each slat tile samples one video stream, pixelates it in
 * tile space, and recolours it toward the slat's rainbow hue:
 *
 *   colorized : the video's hue is replaced with the slat hue (classic rainbow bands)
 *   shifted   : the video's own hues are rotated by the slat hue (keeps more of the clip)
 *
 * `uVideoMix` blends between the two. Tile borders get a bright emissive rainbow line so
 * the slats read as a lattice floating in space, and everything fogs out to the void.
 */

export const COLOR_GLSL = /* glsl */ `
  vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  // A punchier rainbow than plain HSV: slightly biased toward saturated primaries.
  vec3 rainbow(float h) {
    vec3 c = hsv2rgb(vec3(fract(h), 1.0, 1.0));
    return pow(c, vec3(0.85));
  }
`;

const VERT = /* glsl */ `
  attribute float aHue;
  attribute float aRand;

  varying vec2 vUv;
  varying float vHue;
  varying float vRand;
  varying float vFogDepth;

  void main() {
    vUv = uv;
    vHue = aHue;
    vRand = aRand;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uTime;
  uniform float uPixelCells;
  uniform float uHueSpeed;
  uniform float uSaturation;
  uniform float uVideoMix;
  uniform float uVideoAspect;
  uniform vec2 uTileSize;   // world units: (across, along)
  uniform float uFit;       // 1 = cover, 0 = stretch
  uniform float uEdgeGlow;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;

  varying vec2 vUv;
  varying float vHue;
  varying float vRand;
  varying float vFogDepth;

  ${COLOR_GLSL}

  void main() {
    float tileAspect = uTileSize.x / uTileSize.y;

    // 1. Pixelate in tile space so the grid lines up with the slat.
    vec2 cells = vec2(uPixelCells, max(2.0, floor(uPixelCells / tileAspect)));
    vec2 puv = (floor(vUv * cells) + 0.5) / cells;

    // 2. Fit the video into the tile.
    vec2 vuv = puv;
    if (uFit > 0.5) {
      float r = tileAspect / uVideoAspect;
      if (r > 1.0) vuv.y = (puv.y - 0.5) / r + 0.5; // tile is wider than the clip: crop top/bottom
      else         vuv.x = (puv.x - 0.5) * r + 0.5; // tile is taller than the clip: crop sides
    }
    // Video textures are uploaded without GPU sRGB decoding (three.js does the same for
    // its own materials), and the fallback canvases are tagged NoColorSpace, so this is
    // raw display-referred colour — exactly what we want for the hue/saturation work below.
    vec3 video = texture2D(uMap, vuv).rgb;

    // 3. Recolour toward this slat's rainbow hue (in display space, perceptual).
    float hue = fract(vHue + uTime * uHueSpeed);
    vec3 hsv = rgb2hsv(video);
    float value = 0.10 + 0.95 * pow(hsv.z, 0.9);          // lift blacks so dark footage still glows
    float sat = clamp(hsv.y * uSaturation, 0.0, 1.0);

    vec3 colorized = hsv2rgb(vec3(hue, max(sat, 0.75), value));
    vec3 shifted = hsv2rgb(vec3(fract(hsv.x + hue), max(sat, 0.35), value));
    vec3 col = mix(colorized, shifted, uVideoMix);

    // Subtle per-cell sparkle so flat footage still shimmers.
    float cellNoise = fract(sin(dot(floor(vUv * cells) + vRand * 17.0, vec2(12.9898, 78.233))) * 43758.5453);
    col *= 0.92 + 0.16 * cellNoise;

    // 4. Rainbow lattice: glowing border around every tile (in world units).
    vec2 edgeWidth = vec2(0.15, 0.15) / uTileSize;
    vec2 d = min(vUv, 1.0 - vUv);
    float border = 1.0 - smoothstep(0.0, 1.0, min(d.x / edgeWidth.x, d.y / edgeWidth.y));
    vec3 glow = rainbow(hue + 0.08) * uEdgeGlow;
    col = mix(col, glow, border);

    // 5. Fog to the void.
    float fog = smoothstep(uFogNear, uFogFar, vFogDepth);
    col = mix(col, uFogColor, fog);

    // Everything above was display-referred (sRGB); the render pipeline is linear.
    gl_FragColor = sRGBTransferEOTF(vec4(col, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createSlatMaterial(texture, shared) {
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uMap: { value: texture },
      uVideoAspect: { value: 16 / 9 },
      // shared uniforms (same object across all slat materials; set once, applies to all)
      uTime: shared.uTime,
      uPixelCells: shared.uPixelCells,
      uHueSpeed: shared.uHueSpeed,
      uSaturation: shared.uSaturation,
      uVideoMix: shared.uVideoMix,
      uTileSize: shared.uTileSize,
      uFit: shared.uFit,
      uEdgeGlow: shared.uEdgeGlow,
      uFogColor: shared.uFogColor,
      uFogNear: shared.uFogNear,
      uFogFar: shared.uFogFar,
    },
    side: THREE.DoubleSide,
  });
  material.toneMapped = false;
  return material;
}

/** Uniforms shared by every slat material, so one update reaches all of them. */
export function createSharedUniforms(settings) {
  return {
    uTime: { value: 0 },
    uPixelCells: { value: settings.get('pixelCells') },
    uHueSpeed: { value: settings.get('hueSpeed') },
    uSaturation: { value: settings.get('saturation') },
    uVideoMix: { value: settings.get('videoMix') },
    uTileSize: { value: new THREE.Vector2(7, 4) },
    uFit: { value: settings.get('fit') === 'cover' ? 1 : 0 },
    uEdgeGlow: { value: 1.25 },
    // display-referred (sRGB) components, matching the CSS background #07050f
    uFogColor: { value: new THREE.Vector3(0x07 / 255, 0x05 / 255, 0x0f / 255) },
    uFogNear: { value: 140 },
    uFogFar: { value: 420 },
  };
}

/* ------------------------------------------------------------------ */
/* Edge rails: translucent glowing ribbons along both sides of the road */
/* ------------------------------------------------------------------ */

const RAIL_VERT = /* glsl */ `
  attribute float aHue;
  varying vec2 vUv;
  varying float vHue;
  varying float vFogDepth;
  void main() {
    vUv = uv;
    vHue = aHue;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const RAIL_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uHueSpeed;
  uniform float uOpacity;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec2 vUv;
  varying float vHue;
  varying float vFogDepth;

  ${COLOR_GLSL}

  void main() {
    float hue = fract(vHue + uTime * uHueSpeed);
    vec3 col = rainbow(hue);
    // bright at the bottom edge and top rim, translucent in between
    float bottom = 1.0 - smoothstep(0.0, 0.18, vUv.y);
    float top = smoothstep(0.86, 1.0, vUv.y);
    float body = 0.22;
    float a = max(max(bottom, top * 0.9), body) * uOpacity;
    // moving light pulses along the rail
    float pulse = 0.5 + 0.5 * sin(vUv.x * 40.0 - uTime * 6.0);
    col *= 1.0 + 0.6 * pulse * (bottom + top);
    float fog = smoothstep(uFogNear, uFogFar, vFogDepth);
    a *= 1.0 - fog;
    gl_FragColor = vec4(sRGBTransferEOTF(vec4(col, 1.0)).rgb * 1.15, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createRailMaterial(shared) {
  const material = new THREE.ShaderMaterial({
    vertexShader: RAIL_VERT,
    fragmentShader: RAIL_FRAG,
    uniforms: {
      uTime: shared.uTime,
      uHueSpeed: shared.uHueSpeed,
      uOpacity: { value: 1 },
      uFogColor: shared.uFogColor,
      uFogNear: shared.uFogNear,
      uFogFar: shared.uFogFar,
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  material.toneMapped = false;
  return material;
}
