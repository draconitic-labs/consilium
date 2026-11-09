// aurora/field.js: starts the particle field and hands its controls to app.js.
// It waits until app.js has finished its first load, then applies the wanted
// field state when "consilium-field-ready" fires.
(function () {
  "use strict";
  function start() {
    const { initAurora, aurora } = window.ConsiliumAurora;
    initAurora(document.getElementById("field"));
    window.ConsiliumField = aurora;
    document.dispatchEvent(new Event("consilium-field-ready"));
  }
  const later = () => setTimeout(start, 0);
  if (window.ConsiliumUiReady) later();
  else document.addEventListener("consilium-ui-ready", later, { once: true });
})();
