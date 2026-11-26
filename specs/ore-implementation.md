# VaultOre's Implementation of Ore

> **Status:** How VaultOre implements [Ore](https://github.com/cronai-labs/ore-spec/blob/main/SPEC.md) 0.2. The format is defined there; this document adds only what VaultOre decides or adds. It describes the code it is checked in with, so it names no VaultOre version.

The [Ore specification](https://github.com/cronai-labs/ore-spec) defines what a workflow note is, what its front matter and cells mean, how cells run and in which order, and where outputs go. This document follows its sections and records, for each one, what the specification leaves to the runner: VaultOre's code symbols (`packages/core/src/…`), error texts, settings, provider details, and the extensions VaultOre adds (artifacts, the output note's fields). Where a released VaultOre deviates from the specification, the specification's Appendix B says so. Where VaultOre accepts or checks more than Ore asks for, [Beyond the specification](#beyond-the-specification) lists it.

Permissions, their defaults and how `ask` is resolved are in [permissions-spec.md](permissions-spec.md); the container flags and hardening in [sandbox-spec.md](sandbox-spec.md).

## Workflow notes (Ore §2)

`isWorkflowFrontmatter` decides whether a note is a workflow. The plugin offers its run commands only on such notes.

## Front matter (Ore §3)

- The front matter is validated against `WorkflowFrontmatterSchema` (`packages/core/src/types/index.ts`). A known key with the wrong type fails the run with `Invalid frontmatter: …`.
- **Unknown keys are dropped without a warning:** a `runIf:` or `defaultModel:` is ignored, not rejected. Every key, known or not, is still part of what a permission decision is bound to (permissions-spec §5.3).
- `vaultore list` shows `name`.
- **`runtime.engine`:** the runner's setting is the plugin's "Default runtime engine" (CLI: `runtimeEngine` in `.vaultore/config.json`). `runtime.memoryLimit` and `runtime.cpuLimit` are passed to the engine as `--memory` and `--cpus`. Defaults: `DEFAULT_RUNTIME`.
- **The limits cannot be switched off from a note.** `runtime.timeout` is a number of seconds greater than 0 and at most 86400 (a day; `MAX_TIMEOUT_SECONDS`), `runtime.cpuLimit` a number greater than 0, and `runtime.memoryLimit` an amount greater than zero with an optional unit, such as `512m` (the unit itself is left to the engine). Anything else fails the run before any cell runs, with the key and the value in the message: `Invalid frontmatter: runtime.timeout: expected a number of seconds greater than 0 and at most 86400, got 0`. The engines read a memory or CPU limit of `0` as "no limit", and a time limit of `0` set no timer. Ore requires all three checks (§3.3, §10). For the memory limit it fixes only that an empty value or an amount of zero fails; VaultOre asks for the form as well (see [Beyond the specification](#beyond-the-specification)).
- **Engine check:** every run checks that the engine is available before any cell runs, even a workflow with only AI cells.
- **`runtime.timeout`** applies to container cells only; AI cells use the AI request timeout (below).
- **`schedule`** is read by `cron-parser` 5. Schedulers tick every 60 seconds.
  - **One runner per note:** on each computer a scheduled note is approved for Obsidian or for the agent, in one file both read (`~/.config/vaultore/schedules.json`); only that runner arms it (#301). Details: [permissions-spec.md](permissions-spec.md) §6.
  - **Obsidian plugin:** runs a scheduled note only while Obsidian is open, only when the "Run scheduled workflows" setting is on (off by default), and only when the user approved that note's exact schedule for Obsidian in the settings list. A changed schedule, a renamed note or a note that arrives through sync is listed but not run until approved. An invalid expression is shown in the list and reported once as a notice.
  - **`vaultore agent`:** runs a scheduled note only after `vaultore schedules approve`, and only while the note's front matter and cells are what was approved (the hash a permission decision is bound to). One agent runs a vault at a time, holding a lock the plugin reads to show whether it runs. The note and the approvals are read again when a run is due. Its rescan, every `--rescan` seconds, keeps the next run of a note it armed already, so an occurrence that came due just before a rescan still runs (#255). Details: [permissions-spec.md](permissions-spec.md) §6.2.
  - **One run per occurrence:** each occurrence of a note's schedule, a slot, runs at most once, whether the plugin or the agent fires it. The runner whose own check passes first claims it, in a record outside the vault beside the run locks (`~/.config/vaultore/slots`); the other skips it, naming the first. The record keeps what each slot came to, for 30 days at most (`--keep-days`, the plugin's "Scheduled-run history"), and `vaultore schedules log` shows it. Slots that no runner fired are recorded as missed runs when a runner arms the note or its tick comes later than the "Late after" setting (2 minutes by default, one value per machine, `vaultore schedules late-after`), said once, and caught up (one run) or dismissed by the user (`vaultore schedules catch-up | dismiss`, the plugin's "Missed runs" settings) (#269). The model, its states and limits: [schedule-record-spec.md](schedule-record-spec.md).
- **`go:`:** the schema accepts a `go:` block ([go-cell-spec.md](go-cell-spec.md)); nothing reads it.

## Permissions (Ore §4)

[permissions-spec.md](permissions-spec.md) §2–§5: defaults, what each permission controls in VaultOre (mounts, masked folders, network), stored decisions and how `ask` is asked.

## Cells (Ore §5)

- `ore:py` and `ore:go` cells are parsed and fail at run time, each on its own: `Cell "<id>" is an ore:<type> cell, which VaultOre does not run. It runs ore:ts, ore:shell and ore:ai cells: rewrite the cell as one of those, or remove it. Cells that do not depend on it still run.` (`unsupportedCellMessage`). The message names no VaultOre version.
- A missing, empty or duplicate `id`, or a `depends` entry naming no cell, is a parse error.
- An `id` that is not of the form Ore §5.3 gives is a parse error that names the id and the rule it breaks (`idFault`, `packages/core/src/parser/index.ts`): `Cell id "fetch.raw" contains ".": an id holds only the letters A-Z and a-z, digits, "_" and "-"`, `Cell id "-rf" starts with "-": an id starts with a letter or digit`, `Cell id "…" has 65 characters: an id has at most 64`. The characters are matched as these exactly; a letter outside `A`-`Z` and `a`-`z` is refused.
- A reserved `id` is a parse error in any letter case: `Cell id "Run" is reserved: its output would be run.json, the run's own record`, and for `con`, `prn`, `aux`, `nul`, `com0` to `com9` and `lpt0` to `lpt9`, `Cell id "COM1" is reserved: Windows keeps this name for a device, so it cannot be a file name there`. Only `A`-`Z` are folded for the comparison.
- Two ids that differ only in letter case are a parse error at the second cell: `Cells fetch and Fetch differ only in letter case, and their output files are one file where case is ignored: rename one`. Ids are compared exactly everywhere else.
- `timeout` on a container cell is a number of seconds greater than 0 and at most 86400, written in digits (`30`, `0.5`). Anything else (`2m`, `abc`, `0`, `-5`, `86401`) is a parse error that names the cell. Without a number above zero no kill timer was set, and far above a day the limit stops being one: a delay past 2^31-1 ms does not fit a timer, which then fires at once. On an `ore:ai` cell the attribute is ignored, whatever its value (Ore §5.3: it has no effect there).
- `execContainer` refuses a `timeout` that is not greater than 0 or does not fit a timer (`MAX_TIMER_MS`), and `buildRunCommand` a memory or CPU limit of zero or an empty one, so a caller that does not go through the parser cannot get an unlimited cell by passing a wrong value. Leaving the option out is the only way to run without that limit.
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
- **`cell(id)`** answers for cells that have an output and for nothing else; any other id throws `Cell output not found: <id>`. The outputs reach the script as one JSON string parsed into a `Map` (`cellOutputsSource`), so a name is data whatever it is: `cell("constructor")` throws, and an output recorded under `__proto__` is an entry like any other ([#223](https://github.com/cronai-labs/vaultore/issues/223)). No cell can have that id, but a recorded output is named by its callout in the note.
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

- `orderCells` orders the cells as Ore §8 describes, with a queue. It starts with the cells that have no dependencies, in document order. A cell joins the end when the last of its dependencies has had its turn, and cells that join at the same moment join in document order. For cells `a`, `b` (depends on `a`), `c` and `d` (depends on `a`) the order is `a c b d`: `c` was in the queue from the start, `b` and `d` joined after `a`. With `b` depending on `c` instead it is `a c d b`.
- A cell whose dependency did not succeed fails with `Dependency output missing: <id>` or `Dependency failed: <id>`.
- **Running one cell:** "Run cell" (`vaultore run --cell`) runs it with its dependencies; "Run cell only (skip dependencies)" (`--skip-deps`) runs it alone, with the dependencies' last recorded outputs. An id that no cell of the note has, an empty one included, fails before anything runs or is recorded: `Cell "reprot" not found in Workflows/digest.md. Its cells are: fetch, report`.
- **A dependency cycle is a parse error**, so no cell runs: `Dependency cycle: a depends on b, b depends on a`, or `Cell a depends on itself`, reported at the line of the cycle's first cell (`findDependencyCycle`). Ore requires this from version 0.2 (§5.3, §10).
- **One run per note,** across the plugin and the CLI (#215). Every run of a note, started by hand or by a schedule, holds the note's run lock from before its run record exists until it ends, also when it fails; a runner that is killed leaves it behind (below). A second run is refused before anything runs or is recorded, and told who holds the note: `Workflows/digest.md is already being run by process 4242 (vaultore agent), since <time>. Nothing was run. If that process is not running VaultOre, remove <lock>`. The plugin shows it as a notice, `vaultore run` exits with 1, and `vaultore agent` reports the scheduled run as skipped.
  - **Where:** outside the vault, in one directory per user that no flag, setting or environment variable moves: `~/.config/vaultore/locks` under the account's home directory, `%APPDATA%\vaultore\locks` on Windows. Sync cannot deliver a lock, and a cell cannot reach one. A lock is named after the note's real path, as the file system spells it, so a note reached through a linked vault folder or in other letter case on macOS and Windows is one note (`packages/core/src/lock/run-lock.ts`).
  - **Decided inside the lock:** with the lock held, the note is read again. If it is no longer what the runner read and checked (another run wrote its outputs into it, or it was edited), nothing runs: `<note> changed after it was read for this run, so nothing was run. Run it again`.
  - **A lock left behind** by a runner that was killed, or by a run of an earlier load of the plugin (Obsidian reloads a plugin in the same process), or taken more than an hour before the machine last started, is taken over, and the runner logs it (the CLI on stderr, the plugin in the developer console). A lock whose holder runs is never removed (`packages/core/src/lock/index.ts`). The hour keeps a clock set forward after the lock was taken (a time sync after waking, a resumed virtual machine) from making a live lock look older than the boot; a lock the process itself holds is never judged by the clock.
  - **The run it cut off** never finalised its record, so its `run.json` still says `"running"`. The run that takes the lock over marks it `"aborted"`, with an `error` naming the holder, why it no longer held the lock, and when this was recorded. It touches only this note's records that still say `"running"` and started at or after the holder took the lock: while the holder held it, no other run of the note could start one (#256).
  - **The limits:**
    - Two machines that run the same synced vault each have their own locks, so both may run a note at once. Run scheduled notes on one machine.
    - Runners in separate containers that share a lock directory cannot see each other's processes, and may take each other's locks as left behind.
    - The lock prevents two runs at once, not two runs in a row. For a note scheduled in both the plugin and `vaultore agent`, the schedule record (above) keeps the second runner from running the same occurrence again (#255).
    - A runner needs to be able to create `~/.config/vaultore/locks`. Under a user id with no account entry (a container may run one), or with a read-only home, every run is refused with a message saying so.

## Outputs (Ore §9)

- `<outputRoot>` is the "Output folder" setting (CLI: `outputRoot`), default `_vaultore`.
- **Callout:** a cell whose output names artifacts (below) adds `> artifactDir: [[<dir>/_index.md]]` and `> artifacts: [[file]], …`.
- **`<cellId>.json`:** the file is named after the id as written. `meta` also holds `outputPath`, `outputViewPath` and `artifacts`. **`index.json`** lists each run with its outputs.
- **A recorded output** (the last output of a cell that does not run in this run) is read from the path its callout in the note links, never from a computed name, so records of earlier versions are found where they are. The record must name the cell: one whose `cellId` is another cell's is skipped with the warning `Not reading the recorded output of <id>: <path> is the record of cell <other>` (`hydrateOutputsFromStubs`).
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
    by: vaultore/VERSION
    at: 2026-10-15T08:00:00.000Z
  ---
  ```

  `VERSION` is the version of the VaultOre that wrote the note, `RUN_ID` the run's id. The body is the value in a fenced block (`text` for a string, `json` otherwise), fenced longer than any backtick run inside it.

### Artifacts (VaultOre extension)

A TS cell whose output is an object with `artifactDir` (a vault path) and/or `files` (vault paths) gets an index note, `<artifactDir>/_index.md`: an OKF concept of type `VaultOre Artifacts` that links each file with a relative Markdown link. See the last cell of `fixtures/canonical/sys-snapshot.md`.

## Beyond the specification

Where VaultOre accepts or checks more than Ore 0.2 asks for, or decides what Ore leaves open. A note written as the specification describes never meets them. They are recorded so that a change to one of them is a decision.

- **Attribute values (Ore §5.2, Appendix A).** Every attribute is read in each of the four forms a value can have, and its value is the text inside the quotes or brackets (`readAttributes`). So `timeout="30"`, `timeout='30'` and `timeout=[30]` are 30 seconds, `id="a"` and `id=[a]` are the id `a`, and `depends=a` and `depends="a, b"` name cells without brackets. Ore's grammar gives a value these forms without tying a form to an attribute; its text uses brackets for the list in `depends` only.
- **A repeated attribute.** The last one on the fence line counts: `timeout=5 timeout=7` is 7 seconds. When a cell has both `maxTokens` and `max_tokens`, `maxTokens` counts. Ore does not say.
- **`timeout` on `ore:py` and `ore:go` cells** is checked like on `ore:ts` and `ore:shell`: a wrong value is a parse error, so no cell runs. Ore requires the check for `ts` and `shell` cells (§5.3) and has these cell types fail at run time (§5.1), which they do when the value is valid or absent.
- **`temperature` and `maxTokens` are read leniently.** A value that does not start with a number is dropped, and the cell runs with the setting instead: `temperature=warm`. A number followed by other text is read up to that text, and `maxTokens` loses its fraction: `temperature=0.5abc` is 0.5, `maxTokens=12.7` is 12. Ore gives the two attributes a type (§5.3) and no rule for a value that is not of it.
- **The form of `runtime.memoryLimit`.** Ore refuses an empty value and an amount of zero and leaves the rest to the container engine (§3.3). VaultOre also refuses, before any cell runs, a value that is not a number with an optional unit of up to three letters (`isMemoryLimit`): `lots`, `-512m`, `512 megabytes`. A unit the engine does not know still fails the cell there, with the engine's message.

## Reserved features (Ore §12)

VaultOre implements none of the reserved features: the parser drops the reserved front matter keys and cell attributes, and `ore:py` and `ore:go` cells fail (see Cells above). VaultOre's design work on them: conditions and structured outputs [#80](https://github.com/cronai-labs/vaultore/issues/80), note references from another cell [#71](https://github.com/cronai-labs/vaultore/issues/71), `ore:go` [go-cell-spec.md](go-cell-spec.md), parallel cells [parallel-execution.md](../docs/design/parallel-execution.md). The [roadmap](../docs/roadmap.md) lists the rest.
