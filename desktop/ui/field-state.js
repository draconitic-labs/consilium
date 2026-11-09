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

  const api = { WORLD_BY_PROVIDER, WORLDS, worldForProvider, moodForState };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.ConsiliumFieldState = api;
  }
})(this);
