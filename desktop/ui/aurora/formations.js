// aurora/formations.js: particle target-shape generators.
// Each generator returns { targets: Float32Array(n*2) in clip space,
// classes: Float32Array(n) } where class ∈ [0,1] feeds hue/brightness
// grouping in the shaders (sector identity, elevation, glyph membership…).

const TAU = Math.PI * 2;

function alloc(n) {
  return { targets: new Float32Array(n * 2), classes: new Float32Array(n) };
}

/* Free drift — targets unused (weight 0), but keep a scatter for morph-outs. */
export function scatter(n) {
  const f = alloc(n);
  for (let i = 0; i < n; i++) {
    f.targets[i * 2] = Math.random() * 2.4 - 1.2;
    f.targets[i * 2 + 1] = Math.random() * 2.2 - 1.1;
    f.classes[i] = Math.random();
  }
  return f;
}

/* Lit dot-terrain (GEO_NOISE law): rows recede upward with perspective,
   elevation = layered sine noise; class = normalized elevation (crest light). */
export function terrain(n, { rows = 90, horizon = 0.15, drop = 0.85 } = {}) {
  const f = alloc(n);
  const perRow = Math.max(8, Math.floor(n / rows));
  let i = 0;
  for (let r = 0; r < rows && i < n; r++) {
    const t = r / (rows - 1);                      // 0 far → 1 near
    const persp = 0.22 + t * t * 1.15;             // row width scale
    const y0 = horizon + 0.08 - t * drop;          // near rows go down
    for (let c = 0; c < perRow && i < n; c++, i++) {
      const u = (c / (perRow - 1)) * 2 - 1;
      const x = u * 1.25 * persp;
      const e =
        Math.sin(u * 4.1 + r * 0.37) * 0.5 +
        Math.sin(u * 9.7 - r * 0.21) * 0.28 +
        Math.sin(u * 2.3 + r * 0.11) * 0.42;
      const elev = (e + 1.2) / 2.4;                // 0..1
      f.targets[i * 2] = x;
      f.targets[i * 2 + 1] = y0 + elev * 0.16 * (0.4 + t);
      f.classes[i] = Math.max(0, Math.min(1, elev * elev * (0.35 + 0.65 * t)));
    }
  }
  for (; i < n; i++) { f.targets[i * 2] = Math.random() * 2.4 - 1.2; f.targets[i * 2 + 1] = Math.random() * 2.2 - 1.1; f.classes[i] = 0.05; }
  return f;
}

/* Ring / iris with hue-by-angle sectors and a calm dark core. */
export function ring(n, { cx = 0, cy = 0.02, r0 = 0.34, r1 = 0.5, sectors = 1, sx = 1 } = {}) {
  const f = alloc(n);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const rr = r0 + (r1 - r0) * Math.pow(Math.random(), 0.6);
    const wob = 1 + Math.sin(a * 5 + rr * 20) * 0.03;
    f.targets[i * 2] = cx + Math.cos(a) * rr * wob * sx;
    f.targets[i * 2 + 1] = cy + Math.sin(a) * rr * wob * 0.98;
    f.classes[i] = sectors > 1 ? Math.floor((a / TAU) * sectors) / (sectors - 1) : a / TAU;
  }
  return f;
}

/* Sphere shell (dandelion / GEO_CIRC): denser at rim via projection. */
export function sphere(n, { cx = 0, cy = 0, r = 0.46 } = {}) {
  const f = alloc(n);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1;               // cosθ uniform on sphere
    const a = Math.random() * TAU;
    const s = Math.sqrt(1 - u * u);
    const x = Math.cos(a) * s, y = Math.sin(a) * s;
    f.targets[i * 2] = cx + x * r;
    f.targets[i * 2 + 1] = cy + y * r * 0.98;
    f.classes[i] = 0.25 + 0.75 * Math.abs(u);      // rim brighter (|z| small → rim… invert)
    f.classes[i] = 0.2 + 0.8 * (1 - Math.abs(u));  // limb-dense look
  }
  return f;
}

/* Vertical fiber curtain (Data Flow walls): columns with flow jitter. */
export function curtain(n, { x0 = -0.9, x1 = 0.9, top = 0.75, bottom = -0.75, cols = 46 } = {}) {
  const f = alloc(n);
  for (let i = 0; i < n; i++) {
    const c = Math.floor(Math.random() * cols);
    const u = c / (cols - 1);
    const x = x0 + (x1 - x0) * u + (Math.random() - 0.5) * 0.015;
    const y = bottom + (top - bottom) * Math.random();
    f.targets[i * 2] = x + Math.sin(y * 5 + u * 9) * 0.02;
    f.targets[i * 2 + 1] = y;
    f.classes[i] = u;
  }
  return f;
}

/* Hourglass waist (Data Strings pinch) — continuity iconography. */
export function waist(n, { cx = 0, cy = 0, spread = 0.85, height = 0.62 } = {}) {
  const f = alloc(n);
  for (let i = 0; i < n; i++) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const t = Math.pow(Math.random(), 0.8);        // 0 waist → 1 edge
    const x = cx + side * t * spread;
    const env = Math.pow(t, 1.4) * height;         // pinch envelope
    const y = cy + (Math.random() * 2 - 1) * env;
    f.targets[i * 2] = x;
    f.targets[i * 2 + 1] = y + Math.sin(x * 6) * 0.02 * t;
    f.classes[i] = 1 - t;                          // heat at the waist
  }
  return f;
}

/* Text mask: rasterize glyphs offscreen, emit targets on ink pixels. */
export function textMask(n, text, { fontPx = 160, font = '700 {px}px "Space Grotesk", sans-serif', cx = 0, cy = 0, width = 1.5 } = {}) {
  const cnv = document.createElement('canvas');
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  cnv.width = 900; cnv.height = 260;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cnv.width, cnv.height);
  ctx.fillStyle = '#fff';
  ctx.font = font.replace('{px}', fontPx);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, cnv.width / 2, cnv.height / 2);
  const img = ctx.getImageData(0, 0, cnv.width, cnv.height).data;
  const ink = [];
  for (let y = 0; y < cnv.height; y += 2) {
    for (let x = 0; x < cnv.width; x += 2) {
      if (img[(y * cnv.width + x) * 4] > 128) ink.push(x, y);
    }
  }
  const f = alloc(n);
  const aspect = cnv.height / cnv.width;
  const h = width * aspect;
  if (!ink.length) return scatter(n);
  for (let i = 0; i < n; i++) {
    const k = (Math.random() * (ink.length / 2)) | 0;
    const px = ink[k * 2], py = ink[k * 2 + 1];
    f.targets[i * 2] = cx + (px / cnv.width - 0.5) * width + (Math.random() - 0.5) * 0.004;
    f.targets[i * 2 + 1] = cy - (py / cnv.height - 0.5) * h + (Math.random() - 0.5) * 0.004;
    f.classes[i] = 0.55 + Math.random() * 0.45;
  }
  return f;
}

export const FORMATIONS = { scatter, terrain, ring, sphere, curtain, waist };
