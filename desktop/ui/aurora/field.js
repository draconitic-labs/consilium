// aurora/field.js: starts the particle field and hands its controls to app.js.
// app.js is a classic script that may run first, so it keeps the wanted
// state and applies it when "consilium-field-ready" fires.

import { initAurora, aurora } from './engine.js';

initAurora(document.getElementById('field'));
window.ConsiliumField = aurora;
document.dispatchEvent(new Event('consilium-field-ready'));
