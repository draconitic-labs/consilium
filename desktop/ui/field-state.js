// Maps Consilium state onto the particle field: which hue world a provider
// belongs to, and which motion (mood) a request state shows. Pure functions,
// shared by the desktop UI and its Node tests.
(function (global) {
  "use strict";

  // Routes from the same vendor share a world, so a CLI and its direct API
  // look alike. Anything unlisted uses Consilium's own violet.
  const WORLD_BY_PROVIDER = Object.freeze({
    codex: "codex",
    "openai-api": "codex",
    claude: "claude",
    "anthropic-api": "claude",
    grok: "grok",
    "xai-api": "grok",
    gemini: "gemini",
    "gemini-api": "gemini",
    "openai-compatible": "local",
  });

  const WORLDS = Object.freeze(["consilium", "codex", "claude", "grok", "gemini", "local"]);

  function worldForProvider(providerId) {
    if (typeof providerId !== "string") return "consilium";
    return Object.prototype.hasOwnProperty.call(WORLD_BY_PROVIDER, providerId)
      ? WORLD_BY_PROVIDER[providerId]
      : "consilium";
  }

  // The status line text is the request lifecycle the UI already tracks.
  function moodForState(stateText) {
    switch (stateText) {
      case "thinking…":
      case "reasoning…":
        return "thinking";
      case "writing…":
      case "finishing…":
        return "streaming";
      case "startup failed":
        return "error";
      default:
        return "idle";
    }
  }

  // How to start the particle field this session, from the startup guard's
  // check (see desktop/src-tauri/src/particles.rs) and the user's setting.
  // "webgl" starts the animated field; otherwise the still fallback is drawn
  // and WebGL is never touched. Two frozen starts in a row turn the setting off.
  function particleStart({ envDisabled, motionOn, previousFroze, consecutiveFreezes }) {
    if (envDisabled) return { webgl: false, turnOff: false, reason: "environment" };
    if (previousFroze) {
      return { webgl: false, turnOff: (consecutiveFreezes || 0) >= 2, reason: "froze" };
    }
    if (!motionOn) return { webgl: false, turnOff: false, reason: "setting" };
    return { webgl: true, turnOff: false, reason: "ok" };
  }

  // GL renderers that draw in software: the animated field would keep most of
  // a CPU core busy, so it starts as a still image there.
  const SOFTWARE_RENDERER =
    /llvmpipe|softpipe|lavapipe|swiftshader|basic render|software rasterizer|swrast|mesa offscreen|mesa x11/i;

  function isSoftwareRenderer(name) {
    return typeof name === "string" && SOFTWARE_RENDERER.test(name);
  }

  // Moods where nothing is happening; the field drops to a low frame rate.
  function isIdleMood(mood) {
    return mood === "idle" || mood === "iris";
  }

  const api = {
    WORLD_BY_PROVIDER,
    WORLDS,
    worldForProvider,
    moodForState,
    particleStart,
    isSoftwareRenderer,
    isIdleMood,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.ConsiliumFieldState = api;
  }
})(this);
