# Workflow Note Specification

> **Status:** Canonical for the format. Sections 1–8 describe what the code does at
> version 0.1.0; [Planned](#planned) lists what is specified but not built.
> **Last Updated:** 2026-10-15

A VaultOre workflow is a Markdown note in the vault that contains executable cells. This
specification defines its format and how it runs. Where a behaviour comes from a specific
place in the code, the section names the symbol (`packages/core/src/…`).

Permissions and their defaults are specified in [permissions-spec.md](permissions-spec.md),
the container sandbox in [sandbox-spec.md](sandbox-spec.md). This document links to them
rather than repeating them.

## 1. File Structure

A workflow note has YAML frontmatter with `ore: true`, and a Markdown body with `ore:*` cells.
After a run, VaultOre writes an output callout under each cell:

````markdown
---
ore: true
name: My Workflow
---

# My Workflow

Any Markdown.

```ore:ts id=step1
1 + 1;
```

> [!ore-output] step1
> view: [[_vaultore/runs/my-workflow/RUN_ID/step1.md]]
> ![[_vaultore/runs/my-workflow/RUN_ID/step1.md]]
> json: [[_vaultore/runs/my-workflow/RUN_ID/step1.json]]
> run: RUN_ID
> status: success | duration: 0.12s | at: 2026-10-15T08:00:00.000Z
````

A note is a workflow when its frontmatter parses and `ore` is the boolean `true`
(`isWorkflowFrontmatter`). The plugin offers its run commands only on such notes.

---

## 2. Frontmatter

The frontmatter is validated against `WorkflowFrontmatterSchema`
(`packages/core/src/types/index.ts`). A known key with the wrong type fails the run with
`Invalid frontmatter: …`. **Unknown keys are dropped without a warning**: a `runIf:` or
`defaultModel:` in frontmatter is ignored, not rejected. Every key, known or not, is still part
of what a permission decision is bound to (permissions-spec §5.3).

### 2.1 Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `ore` | `true` | Marks the note as a workflow |
| `name` | string | Human-readable name; `vaultore list` shows it |

### 2.2 Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | The workflow's own version. Quote it: `version: "0.1"`. Unquoted, `0.1` is a YAML number and fails validation |
| `author` | string | |
| `tags` | string[] | |
| `description` | string | |

### 2.3 Runtime

```yaml
runtime:
  engine: docker            # docker | podman | colima | apple
  image: oven/bun:1-alpine  # image for ore:ts and ore:shell cells
  timeout: 60               # seconds per container cell
  memoryLimit: "512m"       # passed to --memory
  cpuLimit: 1               # passed to --cpus
```

| Field | Default (`DEFAULT_RUNTIME`) | Description |
|-------|-----------------------------|-------------|
| `runtime.engine` | the plugin's "Default runtime engine" setting (CLI: `runtimeEngine` in `.vaultore/config.json`), else `docker` | Container engine. When set here it overrides the setting; if that engine is unavailable, the error says the note asked for it |
| `runtime.image` | `oven/bun:1-alpine` | Image for every `ore:ts` and `ore:shell` cell. It must provide `sh`, and `bun` for TS cells |
| `runtime.timeout` | `60` | Seconds a container cell may run; a cell's `timeout=` overrides it. AI cells use the AI request timeout instead (§5.3) |
| `runtime.memoryLimit` | `"512m"` | Container memory limit |
| `runtime.cpuLimit` | `1` | Container CPU limit |

Every run checks that the engine is available before any cell runs, even when the workflow has
only AI cells.

### 2.4 Permissions

```yaml
permissions:
  network: deny        # allow | deny | ask
  vaultRead: allow
  vaultWrite: deny
  buildNetwork: deny
```

Defaults, what each permission controls and how `ask` is resolved: permissions-spec §2–§5.

### 2.5 Schedule

```yaml
schedule: "0 9 * * 1-5"   # 09:00 on weekdays, machine local time
```

A cron expression as `cron-parser` 5 reads it: five fields, or six with a leading seconds
field. Schedulers check every 60 seconds, so the effective resolution is one minute.

- **Obsidian plugin:** runs a scheduled note only while Obsidian is open, only when the
  "Run scheduled workflows" setting is on (off by default), and only when the user approved
  that note's exact schedule in the settings list. A changed schedule, a renamed note or a note
  that arrives through sync is listed but not run until approved. An invalid expression is
  shown in the list and reported once as a notice.
- **`vaultore agent`:** runs every workflow in the vault that has a schedule. It has no
  approval list.

### 2.6 `go:`

The schema accepts a `go:` block ([go-cell-spec.md](go-cell-spec.md)); nothing reads it.

---

## 3. Cells

### 3.1 Form

````markdown
```ore:<type> <attributes>
<content>
```
````

| Type | Status |
|------|--------|
| `ore:ts` | TypeScript or JavaScript, run by Bun in a container (§5.1) |
| `ore:shell` | `sh -lc <content>` in a container (§5.2) |
| `ore:ai` | One completion from the configured provider (§5.3) |
| `ore:py`, `ore:go` | Parsed, but the cell fails at run time with `Cell type not supported in v0.1` ([Planned](#planned)) |

The content is trimmed. A fence with any other `ore:` type is not a cell.

### 3.2 Attribute Syntax

Attributes follow the type on the fence line, separated by spaces: `key=value`,
`key="value with spaces"`, `key='value'`, or `key=[a, b]` for lists. Keys are letters, digits
and `_`. Unknown attributes are ignored.

````markdown
```ore:ai id=summarize depends=[fetch, config] model=gpt-5-mini temperature=0
````

### 3.3 Attributes

| Attribute | Applies to | Description |
|-----------|------------|-------------|
| `id` | all | **Required.** Unique within the note; a missing or duplicate id is a parse error. Use letters, digits, `_` and `-`: only those can be referenced as `{{id}}`, and other characters become `_` in output file names |
| `depends` | all | Ids of cells that must succeed first (§6). An unknown id is a parse error |
| `timeout` | `ts`, `shell` | Seconds; overrides `runtime.timeout`. A non-numeric value currently disables the timeout ([#45](https://github.com/cronai-labs/vaultore/issues/45)) |
| `model` | `ai` | Model id (§5.3) |
| `temperature` | `ai` | Number; overrides the temperature setting |
| `maxTokens` | `ai` | Integer; `max_tokens` is accepted as well. Overrides the max tokens setting |

`mode`, `stdin` and `stdout` are parsed for `ore:go` and unused.

---

## 4. Templates

Templates are resolved in **`ore:ai` cells only**. TS and shell cell content is passed
through as written; a TS cell reads upstream values with `cell()`.

| Syntax | Resolves to |
|--------|-------------|
| `{{cellId}}` | That cell's output: a string as is, anything else as indented JSON. An id with no output yet stays as the literal text |
| `{{note:Path/To/Note.md}}` | The note's content, by vault-relative path |

Templates are resolved in one pass over the cell's own text (`interpolateAsync`). Inserted
text is not scanned again: an output that contains `{{note:…}}` reaches the prompt as those
characters, so fetched text cannot pull a note into a prompt. Building a note path in one cell
and loading it in the next is a proposed feature
([#71](https://github.com/cronai-labs/vaultore/issues/71)); a TS cell can do it today with
`vault.read(cell("path"))`.

`{{note:path}}` is a vault read. Under `vaultRead: deny`, or when the note cannot be read, the
cell fails before anything is sent; that includes a path that leads out of the vault through a
symbolic link, or ends in one (permissions-spec §3.4).

---

## 5. Cell Semantics

Each container cell runs in a fresh container that is removed afterwards (`--rm`). Nothing
persists between cells except outputs and files written into the vault. How the vault is
mounted, and the container's hardening, are in permissions-spec §3–§4.

### 5.1 `ore:ts`

The cell runs as `/tmp/vaultore.ts` under `bun` in `runtime.image`, with the working
directory `/workspace` (the vault mount).

**Output:** the value of the cell's last top-level expression statement, awaited, then passed
through `JSON.stringify`; what JSON cannot hold (a function, a `Map`, a `Date` as an object) does not
survive. A cell that ends in a declaration or a block has no value and records the text
`undefined`. A non-zero exit fails the cell with its stderr.

````markdown
```ore:ts id=sum
const x = 1;
const y = 2;
x + y;          // output: 3
```
````

**Globals** (injected by `buildTypeScriptRuntime`, `packages/core/src/executor/index.ts`):

| Global | Behaviour |
|--------|-----------|
| `cell(id)` | The output value of cell `id`, from this run or, if it did not run, from its last recorded output. Throws if there is none. Declare the cell in `depends` so this cell waits for it and does not run when it failed |
| `vault.read(path)` | Reads `/workspace/<path>`, or this cell's pending write to it. Needs `vaultRead` |
| `vault.exists(path)` | True for this cell's pending writes. Needs `vaultRead` |
| `vault.write(path, content)` | Records a write of the string `content`; the host applies it after the cell (below). Needs `vaultWrite`; without `vaultRead`, only inside this run's directory |
| `vault.mkdirp(path)` | Creates the directory through the mount. Same rule as `vault.write`; `vault.write` creates parent directories itself |
| `vault.readRaw(path)` | Reads any path inside the container, such as `/proc/meminfo`. No permission check |
| `vaultore` | `{ runId, outputRoot, runDir, workflowPath }` for this run |

The permission checks in these helpers only turn a doomed access into a clear error. The mount
enforces reads (permissions-spec §3.3); the host enforces `vault.write` (§3.4). Bun's own APIs
and `fetch` are available; `fetch` reaches the network only under `network: allow`.

**What `vault.write` guarantees** ([#83](https://github.com/cronai-labs/vaultore/issues/83)).
Nothing reaches the vault while the cell runs. Each write records the SHA-256 of the text the
cell last read from that path with `vault.read`, or that `vault.read` or `vault.exists` found
nothing there. After the cell has exited successfully, the host checks every such write
against the file as it is now, and only if all match applies the cell's writes in the order it
made them. Otherwise the cell fails, naming each note that changed, and none of its writes are
applied: the note was edited during the run, or the container saw a stale copy of it (Colima
with sshfs). Run the cell again. Within a cell, a second write to a path replaces the first and
keeps its base.

- A write to a path the cell never read is applied as given. That blind write is the cell's
  choice; read the note first to have it checked.
- A cell that fails, or ends with `process.exit()` before its writes are handed over, writes
  nothing.
- A byte-order mark at the start of a note is ignored by the check and, as before, dropped by
  `vault.read`.
- The check and the write are two steps on the host, so an edit landing between them, within
  milliseconds, is not caught.
- Not covered: shell cells, `vault.mkdirp()` and raw writes to `/workspace` (`Bun.write`,
  `node:fs`) go straight through the mount, and a cell sees its own `vault.write` only through
  `vault.read`/`vault.exists`, not on disk. A cell that only reads can still see a stale copy.
  Read-modify-write belongs in `vault.read` and `vault.write`.

**Framing on stdout.** The host gives each cell run a random 128-bit nonce, written into its
script. The runtime prints the value as one line of JSON between
`__VAULTORE_OUTPUT_START_<nonce>__` and `__VAULTORE_OUTPUT_END_<nonce>__` lines, then the writes
the same way between `__VAULTORE_WRITES_START_<nonce>__` and `__VAULTORE_WRITES_END_<nonce>__`:
a list of `{ path, content, base }`, where `base` is `{ "sha256": "<hex>" }`,
`{ "absent": true }` or `null`. Lines without the nonce are the cell's own logging, so text it
prints, such as a fetched page, cannot pass for a block. Exactly one output block and at most
one writes block after it are accepted; a second block, or a writes block before the output,
fails the cell and applies nothing. Stdout without any framing, as from a cell that exited
early, is the value as a whole and applies no writes.

The environment has `VAULTORE_RUN_ID`, `VAULTORE_OUTPUT_ROOT`, `VAULTORE_RUN_DIR` and
`HOME=/tmp`.

### 5.2 `ore:shell`

The content runs as `sh -lc <content>` in `runtime.image` (the default image's `sh` is
busybox), with the working directory `/workspace` and the same environment, mounts and
hardening as a TS cell.

**Output:** stdout as a string, untrimmed. A non-zero exit fails the cell with its stderr.

### 5.3 `ore:ai`

1. The cell fails with `AI cells require network permission` unless `network` resolves to
   `allow`.
2. **Provider:** the "Default provider" setting (CLI: `defaultProvider`), `openai` or
   `anthropic`; default `openai`. Any other value fails the cell.
3. **Model:** the cell's `model=`, else the "Default model" setting, else the provider's
   default (`DEFAULT_MODELS`: `gpt-5-mini` for OpenAI, `claude-haiku-5-5` for Anthropic).
   VaultOre never switches provider per cell: a `claude-*` model under OpenAI, or a `gpt-*`,
   `o1*`, `o3*` or `o4*` model under Anthropic, fails the cell before anything is read or sent.
4. **Prompt:** the cell content with templates resolved (§4), sent as one user message, with
   no system prompt.
5. **Parameters:** `temperature` and `maxTokens` from the cell, else from settings. OpenAI
   models starting with `o1`, `o3` or `gpt-5` get no temperature and receive `max_completion_tokens`
   instead of `max_tokens`. Anthropic requests always carry `max_tokens`, 800 when nothing is
   set.
6. **Timeout:** the "AI request timeout" setting (CLI: `aiTimeoutSeconds`), default 120
   seconds.

Requests go to `https://api.openai.com/v1/chat/completions` or
`https://api.anthropic.com/v1/messages`: from the plugin through Obsidian's `requestUrl`, from
the CLI through `fetch`.

**Output:** the response text, as a string. It is not parsed; a TS cell that needs JSON calls
`JSON.parse(cell("id"))` (see `fixtures/canonical/smart-inbox.md`).

---

## 6. Execution Order

Cells run **one at a time**. The order respects `depends`: first every cell without
dependencies, in document order, then each cell once all of its dependencies have run
(`orderCells`).

````markdown
```ore:ts id=a
```

```ore:ts id=b depends=[a]
```

```ore:ts id=c depends=[a]
```

```ore:ts id=d depends=[b, c]
```
````

runs `a`, `b`, `c`, `d`.

- **A cell runs only when every cell it depends on has a successful output.** Otherwise it
  fails with `Dependency output missing: <id>` or `Dependency failed: <id>`.
- **A failing cell does not stop the run.** Later cells still run; the ones that depend on it
  fail as above.
- **Running one cell** ("Run cell", `vaultore run --cell`) runs that cell and, transitively,
  what it depends on. "Run cell only (skip dependencies)" (`--skip-deps`) runs just the cell,
  with its dependencies' last recorded outputs.
- **A run stops before any cell** when the frontmatter or a cell does not parse, or the engine
  is not available.
- **A dependency cycle is not detected.** All cells then run in document order and the first
  one whose dependency has no output fails
  ([#45](https://github.com/cronai-labs/vaultore/issues/45)).
- **One run per note at a time.** The plugin refuses to start a second run of a note that is
  running; `vaultore agent` skips a scheduled run while the previous one is in progress.

---

## 7. Outputs

The host writes outputs, whatever the workflow's `vaultWrite` permission says: that permission
governs what cells may write.

### 7.1 The Output Callout

After each cell, the note is re-read and the cell's callout replaced, so edits made in the
note while the run was in flight are kept. If the note was deleted or renamed during the run,
it is not recreated.

```markdown
> [!ore-output] <cellId>
> view: [[<outputRoot>/runs/<workflow>/<runId>/<cellId>.md]]
> ![[<outputRoot>/runs/<workflow>/<runId>/<cellId>.md]]
> json: [[<outputRoot>/runs/<workflow>/<runId>/<cellId>.json]]
> run: <runId>
> status: success | duration: 0.12s | at: <ISO 8601>
```

A failed cell adds `> error: <message>`. A cell whose output names artifacts (§7.3) adds
`> artifactDir: [[<dir>/_index.md]]` and `> artifacts: [[file]], …`. Older notes may hold
outputs as `<!-- ore:output:<id> … -->` comments; they are read, and replaced by a callout on
the next write.

### 7.2 Files

`<outputRoot>` is the "Output folder" setting (CLI: `outputRoot`), default `_vaultore`.
`<workflow>` is the note's path without `.md`. `<runId>` is the start time with `:` and `.`
replaced by `-`, and six random characters.

| File | Content |
|------|---------|
| `<outputRoot>/runs/<workflow>/<runId>/<cellId>.json` | The record: `runId`, `workflowPath`, `cellId`, `value`, `meta` (`status`, `duration`, `timestamp`, `error`, `outputPath`, `outputViewPath`, `artifacts`) |
| `<outputRoot>/runs/<workflow>/<runId>/<cellId>.md` | The same output as a note (below) |
| `<outputRoot>/runs/<workflow>/<runId>/run.json` | The run: `status` (`running`, then `completed`, `failed` or `aborted`), start and finish times, and each cell's status and duration |
| `<outputRoot>/runs/<workflow>/index.json` | Every run of the workflow, newest first, with its outputs |

`<cellId>` in file names has every character other than letters, digits, `_` and `-`
replaced by `_`.

The `.md` view is an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
v0.2 concept (`renderOutputMarkdown`, `packages/core/src/executor/output-note.ts`). The
cell's run state is `cellStatus`, because OKF reserves `status` for the document lifecycle:

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
  by: vaultore/0.1.0
  at: 2026-10-15T08:00:00.000Z
---
```

The body is the value in a fenced block (`text` for a string, `json` otherwise), fenced longer
than any backtick run inside it.

### 7.3 Artifacts

A TS cell whose output is an object with `artifactDir` (a vault path) and/or `files` (vault
paths) gets an index note, `<artifactDir>/_index.md`, an OKF concept of type
`VaultOre Artifacts` that links each file with a relative Markdown link. See the last cell of
`fixtures/canonical/sys-snapshot.md`.

---

## 8. Validation Summary

A run fails before any cell when:

- there is no frontmatter, it is not valid YAML, or a known key has the wrong type (§2);
- a cell has no `id`, two cells share one, or `depends` names an unknown cell (§3.3).

Not validated: unknown frontmatter keys and cell attributes (ignored), dependency cycles
(§6), whether a `{{cellId}}` names an upstream cell (left as text when it has no output).

---

## Planned

Specified in earlier versions of this document and **not built**. The parser drops the keys
and attributes below, or the engine ignores them. Design work for conditions and structured
outputs is [#80](https://github.com/cronai-labs/vaultore/issues/80); the
[roadmap](../docs/roadmap.md) lists the rest.

### Conditions

- **`runIf`** in frontmatter: a condition evaluated before any cell runs; when false, the run
  is skipped and logged, not failed.
- **`when=`** on a cell: the cell is skipped when the condition is false, with a `skipped`
  status that `OutputMeta` does not have yet.
- **Semantic conditions** `{{ai: …}}`: a condition the AI provider evaluates to true or false.
  Open in #80: whether conditions are plain expressions over `cell()` outputs, or AI-evaluated
  (costly and non-deterministic, so it would need its own permission).

````markdown
---
runIf: "{{ai: the inbox note has unprocessed items}}"
---

```ore:ai id=summarize when="{{ai: the content is longer than 500 words}}"
Summarize: {{fetch}}
```
````

### Templates

- `{{block:Note#^blockId}}`: one block of a note.
- `{{meta:date}}`, `{{meta:vault}}`: run metadata.
- `{{cell.field}}`: a field of a structured output (#80).
- Note references whose path comes from an upstream cell
  ([#71](https://github.com/cronai-labs/vaultore/issues/71)).

### Cell Attributes

- `env`: environment variables for the cell.
- `retry`: retries on failure.
- `continueOnError`: today every failure lets the run continue (§6); this would let a
  dependent run after a failed dependency.

### Execution

- **Cycle detection:** a dependency cycle or self-dependency as a parse error naming the
  cycle ([#45](https://github.com/cronai-labs/vaultore/issues/45)).
- **Parallel cells:** independent cells running at the same time, within resource budgets
  ([architecture](../ARCHITECTURE.md#parallel-execution-not-built)).
- **Control blocks:** `control:` in frontmatter with `parallel`, `sequential` and `loop`
  (`until`, `max`), with `{{loop.iteration}}` and `{{cell.previous}}`. Additive: workflows with
  only `depends` keep working.

### AI Cells

- **`defaultModel` in frontmatter**, between the cell's `model=` and the settings.
- **JSON outputs:** an AI response that is valid JSON parsed for downstream cells, or a
  JSON mode per provider (#80).

### Cell Types

- `ore:py`: Python 3.
- `ore:go`: compiled Go with build caching ([go-cell-spec.md](go-cell-spec.md)).

### Validation

- Warnings for unknown frontmatter keys and cell attributes, instead of dropping them.
- A JSON Schema for the frontmatter, generated from `WorkflowFrontmatterSchema`.

---

## Appendix A: Grammar

```ebnf
workflow     = frontmatter body
frontmatter  = "---" newline yaml newline "---"
body         = (text | cell | outputStub)*
cell         = "```ore:" type attributes newline content "```"
outputStub   = "> [!ore-output] " cellId newline ("> " text newline)*
type         = "ts" | "shell" | "ai" | "py" | "go"
attributes   = ((" " | tab) attribute)*
attribute    = key "=" value
key          = [A-Za-z0-9_]+
value        = '"' [^"]* '"' | "'" [^']* "'" | "[" [^\]]* "]" | [^ \t]+
```
