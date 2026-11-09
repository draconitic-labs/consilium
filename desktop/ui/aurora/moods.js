// aurora/moods.js: palettes, provider worlds and moods.
// Colour lives in narrow spectral glints and provider identity, never as
// rainbow noise. Each mood defines flow structure, energy, trail
// persistence and a 3-stop palette; a provider world tints the whole state
// without erasing the mood's meaning.
(function (global) {
"use strict";
const hx = (s) => [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];

/* Consilium's own identity stays violet; providers are data-driven accents,
   grouped by vendor (see field-state.js). `tint`/`gain` wash the particles;
   `accent`/`mix` re-key the mood palette so mid and high stops carry the
   provider. */
const PROVIDER_WORLDS = {
  consilium: { tint: hx('#8b7cf6'), gain: 0.0,  accent: hx('#8b7cf6'), mix: 0.22 },
  codex:     { tint: hx('#5adbe8'), gain: 0.55, accent: hx('#49d6e6'), mix: 0.58 },
  claude:    { tint: hx('#e8a55a'), gain: 0.55, accent: hx('#f0a852'), mix: 0.58 },
  grok:      { tint: hx('#e06ad4'), gain: 0.5,  accent: hx('#e561d2'), mix: 0.52 },
  gemini:    { tint: hx('#7fd8ff'), gain: 0.5,  accent: hx('#74c8ff'), mix: 0.55 },
  local:     { tint: hx('#8affc9'), gain: 0.45, accent: hx('#7cf2bd'), mix: 0.5 },
};

const MOODS = {
  idle: {
    c0: hx('#2a2f38'), c1: hx('#8a95a3'), c2: hx('#f2f6fb'),
    drift: 1, swirl: 0, stream: 0, formationPull: 0.55,
    energy: 0.22, bright: 0.9, decay: 0.90, irid: 0.18, bloom: 0.55,
    formation: 'terrain',
  },
  thinking: {
    c0: hx('#241a5e'), c1: hx('#8f7ff8'), c2: hx('#efe9ff'),
    drift: 0.1, swirl: 1, stream: 0, formationPull: 0.25,
    energy: 0.6, bright: 1.0, decay: 0.945, irid: 0.5, bloom: 0.85,
    formation: 'scatter',
  },
  streaming: {
    c0: hx('#0a3140'), c1: hx('#58d5e8'), c2: hx('#eafcff'),
    drift: 0.15, swirl: 0, stream: 1, formationPull: 0.3,
    energy: 0.55, bright: 1.0, decay: 0.93, irid: 0.4, bloom: 0.8,
    formation: 'curtain',
  },
  tool: {
    c0: hx('#3d2508'), c1: hx('#e8a145'), c2: hx('#fff1d6'),
    drift: 0.5, swirl: 0.35, stream: 0, formationPull: 0.4,
    energy: 0.48, bright: 0.95, decay: 0.925, irid: 0.32, bloom: 0.7,
    formation: 'scatter',
  },
  error: {
    c0: hx('#3c0a12'), c1: hx('#ff4a5e'), c2: hx('#ffdde1'),
    drift: 0.25, swirl: 0.6, stream: 0, formationPull: 0.3,
    energy: 0.7, bright: 1.0, decay: 0.94, irid: 0.25, bloom: 0.9,
    formation: 'scatter',
  },
  /* empty chat: the silver idle palette held in a slow ring, so the
     provider's hue carries the iris */
  iris: {
    c0: hx('#2a2f38'), c1: hx('#8a95a3'), c2: hx('#f2f6fb'),
    drift: 0.04, swirl: 0.3, stream: 0, formationPull: 0.95,
    energy: 0.32, bright: 0.95, decay: 0.92, irid: 0.3, bloom: 0.75,
    formation: 'ring',
  },
  /* ceremony states */
  calibrating: {
    c0: hx('#20242c'), c1: hx('#aab6c4'), c2: hx('#ffffff'),
    drift: 0, swirl: 0.15, stream: 0, formationPull: 1.0,
    energy: 0.45, bright: 1.0, decay: 0.9, irid: 0.3, bloom: 0.9,
    formation: 'ring',
  },
  hero: {
    c0: hx('#241a5e'), c1: hx('#9a8cf9'), c2: hx('#ffffff'),
    drift: 0.05, swirl: 0.35, stream: 0, formationPull: 0.95,
    energy: 0.5, bright: 1.05, decay: 0.94, irid: 0.6, bloom: 1.0,
    formation: 'ring',
  },
};

/* Spectral LUT stops for iridescent glints (thin-film order). */
const SPECTRAL = [
  hx('#7fd8ff'), hx('#9a8cf9'), hx('#ff7ad9'), hx('#ffd27f'), hx('#8affc9'),
];

global.ConsiliumAuroraMoods = { MOODS, PROVIDER_WORLDS, SPECTRAL };
})(this);
