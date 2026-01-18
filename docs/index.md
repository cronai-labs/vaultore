# VaultOre Documentation

Welcome to the VaultOre documentation. This index helps you find what you need.

---

## 🚀 Getting Started

- **[Quickstart: Plugin Development](quickstart-plugin-dev.md)** — Set up the development environment, build the plugin, and run your first workflow
- **[Product Requirements Document (PRD)](PRD.md)** — Complete product vision, objectives, and technical architecture
- **[Architecture Guide](../ARCHITECTURE.md)** — System design, monorepo structure, and implementation details

---

## 📋 Specifications

Technical specifications that serve as TDD anchors:

- **[Workflow Note Specification](../specs/workflow-note-spec.md)** — Format, syntax, and semantics of workflow notes
- **[Permissions Specification](../specs/permissions-spec.md)** — Security model and permission system
- **[Go Cell Specification](../specs/go-cell-spec.md)** — Go cell type (v0.3+, future work)

---

## 🧪 Testing & Development

- **[Testing Fixtures](testing-fixtures.md)** — Canonical workflows as acceptance tests
- **[Roadmap](roadmap.md)** — Version timeline and feature planning
- **[Local Intelligence (RAG) Strategy](local-intelligence.md)** — Local retrieval and AI augmentation

---

## 📚 Reference

### For Users (Coming Soon)

- Getting Started Guide — End-user installation and usage
- Workflow Guide — How to write and run workflows
- API Reference — Vault API and runtime helpers

### For Developers

- [Architecture Guide](../ARCHITECTURE.md) — System design and module structure
- [PRD](PRD.md) — Product requirements and technical decisions
- [Quickstart: Plugin Development](quickstart-plugin-dev.md) — Development setup

---

## 🗂️ Documentation Structure

```
docs/
├── index.md                    # This file
├── quickstart-plugin-dev.md   # Development quickstart
├── PRD.md                      # Product requirements
├── roadmap.md                  # Version timeline
├── local-intelligence.md       # Local RAG strategy
└── testing-fixtures.md         # Canonical workflows guide

specs/
├── workflow-note-spec.md        # Workflow format spec
├── permissions-spec.md          # Security model
└── go-cell-spec.md             # Go cells (v0.3+)

fixtures/
└── canonical/                  # Test workflows
    ├── hello-world.md
    ├── link-digest.md
    ├── daily-summary.md
    ├── smart-inbox.md
    └── sys-snapshot.md
```

---

## 🎯 Quick Links by Role

### I want to...

| Goal | Document |
|------|----------|
| **Set up development** | [Quickstart: Plugin Development](quickstart-plugin-dev.md) |
| **Understand the vision** | [PRD](PRD.md) |
| **See the architecture** | [Architecture Guide](../ARCHITECTURE.md) |
| **Write a workflow** | [Workflow Note Spec](../specs/workflow-note-spec.md) |
| **Test the system** | [Testing Fixtures](testing-fixtures.md) |
| **Plan local RAG** | [Local Intelligence Strategy](local-intelligence.md) |
| **Plan features** | [Roadmap](roadmap.md) |
| **Understand security** | [Permissions Spec](../specs/permissions-spec.md) |
| **Add Go support** | [Go Cell Spec](../specs/go-cell-spec.md) (v0.3+) |

---

## 📝 Contributing

When adding documentation:

1. **User-facing docs** → `docs/`
2. **Technical specs** → `specs/`
3. **Test workflows** → `fixtures/canonical/`
4. **Architecture notes** → `ARCHITECTURE.md` (root)

Follow the existing style and link back to this index.

---

**Need help?** Open an [issue](https://github.com/cronai-ug/vaultore/issues) or start a [discussion](https://github.com/cronai-ug/vaultore/discussions).
