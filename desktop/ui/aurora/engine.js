// aurora/engine.js: the particle field behind the conversation.
// Transform-feedback simulation, half-resolution trail accumulation
// (fibers), bright-pass and dual-Kawase bloom, a composite on pure black,
// then crisp point heads. The DOM above stays transform/opacity only.
//
// Noise chunks adapted from Ashima Arts / Ian McEwan webgl-noise (MIT);
// see THIRD_PARTY_NOTICES.txt.

import { MOODS, PROVIDER_WORLDS, SPECTRAL } from './moods.js';
import { FORMATIONS, textMask, scatter } from './formations.js';

/* hue rotation (Rec. 601 luma axis) — the palette breathes without leaving
   its family; shadows stay anchored so the silver-base law holds */
function hueRotate(c, a) {
  const ca = Math.cos(a), sa = Math.sin(a);
  const m = [
    0.213 + ca * 0.787 - sa * 0.213, 0.715 - ca * 0.715 - sa * 0.715, 0.072 - ca * 0.072 + sa * 0.928,
    0.213 - ca * 0.213 + sa * 0.143, 0.715 + ca * 0.285 + sa * 0.140, 0.072 - ca * 0.072 - sa * 0.283,
    0.213 - ca * 0.213 - sa * 0.787, 0.715 - ca * 0.715 + sa * 0.715, 0.072 + ca * 0.928 + sa * 0.072,
  ];
  return [
    Math.max(0, c[0] * m[0] + c[1] * m[1] + c[2] * m[2]),
    Math.max(0, c[0] * m[3] + c[1] * m[4] + c[2] * m[5]),
    Math.max(0, c[0] * m[6] + c[1] * m[7] + c[2] * m[8]),
  ];
}

/* ───────────────────────── shaders ───────────────────────── */

const SIM_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_vel;
layout(location=2) in vec2 a_seedlife;
layout(location=3) in vec2 a_target;
layout(location=4) in float a_class;

uniform float u_dt;
uniform float u_time;
uniform float u_aspect;
uniform float u_wDrift;
uniform float u_wSwirl;
uniform float u_wStream;
uniform float u_energy;
uniform float u_formationPull;
uniform float u_formationW;
uniform vec3  u_pointer;      // x, y (clip), strength
uniform vec4  u_click;        // x, y, age, strength
uniform vec3  u_lights[4];    // x, y, intensity

out vec2 v_pos;
out vec2 v_vel;
out vec2 v_seedlife;

vec2 hash2(vec2 p){
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453) * 2.0 - 1.0;
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(dot(hash2(i), f), dot(hash2(i + vec2(1, 0)), f - vec2(1, 0)), u.x),
    mix(dot(hash2(i + vec2(0, 1)), f - vec2(0, 1)), dot(hash2(i + vec2(1, 1)), f - vec2(1, 1)), u.x),
    u.y);
}
vec2 curl(vec2 p){
  float e = 0.13;
  float a = vnoise(p + vec2(0.0, e)) - vnoise(p - vec2(0.0, e));
  float b = vnoise(p + vec2(e, 0.0)) - vnoise(p - vec2(e, 0.0));
  return vec2(a, -b) / (2.0 * e);
}
float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }

void main(){
  vec2 p = a_pos;
  vec2 v = a_vel;
  float seed = a_seedlife.x;
  float life = a_seedlife.y;
  float t = u_time;
  vec2 world = vec2(p.x * u_aspect, p.y);
  vec2 acc = vec2(0.0);

  // shared turbulence — the living dust (calms inside strong formations)
  acc += curl(world * 1.25 + vec2(t * 0.03, -t * 0.02) + seed * 3.7)
       * (0.14 + 0.5 * u_energy) * (1.0 - 0.72 * u_formationW);

  if (u_wDrift > 0.001) {
    float band = (fract(seed * 7.919) * 2.0 - 1.0) * 0.9;
    float ridgeY = band + vnoise(vec2(world.x * 1.1 + band * 9.7, t * 0.045 + band * 4.0)) * 0.3;
    acc += vec2(0.026 + 0.05 * u_energy, (ridgeY - p.y) * 1.2) * u_wDrift;
  }
  if (u_wSwirl > 0.001) {
    vec2 r = world + vec2(1e-4);
    float len = length(r);
    vec2 tang = normalize(vec2(-r.y, r.x));
    float targetR = 0.16 + fract(seed * 13.61) * 0.8;
    acc += (tang * (0.5 + 0.85 * fract(seed * 5.13)) * (0.35 + 0.9 * u_energy)
          + normalize(r) * (targetR - len) * 1.5) * u_wSwirl;
  }
  if (u_wStream > 0.001) {
    float wave = sin(world.x * 2.4 + t * 0.7 + seed * 6.283) * 0.15;
    float lane = (fract(seed * 3.77) * 2.0 - 1.0) * 0.85;
    acc += vec2(0.4 + 0.5 * fract(seed * 9.29), (lane + wave - p.y) * 0.85) * u_wStream;
  }

  // formation attraction — shapes condense from the dust
  if (u_formationW > 0.001) {
    vec2 delta = a_target - p;
    acc += delta * (2.2 * u_formationPull * u_formationW);
    v *= mix(1.0, 0.93, u_formationW * u_formationPull); // settle inside forms
  }

  // pointer lens — a wide, gentle vortex: light repulsion, strong stir
  if (u_pointer.z > 0.001) {
    vec2 d = world - vec2(u_pointer.x * u_aspect, u_pointer.y);
    float l = length(d) + 1e-4;
    float fall = exp(-l * 4.4);
    acc += (d / l) * fall * 1.6 * u_pointer.z;
    acc += vec2(-d.y, d.x) / l * fall * 1.2 * u_pointer.z;
  }
  // click ripple — an expanding shell push
  if (u_click.w > 0.001) {
    vec2 d = world - vec2(u_click.x * u_aspect, u_click.y);
    float l = length(d) + 1e-4;
    float ringR = u_click.z * 1.6;
    float shell = exp(-pow((l - ringR) * 9.0, 2.0));
    acc += (d / l) * shell * 2.4 * u_click.w;
  }

  float drag = mix(0.965, 0.915, clamp(u_energy, 0.0, 1.0));
  v = v * drag + acc * u_dt * 1.7;
  float speed = length(v);
  float maxSpeed = 0.32 + 0.5 * u_energy;
  if (speed > maxSpeed) v *= maxSpeed / speed;
  p += v * u_dt * (0.55 + 0.75 * u_energy);

  if (p.x > 1.28) p.x = -1.27; else if (p.x < -1.28) p.x = 1.27;
  if (p.y > 1.18) p.y = -1.17; else if (p.y < -1.18) p.y = 1.17;

  life -= u_dt * (0.012 + fract(seed * 8.31) * 0.028) * (1.0 - 0.75 * u_formationW);
  if (life <= 0.0) {
    p = vec2(rand(vec2(seed, t)) * 2.5 - 1.25, rand(vec2(t, seed)) * 2.3 - 1.15);
    if (u_formationW > 0.5) p = a_target + (vec2(rand(vec2(seed, t + 9.0)), rand(vec2(t + 7.0, seed))) - 0.5) * 0.1;
    v = vec2(0.0);
    life = 0.6 + rand(vec2(seed * 2.7, t * 1.3));
  }

  v_pos = p; v_vel = v; v_seedlife = vec2(seed, life);
}`;

const SIM_FS = `#version 300 es
precision mediump float; out vec4 o; void main(){ o = vec4(0.0); }`;

const POINT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_vel;
layout(location=2) in vec2 a_seedlife;
layout(location=4) in float a_class;

uniform float u_dpr;
uniform float u_time;
uniform float u_energy;
uniform float u_crisp;        // 0 = trail pass (soft), 1 = head pass (sharp)
uniform float u_bokeh;        // bokeh fraction gate
uniform vec3  u_lights[4];
uniform float u_aspect;
uniform vec3  u_pointerP;     // pointer x, y, strength — color heat follows the hand
uniform vec4  u_clickP;       // click x, y, age, strength — spectral shell flash

out float v_mix;
out float v_alpha;
out float v_seed;
out float v_angle;
out float v_class;
out float v_bokeh;
out float v_prox;

void main(){
  float seed = a_seedlife.x;
  float life = a_seedlife.y;
  float speed = length(a_vel);
  gl_Position = vec4(a_pos, 0.0, 1.0);

  float isBokeh = step(1.0 - u_bokeh, fract(seed * 17.77));
  v_bokeh = isBokeh;

  // pointer proximity — the field wakes where the hand passes
  vec2 world = vec2(a_pos.x * u_aspect, a_pos.y);
  float pd = length(world - vec2(u_pointerP.x * u_aspect, u_pointerP.y));
  float prox = exp(-pd * 3.4) * u_pointerP.z;
  float cd = length(world - vec2(u_clickP.x * u_aspect, u_clickP.y));
  float shell = exp(-pow((cd - u_clickP.z * 1.6) * 7.0, 2.0)) * u_clickP.w;
  v_prox = min(prox + shell, 1.2);

  float base = mix(1.4, 2.4, fract(seed * 6.11));
  float size = base * (1.0 + speed * (2.0 + 3.0 * u_energy));
  size *= 1.0 + v_prox * 0.5;
  size = mix(size, 9.0 + fract(seed * 3.3) * 14.0, isBokeh);
  gl_PointSize = clamp(size * u_dpr * mix(1.0, 0.72, u_crisp), 1.0, 30.0 * u_dpr);

  // light response — suns brighten nearby dust
  float lightGain = 0.0;
  for (int i = 0; i < 4; i++) {
    float d = length(world - vec2(u_lights[i].x * u_aspect, u_lights[i].y));
    lightGain += u_lights[i].z / (1.0 + d * d * 14.0);
  }

  v_mix = clamp(speed * (1.8 + 4.5 * u_energy) + fract(seed * 11.317) * 0.35 + lightGain * 0.6 + v_prox * 0.5, 0.0, 1.0);
  float tw = 0.6 + 0.4 * sin(u_time * (0.7 + fract(seed * 5.7) * 2.4) + seed * 40.0);
  v_alpha = tw * smoothstep(0.0, 0.15, life) * (0.45 + 0.55 * clamp(life, 0.0, 1.0)) * (1.0 + lightGain) * (1.0 + v_prox * 0.7);
  v_seed = seed;
  v_angle = atan(a_vel.y, a_vel.x);
  v_class = a_class;
}`;

const POINT_FS = `#version 300 es
precision highp float;
in float v_mix;
in float v_alpha;
in float v_seed;
in float v_angle;
in float v_class;
in float v_bokeh;
in float v_prox;

uniform vec3 u_c0;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_s0; uniform vec3 u_s1; uniform vec3 u_s2; uniform vec3 u_s3; uniform vec3 u_s4;
uniform float u_irid;
uniform float u_bright;
uniform float u_crisp;
uniform vec3 u_tint;
uniform float u_tintGain;

out vec4 o;

vec3 spectral(float t){
  t = fract(t) * 4.0;
  vec3 c = mix(u_s0, u_s1, clamp(t, 0.0, 1.0));
  c = mix(c, u_s2, clamp(t - 1.0, 0.0, 1.0));
  c = mix(c, u_s3, clamp(t - 2.0, 0.0, 1.0));
  c = mix(c, u_s4, clamp(t - 3.0, 0.0, 1.0));
  return c;
}

void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float soft = mix(0.10, 0.30, v_bokeh);
  float core = smoothstep(0.5, soft, r);
  core = mix(core * core, core * 0.35, v_bokeh);

  vec3 col = v_mix < 0.5 ? mix(u_c0, u_c1, v_mix * 2.0) : mix(u_c1, u_c2, v_mix * 2.0 - 1.0);

  // iridescent glints on the energetic tips — and blooming around the hand
  float glintGate = clamp(smoothstep(0.55, 0.9, v_mix) * u_irid + v_prox * u_irid * 0.85, 0.0, 1.0);
  col = mix(col, spectral(v_angle / 6.2831 + v_seed * 0.7), glintGate);

  // provider world tint — hue identity without erasing the silver base
  col = mix(col, col * (0.35 + 1.3 * u_tint), u_tintGain * 0.55);
  col *= 1.0 + v_prox * 0.3;

  float a = v_alpha * u_bright * mix(0.5, 1.0, u_crisp) * mix(1.0, 0.5, v_bokeh);
  o = vec4(col * core * a, 1.0);
}`;

const QUAD_VS = `#version 300 es
precision highp float;
out vec2 v_uv;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FADE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_prev;
uniform float u_decay;
out vec4 o;
void main(){
  vec3 c = texture(u_prev, v_uv).rgb * u_decay;
  c = max(c - 0.0015, 0.0);           // floor kill: fibers fully die out
  o = vec4(c, 1.0);
}`;

const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_threshold;
out vec4 o;
void main(){
  vec3 c = texture(u_src, v_uv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = smoothstep(u_threshold, u_threshold + 0.25, l);
  o = vec4(c * k, 1.0);
}`;

const KAWASE_DOWN_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_halfpixel;
out vec4 o;
void main(){
  vec3 sum = texture(u_src, v_uv).rgb * 4.0;
  sum += texture(u_src, v_uv - u_halfpixel).rgb;
  sum += texture(u_src, v_uv + u_halfpixel).rgb;
  sum += texture(u_src, v_uv + vec2(u_halfpixel.x, -u_halfpixel.y)).rgb;
  sum += texture(u_src, v_uv - vec2(u_halfpixel.x, -u_halfpixel.y)).rgb;
  o = vec4(sum / 8.0, 1.0);
}`;

const KAWASE_UP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_halfpixel;
out vec4 o;
void main(){
  vec3 sum = texture(u_src, v_uv + vec2(-u_halfpixel.x * 2.0, 0.0)).rgb;
  sum += texture(u_src, v_uv + vec2(-u_halfpixel.x, u_halfpixel.y)).rgb * 2.0;
  sum += texture(u_src, v_uv + vec2(0.0, u_halfpixel.y * 2.0)).rgb;
  sum += texture(u_src, v_uv + vec2(u_halfpixel.x, u_halfpixel.y)).rgb * 2.0;
  sum += texture(u_src, v_uv + vec2(u_halfpixel.x * 2.0, 0.0)).rgb;
  sum += texture(u_src, v_uv + vec2(u_halfpixel.x, -u_halfpixel.y)).rgb * 2.0;
  sum += texture(u_src, v_uv + vec2(0.0, -u_halfpixel.y * 2.0)).rgb;
  sum += texture(u_src, v_uv + vec2(-u_halfpixel.x, -u_halfpixel.y)).rgb * 2.0;
  o = vec4(sum / 12.0, 1.0);
}`;

const COMP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_trail;
uniform sampler2D u_bloom;
uniform float u_bloomGain;
uniform float u_time;
uniform float u_dim;          // ceremony and conversation dimmer 0..0.7
out vec4 o;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main(){
  // true black: nothing is drawn where there are no particles
  vec3 trail = texture(u_trail, v_uv).rgb;
  vec3 bloom = texture(u_bloom, v_uv).rgb * u_bloomGain;

  vec3 c = trail + bloom;

  // vignette
  float vig = smoothstep(1.25, 0.35, length(v_uv - 0.5) * 1.9);
  c *= mix(0.55, 1.0, vig);

  // film grain only where light already is, so black stays black
  float g = hash(v_uv * vec2(1920.0, 1080.0) + fract(u_time * 13.7) * 371.0);
  float lit = smoothstep(0.004, 0.06, max(c.r, max(c.g, c.b)));
  c = max(c + (g - 0.5) * 0.028 * lit, 0.0);

  c *= (1.0 - u_dim);
  // gentle filmic-ish shoulder
  c = c / (1.0 + c * 0.6);
  o = vec4(c, 1.0);
}`;

/* ───────────────────────── engine ───────────────────────── */

function compile(gl, vs, fs, tf) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.slice(0, 200));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  if (tf) gl.transformFeedbackVaryings(p, tf, gl.INTERLEAVED_ATTRIBS);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

function makeTarget(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, w, h };
}

class Aurora {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    this.ok = !!this.gl;
    if (!this.ok) return;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.mood = 'idle';
    this.provider = 'consilium';
    this.still = false;
    this.cur = this.snap(MOODS.idle, PROVIDER_WORLDS.consilium);
    this.target = this.snap(MOODS.idle, PROVIDER_WORLDS.consilium);
    this.formationName = null;
    this.formationW = 0; this.formationWTarget = 0;
    this.pointer = { x: 0, y: 0, s: 0 };
    this.click = { x: 0, y: 0, age: 10, s: 0 };
    this.lights = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    this.dim = 0; this.dimTarget = 0;
    this.time = 0; this.last = performance.now();
    this.frameEma = 16; this.running = false;

    const area = Math.max(1, canvas.clientWidth) * Math.max(1, canvas.clientHeight);
    this.count = Math.min(60000, Math.max(16000, Math.floor(area / 30)));

    try { this.build(); } catch (e) { console.error('aurora build failed', e); this.ok = false; return; }
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    document.addEventListener('visibilitychange', () => { document.hidden ? this.stop() : this.start(); });
    const toClip = (e) => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1, -(((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1)];
    };
    addEventListener('pointermove', (e) => {
      [this.pointer.x, this.pointer.y] = toClip(e);
      this.pointer.s = Math.min(1, this.pointer.s + 0.22);
    }, { passive: true });
    addEventListener('pointerdown', (e) => {
      [this.click.x, this.click.y] = toClip(e);
      this.click.age = 0; this.click.s = 0.9;
    }, { passive: true });

    this.setFormation(MOODS.idle.formation, {}, 1);
    this.start();
  }

  snap(m, world) {
    // the provider accent re-keys the palette itself: shadows stay mood-owned,
    // mids lean into the accent, tips carry an accent-warmed white
    const mixv = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const acc = world.accent || world.tint;
    const tip = mixv([1, 1, 1], acc, 0.38);
    const k = world.mix ?? 0;
    return {
      c0: mixv(m.c0, acc.map((v) => v * 0.32), k * 0.3),
      c1: mixv(m.c1, acc, k * 0.5),
      c2: mixv(m.c2, tip, k * 0.65),
      drift: m.drift, swirl: m.swirl, stream: m.stream,
      energy: m.energy, bright: m.bright, decay: m.decay,
      irid: m.irid, bloom: m.bloom, formationPull: m.formationPull,
      tint: [...world.tint], tintGain: world.gain,
    };
  }

  build() {
    const gl = this.gl;
    this.progSim = compile(gl, SIM_VS, SIM_FS, ['v_pos', 'v_vel', 'v_seedlife']);
    this.progPoint = compile(gl, POINT_VS, POINT_FS);
    this.progFade = compile(gl, QUAD_VS, FADE_FS);
    this.progBright = compile(gl, QUAD_VS, BRIGHT_FS);
    this.progDown = compile(gl, QUAD_VS, KAWASE_DOWN_FS);
    this.progUp = compile(gl, QUAD_VS, KAWASE_UP_FS);
    this.progComp = compile(gl, QUAD_VS, COMP_FS);

    const n = this.count;
    const data = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      data[o] = Math.random() * 2.5 - 1.25;
      data[o + 1] = Math.random() * 2.3 - 1.15;
      data[o + 4] = Math.random();
      data[o + 5] = Math.random();
    }
    this.simBufs = [gl.createBuffer(), gl.createBuffer()];
    this.formBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.formBuf);
    gl.bufferData(gl.ARRAY_BUFFER, n * 3 * 4, gl.DYNAMIC_DRAW);

    this.vaos = [gl.createVertexArray(), gl.createVertexArray()];
    for (let i = 0; i < 2; i++) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.simBufs[i]);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_COPY);
      gl.bindVertexArray(this.vaos[i]);
      const stride = 6 * 4;
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 16);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.formBuf);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 12, 0);
      gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 12, 8);
    }
    gl.bindVertexArray(null);
    this.src = 0;
    this.tf = gl.createTransformFeedback();

    this.u = {};
    for (const prog of [this.progSim, this.progPoint, this.progFade, this.progBright, this.progDown, this.progUp, this.progComp]) {
      const count = this.gl.getProgramParameter(prog, this.gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const info = this.gl.getActiveUniform(prog, i);
        const key = info.name.replace('[0]', '');
        (this.u[key] ||= new Map()).set(prog, this.gl.getUniformLocation(prog, info.name));
      }
    }
  }

  set1(prog, name, v) { const l = this.u[name]?.get(prog); if (l) this.gl.uniform1f(l, v); }
  set2(prog, name, a, b) { const l = this.u[name]?.get(prog); if (l) this.gl.uniform2f(l, a, b); }
  set3v(prog, name, v) { const l = this.u[name]?.get(prog); if (l) this.gl.uniform3fv(l, v); }
  setTex(prog, name, unit) { const l = this.u[name]?.get(prog); if (l) this.gl.uniform1i(l, unit); }

  resize() {
    if (!this.ok) return;
    const gl = this.gl;
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    this.dpr = dpr;
    this.canvas.width = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    this.canvas.height = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    this.aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const hw = Math.max(2, this.canvas.width >> 1), hh = Math.max(2, this.canvas.height >> 1);
    const qw = Math.max(2, this.canvas.width >> 2), qh = Math.max(2, this.canvas.height >> 2);
    const ew = Math.max(2, this.canvas.width >> 3), eh = Math.max(2, this.canvas.height >> 3);
    for (const t of [this.trailA, this.trailB, this.bloomQ, this.bloomE, this.bloomQ2].filter(Boolean)) {
      gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex);
    }
    this.trailA = makeTarget(gl, hw, hh);
    this.trailB = makeTarget(gl, hw, hh);
    this.bloomQ = makeTarget(gl, qw, qh);
    this.bloomE = makeTarget(gl, ew, eh);
    this.bloomQ2 = makeTarget(gl, qw, qh);
  }

  /* ── public control ── */
  setMood(name) {
    if (!MOODS[name] || this.mood === name) return;
    this.mood = name;
    this.target = this.snap(MOODS[name], PROVIDER_WORLDS[this.provider] || PROVIDER_WORLDS.consilium);
    if (MOODS[name].formation && MOODS[name].formation !== this.formationName) {
      this.setFormation(MOODS[name].formation, {}, name === 'idle' ? 0.85 : 0.5);
    }
  }
  setProvider(world) {
    this.provider = world && PROVIDER_WORLDS[world] ? world : 'consilium';
    this.target = this.snap(MOODS[this.mood], PROVIDER_WORLDS[this.provider]);
  }
  /* Animated (true) or a still frame (false); the OS reduced-motion setting
     also stops the animation once the field has formed. */
  setMotion(on) {
    this.still = !on;
    if (on) this.start();
  }
  setFormation(name, opts = {}, weight = 0.85) {
    if (!this.ok) return;
    const gen = name === 'text' ? (n) => textMask(n, opts.text || 'CONSILIUM', opts) : (FORMATIONS[name] || scatter);
    const f = gen(this.count, opts);
    const inter = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      inter[i * 3] = f.targets[i * 2];
      inter[i * 3 + 1] = f.targets[i * 2 + 1];
      inter[i * 3 + 2] = f.classes[i];
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.formBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, inter);
    this.formationName = name;
    this.formationWTarget = weight;
  }
  releaseFormation() { this.formationWTarget = 0; }
  setLights(list) {
    for (let i = 0; i < 4; i++) {
      const l = list[i];
      this.lights[i] = l ? [l.x, l.y, l.i] : [0, 0, 0];
    }
  }
  pulse(x = 0, y = 0, s = 0.9) { this.click = { x, y, age: 0, s }; }
  setDim(v) { this.dimTarget = Math.max(0, Math.min(0.7, v)); }

  /* ── frame ── */
  step(now) {
    if (!this.ok || !this.running) return;
    const gl = this.gl;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt * (0.6 + this.cur.energy);

    const k = 1 - Math.exp(-dt * 2.6);
    const lerp = (a, b) => a + (b - a) * k;
    for (const key of ['drift', 'swirl', 'stream', 'energy', 'bright', 'decay', 'irid', 'bloom', 'formationPull', 'tintGain'])
      this.cur[key] = lerp(this.cur[key], this.target[key]);
    for (const key of ['c0', 'c1', 'c2', 'tint'])
      for (let i = 0; i < 3; i++) this.cur[key][i] = lerp(this.cur[key][i], this.target[key][i]);
    this.formationW = lerp(this.formationW, this.formationWTarget);
    this.dim = lerp(this.dim, this.dimTarget);
    this.pointer.s *= Math.exp(-dt * 1.4);
    this.click.age += dt;
    this.click.s *= Math.exp(-dt * 1.4);

    // living color: mids and tips breathe around the mood/provider key,
    // wider when the field is excited; shadows stay anchored
    const breath = (Math.sin(this.time * 0.11) + 0.45 * Math.sin(this.time * 0.047 + 1.7))
                 * (0.05 + 0.11 * this.cur.energy);
    this.disp = {
      c0: this.cur.c0,
      c1: hueRotate(this.cur.c1, breath),
      c2: hueRotate(this.cur.c2, breath * 1.5),
    };

    /* 1 · simulation (transform feedback) */
    gl.useProgram(this.progSim);
    this.set1(this.progSim, 'u_dt', dt);
    this.set1(this.progSim, 'u_time', this.time);
    this.set1(this.progSim, 'u_aspect', this.aspect);
    this.set1(this.progSim, 'u_wDrift', this.cur.drift);
    this.set1(this.progSim, 'u_wSwirl', this.cur.swirl);
    this.set1(this.progSim, 'u_wStream', this.cur.stream);
    this.set1(this.progSim, 'u_energy', this.cur.energy);
    this.set1(this.progSim, 'u_formationPull', this.cur.formationPull);
    this.set1(this.progSim, 'u_formationW', this.formationW);
    { const l = this.u['u_pointer']?.get(this.progSim); if (l) gl.uniform3f(l, this.pointer.x, this.pointer.y, this.pointer.s); }
    { const l = this.u['u_click']?.get(this.progSim); if (l) gl.uniform4f(l, this.click.x, this.click.y, this.click.age, this.click.s); }
    { const l = this.u['u_lights']?.get(this.progSim); if (l) gl.uniform3fv(l, this.lights.flat()); }

    gl.bindVertexArray(this.vaos[this.src]);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.tf);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.simBufs[1 - this.src]);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    this.src = 1 - this.src;

    /* 2 · trail accumulation (half res) */
    const read = this.src === 0 ? this.trailB : this.trailA;   // previous accumulation
    const write = this.src === 0 ? this.trailA : this.trailB;
    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
    gl.viewport(0, 0, write.w, write.h);
    gl.disable(gl.BLEND);
    gl.useProgram(this.progFade);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, read.tex);
    this.setTex(this.progFade, 'u_prev', 0);
    this.set1(this.progFade, 'u_decay', this.cur.decay);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.drawPoints(0.0);

    /* 3 · bloom: bright-pass → kawase down/up */
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomQ.fbo);
    gl.viewport(0, 0, this.bloomQ.w, this.bloomQ.h);
    gl.useProgram(this.progBright);
    gl.bindTexture(gl.TEXTURE_2D, write.tex);
    this.setTex(this.progBright, 'u_src', 0);
    this.set1(this.progBright, 'u_threshold', 0.32);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomE.fbo);
    gl.viewport(0, 0, this.bloomE.w, this.bloomE.h);
    gl.useProgram(this.progDown);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomQ.tex);
    this.setTex(this.progDown, 'u_src', 0);
    this.set2(this.progDown, 'u_halfpixel', 0.5 / this.bloomQ.w, 0.5 / this.bloomQ.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomQ2.fbo);
    gl.viewport(0, 0, this.bloomQ2.w, this.bloomQ2.h);
    gl.useProgram(this.progUp);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomE.tex);
    this.setTex(this.progUp, 'u_src', 0);
    this.set2(this.progUp, 'u_halfpixel', 0.5 / this.bloomE.w, 0.5 / this.bloomE.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* 4 · composite to screen + crisp heads */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.progComp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, write.tex);
    this.setTex(this.progComp, 'u_trail', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomQ2.tex);
    this.setTex(this.progComp, 'u_bloom', 1);
    gl.activeTexture(gl.TEXTURE0);
    this.set1(this.progComp, 'u_bloomGain', this.cur.bloom);
    this.set1(this.progComp, 'u_time', this.time);
    this.set1(this.progComp, 'u_dim', this.dim);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.drawPoints(1.0);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);

    /* adaptive quality */
    const frame = performance.now() - now;
    this.frameEma = this.frameEma * 0.95 + frame * 0.05;
    if (this.frameEma > 24 && this.count > 12000) {
      this.count = Math.floor(this.count * 0.7);
      this.frameEma = 15;
    }

    if ((this.reduced || this.still) && this.time > 2.5) { this.running = false; return; }
    this.raf = requestAnimationFrame((t) => this.step(t));
  }

  drawPoints(crisp) {
    const gl = this.gl;
    gl.useProgram(this.progPoint);
    this.set1(this.progPoint, 'u_dpr', crisp > 0.5 ? this.dpr : this.dpr * 0.5);
    this.set1(this.progPoint, 'u_time', this.time);
    this.set1(this.progPoint, 'u_energy', this.cur.energy);
    this.set1(this.progPoint, 'u_crisp', crisp);
    this.set1(this.progPoint, 'u_bokeh', crisp > 0.5 ? 0.055 : 0.0);
    this.set1(this.progPoint, 'u_aspect', this.aspect);
    const pal = this.disp || this.cur;
    this.set3v(this.progPoint, 'u_c0', pal.c0);
    this.set3v(this.progPoint, 'u_c1', pal.c1);
    this.set3v(this.progPoint, 'u_c2', pal.c2);
    { const l = this.u['u_pointerP']?.get(this.progPoint); if (l) this.gl.uniform3f(l, this.pointer.x, this.pointer.y, this.pointer.s); }
    { const l = this.u['u_clickP']?.get(this.progPoint); if (l) this.gl.uniform4f(l, this.click.x, this.click.y, this.click.age, this.click.s); }
    this.set3v(this.progPoint, 'u_s0', SPECTRAL[0]);
    this.set3v(this.progPoint, 'u_s1', SPECTRAL[1]);
    this.set3v(this.progPoint, 'u_s2', SPECTRAL[2]);
    this.set3v(this.progPoint, 'u_s3', SPECTRAL[3]);
    this.set3v(this.progPoint, 'u_s4', SPECTRAL[4]);
    this.set1(this.progPoint, 'u_irid', this.cur.irid);
    this.set1(this.progPoint, 'u_bright', this.cur.bright * (crisp > 0.5 ? 1.0 : 0.55));
    this.set3v(this.progPoint, 'u_tint', this.cur.tint);
    this.set1(this.progPoint, 'u_tintGain', this.cur.tintGain);
    { const l = this.u['u_lights']?.get(this.progPoint); if (l) this.gl.uniform3fv(l, this.lights.flat()); }
    this.gl.bindVertexArray(this.vaos[this.src]);
    this.gl.drawArrays(this.gl.POINTS, 0, this.count);
  }

  start() { if (this.ok && !this.running) { this.running = true; this.last = performance.now(); this.raf = requestAnimationFrame((t) => this.step(t)); } }
  stop() { this.running = false; if (this.raf) cancelAnimationFrame(this.raf); }
}

/* ── static fallback: prerendered lit terrain, slow pan ── */
function staticFallback(canvas) {
  canvas.style.background = '#000';
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  canvas.width = Math.max(2, canvas.clientWidth); canvas.height = Math.max(2, canvas.clientHeight);
  const rows = 70, perRow = 110;
  for (let r = 0; r < rows; r++) {
    const t = r / rows;
    const y = canvas.height * (0.25 + t * 0.72);
    for (let c = 0; c < perRow; c++) {
      const u = c / perRow * 2 - 1;
      const e = Math.sin(u * 4.1 + r * 0.37) * 0.5 + Math.sin(u * 9.7 - r * 0.21) * 0.3;
      const elev = (e + 1) / 2;
      const x = canvas.width * (0.5 + u * (0.25 + t * 0.3));
      const b = 30 + elev * elev * 180 * (0.3 + t);
      ctx.fillStyle = `rgba(${b + 20},${b + 24},${b + 34},${0.25 + elev * 0.5})`;
      const s = 0.6 + elev * 1.8 * (0.4 + t);
      ctx.fillRect(x, y - elev * 26 * (0.4 + t), s, s);
    }
  }
  return { setMood() {}, setProvider() {}, setMotion() {}, setFormation() {}, releaseFormation() {}, setLights() {}, pulse() {}, setDim() {}, ok: true, fallback: true };
}

let engine = null;
export function initAurora(canvas) {
  try {
    engine = new Aurora(canvas);
    if (!engine.ok) engine = staticFallback(canvas);
  } catch (e) {
    console.error('aurora init failed', e);
    engine = staticFallback(canvas);
  }
  return engine;
}
export const aurora = {
  setMood: (m) => engine?.setMood?.(m),
  setProvider: (p) => engine?.setProvider?.(p),
  setMotion: (on) => engine?.setMotion?.(on),
  setFormation: (n, o, w) => engine?.setFormation?.(n, o, w),
  releaseFormation: () => engine?.releaseFormation?.(),
  setLights: (l) => engine?.setLights?.(l),
  pulse: (x, y, s) => engine?.pulse?.(x, y, s),
  setDim: (v) => engine?.setDim?.(v),
  frameEma: () => engine?.frameEma ?? 0,
};
