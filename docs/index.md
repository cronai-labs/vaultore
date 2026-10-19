# VaultOre Documentation

Where to find what. The [README](../README.md) covers installing and using the plugin.

## Specifications

What the code does, and what is planned, per topic. Each topic has one source; other
documents link to it.

| Document | Covers |
|----------|--------|
| [Ore specification](https://github.com/cronai-labs/ore-spec) | The Ore format itself, independent of VaultOre (separate repository) |
| [Ore implementation](../specs/ore-implementation.md) | What VaultOre decides and adds on top of the format: code symbols, error texts, settings, providers, output files, artifacts |
| [Permissions spec](../specs/permissions-spec.md) | Permissions, their defaults, the vault mounts, stored decisions |
| [Sandbox spec](../specs/sandbox-spec.md) | Container engines and hardening today; a container-free tier proposed |
| [CronAI handover spec](../specs/cronai-handover-spec.md) | The schedule manifest `vaultore schedules export` writes |
| [Go cell spec](../specs/go-cell-spec.md) | `ore:go` cells: a design, not built |

## Guides

| Document | Covers |
|----------|--------|
| [Plugin development quickstart](quickstart-plugin-dev.md) | Build the plugin, load it into a test vault, run a fixture |
| [Testing fixtures](testing-fixtures.md) | The canonical workflows and how they are tested |
| [Interoperability](interoperability.md) | The CLI and headless agent, OKF, the Obsidian CLI, Quarto, CronAI |
| [Architecture](../ARCHITECTURE.md) | Packages, modules, how a run flows through the code |
| [Contributing](../CONTRIBUTING.md) | Setup, conventions, pull requests, releases |

## Planning

| Document | Covers |
|----------|--------|
| [Roadmap](roadmap.md) | What exists, what is next, what is under consideration |
| [Local intelligence](local-intelligence.md) | An exploration of local retrieval for AI cells; nothing of it is built |

## Layout

```
docs/
├── index.md                  # this file
├── interoperability.md
├── local-intelligence.md
├── quickstart-plugin-dev.md
├── roadmap.md
└── testing-fixtures.md

specs/
├── cronai-handover-spec.md
├── go-cell-spec.md
├── ore-implementation.md
├── permissions-spec.md
└── sandbox-spec.md

fixtures/canonical/           # workflow notes that double as acceptance tests
├── daily-summary.md
├── hello-world.md
├── link-digest.md
├── smart-inbox.md
└── sys-snapshot.md
```

User-facing guides go in `docs/`, format and behaviour specifications in `specs/`, workflows
used as tests in `fixtures/canonical/`. Questions and proposals:
[issues](https://github.com/cronai-labs/vaultore/issues).
