// Run with: node field-state.test.js
const assert = require("assert");
const { WORLDS, worldForProvider, moodForState } = require("./field-state.js");

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

console.log("field-state tests passed");
