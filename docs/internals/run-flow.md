# How a run flows through the code

The adapters, the core modules and the steps of a run. The map of the repository is [ARCHITECTURE.md](../../ARCHITECTURE.md). Behaviour is specified in [specs/](../../specs/); this describes the code that implements it.

## Adapters

The plugin and the CLI each implement `PlatformAdapter` and call the same executor.

```
            @vaultore/core
            ┌──────┴──────┐
            ▼             ▼
  @vaultore/obsidian   @vaultore/cli
  (Obsidian plugin)    (vaultore command, NodeAdapter)
```

| | Obsidian plugin | CLI |
|---|---|---|
| Built by | esbuild → `packages/obsidian/dist/main.js` (one CommonJS bundle, core included) | tsup → `packages/cli/dist/cli.js`, `index.js` |
| Files | Obsidian's vault API; `.vaultore/` through the adapter | Node `fs`, confined to the vault root |
| Settings | Plugin data (`.obsidian/plugins/vaultore/data.json`) | `<vault>/.vaultore/config.json` |
| Secrets | Obsidian secret storage, by the name the user selected | Environment variables |
| HTTP | `requestUrl` | `fetch` |
| Timers (core calls none of its own) | The window's; the scheduler's interval is registered with the plugin | Node's |
| `ask` permissions | Modal | Deny, or allow with `--yes` |
| Run lock | `acquireRunLock` as `Obsidian` | `acquireRunLock` as `vaultore run`, `vaultore agent` or `vaultore schedules catch-up` |
| Schedule record | `claimSlot` as `Obsidian`, pruned by the "Scheduled-run history" setting | `claimSlot` as `vaultore agent`, pruned by `--keep-days` |
| Scheduling | Approved notes only, while Obsidian is open; an approval is a path and a schedule, in the plugin data | `vaultore agent`, approved notes only; an approval is a path and the note's content hash, in `approvals.json` outside the vault (`--state-dir`) |

## Core modules

| Module | Responsibility | Main symbols |
|--------|----------------|--------------|
| `types` | Shared types; `DEFAULT_PERMISSIONS`, `DEFAULT_RUNTIME`, `WorkflowFrontmatterSchema` (zod) | |
| `parser` | Frontmatter and cells from note text; reading and writing output callouts; `{{…}}` templates | `WorkflowParser`, `OutputSerializer`, `TemplateInterpolator`, `isWorkflowFrontmatter` |
| `executor` | A whole run: permissions, engine check, order, each cell, outputs, run records | `WorkflowExecutor`, `renderOutputMarkdown` |
| `runtime` | Which engines answer; the `run` command line with its hardening; spawning it | `detectRuntimes`, `buildRunCommand`, `execContainer` |
| `providers` | Requests to OpenAI and Anthropic, through the adapter's `request` (core has no transport of its own); model/provider check; timeouts | `createProviderFromSettings`, `assertModelMatchesProvider`, `DEFAULT_MODELS` |
| `scheduler` | Cron registrations, a 60-second tick, due runs handed to a callback with the occurrence that came due; whether a note still has its schedule approval; the schedule record, which lets each occurrence run at most once across the plugin and the CLI, in `~/.config/vaultore/slots`, and records the occurrences no runner fired as missed runs to catch up or dismiss | `WorkflowScheduler`, `computeNextRun`, `classifyScheduleApproval`, `claimSlot`, `readSlotRecord`, `SlotTakenError`, `recordMissedSlots`, `catchUpMissedSlot`, `dismissMissedSlots` |
| `lock` | A lock between VaultOre processes on one machine: the approvals file's, and one run lock per note, shared by the plugin and the CLI, in `~/.config/vaultore/locks` | `acquireLock`, `acquireRunLock`, `RunLockHeldError` |
| `settings` | This machine's settings both runners must share, in `~/.config/vaultore/settings.json`: the late threshold | `readMachineSettings`, `writeMachineSettings`, `machineSettingsPath` |
| `vault` | `createVaultAPI`, `generateRuntimeScript`: exported, but the executor injects its own copy (`buildTypeScriptRuntime`), and the two have diverged ([#45](https://github.com/cronai-labs/vaultore/issues/45)) | |

## The steps of a run

`WorkflowExecutor.runWorkflow` (`packages/core/src/executor/index.ts`):

1. **Parse** the note: frontmatter against the schema, cells, existing outputs.
2. **Claim the slot**, for a scheduled run only: the platform's `claimSlot`, refused when a
   runner claimed this occurrence first. A catch-up of missed runs brings the slot it holds
   instead (`slotClaim`). From here the slot is spent; its outcome is written when the run
   ends, however it ends (schedule-record-spec).
3. **Lock the note**: the platform's `acquireRunLock`, refused while another run of the note
   holds it. A lock left behind by a run that ended without finishing is taken over, and that
   run's record is marked `aborted`. Then read the note again, and stop if it is no longer what
   the caller read. The lock is released when the run ends (ore-implementation, "One run per
   note").
4. **Create the run**: a run id, `<outputRoot>/runs/<workflow>/<runId>/run.json` with status
   `running`.
5. **Resolve permissions**: defaults, then frontmatter, then a stored decision or a prompt for
   each `ask`, bound to a hash of the frontmatter and cells (permissions-spec §5).
6. **Choose and check the engine**: frontmatter, else setting, else `docker`; `detectRuntimes`
   probes all four engines in parallel, each with a 10-second timeout.
7. **Order the cells** by `depends`; for a single-cell run, keep the target and what it needs.
8. **Hydrate** earlier outputs from the JSON files the note's callouts link, so `cell()` and
   dependency checks can use them for cells that do not run this time.
9. **For each cell, one at a time:** check its dependencies succeeded; run it (a container for
   `ts` and `shell`, a provider request for `ai`); write its JSON record, Markdown view and the
   run index; re-read the note and replace the cell's callout.
10. **Finish** `run.json`: `completed`, `failed` (a cell failed) or `aborted` (the run threw).

A container cell is `docker run --rm …` (or `podman`, or `container` for Apple; Colima uses
the `docker` CLI). TS cells get a generated script on stdin that defines `cell()`, `vault` and
`vaultore`, runs the cell body, and prints the last expression's value as JSON between markers
the executor extracts.
