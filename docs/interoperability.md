# Interoperability

> **Last Updated:** 2026-10-15

VaultOre is core-first by design: all engine logic lives in
`@vaultore/core`, and each surface (today the Obsidian plugin and the CLI)
is a thin adapter. This document maps
the interop surfaces and how VaultOre relates to neighboring formats and
tools.

## Running Without Obsidian

### `vaultore` CLI (implemented; not published to npm yet)

`@vaultore/cli` provides a standalone binary with a plain-filesystem
`PlatformAdapter` — any directory of markdown is a vault.

It is not on npm yet, so build it from a checkout and invoke the built entry
point (or link it onto your `PATH` yourself):

```bash
git clone https://github.com/cronai-labs/vaultore.git
cd vaultore && bun install && bun run build
alias vaultore="node $PWD/packages/cli/dist/cli.js"
```

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
| Permission prompts | Modal dialog | Non-interactive: deny unless `--yes`; decisions persist to config, bound to the note's content |
| Scheduling | Only notes the user approved, while Obsidian is open | `vaultore agent` runs every scheduled note |

The same workflow note produces the same run either way — outputs, run
JSON, and artifact indexes are written by shared core code.

### Headless agent

`vaultore agent` is a local scheduler daemon: it scans the vault,
registers every workflow with a `schedule:`, runs them on cron, and rescans
(every 300 seconds unless `--rescan` says otherwise). **It has no approval
step**, unlike the plugin: point it only at a vault whose workflows you
trust. It skips a scheduled run while the previous run of the same note is
still going. Run it under systemd or launchd to keep it alive.

### Embedding as a library

`@vaultore/cli` exports `NodeAdapter`, `discoverWorkflows`, and
`buildScheduleManifest`; `@vaultore/core` exports the parser, executor and
scheduler. Other tools can embed headless execution without shelling out.
Neither package is published to npm yet.

## CronAI Schedule Handover

`vaultore schedules export` writes a manifest of the vault's scheduled
workflows, meant to hand them to CronAI infrastructure that runs the same
`vaultore run` CLI. The export exists; the CronAI side does not yet. The
contract (ownership, drift detection, permissions in the cloud) is
specified in [specs/cronai-handover-spec.md](../specs/cronai-handover-spec.md).

## Open Knowledge Format (OKF)

[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
(Apache 2.0) specifies knowledge as Markdown files with YAML frontmatter,
organised in directory bundles and linked with standard Markdown links. Only
`type` is required; `title`, `description` and `tags` are recommended, and
consumers preserve unknown keys. Version 0.2, current when this was written
(2026-10-15), adds provenance (`generated: { by, at }`, replacing v0.1's
`timestamp`), trust (`verified`) and lifecycle (`status: draft | stable |
deprecated`, `stale_after`), with every timestamp an ISO 8601 datetime with
an offset.

What VaultOre does with it today:

- **Output views and artifact indexes are OKF v0.2 concepts.** They carry
  `type` (`VaultOre Output`, `VaultOre Artifacts`), `title`, `description`,
  `tags` and `generated: { by: vaultore/<version>, at }`. The cell's run
  state is `cellStatus`, leaving `status` to OKF's lifecycle, and artifact
  indexes link their files with relative Markdown links
  ([Ore implementation](../specs/ore-implementation.md#outputs-ore-9)).
- **Not yet a bundle.** The output folder has no bundle `index.md`, the JSON
  records are not OKF concepts, and the callouts in workflow notes still use
  wikilinks.
- **Reading a bundle** works like reading any notes: an `ore:ts` cell can
  `vault.read()` OKF files and pass them to an `ore:ai` cell.

An `okf export` command (bundle assembly, wikilink-to-Markdown-link
normalisation, a generated `index.md`) and an OKF ingestion helper are under
consideration ([roadmap](roadmap.md#under-consideration)).

## Obsidian CLI (official)

Obsidian has an official command-line interface
([obsidian.md/help/cli](https://obsidian.md/help/cli); read 2026-10-15: it needs
the Obsidian 1.12 installer and a running app). It composes with VaultOre from the
outside: scripts can prepare or query notes with it and open a workflow
note. `vaultore`, by contrast, works on the vault's files and needs no
running app.

Rule of thumb: drive a **running Obsidian** with the official CLI; drive
the **vault as files** with `vaultore`.

## Quarto (QMD)

Quarto's `.qmd` notebooks are the closest neighbour format: Markdown with
executable ```` ```{python} ````-style cells and YAML frontmatter, rendered
by `quarto render`.

1. **Cell mapping**: the formats translate mechanically.

   | Quarto | VaultOre |
   |--------|----------|
   | ```` ```{python} ```` | ```` ```ore:py ```` (planned) |
   | `#| option: value` cell options | fence attributes (`id=… depends=[…]`) |
   | `engine:` frontmatter | `runtime.engine:` frontmatter |
   | freeze/cache outputs | `_vaultore/runs/` output JSON |

2. **Engine extension**: a `quarto-vaultore` engine that runs `ore:*` cells
   during `quarto render`, which would make workflow notes publishable
   documents. Under consideration; whether Quarto's engine-extension API fits
   needs checking against the Quarto release current when the work starts.

## Surface Map

```
                      @vaultore/core (parser · executor · scheduler · providers)
                                         │
        ┌──────────────┬─────────────────┼──────────────────┬───────────────┐
        ▼              ▼                 ▼                  ▼               ▼
  Obsidian plugin   vaultore CLI    vaultore agent    CronAI runner    quarto-vaultore
  (interactive)     (headless run)  (local cron)      (not built)      (proposed)
        │                                                   ▲
        └── official Obsidian CLI drives the running app    └── schedule manifest handover
```
