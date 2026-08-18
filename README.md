# VaultOre

**A Markdown-native AI workflow engine for Obsidian**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.11.4+-purple.svg)](https://obsidian.md)

VaultOre turns your Obsidian vault into an automation platform. Create **notebook-style workflows** with AI, TypeScript, and shell steps — all defined in plain Markdown files inside your vault.

> **"Mine value from your vault."** — Your notes are the data source. Workflows are the refinery. Knowledge artifacts are the output.

## ✨ Features

- **📝 Markdown-native** — Workflows are `.md` files that live in your vault
- **🤖 AI-powered** — OpenAI and Anthropic support (bring your own API key)
- **🔒 Sandboxed** — All code runs in isolated containers, network disabled by default
- **📅 Time-triggered** — Cron scheduling for automated workflows while Obsidian is open
- **🔗 Vault-integrated** — Workflows read from and write to your notes
- **🧱 Git-friendly** — Workflows are plain Markdown that diff cleanly

## ⚙️ Requirements

| Requirement | Notes |
|-------------|-------|
| **Obsidian 1.11.4+ (desktop only)** | Uses the desktop file system and secret storage; not available on mobile |
| **A container runtime** | [Docker](https://docker.com), [Podman](https://podman.io), [Colima](https://github.com/abiosoft/colima), or [Apple container](https://github.com/apple/container) (macOS 26+, Apple silicon) must be installed and running |
| **AI provider API key** *(optional)* | Only needed for `ore:ai` cells — OpenAI or Anthropic |

**Windows:** use Docker Desktop with the WSL2 backend, or install Docker Engine/Podman directly inside a WSL2 distro.

**Apple container note:** Apple's `container` CLI does not support disabling network access yet, so workflows with `network: deny` (the default) refuse to run on that engine rather than running un-isolated — use Docker or Podman for those, or grant `network: allow` explicitly.

> A container-free WASM sandbox tier for TypeScript cells is planned for v0.2 — see the [Sandbox Spec](specs/sandbox-spec.md).

## 🚀 Installation

VaultOre is pre-release: it is not yet in the Obsidian community plugin directory, and
there is no published release to download. Build it from source:

```bash
git clone https://github.com/cronai-labs/vaultore.git
cd vaultore
bun install
bun run build
bun run obsidian:package
```

That writes `main.js`, `manifest.json`, and `styles.css` to
`packages/obsidian/package/vaultore/`. Then:

1. Copy that `vaultore/` folder into `<your-vault>/.obsidian/plugins/`
2. In Obsidian: **Settings → Community plugins → Enable "VaultOre"**
3. Open **Settings → VaultOre** to pick your container runtime and (optionally) add an AI provider API key

Once the plugin is released and listed, downloadable builds will appear under
[Releases](https://github.com/cronai-labs/vaultore/releases) and you will be able to
install directly from **Settings → Community plugins → Browse**.

## 🏃 Your First Workflow

Create a note with this content:

````markdown
---
ore: true
name: Hello World
runtime:
  engine: docker
  image: oven/bun:1-alpine
---

# Hello World

```ore:ts id=hello
const message = "Hello from VaultOre!";
message;
```

```ore:ts id=transform depends=[hello]
const msg = cell("hello");
msg.toUpperCase();
```
````

Then open the command palette (`Cmd+P` / `Ctrl+P`) and run **"VaultOre: Run all cells"**. Output callouts appear below each cell, with results persisted under your configured output folder.

> **Tip:** No default hotkeys are set to avoid conflicts. Assign your own under **Settings → Hotkeys** (search for "VaultOre").

### Commands

| Command | What it does |
|---------|--------------|
| **Run all cells** | Execute every cell in the active workflow note, in dependency order |
| **Run cell** | Execute the cell under the cursor, including its dependencies |
| **Run cell only (skip dependencies)** | Execute just the cell under the cursor |

### Cell Types

| Type | Syntax | Runs in |
|------|--------|---------|
| TypeScript | ` ```ore:ts ` | Bun container |
| Shell | ` ```ore:shell ` | Alpine container |
| AI | ` ```ore:ai ` | Your configured AI provider (network) |

Inside `ore:ts` cells you get `vault.read()`, `vault.write()`, `vault.exists()`, `vault.mkdirp()`, and `cell("other-id")` to access other cells' outputs. Prompts in `ore:ai` cells can interpolate outputs with `{{cellId}}` and note contents with `{{note:Path/To/Note.md}}`.

### Scheduling

Add a cron expression to run a workflow automatically while Obsidian is open:

```yaml
---
ore: true
name: Daily Summary
schedule: "0 18 * * *"   # every day at 6pm
---
```

## 🔐 Security & Privacy

- **Code execution is sandboxed.** `ore:ts` and `ore:shell` cells run inside containers with **network disabled by default**, memory/CPU limits, and your vault mounted read-only unless a workflow is granted write permission.
- **Permissions are explicit.** Workflows declare `network`, `vaultRead`, and `vaultWrite` permissions in frontmatter. Anything marked `ask` triggers a confirmation dialog, and your decision is remembered per workflow.
- **AI cells call external services.** When a workflow contains `ore:ai` cells, the cell's prompt — including any interpolated cell outputs and note contents — is sent to the AI provider you configured (OpenAI or Anthropic) using your own API key. Nothing is sent anywhere unless a workflow with AI cells runs.
- **API keys stay local.** Keys are stored in Obsidian's encrypted secret storage, never in plain-text settings files.
- **No telemetry.** VaultOre makes no network requests of its own.

See the [Permissions Spec](specs/permissions-spec.md) for the full security model.

## 🔌 Interoperability

VaultOre is core-first: the engine is editor-agnostic, and Obsidian is one of several surfaces.

- **Standalone CLI** — `vaultore run <workflow.md>` executes any workflow headless, no Obsidian required; `vaultore agent` is a local scheduler daemon ([@vaultore/cli](packages/cli), build from source — not on npm yet)
- **CronAI handover** — `vaultore schedules export` emits a manifest that hands scheduled jobs to always-on CronAI infrastructure ([spec](specs/cronai-handover-spec.md))
- **Open Knowledge Format** — run outputs and artifact indexes are [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) v0.1 concepts out of the box, so any OKF consumer can ingest VaultOre's output tree as an agent-ready knowledge bundle
- **Obsidian CLI & Quarto** — composes with the official Obsidian CLI (1.12+) and maps cleanly onto Quarto's QMD cells; a `quarto-vaultore` engine extension is planned

Details in [docs/interoperability.md](docs/interoperability.md).

## 🎯 Why VaultOre?

| If you want... | Use... |
|----------------|--------|
| Chat inside Obsidian | Copilot, Smart Connections |
| AI coding agents | Claude Code, OpenProse |
| Visual automation builders | n8n, Zapier |
| **AI + code execution + your vault + scheduling** | **VaultOre** |

1. **Knowledge-first** — Your vault is the data source, not just storage
2. **Time-triggered** — Cron scheduling, not just reactive automation
3. **Obsidian-native** — Outputs become linkable notes in your graph
4. **Git-friendly** — Workflows diff cleanly and are easy to share

## 🗺️ Roadmap

| Version | Theme | Key Features |
|---------|-------|--------------|
| **v0.1 (current)** | MVP | TypeScript, shell, and AI cells; scheduling; permissions; Docker/Podman/Colima/Apple container engines; standalone CLI + headless agent; OKF-conformant outputs |
| v0.2 | Notebooks that don't rot | **WASM sandbox tier (no container required for TS cells)**, Python cells, dependency graph, staleness detection, semantic conditions, warm container pool, OKF bundle export |
| v0.3 | Go + control flow | Go cells with build caching (WASI lane under evaluation), loop/parallel blocks |
| v0.4 | Automation | CronAI cloud execution, event triggers, Quarto engine extension, more AI providers |
| v0.5 | Portability | VS Code and Zed extensions |

Each version is additive — no breaking changes to the workflow format.

## 📖 Documentation

- [Plugin Development Quickstart](docs/quickstart-plugin-dev.md) — build and hack on VaultOre
- [Documentation Index](docs/index.md) — all docs in one place
- [Workflow Note Spec](specs/workflow-note-spec.md) — the full workflow format
- [Permissions Spec](specs/permissions-spec.md) — security model
- [Sandbox Spec](specs/sandbox-spec.md) — execution tiers: containers today, WASM next
- [Architecture](ARCHITECTURE.md) — system design

## 🏗️ Architecture

```
vaultore/
├── packages/
│   ├── core/        # @vaultore/core - Editor-agnostic engine
│   ├── obsidian/    # Obsidian plugin
│   └── cli/         # @vaultore/cli - Standalone CLI + headless agent
├── containers/      # Runtime container images
├── specs/           # Specifications (TDD anchors)
├── fixtures/        # Canonical test workflows
└── docs/            # Documentation
```

## 🤝 Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, commit conventions, and the release process.

```bash
git clone https://github.com/cronai-labs/vaultore.git
cd vaultore
bun install
bun run build
bun run test
```

## 📄 License

MIT © [CronAI UG](https://cronai.de)

---

Made with ❤️ for the Obsidian community
