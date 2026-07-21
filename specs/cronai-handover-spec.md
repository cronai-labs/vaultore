# CronAI Schedule Handover Specification

> **Version:** 0.1.0
> **Status:** Implemented (export side); cloud side tracked for v0.4
> **Last Updated:** 2026-07-21

## Motivation

Scheduled workflows only fire while a local scheduler is alive — the
Obsidian plugin (while the app is open) or `vaultore agent` (while the
daemon runs). True "every Monday at 9am" automation needs an always-on
executor. This spec defines the **handover contract** between local
VaultOre and CronAI infrastructure so scheduled jobs can migrate to the
cloud without changing a single workflow note.

The workflow note stays the source of truth. The handover manifest is a
derived artifact — regenerate it any time, diff it, commit it.

## The Schedule Manifest

Produced by `vaultore schedules export` (also available programmatically
via `buildScheduleManifest()` from `@vaultore/cli`).

```json
{
  "format": "vaultore.schedule-manifest",
  "version": "0.1",
  "generatedAt": "2026-07-21T12:00:00.000Z",
  "vault": { "root": "/path/to/vault", "name": "vault" },
  "workflows": [
    {
      "path": "Workflows/daily-summary.md",
      "name": "Daily Summary",
      "schedule": "0 18 * * *",
      "runtime": { "engine": "docker", "image": "oven/bun:1-alpine" },
      "permissions": { "network": "allow", "vaultWrite": "allow" },
      "contentSha256": "c9ef8a9e…"
    }
  ]
}
```

Field semantics:

| Field | Meaning |
|-------|---------|
| `format` / `version` | Manifest identity; consumers must reject unknown majors |
| `generatedAt` | Export time (ISO 8601) — staleness signal, not an expiry |
| `vault` | Where the manifest was generated; the cloud side maps this to its synced replica |
| `workflows[].path` | Vault-relative note path — the stable job identity |
| `workflows[].schedule` | Cron expression, verbatim from frontmatter |
| `workflows[].runtime` / `permissions` | Copied from frontmatter so the cloud runner can pre-validate capability requirements before accepting the job |
| `workflows[].contentSha256` | Hash of the note at export time, for drift detection |

**The manifest never contains secrets, cell code, or outputs.** It is safe
to commit and to transmit; the workflow content itself travels via vault
sync (see below), and API keys are injected by CronAI's secret store on
the runner.

## Execution Model

```
┌────────────── local ──────────────┐      ┌───────────── CronAI ─────────────┐
│ vault (git)                       │ sync │ vault replica (git)              │
│  ├─ Workflows/daily-summary.md ───┼─────►│  ├─ Workflows/daily-summary.md   │
│  └─ .vaultore/config.json         │      │  └─ .vaultore/config.json        │
│                                   │      │                                  │
│ vaultore schedules export ────────┼─────►│ scheduler registers cron jobs    │
│        (manifest)                 │      │   └─ fires: vaultore run <path>  │
│                                   │◄─────┤ outputs committed back to vault  │
└───────────────────────────────────┘ sync └──────────────────────────────────┘
```

1. The vault is synced to CronAI (git remote is the reference mechanism;
   outputs flow back as commits, so run results appear in Obsidian like
   any other sync).
2. CronAI ingests the manifest and registers one cron job per entry.
3. At fire time the runner executes `vaultore run <path> --vault <replica>`
   with the pinned container runtime — the **same headless CLI** users run
   locally, so local and cloud behavior are identical by construction.
4. Before running, the runner recomputes the note's SHA-256:
   - **match** → run
   - **mismatch** → the note changed since export; the runner re-reads
     `schedule` from the note. If the schedule changed, it re-registers and
     skips this fire; otherwise it runs the current content. (The manifest
     hands over *which notes are scheduled*, not a frozen snapshot.)

## Ownership — Avoiding Double Execution

Exactly one scheduler should own a workflow. On successful ingest, CronAI
writes `.vaultore/handover.json` into the vault:

```json
{
  "format": "vaultore.handover",
  "version": "0.1",
  "owner": "cronai",
  "acceptedAt": "2026-07-21T12:05:00.000Z",
  "workflows": ["Workflows/daily-summary.md"]
}
```

Local schedulers (plugin and `vaultore agent`) must skip registering any
path listed in a handover file with `owner: cronai`. Deleting the file —
or removing a path from it — returns ownership to local scheduling on the
next rescan. *(Local honoring ships in v0.2; until then, disable local
schedules manually after handover.)*

## Permission Semantics in the Cloud

- Cloud runs are non-interactive: any permission still at `ask` resolves
  to **deny** (same fail-closed rule as `vaultore run` without `--yes`).
- Users pre-grant per-workflow decisions in `.vaultore/config.json`
  (`permissionDecisions`), which syncs with the vault.
- CronAI must never widen a permission beyond what the note's frontmatter
  requests.

## Out of Scope (v0.1)

- Event triggers (file-change, webhook) — v0.4
- Partial-cell scheduling
- Manifest signing (planned before any multi-tenant ingestion endpoint)
