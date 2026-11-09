# Changelog

## 0.2.0 — 2026-11-08

- New desktop look: a true-black layout with a WebGL particle field behind the conversation. The field forms an iris on an empty chat, follows each request (thinking, writing, errors), and takes the colour of the selected provider family. Message text, the composer and dialogs sit on opaque black so particles never pass behind text.
- Switching provider runs a short calibration in the field while the new provider's controls load.
- Consilium's violet identity and per-provider colours replace the neon-red palette, in the desktop and terminal apps.
- New particle-iris app icon. The Draconitic Labs mark appears as the publisher mark in Setup & About and the sidebar.
- Bundled fonts: Inter, Space Grotesk, Geist Mono and JetBrains Mono (SIL Open Font License 1.1). Their licenses are in THIRD_PARTY_NOTICES.txt.
- Session history has a search box and marks each conversation with its provider's colour.
- Setup & About has an "Animated particle field" setting; when it is off, a still image is shown and WebGL is not used. The system reduced-motion setting is always honored.
- If creating the particle field's WebGL context freezes (seen inside some GL drivers), the next launch shows the still image instead, and two freezes in a row turn the setting off. `CONSILIUM_PARTICLES=0` starts without WebGL.
- The Codex model list comes from the installed Codex CLI's catalog (`codex debug models`), with each model's reasoning levels.
- On Linux with the NVIDIA driver, WebKitGTK uses shared-memory buffers (`WEBKIT_DMABUF_RENDERER_FORCE_SHM=1`) unless you have chosen otherwise.
- The application ID, data folders and session format are unchanged.

## 0.1.1 — 2026-11-08

- Load configuration only from the documented per-user location or explicit CONSILIUM_ENV_FILE.
- Require explicit consent for the Gemini CLI process-argument privacy limitation.
- Keep terminal rendering responsive for long Unicode combining sequences.
- Patch rustls, update lru/chacha20, and harden dependency and release workflows.
- Clear later RustSec advisories by updating rustls, rustls-webpki and quinn-proto, and update Tauri to 2.12.
- Name Draconitic Labs as publisher, with the project page at https://ai.draconitic.com/consilium. The application ID `com.flintglade.consilium` and the Windows `Flintglade\Consilium` data folders are unchanged.
