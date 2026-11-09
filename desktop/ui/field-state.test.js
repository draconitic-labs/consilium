// Run with: node field-state.test.js
const assert = require("assert");
const { WORLDS, worldForProvider, moodForState, particleStart, isSoftwareRenderer, isIdleMood } = require("./field-state.js");

// every vendor's CLI and direct API share one hue world
assert.strictEqual(worldForProvider("codex"), "codex");
assert.strictEqual(worldForProvider("openai-api"), "codex");
assert.strictEqual(worldForProvider("claude"), "claude");
assert.strictEqual(worldForProvider("anthropic-api"), "claude");
assert.strictEqual(worldForProvider("grok"), "grok");
assert.strictEqual(worldForProvider("xai-api"), "grok");
assert.strictEqual(worldForProvider("gemini"), "gemini");
assert.strictEqual(worldForProvider("gemini-api"), "gemini");
assert.strictEqual(worldForProvider("openai-compatible"), "local");

// routes without their own world, unknown ids and bad input use Consilium violet
for (const id of ["mistral-api", "deepseek-api", "copilot", "kiro", "", "toString", "__proto__", null, undefined, 7]) {
  assert.strictEqual(worldForProvider(id), "consilium", String(id));
}

// every world the map can return has a stylesheet and particle palette entry
const fs = require("fs");
const path = require("path");
const css = fs.readFileSync(path.join(__dirname, "style.css"), "utf8");
const moods = fs.readFileSync(path.join(__dirname, "aurora", "moods.js"), "utf8");
for (const world of WORLDS) {
  if (world !== "consilium") {
    assert.ok(css.includes(`body[data-world="${world}"]`), `style.css lacks ${world}`);
  }
  assert.ok(new RegExp(`\\b${world}:\\s*\\{`).test(moods), `moods.js lacks ${world}`);
}

// request states drive the field's motion
assert.strictEqual(moodForState("thinking…"), "thinking");
assert.strictEqual(moodForState("reasoning…"), "thinking");
assert.strictEqual(moodForState("writing…"), "streaming");
assert.strictEqual(moodForState("finishing…"), "streaming");
assert.strictEqual(moodForState("startup failed"), "error");
for (const text of ["ready", "stopping…", "provider is still stopping…", "", undefined]) {
  assert.strictEqual(moodForState(text), "idle", String(text));
}

// the particle-field startup decision
const start = (overrides) =>
  particleStart({ envDisabled: false, motionOn: true, previousFroze: false, consecutiveFreezes: 0, ...overrides });
assert.deepStrictEqual(start({}), { webgl: true, turnOff: false, reason: "ok" });
// CONSILIUM_PARTICLES=0 wins over everything else
assert.deepStrictEqual(start({ envDisabled: true, previousFroze: true, consecutiveFreezes: 5 }), {
  webgl: false, turnOff: false, reason: "environment",
});
// one frozen start: still image this session, setting untouched, next launch retries
assert.deepStrictEqual(start({ previousFroze: true, consecutiveFreezes: 1 }), {
  webgl: false, turnOff: false, reason: "froze",
});
// two in a row: still image and the setting goes off
assert.deepStrictEqual(start({ previousFroze: true, consecutiveFreezes: 2 }), {
  webgl: false, turnOff: true, reason: "froze",
});
assert.strictEqual(start({ previousFroze: true, consecutiveFreezes: 3 }).turnOff, true);
// a count from earlier freezes alone does not block a start that is not frozen
assert.strictEqual(start({ consecutiveFreezes: 2 }).webgl, true);
// the user's setting off means no WebGL at all
assert.deepStrictEqual(start({ motionOn: false }), { webgl: false, turnOff: false, reason: "setting" });

// software renderers start the field as a still image
for (const name of [
  "llvmpipe (LLVM 19.1.7, 256 bits)",
  "ANGLE (Mesa, llvmpipe (LLVM 19.1.7, 256 bits), OpenGL ES 3.2)",
  "softpipe",
  "Gallium 0.4 on softpipe",
  "Google SwiftShader",
  "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
  "Microsoft Basic Render Driver",
  "Software Rasterizer",
  "Mesa OffScreen",
  "llvmpipe",
  "lavapipe",
]) {
  assert.strictEqual(isSoftwareRenderer(name), true, name);
}
for (const name of [
  "NVIDIA GeForce RTX 4060/PCIe/SSE2",
  "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060/PCIe/SSE2, OpenGL ES 3.2 NVIDIA 615.78.08)",
  "AMD Radeon RX 7800 XT (radeonsi, navi32, LLVM 19.1.7, DRM 3.59)",
  "Mesa Intel(R) UHD Graphics 620 (KBL GT2)",
  "WebKit WebGL",
  "",
  undefined,
]) {
  assert.strictEqual(isSoftwareRenderer(name), false, String(name));
}

// only moods with nothing happening run at the low frame rate
assert.strictEqual(isIdleMood("idle"), true);
assert.strictEqual(isIdleMood("iris"), true);
for (const mood of ["thinking", "streaming", "error", "calibrating", "tool", undefined]) {
  assert.strictEqual(isIdleMood(mood), false, String(mood));
}

console.log("field-state tests passed");
