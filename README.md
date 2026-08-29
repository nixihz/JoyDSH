<h1 align="center">JoyDSH</h1>

<p align="center">
  <a href="docs/README.zh-CN.md">简体中文</a>
</p>

JoyDSH is a gamepad-driven, TV-style local developer workspace powered by the DeepSeek Harness (DSH) runtime. Inspired by console operating systems' spatial navigation, focus feedback, and fast controls, JoyDSH enables developer workflows with minimal mouse reliance while preserving keyboard efficiency for long-form text and coding.

The project currently features a complete implementation across phases 0 to 3, delivering a gamepad-first, keyboard-friendly development loop (workspace management, task sessions, streaming execution and structured plan view, dual permission presets, TV-style approval flows, per-file change review, atomic safe rollbacks, and agent-driven commit bridging). Detailed documentation:

- [User Operations and Keybindings Guide](./docs/user-guide.md)
- [Product & Technical Design (Chinese)](./docs/JoyDSH-产品与技术方案.md)
- [Domain Context](./CONTEXT.md)
- [Architecture Decision Records (ADRs)](./docs/adr/)

The primary goal is a complete real-world loop: select workspace, create or resume tasks, monitor agent execution, handle interactive tool approvals, inspect file diffs and artifacts, and commit or safely roll back changes.

## Development & Build

- Node.js `22.22.3`
- pnpm `10.20.0`
- Rust `1.88.0`
- DeepSeek Harness `0.1.1-rc.2`
- Tauri CLI `2.11.4`

Install dependencies and start the desktop app in development mode:

```bash
pnpm install
pnpm dev
```

Build the native desktop installer (macOS `.dmg`/`.app` or Windows `.msi`):

```bash
pnpm build:app
```

Start the web frontend only for UI layout debugging:

```bash
pnpm dev:web
```

The runtime binds strictly to `127.0.0.1:43127` and uses an application-dedicated `DSH_HOME`. In the "Project Hub", select a workspace root to create folders or open existing projects via native system dialogs. You can also explicitly specify a fixed DSH binary path using `JOYDSH_DSH_BIN`.

## Keyboard & Gamepad Navigation

- **D-Pad / Left Stick / Arrow Keys**: Navigate the spatial focus graph with repeat-scroll on hold.
- **`Enter` / Space / South Button (✕ / A)**: Confirm current selection or trigger actions.
- **`Escape` / East Button (◯ / B)**: Exit text input, dismiss modals, and reliably restore focus.
- **Bumpers (L1/R1, LB/RB) / `[` / `]`**: Cycle between projects.
- **`Tab` / `Shift+Tab`**: Cycle between sidebar, main workspace, and inspector focus regions; gamepads use spatial D-Pad/left-stick navigation.
- **Triggers (L2/R2, LT/RT)**: Switch between task inspector tabs: [Live Stream], [Changes], [Artifacts].
- **West Button (▢ / X) / North Button (△ / Y)**: Quick [Accept Changes] or trigger [Reject Confirmation] in the artifact inspector.
- **`Cmd/Ctrl+K` / Menu Button (Options/Menu)**: Open the global Command Palette for fast project switching, task rollbacks, agent commits, stopping tasks, or model settings.
- **`Cmd/Ctrl+Shift+V` / `F5` / R3 (Right Stick Click)**: Bridge voice input to Spokenly or another external dictation tool (simulating Right Command by default). Spokenly's automatic mode supports short-press toggle and hold-to-talk; the gamepad button is configurable.

On macOS, grant JoyDSH access under **System Settings > Privacy & Security > Accessibility** before using simulated voice-input shortcuts. JoyDSH checks this permission and exposes an authorization action in Settings.
- **Right Stick**: Smoothly scroll streaming execution logs and long text vertically, or wide diff and zoomed-image content horizontally.

Direct keyboard and voice input are used for text and code editing. Dictation preserves the current editable field and falls back to the foreground task input when none is focused; transcribed text is never submitted automatically. When an input field is focused, arrow keys control text cursors; pressing `Escape` or the East button immediately restores spatial navigation.

## Verification

```bash
pnpm test
pnpm typecheck
pnpm --filter @joydsh/desktop build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Full automated test suite covers 164 Rust unit/integration tests (task baseline, diff computation, strong snapshot protection, atomic safe rollback, and commit bridging) and 60 frontend Vitest tests.
