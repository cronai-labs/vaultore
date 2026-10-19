# VaultOre's Implementation of Ore

> **Status:** How VaultOre 0.1.3 implements [Ore 0.1](https://github.com/cronai-labs/ore-spec/blob/main/SPEC.md). The format is defined there; this document adds only what VaultOre decides or adds.
> **Last Updated:** 2026-10-19

The [Ore specification](https://github.com/cronai-labs/ore-spec) defines what a workflow note is, what its front matter and cells mean, how cells run and in which order, and where outputs go. This document follows its sections and records, for each one, what the specification leaves to the runner: VaultOre's code symbols (`packages/core/src/…`), error texts, settings, provider details, and the extensions VaultOre adds (artifacts, the output note's fields). Where VaultOre deviates from the specification, the specification's Appendix B says so.

Permissions, their defaults and how `ask` is resolved are in [permissions-spec.md](permissions-spec.md); the container flags and hardening in [sandbox-spec.md](sandbox-spec.md).

## Workflow notes (Ore §2)

`isWorkflowFrontmatter` decides whether a note is a workflow. The plugin offers its run commands only on such notes.

## Front matter (Ore §3)

- The front matter is validated against `WorkflowFrontmatterSchema` (`packages/core/src/types/index.ts`). A known key with the wrong type fails the run with `Invalid frontmatter: …`.
- **Unknown keys are dropped without a warning:** a `runIf:` or `defaultModel:` is ignored, not rejected. Every key, known or not, is still part of what a permission decision is bound to (permissions-spec §5.3).
- `vaultore list` shows `name`.
- **`runtime.engine`:** the runner's setting is the plugin's "Default runtime engine" (CLI: `runtimeEngine` in `.vaultore/config.json`). `runtime.memoryLimit` and `runtime.cpuLimit` are passed to the engine as `--memory` and `--cpus`. Defaults: `DEFAULT_RUNTIME`.
- **Engine check:** every run checks that the engine is available before any cell runs, even a workflow with only AI cells.
- **`runtime.timeout`** applies to container cells only; AI cells use the AI request timeout (below).
- **`schedule`** is read by `cron-parser` 5. Schedulers tick every 60 seconds.
  - **Obsidian plugin:** runs a scheduled note only while Obsidian is open, only when the "Run scheduled workflows" setting is on (off by default), and only when the user approved that note's exact schedule in the settings list. A changed schedule, a renamed note or a note that arrives through sync is listed but not run until approved. An invalid expression is shown in the list and reported once as a notice.
  - **`vaultore agent`:** runs every workflow in the vault that has a schedule. It has no approval list.
- **`go:`:** the schema accepts a `go:` block ([go-cell-spec.md](go-cell-spec.md)); nothing reads it.

## Permissions (Ore §4)

[permissions-spec.md](permissions-spec.md) §2–§5: defaults, what each permission controls in VaultOre (mounts, masked folders, network), stored decisions and how `ask` is asked.

## Cells (Ore §5)

- `ore:py` and `ore:go` cells are parsed and fail at run time with `Cell type not supported in v0.1`.
- A missing or duplicate `id`, or a `depends` entry naming no cell, is a parse error.
- In output file names, characters of `id` other than letters, digits, `_` and `-` become `_`.
- A non-numeric `timeout` currently disables the timeout ([#45](https://github.com/cronai-labs/vaultore/issues/45)).
- `mode`, `stdin` and `stdout` are parsed for `ore:go` and unused.

## Templates (Ore §6)

- Resolved by `interpolateAsync`, in one pass.
- Building a note path in one cell and loading it in the next is proposed ([#71](https://github.com/cronai-labs/vaultore/issues/71)); a TS cell can do it today with `vault.read(cell("path"))`.
- `{{note:}}` through a symbolic link that leaves the vault, or ends in one, fails as described in permissions-spec §3.4.

## Cell semantics (Ore §7)

Each container cell runs with `--rm`. How the vault is mounted and the container's hardening: permissions-spec §3–§4.

### `ore:ts`

- The cell runs as `/tmp/vaultore.ts` under `bun`. The runtime that provides the globals is injected by `buildTypeScriptRuntime` (`packages/core/src/executor/index.ts`).
- **Output** goes through `JSON.stringify`: what JSON cannot hold (a function, a `Map`, a `Date` as an object) does not survive.
- **Globals:** `vault.exists(path)` is also true for this cell's pending writes. `vault.write` creates parent folders itself. `vault.readRaw` has no permission check. The permission checks in these helpers only turn a doomed access into a clear error: the mount enforces reads (permissions-spec §3.3), the host enforces `vault.write` (§3.4). Bun's own APIs and `fetch` are available; `fetch` reaches the network only under `network: allow`.
- **What `vault.write` guarantees** ([#83](https://github.com/cronai-labs/vaultore/issues/83)): each write records the SHA-256 of the text the cell last read from that path with `vault.read`, or that `vault.read` or `vault.exists` found nothing there. After the cell exits successfully, the host checks every such write against the file as it is now and applies the writes, in the order the cell made them, only if all match. Otherwise the cell fails, naming each note that changed: the note was edited during the run, or the container saw a stale copy (Colima with sshfs). Within a cell, a second write to a path replaces the first and keeps its base.
  - A cell that ends with `process.exit()` before its writes are handed over writes nothing.
  - A byte-order mark at the start of a note is ignored by the check and dropped by `vault.read`.
  - The check and the write are two steps on the host, so an edit landing between them, within milliseconds, is not caught.
  - Not covered: shell cells, `vault.mkdirp()` and raw writes to `/workspace` (`Bun.write`, `node:fs`) go straight through the mount. A cell sees its own `vault.write` only through `vault.read`/`vault.exists`, not on disk. A cell that only reads can still see a stale copy.
- **Framing on stdout.** The host gives each cell run a random 128-bit nonce, written into its script. The runtime prints the value as one line of JSON between `__VAULTORE_OUTPUT_START_<nonce>__` and `__VAULTORE_OUTPUT_END_<nonce>__` lines, then the writes the same way between `__VAULTORE_WRITES_START_<nonce>__` and `__VAULTORE_WRITES_END_<nonce>__`: a list of `{ path, content, base }`, where `base` is `{ "sha256": "<hex>" }`, `{ "absent": true }` or `null`. Lines without the nonce are the cell's own logging, so text it prints cannot pass for a block. Exactly one output block and at most one writes block after it are accepted; a second block, or a writes block before the output, fails the cell and applies nothing. Stdout without any framing, as from a cell that exited early, is the value as a whole and applies no writes.
- **Environment:** `VAULTORE_RUN_ID`, `VAULTORE_OUTPUT_ROOT`, `VAULTORE_RUN_DIR` and `HOME=/tmp`.

### `ore:shell`

The default image's `sh` is busybox. The output is stdout, untrimmed.

### `ore:ai`

1. Without `network: allow` the cell fails with `AI cells require network permission`.
2. **Provider:** the "Default provider" setting (CLI: `defaultProvider`), `openai` or `anthropic`; default `openai`. Any other value fails the cell.
3. **Model:** the cell's `model=`, else the "Default model" setting, else the provider's default (`DEFAULT_MODELS`: `gpt-5-mini` for OpenAI, `claude-haiku-5-5` for Anthropic). A `claude-*` model under OpenAI, or a `gpt-*`, `o1*`, `o3*` or `o4*` model under Anthropic, fails the cell before anything is read or sent.
4. **Prompt:** no system prompt.
5. **Parameters:** OpenAI models starting with `o1`, `o3` or `gpt-5` get no temperature and receive `max_completion_tokens` instead of `max_tokens`. Anthropic requests always carry `max_tokens`, 800 when nothing is set.
6. **Timeout:** the "AI request timeout" setting (CLI: `aiTimeoutSeconds`), default 120 seconds.

Requests go to `https://api.openai.com/v1/chat/completions` or `https://api.anthropic.com/v1/messages`: from the plugin through Obsidian's `requestUrl`, from the CLI through `fetch`. A TS cell that needs JSON from an AI cell calls `JSON.parse(cell("id"))` (see `fixtures/canonical/smart-inbox.md`).

## Execution order (Ore §8)

- `orderCells` orders the cells.
- A cell whose dependency did not succeed fails with `Dependency output missing: <id>` or `Dependency failed: <id>`.
- **Running one cell:** "Run cell" (`vaultore run --cell`) runs it with its dependencies; "Run cell only (skip dependencies)" (`--skip-deps`) runs it alone, with the dependencies' last recorded outputs.
- **A dependency cycle is not detected.** All cells then run in document order, and the first one whose dependency has no output fails ([#45](https://github.com/cronai-labs/vaultore/issues/45)).
- **One run per note:** the plugin refuses to start a second run of a note that is running; `vaultore agent` skips a scheduled run while the previous one is in progress.

## Outputs (Ore §9)

- `<outputRoot>` is the "Output folder" setting (CLI: `outputRoot`), default `_vaultore`.
- **Callout:** a cell whose output names artifacts (below) adds `> artifactDir: [[<dir>/_index.md]]` and `> artifacts: [[file]], …`.
- **`<cellId>.json`:** `meta` also holds `outputPath`, `outputViewPath` and `artifacts`. **`index.json`** lists each run with its outputs.
- **`<cellId>.md`** is written by `renderOutputMarkdown` (`packages/core/src/executor/output-note.ts`). Its front matter:

  ```yaml
  ---
  type: VaultOre Output
  title: step1 output
  description: Output of workflow cell step1 (status success).
  tags:
    - vaultore
    - output
  vaultore: output
  cellId: step1
  runId: RUN_ID
  cellStatus: success
  durationMs: 120
  source: _vaultore/runs/my-workflow/RUN_ID/step1.json
  generated:
    by: vaultore/0.1.3
    at: 2026-10-15T08:00:00.000Z
  ---
  ```

  The body is the value in a fenced block (`text` for a string, `json` otherwise), fenced longer than any backtick run inside it.

### Artifacts (VaultOre extension)

A TS cell whose output is an object with `artifactDir` (a vault path) and/or `files` (vault paths) gets an index note, `<artifactDir>/_index.md`: an OKF concept of type `VaultOre Artifacts` that links each file with a relative Markdown link. See the last cell of `fixtures/canonical/sys-snapshot.md`.

## Reserved features (Ore §12)

VaultOre implements none of the reserved features: the parser drops the reserved front matter keys and cell attributes, and `ore:py` and `ore:go` cells fail (see Cells above). VaultOre's design work on them: conditions and structured outputs [#80](https://github.com/cronai-labs/vaultore/issues/80), note references from another cell [#71](https://github.com/cronai-labs/vaultore/issues/71), cycle detection [#45](https://github.com/cronai-labs/vaultore/issues/45), `ore:go` [go-cell-spec.md](go-cell-spec.md), parallel cells [ARCHITECTURE.md](../ARCHITECTURE.md#parallel-execution-not-built). The [roadmap](../docs/roadmap.md) lists the rest.
