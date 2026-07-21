# Interoperability

> **Last Updated:** 2026-07-21

VaultOre is core-first by design: all engine logic lives in
`@vaultore/core`, and every surface — the Obsidian plugin, the CLI, future
editor extensions, CronAI runners — is a thin adapter. This document maps
the interop surfaces and how VaultOre relates to neighboring formats and
tools.

## Running Without Obsidian

### `vaultore` CLI (shipped)

`@vaultore/cli` provides a standalone binary with a plain-filesystem
`PlatformAdapter` — any directory of markdown is a vault:

```bash
vaultore run Workflows/digest.md --vault ~/notes     # headless run
vaultore run Workflows/digest.md --cell fetch --yes  # single cell, auto-grant asks
vaultore list --vault ~/notes                        # discover workflow notes
vaultore agent --vault ~/notes                       # headless scheduler daemon
vaultore schedules export --out schedules.json       # CronAI handover manifest
```

Conventions that differ from the plugin, on purpose:

| Concern | Plugin | CLI |
|---------|--------|-----|
| Settings | Obsidian settings UI | `<vault>/.vaultore/config.json` |
| Secrets | Obsidian secret storage | Environment (`VAULTORE_OPENAI_APIKEY`, `OPENAI_API_KEY`, …) |
| Permission prompts | Modal dialog | Non-interactive: deny unless `--yes`; decisions persist to config |

The same workflow note produces the same run either way — outputs, run
JSON, and artifact indexes are written by shared core code.

### Headless agent

`vaultore agent` is the always-on local scheduler: it scans the vault,
registers every `schedule:` workflow, fires them on cron, and rescans
periodically. Run it under systemd/launchd on a home server, or in CI for
"poor-man's cloud" scheduling. For real always-on execution, hand
schedules to CronAI (below).

### Embedding as a library

`@vaultore/cli` exports `NodeAdapter`, `discoverWorkflows`, and
`buildScheduleManifest`; `@vaultore/core` exports the parser/executor/
scheduler. Third-party runners embed headless execution without shelling
out.

## CronAI Schedule Handover

Scheduled jobs migrate to CronAI infrastructure via the schedule manifest
(`vaultore schedules export`) — workflow notes stay the source of truth,
the vault syncs via git, and the cloud runner executes the identical
`vaultore run` CLI. Ownership handoff, drift detection, and permission
semantics are specified in
[specs/cronai-handover-spec.md](../specs/cronai-handover-spec.md).

## Open Knowledge Format (OKF)

Google released OKF v0.1 in June 2026
([announcement](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/),
[spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md),
Apache 2.0): an open specification for agent-ready knowledge as **markdown
files with YAML frontmatter**, organized in directory "bundles", linked
into a graph — only `type` is required; `title`, `description`,
`resource`, `tags`, `timestamp` are recommended; unknown fields must be
preserved.

### Impact assessment

**OKF validates VaultOre's core thesis** — markdown + frontmatter as the
machine interface for AI systems — and gives it an industry-backed
interchange target:

1. **Obsidian vaults are already OKF-shaped.** A vault is a directory of
   frontmatter'd markdown with links. The deltas are small: OKF requires a
   `type` field per concept and uses standard markdown links, where
   Obsidian favors `[[wikilinks]]`.
2. **VaultOre run outputs are now OKF concepts** (shipped). Output views
   and artifact indexes carry `type`, `title`, `description`,
   `timestamp`, and `tags` in their frontmatter, so the `_vaultore/`
   output tree is consumable by any OKF consumer — including Google's
   reference enrichment agent — with zero conversion.
3. **Workflows can produce and consume knowledge bundles.** An `ore:ts`
   cell can read an OKF bundle as structured context for `ore:ai` cells
   today (it's just files); a first-class `vault.okf.*` helper and an
   `okf export` command (bundle assembly + wikilink→markdown-link
   normalization + generated `index.md`/`log.md`) are roadmap items.
4. **Strategic positioning:** VaultOre becomes the *refinery* that turns
   vault knowledge into OKF bundles on a schedule — "OKF producer" is a
   differentiator no chat-only Obsidian plugin has.

Planned work: v0.2 — `okf export` command and wikilink normalization;
v0.2 — OKF bundle ingestion helper for AI cell context.

## Obsidian CLI (official)

Obsidian 1.12+ ships an official CLI (enable in **Settings → General**,
docs at help.obsidian.md/cli) that can read/search/write notes and
interact with plugins from the terminal against a running Obsidian
instance. That composes with VaultOre from the outside: scripts can
prepare or query notes via `obsidian …` and trigger VaultOre runs.
The community tool formerly named obsidian-cli now lives on as
[notesmd-cli](https://github.com/Yakitrak/notesmd-cli) and works vault-
directly (no running app needed) — as does `vaultore` itself.

Rule of thumb: drive a **running Obsidian** with the official CLI; drive
the **vault as files** with `vaultore`.

## Quarto (QMD)

Quarto's `.qmd` notebooks are the closest neighbor format: markdown with
executable ```` ```{python} ````-style cells, YAML frontmatter, rendered
by `quarto render`. Two interop paths:

1. **Cell mapping** — the formats are mechanically convertible:

   | Quarto | VaultOre |
   |--------|----------|
   | ```` ```{python} ```` | ```` ```ore:py ```` (v0.2) |
   | `#| option: value` cell options | fence attributes (`id=… depends=[…]`) |
   | `engine:` frontmatter | `runtime.engine:` frontmatter |
   | freeze/cache outputs | `_vaultore/runs/` output JSON |

2. **Engine extension** — Quarto 1.9 (March 2026) introduced TypeScript
   engine extensions with a markdown-in→markdown-out contract, which is
   exactly the VaultOre executor's shape. A `quarto-vaultore` engine could
   execute `ore:*` cells during `quarto render`, making workflow notes
   publishable documents. The extension API is explicitly still in flux
   upstream, so this is targeted for v0.4 rather than now.

## Surface Map

```
                      @vaultore/core (parser · executor · scheduler · providers)
                                         │
        ┌──────────────┬─────────────────┼──────────────────┬───────────────┐
        ▼              ▼                 ▼                  ▼               ▼
  Obsidian plugin   vaultore CLI    vaultore agent    CronAI runner    (v0.4) quarto-vaultore
  (interactive)     (headless run)  (local cron)      (cloud cron)     (publish-time exec)
        │                                                   ▲
        └── official Obsidian CLI drives the running app    └── schedule manifest handover
```
