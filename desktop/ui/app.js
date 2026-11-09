"use strict";

// Slash commands — every entry is implemented.
const COMMANDS = [
  { name: "/help", desc: "show commands and keys" },
  { name: "/clear", desc: "clear the transcript (keeps context)" },
  { name: "/new", desc: "start a fresh session (resets context)" },
  { name: "/model", desc: "show or set the model — /model [name]" },
];

const $ = (id) => document.getElementById(id);
const transcript = $("transcript");
const emptyState = $("empty-state");
const input = $("input");
const sendBtn = $("send");
const stopBtn = $("stop");
const slashMenu = $("slash-menu");
const stateDot = $("state-dot");
const stateText = $("state-text");
const chipsRow = $("chips");
const fileInput = $("file-input");
const sessionsEl = $("sessions");
const providerSelect = $("provider-select");
const connectorsEl = $("connectors");
const modelSelect = $("model-select");
const effortSelect = $("effort-select");
const agentToggle = $("agent-toggle");
const routingProfileSelect = $("routing-profile-select");
const requestState = window.ConsiliumRequestState;
const fieldState = window.ConsiliumFieldState;
const GROK_DEFAULT_MODEL = "grok-4.5";

let invoke, listen;
let messages = []; // {role, content} — sent to the backend
let attachments = []; // {kind:'image'|'text', name, mime?, data?, text?}
let busy = false;
let transitioning = false;
let terminalizing = false;
let streamBody = null; // .answer element of the streaming assistant message
let streamText = "";
let thinkText = "";
let thinkEls = null; // {details, pre} for the current message's thinking panel
let activeRequestId = null;
let requestSnapshot = null;
let requestSubmission = null;
let slashSelection = 0;
let currentId = crypto.randomUUID();
let grokSession = null;
let activeProvider = "grok";
let activeRoutingProfile = "manual";
let providersById = {}; // id -> provider metadata from the desktop backend
// Short display name of the active provider's agent, used to label assistant
// messages ("Grok", "Claude", "Codex", …). Set from the provider catalog.
let assistantName = "Grok";
let modelSupportsEffort = false;
let implicitDefaultModel = null;

/* ------- particle field ------- */
// aurora/field.js is a module and may finish loading after this script, so
// the wanted field state lives here and is applied once the field is ready.
// On an empty chat the field forms an iris above the title; during a
// conversation it dims and follows the request (thinking, writing, error).
const MOTION_KEY = "consilium.motion";
const fieldWanted = { world: "consilium", mood: "idle", motion: true };
let fieldScene = null; // "empty" or "conversation"
let fieldMoodShown = null;
let fieldSwitching = false;
let fieldErrorUntil = 0;

function field() {
  return window.ConsiliumField || null;
}

function fieldReady() {
  if (field()) return Promise.resolve();
  return new Promise((resolve) =>
    document.addEventListener("consilium-field-ready", () => resolve(), { once: true })
  );
}

function readMotionPreference() {
  try {
    return localStorage.getItem(MOTION_KEY) !== "off";
  } catch {
    return true;
  }
}

// The iris is a circle centred in the free space above the empty-state title.
function irisAboveTitle() {
  const canvas = $("field");
  const title = emptyState.querySelector("h1");
  if (!canvas || !title) return {};
  const c = canvas.getBoundingClientRect();
  const t = title.getBoundingClientRect();
  const top = transcript.getBoundingClientRect().top;
  if (!c.height || !c.width) return {};
  const space = Math.max(0, t.top - top - 24);
  const radius = Math.max(56, Math.min(c.height * 0.25, space / 2));
  const centerY = top + 12 + space / 2 - c.top;
  return {
    cx: ((t.left + t.width / 2 - c.left) / c.width) * 2 - 1,
    cy: -((centerY / c.height) * 2 - 1),
    r0: (radius * 0.62) / (c.height / 2),
    r1: radius / (c.height / 2),
    sx: c.height / c.width,
  };
}

function syncField(reform = false) {
  const f = field();
  if (!f || fieldSwitching) return;
  const scene = emptyState.hidden ? "conversation" : "empty";
  const mood = fieldWanted.mood === "idle" && scene === "empty" ? "iris" : fieldWanted.mood;
  const changed = reform || scene !== fieldScene || mood !== fieldMoodShown;
  fieldScene = scene;
  fieldMoodShown = mood;
  f.setDim(scene === "empty" ? 0 : 0.45);
  f.setMood(mood);
  if (changed && mood === "iris") f.setFormation("ring", irisAboveTitle(), 0.9);
}

function setFieldWorld(providerId) {
  const world = fieldState.worldForProvider(providerId);
  document.body.dataset.world = world;
  fieldWanted.world = world;
  if (!fieldSwitching) field()?.setProvider(world);
}

function setFieldMood(mood) {
  if (mood === "idle" && Date.now() < fieldErrorUntil) return;
  fieldWanted.mood = mood;
  syncField();
}

function flashFieldError() {
  fieldErrorUntil = Date.now() + 2400;
  fieldWanted.mood = "error";
  syncField();
  setTimeout(() => {
    if (Date.now() >= fieldErrorUntil) setFieldMood(fieldState.moodForState(stateText.textContent));
  }, 2500);
}

function beginProviderCeremony(provider) {
  const started = performance.now();
  fieldSwitching = true;
  document.body.classList.add("switching");
  document.body.dataset.world = "consilium";
  $("switch-label").textContent = `Loading ${provider.name}`;
  $("switch-veil").classList.add("on");
  const f = field();
  if (f) {
    f.setProvider("consilium");
    f.setMood("calibrating");
    f.setDim(0.35);
    const c = $("field").getBoundingClientRect();
    f.setFormation("ring", { cx: 0, cy: 0, r0: 0.22, r1: 0.36, sx: c.width ? c.height / c.width : 1 }, 0.9);
  }
  return async function endProviderCeremony(providerId) {
    const elapsed = performance.now() - started;
    if (elapsed < 350) await new Promise((resolve) => setTimeout(resolve, 350 - elapsed));
    fieldSwitching = false;
    $("switch-veil").classList.remove("on");
    document.body.classList.remove("switching");
    setFieldWorld(providerId);
    field()?.pulse(0, 0, 0.7);
    syncField(true);
  };
}

async function bootField() {
  await fieldReady();
  const f = field();
  if (!f) return;
  fieldWanted.motion = readMotionPreference();
  f.setMotion(fieldWanted.motion);
  f.setProvider(fieldWanted.world);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (fieldWanted.motion && !reduced && !emptyState.hidden && !fieldSwitching) {
    // the wordmark forms from the particles, then becomes the iris
    try {
      await document.fonts.load('700 150px "Space Grotesk"');
    } catch {
      // the wordmark falls back to the system face
    }
    const iris = irisAboveTitle();
    f.setMood("calibrating");
    f.setFormation(
      "text",
      { text: "CONSILIUM", fontPx: 150, cx: iris.cx || 0, cy: iris.cy || 0.3, width: 1.05 },
      0.95
    );
    await new Promise((resolve) => setTimeout(resolve, 1400));
  }
  document.body.classList.remove("booting");
  syncField(true);
}

// The empty-state text stays hidden while the wordmark forms; never longer.
setTimeout(() => document.body.classList.remove("booting"), 4000);

new MutationObserver(() => syncField()).observe(emptyState, {
  attributes: true,
  attributeFilter: ["hidden"],
});
let fieldResizeTimer = null;
addEventListener("resize", () => {
  clearTimeout(fieldResizeTimer);
  fieldResizeTimer = setTimeout(() => syncField(true), 200);
});

/* ------- state / status ------- */
function setControlsBusy(isBusy) {
  const locked = isBusy || transitioning || terminalizing;
  const disabled = requestState.controlsDisabled(
    locked,
    modelSupportsEffort,
    routingProfileSelect.value || "manual"
  );
  providerSelect.disabled = disabled.provider;
  modelSelect.disabled = disabled.model;
  effortSelect.disabled = disabled.effort;
  agentToggle.disabled = disabled.agent;
  routingProfileSelect.disabled = disabled.routing;
  $("new-chat").disabled = disabled.session;
  $("attach").disabled = disabled.attachment;
  connectorsEl
    .querySelectorAll("button.connector, button.connector-login")
    .forEach((button) => (button.disabled = locked));
  sessionsEl.setAttribute("aria-busy", String(locked));
  transcript.setAttribute("aria-busy", String(locked));
}

function setState(text, isBusy) {
  const locked = isBusy || transitioning || terminalizing;
  stateText.textContent = text;
  stateDot.classList.toggle("busy", isBusy);
  sendBtn.hidden = isBusy;
  stopBtn.hidden = !isBusy;
  sendBtn.disabled = locked;
  stopBtn.disabled = !isBusy || terminalizing;
  setControlsBusy(isBusy);
  setFieldMood(fieldState.moodForState(text));
}

function refreshConversationModeLabel() {
  const label = $("info-conversation");
  if (label) label.textContent = agentToggle.checked ? "Agent · provider tools" : "Chat · no tools";
}

async function refreshStatus() {
  const status = await invoke("status");
  if (status.error) {
    $("setup-error").textContent = status.error;
    $("setup-screen").hidden = false;
    return false;
  }
  $("setup-screen").hidden = true;
  $("info-mode").textContent = status.mode;
  $("info-model").textContent = status.model;
  $("info-session").textContent = status.session;
  activeProvider = status.provider || activeProvider;
  setFieldWorld(activeProvider);
  if (providerSelect && providersById[activeProvider]) {
    providerSelect.value = activeProvider;
    assistantName = providersById[activeProvider].name.split(/\s+/)[0];
  }
  grokSession = status.session_id || null;
  if (hasSelectOption(routingProfileSelect, status.routing_profile)) {
    routingProfileSelect.value = status.routing_profile;
  }
  activeRoutingProfile = status.routing_profile || "manual";
  if (activeRoutingProfile === "agent-tools") agentToggle.checked = true;
  refreshConversationModeLabel();
  $("route-explanation").textContent = status.route_explanation || "";
  setControlsBusy(busy);
  return status;
}

/* ------- transcript rendering ------- */
function nearBottom() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
}

function addMessage(role, who) {
  emptyState.hidden = true;
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;
  const label = document.createElement("div");
  label.className = "who";
  label.textContent = who;
  const body = document.createElement("div");
  body.className = "body";
  msg.append(label, body);
  transcript.appendChild(msg);
  transcript.scrollTop = transcript.scrollHeight;
  return body;
}

function addInfo(text) {
  addMessage("info", "·").textContent = text;
}

function appendAttachmentMetadata(body, attachmentItems, contentUnavailable = false) {
  const metadata = requestState.sanitizeAttachmentMetadata(attachmentItems);
  if (!metadata.length) return;
  const row = document.createElement("div");
  row.className = "sent-chips";
  for (const attachment of metadata) {
    const item = document.createElement("span");
    item.className = "sent-chip";
    const icon = attachment.kind === "image" ? "🖼" : "📄";
    const size = attachment.size_bytes
      ? ` · ${attachment.size_bytes < 1024 ? `${attachment.size_bytes} B` : `${Math.ceil(attachment.size_bytes / 1024)} KB`}`
      : "";
    item.textContent = `${icon} ${attachment.name}${size}${
      contentUnavailable ? " · reattach for follow-up" : ""
    }`;
    if (contentUnavailable) {
      item.title = "Only attachment metadata is stored; the file contents are not available after reload.";
    }
    row.appendChild(item);
  }
  body.appendChild(row);
}

// Assistant message with a collapsible "thinking" panel above the answer.
// Returns { answer, showThinking(text) } — the panel only appears once
// reasoning actually arrives.
function addAssistantMessage() {
  emptyState.hidden = true;
  const msg = document.createElement("div");
  msg.className = "msg assistant";
  const label = document.createElement("div");
  label.className = "who";
  label.textContent = assistantName;
  const answer = document.createElement("div");
  answer.className = "body answer";
  msg.append(label, answer);
  transcript.appendChild(msg);
  transcript.scrollTop = transcript.scrollHeight;

  let details = null;
  let pre = null;
  const showThinking = (text) => {
    if (!details) {
      details = document.createElement("details");
      details.className = "thinking";
      details.open = true;
      const summary = document.createElement("summary");
      summary.innerHTML = '<span class="think-spark">✦</span> Thinking';
      pre = document.createElement("pre");
      details.append(summary, pre);
      msg.insertBefore(details, answer);
    }
    pre.textContent = text;
  };
  return { msg, answer, showThinking, getDetails: () => details };
}

function clearTranscriptDom() {
  transcript.querySelectorAll(".msg").forEach((m) => m.remove());
  emptyState.hidden = false;
}

function renderStoredMessage(m) {
  if (m.role === "user") {
    const body = addMessage("user", "You");
    body.textContent = m.content;
    appendAttachmentMetadata(body, m.attachments, true);
  } else if (m.role === "assistant") {
    // rebuild the collapsible thinking panel (collapsed) if this message
    // was saved with reasoning, so it survives reloads and restarts
    const view = addAssistantMessage();
    if (m.thinking) {
      view.showThinking(m.thinking);
      const d = view.getDetails();
      if (d) d.open = false;
    }
    view.answer.innerHTML = renderMarkdown(m.content);
  } else if (m.role === "error") {
    addMessage("error", "✗ error").textContent = m.content;
  } else if (m.role === "info") {
    addInfo(m.content);
  }
}

/* ------- session history ------- */
function sessionTitle() {
  const first = messages.find((m) => m.role === "user");
  const firstText = first ? first.displayContent ?? first.content : "New chat";
  let t = firstText.split("\n")[0].trim();
  if (!t && first?.attachments?.length) t = `Attachment: ${first.attachments[0].name}`;
  return t.length > 42 ? t.slice(0, 42) + "…" : t || "New chat";
}

function selectedRuntimeSnapshot() {
  return requestState.snapshotRuntime({
    provider: activeProvider,
    model: modelSelect.value || null,
    effort: effortSelect.value,
    agent: agentToggle.checked,
    routingProfile: routingProfileSelect.value || "manual",
  });
}

async function persistSession(runtimeOverride = null) {
  if (messages.length === 0) return;
  const runtime = runtimeOverride || selectedRuntimeSnapshot();
  try {
    await invoke("save_session", {
      session: {
        id: currentId,
        title: sessionTitle(),
        updated_ms: 0, // set server-side
        grok_session: grokSession,
        runtime: {
          provider: runtime.provider,
          agent: runtime.agent,
          model: runtime.model,
          effort: runtime.effort,
          routing_profile: runtime.routingProfile,
        },
        messages: messages.map(requestState.persistableMessage),
      },
    });
    await refreshSessions();
    return true;
  } catch (error) {
    await showStorageFailure(error);
    return false;
  }
}

function relTime(ms) {
  const d = Date.now() - ms;
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}

let sessionList = [];

async function refreshSessions() {
  try {
    sessionList = await invoke("list_sessions");
    $("storage-alert").hidden = true;
  } catch (error) {
    await showStorageFailure(error);
    return;
  }
  renderSessionList();
}

function renderSessionList() {
  const query = $("session-search").value.trim().toLowerCase();
  const shown = query
    ? sessionList.filter((meta) => meta.title.toLowerCase().includes(query))
    : sessionList;
  sessionsEl.innerHTML = "";
  if (query && !shown.length) {
    const none = document.createElement("div");
    none.className = "sessions-empty";
    none.textContent = "No chats match.";
    sessionsEl.appendChild(none);
  }
  for (const meta of shown) {
    const item = document.createElement("div");
    item.className = "session-item" + (meta.id === currentId ? " active" : "");
    item.dataset.world = fieldState.worldForProvider(meta.provider);
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = meta.title;
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = relTime(meta.updated_ms);
    const del = document.createElement("button");
    del.className = "del";
    del.title = "Delete";
    del.setAttribute("aria-label", `Delete ${meta.title}`);
    del.textContent = "✕";
    del.disabled = busy || transitioning;
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (busy || transitioning) return;
      if (!window.confirm(`Delete “${meta.title}”? This cannot be undone.`)) return;
      transitioning = true;
      setControlsBusy(true);
      try {
        await invoke("delete_session", { id: meta.id });
        if (meta.id === currentId) {
          await invoke("new_session");
          currentId = crypto.randomUUID();
          grokSession = null;
          messages = [];
          attachments = [];
          renderChips();
          clearTranscriptDom();
          await refreshStatus();
        }
        await refreshSessions();
      } catch (error) {
        await showStorageFailure(error);
      } finally {
        transitioning = false;
        setControlsBusy(busy);
      }
    });
    item.append(title, time, del);
    item.addEventListener("click", () => loadSession(meta.id));
    item.tabIndex = busy || transitioning ? -1 : 0;
    item.setAttribute("role", "button");
    item.setAttribute("aria-label", `Open chat: ${meta.title}`);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        loadSession(meta.id);
      }
    });
    sessionsEl.appendChild(item);
  }
}

$("session-search").addEventListener("input", renderSessionList);

async function showStorageFailure(error) {
  const alert = $("storage-alert");
  const restore = $("restore-backup");
  let health = null;
  try {
    health = await invoke("session_store_health");
  } catch (_) {
    // The original storage error remains the useful message.
  }
  $("storage-alert-text").textContent = health
    ? `${String(error)} History file: ${health.path}`
    : String(error);
  restore.hidden = !health?.backup_available;
  if (health?.backup_available) {
    restore.title = `Restore ${health.backup_path}`;
  }
  alert.hidden = false;
}

async function loadSession(id) {
  if (busy || transitioning) return;
  transitioning = true;
  setControlsBusy(true);
  try {
    let stored;
    try {
      stored = await invoke("load_session", { id });
    } catch (error) {
      await showStorageFailure(error);
      return;
    }

    const runtime = stored.runtime || null;
    const previousRuntime = selectedRuntimeSnapshot();
    const expectedProvider = runtime?.provider || (stored.grok_session ? "grok" : null);
    const targetAgent = runtime ? !!runtime.agent : false;
    const savedRoutingProfile = runtime?.routing_profile || "manual";
    const restoredMessages = (stored.messages || []).map(requestState.normalizeStoredMessage);

    // The transcript is the durable user asset. Render it before attempting
    // any provider-specific restoration, and keep it visible even when an
    // installed CLI, model alias, or endpoint has changed since it was saved.
    currentId = stored.id;
    grokSession = null;
    messages = restoredMessages;
    attachments = [];
    renderChips();
    clearTranscriptDom();
    messages.forEach(renderStoredMessage);

    let restoredProviderSession = null;
    let runtimeWarning = "";

    try {
      if (runtime || expectedProvider) {
        if (savedRoutingProfile === "manual") {
          if (activeRoutingProfile !== "manual") {
            await invoke("set_routing_profile", {
              profileId: "manual",
              agent: targetAgent,
            });
          }
          if (expectedProvider) {
            const provider = providersById[expectedProvider];
            const supportsTargetMode = targetAgent
              ? provider?.supports_agent
              : provider?.supports_chat;
            if (!provider || !supportsTargetMode) {
              throw new Error(
                `${expectedProvider} is unavailable for the saved ${targetAgent ? "Agent" : "Chat"} mode`
              );
            }
            await invoke("set_provider", { providerId: expectedProvider });
          }
        } else {
          const routed = await invoke("set_routing_profile", {
            profileId: savedRoutingProfile,
            agent: targetAgent,
          });
          if (expectedProvider && routed.provider !== expectedProvider) {
            throw new Error(
              `the ${savedRoutingProfile} profile now selects ${
                providersById[routed.provider]?.name || routed.provider
              } instead of ${providersById[expectedProvider]?.name || expectedProvider}`
            );
          }
        }
        agentToggle.checked = targetAgent;

        let status = await refreshStatus();
        activeProvider = status.provider || activeProvider;
        activeRoutingProfile = status.routing_profile || savedRoutingProfile;
        await populateProviders();
        await populateModels();

        if (expectedProvider && activeProvider !== expectedProvider) {
          throw new Error(`the selected provider is now ${activeProvider}`);
        }

        const savedModel = requestState.normalizeImplicitModel(runtime?.model, activeProvider);
        if (!savedModel && !requestState.supportsImplicitModelDefault(activeProvider)) {
          throw new Error("the saved direct route did not record its required model ID");
        }
        await invoke("restore_model_for_session", { model: savedModel });
        status = await refreshStatus();
        if (!requestState.savedModelMatchesStatus(savedModel, status.model, activeProvider)) {
          throw new Error(
            `the saved model ${savedModel || "default"} does not match ${status.model || "the current model"}`
          );
        }
        await populateModels();
        if (savedModel) {
          ensureModelOption(savedModel);
          modelSelect.value = savedModel;
        }
        syncEffortAvailability();

        const effort = runtime?.effort || "default";
        if (!hasSelectOption(effortSelect, effort)) {
          throw new Error(`the saved thinking level ${effort} is unavailable for this model`);
        }
        effortSelect.value = effort;
        await invoke("set_effort", { effort });

        restoredProviderSession = requestState.providerSessionForRestore(
          stored.grok_session,
          runtime,
          activeProvider
        );
        await invoke("resume_session", {
          grokSession: restoredProviderSession,
          agent: targetAgent,
          effort: effort === "default" ? null : effort,
          ownerProvider: activeProvider,
        });
        grokSession = restoredProviderSession;
      } else {
        // A transcript with no historical runtime metadata remains useful,
        // but no cached native provider context can be trusted for it.
        await invoke("new_session");
      }
    } catch (error) {
      restoredProviderSession = null;
      grokSession = null;
      runtimeWarning = `The saved runtime could not be resumed (${String(
        error
      )}). The transcript is intact, and incompatible native context was not resumed.`;
      try {
        agentToggle.checked = previousRuntime.agent;
        if (previousRuntime.routingProfile === "manual") {
          await invoke("set_routing_profile", {
            profileId: "manual",
            agent: previousRuntime.agent,
          });
          await invoke("set_provider", { providerId: previousRuntime.provider });
        } else {
          await invoke("set_routing_profile", {
            profileId: previousRuntime.routingProfile,
            agent: previousRuntime.agent,
          });
        }
        const rollbackStatus = await refreshStatus();
        await populateProviders();
        await populateModels();
        if (rollbackStatus?.provider === previousRuntime.provider) {
          await invoke("restore_model_for_session", { model: previousRuntime.model });
          await invoke("set_effort", { effort: previousRuntime.effort || "default" });
        }
      } catch (rollbackError) {
        runtimeWarning += ` Runtime selection rollback also reported: ${String(rollbackError)}.`;
      }
      try {
        await invoke("new_session");
      } catch (resetError) {
        runtimeWarning += ` Runtime reset also reported: ${String(resetError)}.`;
      }
    }

    await refreshStatus();
    await populateProviders();
    await populateModels();
    await refreshRouteDecision();
    await refreshSessions();
    if (runtimeWarning) addInfo(runtimeWarning);
  } finally {
    transitioning = false;
    setControlsBusy(busy);
  }
}

async function newChat(announce = true) {
  if (busy || transitioning) return;
  transitioning = true;
  setControlsBusy(true);
  try {
    await invoke("new_session");
    currentId = crypto.randomUUID();
    grokSession = null;
    messages = [];
    attachments = [];
    renderChips();
    clearTranscriptDom();
    await refreshStatus();
    await refreshSessions();
    if (announce) addInfo("Started a new session — context reset.");
  } catch (error) {
    addInfo(`Could not start a new session: ${String(error)}`);
  } finally {
    transitioning = false;
    setControlsBusy(busy);
  }
}

/* ------- attachments ------- */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function addAttachment(file) {
  if (busy || transitioning || !file) return;
  if (attachments.length >= 12) {
    addInfo("Attach at most 12 files to one message.");
    return;
  }
  const aggregateBytes = attachments.reduce((total, item) => total + (item.bytes || 0), 0);
  if (aggregateBytes + file.size > 24 * 1024 * 1024) {
    addInfo(`${file.name}: combined attachments may be at most 24 MB.`);
    return;
  }
  if (file.type.startsWith("image/")) {
    if (file.size > 20 * 1024 * 1024) {
      addInfo(`${file.name}: image too large (max 20 MB).`);
      return;
    }
    attachments.push({
      kind: "image",
      name: file.name || "pasted image",
      bytes: file.size,
      mime: file.type,
      data: await fileToBase64(file),
    });
  } else {
    if (file.size > 512 * 1024) {
      addInfo(`${file.name}: text files up to 512 KB only.`);
      return;
    }
    attachments.push({ kind: "text", name: file.name, bytes: file.size, text: await file.text() });
  }
  renderChips();
}

function renderChips() {
  chipsRow.hidden = attachments.length === 0;
  chipsRow.innerHTML = "";
  attachments.forEach((a, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const icon = a.kind === "image" ? "🖼" : "📄";
    chip.textContent = `${icon} ${a.name}`;
    const x = document.createElement("button");
    x.textContent = "✕";
    x.type = "button";
    x.setAttribute("aria-label", `Remove ${a.name}`);
    x.addEventListener("click", () => {
      attachments.splice(i, 1);
      renderChips();
    });
    chip.appendChild(x);
    chipsRow.appendChild(chip);
  });
}

$("attach").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  for (const f of fileInput.files) await addAttachment(f);
  fileInput.value = "";
  input.focus();
});

document.addEventListener("paste", async (e) => {
  for (const item of e.clipboardData.items) {
    if (item.kind === "file") {
      e.preventDefault();
      await addAttachment(item.getAsFile());
    }
  }
});

for (const evt of ["dragover", "drop"]) {
  document.addEventListener(evt, async (e) => {
    e.preventDefault();
    if (evt === "drop") {
      for (const f of e.dataTransfer.files) await addAttachment(f);
    }
  });
}

/* ------- streaming ------- */
let streamMsg = null; // the current addAssistantMessage() handle

// Final answer text for the current stream. In CHAT mode, stripAgentPreamble
// trims a CLI's workspace-oriented opener on ambiguous prompts. In AGENT mode
// replies are legitimately action-oriented
// ("Creating the file…", "Setting up the project…") — never strip those, or
// real work gets replaced with a dismissive fallback.
function finalAnswerText(runtime = requestSnapshot) {
  if (runtime?.agent) return streamText;
  return stripAgentPreamble(streamText);
}

async function reconcileCompletedRuntime(runtime) {
  const status = await refreshStatus();
  if (status?.provider && status.provider !== runtime.provider) {
    const provider = providersById[status.provider];
    const label = streamMsg?.msg.querySelector(".who");
    if (label && provider) label.textContent = provider.name.split(/\s+/)[0];
    await populateModels();
  }
  const provider = status?.provider || runtime.provider;
  const routeChanged = provider !== runtime.provider;
  const model = routeChanged
    ? modelSelect.value ||
      (requestState.supportsImplicitModelDefault(provider) ? null : status?.model || null)
    : runtime.model;
  const effort = routeChanged && status?.effort !== "default" ? status.effort : routeChanged ? null : runtime.effort;
  return requestState.snapshotRuntime({
    ...runtime,
    provider,
    model,
    effort,
  });
}

function finalizeStream(suffix, runtime = requestSnapshot) {
  if (!streamBody) return;
  streamBody.classList.remove("streaming");
  streamBody.innerHTML = renderMarkdown(finalAnswerText(runtime) + (suffix || ""));
  // collapse the thinking panel once the answer is in
  if (streamMsg) {
    const d = streamMsg.getDetails();
    if (d) d.open = false;
  }
  streamBody = null;
  streamMsg = null;
  thinkText = "";
  busy = false;
  setState("ready", false);
}

function discardStreamWithoutAnswer() {
  if (streamMsg?.msg) streamMsg.msg.remove();
  streamBody = null;
  streamMsg = null;
  streamText = "";
  thinkText = "";
  busy = false;
  setState("ready", false);
}

function restoreRejectedSubmission() {
  const submission = requestSubmission;
  requestSubmission = null;
  if (!submission) return;
  if (messages.at(-1) === submission.message) messages.pop();
  if (submission.userBody?.parentElement) submission.userBody.parentElement.remove();
  attachments = submission.attachments.map((attachment) => ({ ...attachment }));
  renderChips();
  input.value = input.value.trim()
    ? `${submission.text}\n${input.value}`
    : submission.text;
  autosize();
}

async function sendMessage(text) {
  const runtime = selectedRuntimeSnapshot();
  requestSnapshot = runtime;
  const pendingAttachments = attachments.map((attachment) => ({ ...attachment }));
  const attachmentMetadata = requestState.sanitizeAttachmentMetadata(pendingAttachments);
  let content = text;
  for (const a of pendingAttachments.filter((a) => a.kind === "text")) {
    content += `\n\n[Attached file: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\``;
  }
  const images = pendingAttachments
    .filter((a) => a.kind === "image")
    .map((a) => ({ data: a.data, mime: a.mime }));
  attachments = [];
  renderChips();

  const userMessage = {
    role: "user",
    content,
    displayContent: text,
    ...(attachmentMetadata.length ? { attachments: attachmentMetadata } : {}),
  };
  messages.push(userMessage);
  const userBody = addMessage("user", "You");
  userBody.textContent = text;
  appendAttachmentMetadata(userBody, attachmentMetadata);

  streamText = "";
  thinkText = "";
  streamMsg = addAssistantMessage();
  streamBody = streamMsg.answer;
  streamBody.classList.add("streaming");
  busy = true;
  setState("thinking…", true);
  const requestId = crypto.randomUUID();
  activeRequestId = requestId;
  requestSubmission = {
    text,
    content,
    attachments: pendingAttachments,
    message: userMessage,
    userBody,
  };

  try {
    await invoke("send", {
      requestId,
      messages: [...messages],
      images,
      agent: runtime.agent,
    });
  } catch (e) {
    if (activeRequestId === requestId) activeRequestId = null;
    if (streamMsg) streamMsg.msg.remove();
    restoreRejectedSubmission();
    streamBody = null;
    streamMsg = null;
    requestSnapshot = null;
    busy = false;
    flashFieldError();
    setState("ready", false);
    addMessage("error", "✗ error").textContent = String(e);
  }
}

/* ------- slash commands ------- */
function runSlashCommand(line) {
  const [cmd, ...args] = line.slice(1).trim().split(/\s+/);
  switch (cmd) {
    case "help":
      addInfo(
        "Commands: /help, /clear (clear transcript, keep context), /new (fresh session), /model [name].\n" +
          "Keys: Enter send · Shift+Enter newline · Tab complete · Esc clear input.\n" +
          "Attach: 📎 button, paste an image, or drop files onto the window.\n" +
          "Below the composer: pick a Model and Thinking level. Agent mode uses only connectors with a native tool-enabled runtime; Chat mode does not enable tools."
      );
      break;
    case "clear":
      clearTranscriptDom();
      break;
    case "new":
      newChat();
      break;
    case "model":
      if (args[0]) {
        const requested = args[0];
        transitioning = true;
        setControlsBusy(true);
        invoke("set_model", { model: requested })
          .then(async () => {
            ensureModelOption(requested === "default" ? "" : requested);
            modelSelect.value = requested === "default" ? "" : requested;
            syncEffortAvailability();
            currentId = crypto.randomUUID();
            grokSession = null;
            messages = [];
            attachments = [];
            renderChips();
            clearTranscriptDom();
            await invoke("new_session");
            await refreshStatus();
            await refreshSessions();
            addInfo(`Model set to ${requested}; started a fresh conversation so models never inherit one another's context.`);
          })
          .catch((e) => addInfo(`Cannot set model: ${e}`))
          .finally(() => {
            transitioning = false;
            setControlsBusy(busy);
          });
      } else {
        invoke("status").then((s) => addInfo(`Current model: ${s.model}`));
      }
      break;
    default:
      addInfo(`Unknown command: /${cmd} — try /help`);
  }
}

function slashMatches() {
  const v = input.value;
  if (!v.startsWith("/") || v.includes(" ") || v.includes("\n")) return [];
  return COMMANDS.filter((c) => c.name.startsWith(v));
}

function renderSlashMenu() {
  const matches = slashMatches();
  slashMenu.hidden = matches.length === 0;
  if (slashMenu.hidden) return;
  slashSelection = Math.min(slashSelection, matches.length - 1);
  slashMenu.innerHTML = "";
  matches.forEach((c, i) => {
    const item = document.createElement("div");
    item.className = "slash-item" + (i === slashSelection ? " selected" : "");
    item.innerHTML = `<span class="name"></span><span class="desc"></span>`;
    item.querySelector(".name").textContent = c.name;
    item.querySelector(".desc").textContent = c.desc;
    item.addEventListener("click", () => {
      input.value = c.name;
      input.focus();
      renderSlashMenu();
    });
    slashMenu.appendChild(item);
  });
}

/* ------- composer ------- */
function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}

function submit() {
  const text = input.value.trim();
  if (transitioning) return;
  if (!requestState.canSubmit({ busy, text, attachmentCount: attachments.length })) {
    if (busy) setState("finish or stop the active response", true);
    return;
  }
  input.value = "";
  autosize();
  renderSlashMenu();
  if (text.startsWith("/")) {
    runSlashCommand(text);
    return;
  }
  sendMessage(text);
}

input.addEventListener("input", () => {
  slashSelection = 0;
  autosize();
  renderSlashMenu();
});

input.addEventListener("keydown", (e) => {
  const matches = slashMatches();
  if (matches.length > 0) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      slashSelection = Math.max(0, slashSelection - 1);
      renderSlashMenu();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      slashSelection = Math.min(matches.length - 1, slashSelection + 1);
      renderSlashMenu();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      input.value = matches[slashSelection].name;
      renderSlashMenu();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
  if (e.key === "Escape") {
    input.value = "";
    autosize();
    renderSlashMenu();
  }
});

sendBtn.addEventListener("click", submit);
stopBtn.addEventListener("click", async () => {
  if (!busy || terminalizing) return;
  const runtime = requestSnapshot || selectedRuntimeSnapshot();
  terminalizing = true;
  setState("stopping…", true);
  activeRequestId = null;
  try {
    await invoke("interrupt");
    requestSubmission = null;
    const answer = finalAnswerText(runtime);
    const interrupted = answer ? "\n\n> Response stopped before completion." : "";
    if (requestState.hasRenderableAssistantOutput(streamText)) {
      messages.push({
        role: "assistant",
        content: answer + interrupted,
        thinking: thinkText || null,
      });
    }
    let completedRuntime = runtime;
    try {
      completedRuntime = await reconcileCompletedRuntime(runtime);
    } catch (error) {
      addInfo(`The provider stopped, but its final runtime status could not be refreshed: ${error}`);
    }
    await persistSession(completedRuntime);
    if (requestState.hasRenderableAssistantOutput(streamText)) {
      finalizeStream(interrupted, runtime);
    } else {
      discardStreamWithoutAnswer();
      addInfo("Response stopped before any answer text was returned.");
    }
    requestSnapshot = null;
    await refreshRouteDecision();
  } catch (error) {
    addMessage("error", "✗ error").textContent = String(error);
    setState("provider is still stopping…", true);
  } finally {
    terminalizing = false;
    setState(busy ? stateText.textContent : "ready", busy);
  }
});
$("new-chat").addEventListener("click", () => newChat());

/* ------- model / effort controls ------- */
let modelsById = {}; // id -> model metadata from the Grok CLI cache

function hasSelectOption(select, value) {
  return [...select.options].some((opt) => opt.value === value);
}

function ensureModelOption(modelId, source = "saved session", template = null) {
  if (!modelId || hasSelectOption(modelSelect, modelId)) return;
  const opt = document.createElement("option");
  opt.value = modelId;
  opt.textContent = `${modelId} · ${source}`;
  opt.title = `This exact model ID comes from the ${source} but is not in the current provider catalog.`;
  modelSelect.appendChild(opt);
  modelsById[modelId] = {
    ...(template || {}),
    id: modelId,
    name: modelId,
    description: opt.title,
    context_window: template?.context_window ?? null,
    supports_effort: template?.supports_effort ?? false,
    efforts: template?.efforts || [],
  };
}

function compactContext(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K context`;
  return `${tokens} context`;
}

function selectedModelInfo() {
  if (modelSelect.value) return modelsById[modelSelect.value] || null;
  return implicitDefaultModel || modelsById[GROK_DEFAULT_MODEL] || Object.values(modelsById)[0] || null;
}

function modelLabel(m) {
  const parts = [m.name || m.id];
  const ctx = compactContext(m.context_window);
  if (ctx) parts.push(ctx);
  if (m.supports_effort) parts.push("reasoning");
  return parts.join(" · ");
}

function renderEffortOptions(model) {
  const previous = effortSelect.value;
  effortSelect.innerHTML = "";
  const def = document.createElement("option");
  def.value = "default";
  const defaultEffort = model?.efforts?.find((e) => e.default);
  def.textContent = defaultEffort ? `Default (${defaultEffort.label})` : "Default";
  effortSelect.appendChild(def);

  for (const effort of model?.efforts || []) {
    const opt = document.createElement("option");
    opt.value = effort.id;
    opt.textContent = effort.label || effort.id;
    if (effort.description) opt.title = effort.description;
    effortSelect.appendChild(opt);
  }

  effortSelect.value = [...effortSelect.options].some((opt) => opt.value === previous)
    ? previous
    : "default";
}

// Grey out the Thinking control unless the chosen model supports reasoning
// effort — sending --effort to a model that lacks it is a 400 error.
function syncEffortAvailability() {
  const model = selectedModelInfo();
  renderEffortOptions(model);
  modelSupportsEffort = !!(
    model &&
    model.supports_effort &&
    model.efforts &&
    model.efforts.length
  );
  effortSelect.title = modelSupportsEffort
    ? "Reasoning effort for this model"
    : "The selected model doesn't support thinking levels";
  if (!modelSupportsEffort) effortSelect.value = "default";
  setControlsBusy(busy);
}

async function populateModels() {
  const models = await invoke("list_models");
  const status = await invoke("status");
  modelsById = {};
  implicitDefaultModel = null;
  modelSelect.innerHTML = "";
  // Provider CLIs can intentionally delegate model choice to their own
  // configured default. Direct/API routes require an exact model ID, so a
  // non-functional "Default" choice must not be offered there.
  if (requestState.supportsImplicitModelDefault(activeProvider)) {
    const def = document.createElement("option");
    def.value = "";
    const defaultModel = requestState.implicitDefaultModelMetadata(
      models,
      activeProvider,
      GROK_DEFAULT_MODEL
    );
    implicitDefaultModel = defaultModel;
    def.textContent = defaultModel ? `Default (${defaultModel.name})` : "Default";
    modelSelect.appendChild(def);
  }
  for (const m of models) {
    if (requestState.normalizeImplicitModel(m.id, activeProvider) === null) continue;
    modelsById[m.id] = m;
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = modelLabel(m);
    if (m.description) opt.title = m.description;
    if (m.id === status.model) opt.selected = true;
    modelSelect.appendChild(opt);
  }
  const configuredModel = requestState.explicitStatusModel(status.model, activeProvider);
  if (configuredModel) {
    ensureModelOption(configuredModel, "configured provider", implicitDefaultModel);
    modelSelect.value = configuredModel;
  }
  if (!modelSelect.value && !requestState.supportsImplicitModelDefault(activeProvider) && models[0]) {
    modelSelect.value = models[0].id;
  }
  syncEffortAvailability();
  if ([...effortSelect.options].some((opt) => opt.value === status.effort)) {
    effortSelect.value = status.effort;
  }
}

function connectorStateLabel(provider) {
  if (provider.installed && provider.binary) return "Installed";
  if (provider.configured) return provider.local ? "Local" : "Configured";
  if (provider.active) return "Setup";
  if (provider.adapter_state === "watch") return "Watch";
  if (provider.installed) return "Installed";
  return "Planned";
}

function renderConnectors(providers) {
  connectorsEl.innerHTML = "";
  for (const provider of providers) {
    const wrapper = document.createElement("div");
    wrapper.className = "connector-wrap";
    const row = document.createElement("button");
    row.type = "button";
    row.className = `connector ${provider.available ? "active" : provider.adapter_state}`;
    row.title = `${provider.note}\nLogin: ${provider.login_command}`;

    const main = document.createElement("span");
    main.className = "connector-main";
    const name = document.createElement("span");
    name.className = "connector-name";
    name.textContent = provider.name;
    const meta = document.createElement("span");
    meta.className = "connector-meta";
    meta.textContent = provider.auth;
    main.append(name, meta);

    const state = document.createElement("span");
    state.className = "connector-state";
    state.textContent = connectorStateLabel(provider);

    row.append(main, state);
    row.addEventListener("click", async () => {
      if (provider.active && provider.available) {
        if (busy || transitioning) {
          addInfo(`Finish or stop the current response before switching to ${provider.name}.`);
          return;
        }
        const modeSupported = agentToggle.checked
          ? provider.supports_agent
          : provider.supports_chat;
        if (!modeSupported) {
          addInfo(
            agentToggle.checked
              ? `${provider.name} does not provide Consilium Agent mode. Turn Agent off to use it for chat.`
              : `${provider.name} is Agent-only in Consilium. Turn Agent on before selecting it.`
          );
          return;
        }
        if (provider.id === activeProvider && activeRoutingProfile === "manual") {
          addInfo(`${provider.name} is ready and already selected.`);
          return;
        }
        providerSelect.value = provider.id;
        providerSelect.dispatchEvent(new Event("change"));
        return;
      }
      if (["gemini", "grok", "claude", "codex"].includes(provider.id)) {
        try {
          const msg = await invoke("login_provider", { providerId: provider.id });
          addInfo(msg);
          return;
        } catch (e) {
          addInfo(`Cannot launch ${provider.name} login: ${e}`);
        }
      }
      addInfo(
        `${provider.name}: ${provider.note}\nLogin command: ${provider.login_command}` +
          (provider.status_command ? `\nStatus command: ${provider.status_command}` : "")
      );
    });
    wrapper.appendChild(row);
    if (provider.active && provider.installed && provider.binary) {
      const login = document.createElement("button");
      login.type = "button";
      login.className = "connector-login";
      login.textContent = "Sign in";
      login.title = `Launch ${provider.name}'s own sign-in command in a terminal`;
      login.setAttribute("aria-label", `Sign in to ${provider.name}`);
      login.addEventListener("click", async () => {
        if (busy || transitioning) return;
        try {
          const message = await invoke("login_provider", { providerId: provider.id });
          addInfo(message);
        } catch (error) {
          addInfo(`Cannot launch ${provider.name} sign-in: ${error}`);
        }
      });
      wrapper.appendChild(login);
    }
    connectorsEl.appendChild(wrapper);
  }
}

async function populateProviders() {
  const providers = await invoke("list_providers");
  providersById = {};
  const active = providers.find((p) => p.active && p.available);
  providerSelect.innerHTML = "";
  for (const provider of providers) {
    providersById[provider.id] = provider;
    const opt = document.createElement("option");
    opt.value = provider.id;
    const modeSupported = agentToggle.checked
      ? provider.supports_agent
      : provider.supports_chat;
    const readiness = provider.installed && provider.binary
      ? "installed"
      : provider.configured
        ? provider.local
          ? "local"
          : "configured"
        : "ready";
    opt.textContent = provider.available && modeSupported
      ? `${provider.name} · ${readiness}`
      : provider.available && !provider.supports_chat && provider.supports_agent
        ? `${provider.name} · Agent only`
        : provider.available && provider.supports_chat && !provider.supports_agent
          ? `${provider.name} · Chat only`
      : provider.active
        ? `${provider.name} · setup needed`
      : `${provider.name} · ${provider.adapter_state}`;
    opt.title = `${provider.auth} — ${provider.note}`;
    opt.disabled = !provider.active || !provider.available || !modeSupported;
    opt.selected =
      provider.id === activeProvider || (!providersById[activeProvider] && provider.id === active?.id);
    providerSelect.appendChild(opt);
  }
  const selected = providersById[providerSelect.value] || active;
  if (selected) {
    activeProvider = selected.id;
    assistantName = selected.name.split(/\s+/)[0];
  }
  setFieldWorld(activeProvider);
  renderConnectors(providers);
  setControlsBusy(busy);
}

async function populateRoutingProfiles() {
  const profiles = await invoke("list_routing_profiles");
  routingProfileSelect.innerHTML = "";
  const manual = document.createElement("option");
  manual.value = "manual";
  manual.textContent = "Manual · no fallback";
  routingProfileSelect.appendChild(manual);
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    option.title = profile.description;
    routingProfileSelect.appendChild(option);
  }
  routingProfileSelect.value = hasSelectOption(routingProfileSelect, activeRoutingProfile)
    ? activeRoutingProfile
    : "manual";
  await refreshRouteDecision();
  setControlsBusy(busy);
}

async function refreshRouteDecision() {
  const decision = await invoke("routing_decision", { agent: agentToggle.checked });
  $("route-explanation").textContent = decision.explanation;
  const list = $("route-candidates");
  list.innerHTML = "";
  for (const candidate of decision.candidates) {
    const item = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = candidate.provider_name;
    const detail = document.createElement("span");
    detail.textContent = ` — ${candidate.explanation}`;
    item.append(name, detail);
    list.appendChild(item);
  }
}

async function populateOpenModelCatalog() {
  const models = await invoke("list_open_models");
  const list = $("model-catalog-list");
  list.innerHTML = "";
  for (const model of models) {
    const card = document.createElement("article");
    card.className = "model-card";
    const heading = document.createElement("h3");
    heading.textContent = model.name;
    const id = document.createElement("code");
    id.textContent = model.id;
    const details = document.createElement("p");
    const capabilities = [
      model.reasoning ? "reasoning" : null,
      model.tools ? "tools" : null,
      model.vision ? "vision" : null,
      compactContext(model.context_window),
    ].filter(Boolean);
    details.textContent = `${model.organization} · ${model.family}${
      capabilities.length ? ` · ${capabilities.join(" · ")}` : ""
    }. ${model.note}`;
    const source = document.createElement("a");
    source.href = model.source_url;
    source.target = "_blank";
    source.rel = "noreferrer";
    source.textContent = "Official source";
    card.append(heading, id, details, source);
    list.appendChild(card);
  }
}

routingProfileSelect.addEventListener("change", async () => {
  if (busy || transitioning) {
    routingProfileSelect.value = activeRoutingProfile;
    return;
  }
  transitioning = true;
  setControlsBusy(true);
  const requested = routingProfileSelect.value;
  const requestedAgent = requestState.agentModeForRoutingProfile(requested, agentToggle.checked);
  try {
    const status = await invoke("set_routing_profile", {
      profileId: requested,
      agent: requestedAgent,
    });
    activeRoutingProfile = status.routing_profile;
    activeProvider = status.provider || activeProvider;
    agentToggle.checked = requestedAgent;
    await invoke("new_session");
    currentId = crypto.randomUUID();
    grokSession = null;
    messages = [];
    attachments = [];
    renderChips();
    clearTranscriptDom();
    await refreshStatus();
    await populateProviders();
    await populateModels();
    await refreshRouteDecision();
    await refreshSessions();
    addInfo(
      requested === "manual"
        ? "Manual routing enabled; automatic fallback is disabled."
        : `${status.route_explanation}${
            requested === "agent-tools" ? " Agent mode was enabled." : ""
          } Started a new session.`
    );
  } catch (error) {
    routingProfileSelect.value = activeRoutingProfile;
    addInfo(`Cannot change routing profile: ${error}`);
  } finally {
    transitioning = false;
    setControlsBusy(busy);
  }
});

providerSelect.addEventListener("change", async () => {
  const provider = providersById[providerSelect.value];
  if (provider && !provider.active) {
    addInfo(`${provider.name} is a planned connector. ${provider.note}`);
    providerSelect.value = activeProvider;
    return;
  }
  if (provider && !provider.available) {
    addInfo(`${provider.name} is not ready. ${provider.login_command}. ${provider.note}`);
    providerSelect.value = activeProvider;
    return;
  }
  const modeSupported = provider
    ? agentToggle.checked
      ? provider.supports_agent
      : provider.supports_chat
    : false;
  if (provider && !modeSupported) {
    addInfo(
      agentToggle.checked
        ? `${provider.name} supports Chat mode only. Turn Agent off to select it.`
        : `${provider.name} is Agent-only in Consilium. Turn Agent on to select it.`
    );
    providerSelect.value = activeProvider;
    return;
  }
  if (
    !provider ||
    (provider.id === activeProvider && activeRoutingProfile === "manual") ||
    busy ||
    transitioning
  ) {
    return;
  }
  transitioning = true;
  setControlsBusy(true);
  const endProviderCeremony = beginProviderCeremony(provider);
  try {
    await invoke("set_provider", { providerId: provider.id });
    await invoke("new_session");
    activeProvider = provider.id;
    assistantName = provider.name.split(/\s+/)[0];
    currentId = crypto.randomUUID();
    grokSession = null;
    messages = [];
    attachments = [];
    renderChips();
    clearTranscriptDom();
    await refreshStatus();
    await populateModels();
    await refreshRouteDecision();
    await refreshSessions();
    addInfo(`Provider set to ${provider.name}; started a new session.`);
  } catch (e) {
    providerSelect.value = activeProvider;
    addInfo(`Cannot switch provider: ${e}`);
  } finally {
    await endProviderCeremony(activeProvider);
    transitioning = false;
    setControlsBusy(busy);
  }
});

modelSelect.addEventListener("change", async () => {
  syncEffortAvailability();
  if (busy || transitioning) return;
  transitioning = true;
  setControlsBusy(true);
  try {
    await invoke("set_model", { model: modelSelect.value || "default" });
    await invoke("set_effort", { effort: effortSelect.value });
    await invoke("new_session");
    // switching model resets the grok session, so this starts a fresh chat
    currentId = crypto.randomUUID();
    grokSession = null;
    messages = [];
    attachments = [];
    renderChips();
    clearTranscriptDom();
    await refreshStatus();
    await refreshSessions();
    addInfo(
      `Switched to ${modelSelect.options[modelSelect.selectedIndex].textContent} — started a fresh conversation so models never inherit one another's context.`
    );
  } catch (e) {
    addInfo(`Cannot set model: ${e}`);
    await populateModels();
  } finally {
    transitioning = false;
    setControlsBusy(busy);
  }
});

effortSelect.addEventListener("change", async () => {
  if (busy || transitioning) return;
  transitioning = true;
  setControlsBusy(true);
  try {
    await invoke("set_effort", { effort: effortSelect.value });
    addInfo(`Thinking level: ${effortSelect.options[effortSelect.selectedIndex].textContent}.`);
  } catch (e) {
    addInfo(`Cannot set thinking level: ${e}`);
    effortSelect.value = "default";
  } finally {
    transitioning = false;
    setControlsBusy(busy);
  }
});

agentToggle.addEventListener("change", async () => {
  if (busy || transitioning) return;
  const requestedAgent = agentToggle.checked;
  const previousAgent = !requestedAgent;
  const profile = activeRoutingProfile;
  const requestedProfile = requestState.routingProfileForAgentMode(profile, requestedAgent);
  transitioning = true;
  setControlsBusy(true);
  try {
    if (profile === "manual") {
      const provider = providersById[activeProvider];
      const supported = requestedAgent ? provider?.supports_agent : provider?.supports_chat;
      if (!supported) {
        throw new Error(
          requestedAgent
            ? `${provider?.name || activeProvider} has no native Agent/tools adapter.`
            : `${provider?.name || activeProvider} is Agent-only and cannot run as Chat.`
        );
      }
    } else {
      const status = await invoke("set_routing_profile", {
        profileId: requestedProfile,
        agent: requestedAgent,
      });
      activeProvider = status.provider || activeProvider;
      activeRoutingProfile = status.routing_profile || requestedProfile;
      routingProfileSelect.value = activeRoutingProfile;
    }

    await invoke("new_session");
    currentId = crypto.randomUUID();
    grokSession = null;
    messages = [];
    attachments = [];
    renderChips();
    clearTranscriptDom();
    await refreshStatus();
    await populateProviders();
    await populateModels();
    await refreshRouteDecision();
    await refreshSessions();
    refreshConversationModeLabel();
    addInfo(
      requestedAgent
        ? `Agent mode ON — ${assistantName} uses the selected provider's native tool-enabled runtime. Started a fresh conversation.`
        : `Chat mode ON — Consilium sends conversation text without enabling provider tools.${
            profile === "agent-tools" ? " Routing changed to Balanced." : ""
          } Started a fresh conversation.`
    );
  } catch (error) {
    agentToggle.checked = previousAgent;
    if (profile !== "manual") {
      try {
        const restored = await invoke("set_routing_profile", {
          profileId: profile,
          agent: previousAgent,
        });
        activeProvider = restored.provider || activeProvider;
      } catch (_) {
        // Preserve the original, actionable mode-change error.
      }
    }
    await refreshStatus().catch(() => null);
    await populateProviders().catch(() => null);
    await populateModels().catch(() => null);
    await refreshRouteDecision().catch(() => null);
    refreshConversationModeLabel();
    addInfo(`Could not change conversation mode: ${error}`);
  } finally {
    transitioning = false;
    setControlsBusy(busy);
  }
});

$("open-model-catalog").addEventListener("click", () => {
  $("model-catalog-dialog").showModal();
});
$("close-model-catalog").addEventListener("click", () => {
  $("model-catalog-dialog").close();
});
$("model-catalog-dialog").addEventListener("click", (event) => {
  if (event.target === $("model-catalog-dialog")) {
    $("model-catalog-dialog").close();
  }
});

async function openSetupAbout() {
  try {
    const info = await invoke("app_info");
    $("about-version").textContent = `${info.name} ${info.version}`;
    $("about-config-path").textContent = info.config_path;
    $("about-session-path").textContent = info.session_path;
    $("about-repository").href = info.repository;
  } catch (error) {
    $("about-version").textContent = `Version unavailable: ${String(error)}`;
  }
  const actions = $("setup-signin-actions");
  actions.innerHTML = "";
  const installedProviders = Object.values(providersById).filter(
    (provider) => provider.active && provider.installed && provider.binary
  );
  if (!installedProviders.length) {
    const note = document.createElement("span");
    note.className = "dim";
    note.textContent = "No supported provider CLI is currently installed. Local/direct routes use the configuration path below.";
    actions.appendChild(note);
  }
  for (const provider of installedProviders) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Sign in to ${provider.name}`;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        addInfo(await invoke("login_provider", { providerId: provider.id }));
      } catch (error) {
        addInfo(`Cannot launch ${provider.name} sign-in: ${error}`);
      } finally {
        button.disabled = false;
      }
    });
    actions.appendChild(button);
  }
  $("setup-about-dialog").showModal();
}

$("motion-toggle").checked = readMotionPreference();
$("motion-toggle").addEventListener("change", () => {
  const on = $("motion-toggle").checked;
  try {
    localStorage.setItem(MOTION_KEY, on ? "on" : "off");
  } catch {
    // the choice still applies to this window
  }
  fieldWanted.motion = on;
  field()?.setMotion(on);
});

$("open-setup-about").addEventListener("click", openSetupAbout);
$("open-setup-about-main").addEventListener("click", openSetupAbout);
$("close-setup-about").addEventListener("click", () => {
  $("setup-about-dialog").close();
});
$("setup-about-dialog").addEventListener("click", (event) => {
  if (event.target === $("setup-about-dialog")) {
    $("setup-about-dialog").close();
  }
});

$("restore-backup").addEventListener("click", async () => {
  if (busy || transitioning) return;
  if (
    !window.confirm(
      "Replace the unreadable session history with the last-known-good backup?"
    )
  ) {
    return;
  }
  transitioning = true;
  setControlsBusy(true);
  try {
    const restored = await invoke("restore_sessions_backup");
    $("storage-alert").hidden = true;
    addInfo(`Restored ${restored} session${restored === 1 ? "" : "s"} from backup.`);
    await refreshSessions();
  } catch (error) {
    await showStorageFailure(error);
  } finally {
    transitioning = false;
    setControlsBusy(busy);
  }
});
$("dismiss-storage-alert").addEventListener("click", () => {
  $("storage-alert").hidden = true;
});
$("dismiss-setup").addEventListener("click", async () => {
  $("setup-screen").hidden = true;
  await openSetupAbout();
});

/* ------- boot ------- */
async function boot() {
  if (!window.__TAURI__) {
    $("setup-error").textContent = "This page must run inside the Consilium desktop app.";
    $("setup-screen").hidden = false;
    return;
  }
  invoke = window.__TAURI__.core.invoke;
  listen = window.__TAURI__.event.listen;

  await listen("chat-thought", (event) => {
    if (event.payload.request_id !== activeRequestId) return;
    if (!streamMsg) return;
    const follow = nearBottom();
    thinkText += event.payload.text;
    streamMsg.showThinking(thinkText);
    if (follow) transcript.scrollTop = transcript.scrollHeight;
    if (stateText.textContent === "thinking…") setState("reasoning…", true);
  });

  await listen("chat-token", (event) => {
    if (event.payload.request_id !== activeRequestId) return;
    if (!streamBody) return;
    const follow = nearBottom();
    // Once answer text begins, the provider has accepted the turn. Release
    // transient file/image payloads; zero-output failures retain them so the
    // composer can offer a lossless retry.
    if (requestState.hasRenderableAssistantOutput(event.payload.text)) {
      requestSubmission = null;
    }
    streamText += event.payload.text;
    streamBody.textContent = streamText; // plain text while streaming
    streamBody.classList.add("streaming");
    if (follow) transcript.scrollTop = transcript.scrollHeight;
    if (stateText.textContent !== "writing…") setState("writing…", true);
  });

  await listen("chat-finished", async (event) => {
    if (event.payload.request_id !== activeRequestId) return;
    const runtime = requestSnapshot || selectedRuntimeSnapshot();
    terminalizing = true;
    setState("finishing…", true);
    activeRequestId = null;
    requestSubmission = null;
    const answer = finalAnswerText(runtime);
    // capture reasoning before finalizeStream() clears thinkText, so it is
    // saved with the message and survives reloads / app restarts
    const thinking = thinkText || null;
    messages.push({ role: "assistant", content: answer, thinking });
    let completedRuntime = runtime;
    try {
      completedRuntime = await reconcileCompletedRuntime(runtime);
    } catch (error) {
      addInfo(`The answer completed, but its final runtime status could not be refreshed: ${error}`);
    }
    await persistSession(completedRuntime);
    finalizeStream("", runtime);
    requestSnapshot = null;
    terminalizing = false;
    setState("ready", false);
    await refreshRouteDecision();
    if (await invoke("smoke_mode")) invoke("smoke_report", { text: answer });
  });

  await listen("chat-error", async (event) => {
    if (event.payload.request_id !== activeRequestId) return;
    const runtime = requestSnapshot || selectedRuntimeSnapshot();
    terminalizing = true;
    setState("finishing…", true);
    activeRequestId = null;
    const error = String(event.payload.text);
    flashFieldError();
    let completedRuntime = runtime;
    try {
      completedRuntime = await reconcileCompletedRuntime(runtime);
    } catch (statusError) {
      addInfo(`The response stopped, but its final runtime status could not be refreshed: ${statusError}`);
    }
    if (streamText) {
      requestSubmission = null;
      const answer = finalAnswerText(runtime);
      const interrupted = `\n\n> Response interrupted before completion: ${error}`;
      messages.push({
        role: "assistant",
        content: answer + interrupted,
        thinking: thinkText || null,
      });
      await persistSession(completedRuntime);
      finalizeStream(interrupted, runtime);
      addMessage("error", "✗ error").textContent = error;
      addInfo(
        "The partial answer was saved and marked incomplete. Retry the last prompt if needed; Consilium will not splice a second provider into text that already began."
      );
    } else {
      if (streamMsg) streamMsg.msg.remove();
      streamMsg = null;
      streamBody = null;
      restoreRejectedSubmission();
      await persistSession(completedRuntime);
      busy = false;
      setState("ready", false);
      addMessage("error", "✗ error").textContent = error;
    }
    thinkText = "";
    requestSnapshot = null;
    terminalizing = false;
    setState("ready", false);
    await refreshRouteDecision();
    if (await invoke("smoke_mode")) {
      invoke("smoke_report", { text: `[ERROR] ${error}` });
    }
  });

  const ready = await refreshStatus();
  await populateProviders();
  await populateRoutingProfiles();
  await populateOpenModelCatalog();
  if (ready) await populateModels();
  await refreshSessions();
  if (!ready) {
    setControlsBusy(false);
    return;
  }
  input.focus();

  const smoke = await invoke("smoke_config");
  if (smoke.enabled) {
    if (smoke.provider && smoke.provider !== activeProvider) {
      await invoke("set_provider", { providerId: smoke.provider });
      activeProvider = smoke.provider;
      if (providersById[activeProvider]) {
        providerSelect.value = activeProvider;
        assistantName = providersById[activeProvider].name.split(/\s+/)[0];
      }
      await refreshStatus();
      await populateModels();
    }
    if (smoke.session_id) {
      await loadSession(smoke.session_id);
    }
    if (smoke.effort) {
      effortSelect.value = smoke.effort;
      await invoke("set_effort", { effort: smoke.effort });
    }
    agentToggle.checked = !!smoke.agent;
    input.value = smoke.prompt;
    submit();
  }
}

bootField().catch((error) => console.error("particle field", error));
boot().catch((error) => {
  $("setup-error").textContent = `Consilium could not finish starting: ${String(error)}`;
  $("setup-screen").hidden = false;
  setState("startup failed", false);
});
