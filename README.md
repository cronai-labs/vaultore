# VaultOre

**A Markdown-native AI workflow engine for Obsidian**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.4+-purple.svg)](https://obsidian.md)
[![npm](https://img.shields.io/npm/v/@vaultore/core.svg)](https://www.npmjs.com/package/@vaultore/core)

VaultOre turns your Obsidian vault into a powerful automation platform. Create **notebook-style workflows** with AI, TypeScript, and shell steps — all defined in plain Markdown files inside your vault.

> **"Mine value from your vault."** — Your notes are the data source. Workflows are the refinery. Knowledge artifacts are the output.

## ✨ Features

- **📝 Markdown-Native** — Workflows are `.md` files that live in your vault
- **🤖 AI-Powered** — Built-in support for OpenAI, Anthropic, Ollama
- **🔒 Sandboxed** — All code runs in isolated Docker containers
- **⚡ Fast** — Bun-based TypeScript runtime with warm container pool
- **📅 Time-Triggered** — True cron scheduling for automated workflows
- **🔗 Vault-Integrated** — Read from and write to your notes
- **🧠 Semantic Conditions** — AI-evaluated conditions for smart workflows
- **🔄 Evolving Control Flow** — Simple now, powerful later (no breaking changes)

## 🚀 Quick Start

> **For Users:** See [Installation Guide](docs/quickstart-plugin-dev.md#installation) (coming soon)  
> **For Developers:** See [Plugin Development Quickstart](docs/quickstart-plugin-dev.md)

### Prerequisites

- [Obsidian](https://obsidian.md) 1.4+
- [Docker](https://docker.com), [Podman](https://podman.io), or [Colima](https://github.com/abiosoft/colima)

### Installation

> **Note:** VaultOre is currently in active development. For plugin development setup, see the [Plugin Development Quickstart](docs/quickstart-plugin-dev.md).

1. Open Obsidian Settings → Community Plugins
2. Search for "VaultOre"
3. Install and enable the plugin
4. Configure your AI provider API keys

### Your First Workflow

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

```ore:ai id=respond depends=[hello]
Respond enthusiastically to: {{hello}}
```
````

Press `Cmd+Shift+Enter` to run!

### Smart Workflow with Conditions (v0.2+)

````markdown
---
ore: true
name: Smart Inbox
schedule: "0 9 * * 1-5"
runIf: "{{ai: the inbox has unprocessed items}}"
---

# Smart Inbox Processor

```ore:ts id=load
const inbox = await vault.read("Inbox.md");
inbox;
```

```ore:ai id=categorize depends=[load] when="{{ai: there are at least 3 items}}"
Categorize these inbox items into Work, Personal, Reference:
{{load}}
```
````

## 🎯 Why VaultOre?

| If you want... | Use... |
|----------------|--------|
| Chat inside Obsidian | Copilot, Smart Connections |
| AI coding agents | OpenProse, Claude Code |
| Visual automation builders | n8n, Zapier |
| **AI + code execution + your vault + scheduling** | **VaultOre** |

**VaultOre is different because:**

1. **Knowledge-First** — Your vault is the data source, not just storage
2. **Time-Triggered** — True cron scheduling, not just reactive automation
3. **Semantic Conditions** — AI-evaluated conditions for smart workflows
4. **Obsidian-Native** — Links, embeds, and graph integration
5. **Git-Friendly** — Workflows are plain Markdown that diff cleanly

## 📖 Documentation

- [Quickstart: Plugin Development](docs/quickstart-plugin-dev.md) — **Start here for development**
- [Documentation Index](docs/index.md) — All docs in one place
- [PRD](docs/PRD.md) — Product requirements
- [Architecture](ARCHITECTURE.md) — System design

### Specifications

- [Workflow Note Spec](specs/workflow-note-spec.md)
- [Permissions Spec](specs/permissions-spec.md)
- [Go Cell Spec](specs/go-cell-spec.md) (v0.3+)

## 🗺️ Roadmap

| Version | Theme | Key Features |
|---------|-------|--------------|
| **v0.1** | MVP | TS, Shell, AI cells, basic scheduling |
| v0.2 | Notebooks That Don't Rot | Python, DAG, staleness, **semantic conditions** |
| v0.3 | Go + Control Flow | Go cells with caching, **loop/parallel blocks** |
| v0.4 | Automation | CLI, CronAI cloud, event triggers |
| v0.5 | Portability | VS Code, Zed extensions |

### Control Flow Evolution

VaultOre follows a "brick-by-brick" approach to control flow:

| Version | Control Flow | Breaking Changes |
|---------|--------------|------------------|
| v0.1 | `depends[]` only | — |
| v0.2 | + `when` conditions, implicit parallel | None |
| v0.3 | + `control:` blocks (loop, parallel) | None (additive) |

This ensures you can start simple and grow into complexity without rewrites.

## 🏗️ Architecture

```
vaultore/
├── packages/
│   ├── core/        # @vaultore/core - Editor-agnostic engine
│   ├── obsidian/    # Obsidian plugin
│   └── cli/         # Standalone CLI (planned)
├── containers/      # Runtime container images
├── specs/           # Specifications (TDD anchors)
├── fixtures/        # Canonical test workflows
└── docs/            # Documentation
```

## 🧪 Testing

```bash
# Unit tests
bun run test

# Integration tests
bun run test:integration

# Canonical fixture tests (requires Docker)
bun run test:canonical
```

## 🤝 Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
git clone https://github.com/cronai-ug/vaultore.git
cd vaultore
bun install
bun run build
```

## 📄 License

MIT © [CronAI UG](https://cronai.de)

---

Made with ❤️ for the Obsidian community
