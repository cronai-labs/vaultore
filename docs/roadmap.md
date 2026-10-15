# Roadmap

What VaultOre does today, what is being worked on next, and what is under consideration.
This is the one place the roadmap lives; other documents link here. It carries no dates:
an item moves when its issue moves.

## What exists now

Everything in this section is in the code on `main`. The specs describe each part in detail.

**Workflow notes** ([workflow note spec](../specs/workflow-note-spec.md))

- A note with `ore: true` in its frontmatter is a workflow. Cells are fenced blocks:
  `ore:ts` (TypeScript on Bun), `ore:shell` (`sh`) and `ore:ai` (one completion).
- `depends=[…]` orders cells; `cell("id")` reads an upstream output in a TS cell;
  `{{cellId}}` and `{{note:path}}` interpolate into AI prompts.
- `vault.read`, `vault.write`, `vault.exists`, `vault.mkdirp` and `vault.readRaw` inside TS
  cells.

**Execution** ([sandbox spec](../specs/sandbox-spec.md))

- Every TS and shell cell runs in its own container, on Docker, Podman, Colima, or Apple
  `container` on macOS. Engine detection checks exit codes and times out.
- Containers run hardened: read-only root filesystem, no capabilities, non-root user, network
  off unless granted; Docker, Podman and Colima also get `no-new-privileges` and a process limit.
- There is no fallback to running code on the host.

**Permissions** ([permissions spec](../specs/permissions-spec.md))

- `network`, `vaultRead` and `vaultWrite` per workflow, enforced at the container: no vault
  mount, the run directory only, the vault read-only, or the vault read-write. `.obsidian/` is
  hidden from cells.
- A decision for `ask` is bound to the note's frontmatter and cells, and asked again when
  either changes.

**AI**

- OpenAI and Anthropic, with the user's own API key, held in Obsidian's secret storage (the
  plugin) or the environment (the CLI). A model that belongs to the other provider fails the
  cell before anything is sent.

**Outputs**

- An `ore-output` callout under each cell; a JSON record and a Markdown view per cell under
  the output folder (default `_vaultore`); a `run.json` per run. Output views and artifact
  indexes are [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
  v0.2 concepts.

**Scheduling**

- A cron `schedule:` in frontmatter. In the plugin nothing runs on a schedule until the user
  turns on "Run scheduled workflows" and approves each note's exact schedule.

**CLI** ([interoperability](interoperability.md))

- `vaultore run`, `list`, `agent` (a headless scheduler) and `schedules export` (the
  [CronAI handover manifest](../specs/cronai-handover-spec.md)). Built from source; not on npm.

**Release path**

- One `ci-required` check over policy, commitlint, build, tests, lint, container integration
  tests and a reproducible-build check; tag-driven, immutable, attested GitHub releases
  ([CONTRIBUTING](../CONTRIBUTING.md#release-process)).

## Next

Open issues that are planned work:

- [#83](https://github.com/cronai-labs/vaultore/issues/83): Colima with sshfs file sharing
  can serve a container a stale copy of a note; a read-modify-write cell can truncate it.
- [#45](https://github.com/cronai-labs/vaultore/issues/45): parser and executor defects:
  output written under a cell whose id is a prefix of another, a non-numeric `timeout=`
  disabling the timeout, dependency cycles running silently in document order, output file
  name collisions, an unbounded run index.
- [#28](https://github.com/cronai-labs/vaultore/issues/28): a `deny` the CLI stored without
  `--yes` sticks until the note changes; global permission caps.
- [#47](https://github.com/cronai-labs/vaultore/issues/47): one-command install into a vault,
  and a demo vault.
- [#82](https://github.com/cronai-labs/vaultore/issues/82),
  [#84](https://github.com/cronai-labs/vaultore/issues/84): lint core and the CLI with the
  Obsidian review config; typecheck the test files.
- [#42](https://github.com/cronai-labs/vaultore/issues/42): repository baseline (task
  runner, MegaLinter, secret scanning, licence checks).

## Under consideration

Designed in part or proposed, not committed to. Each item names where its design lives.

- **Conditions and structured outputs**: `runIf`, `when=`, `{{cell.field}}` and JSON-mode AI
  cells, which the full smart-inbox needs
  ([#80](https://github.com/cronai-labs/vaultore/issues/80); the
  [workflow note spec](../specs/workflow-note-spec.md#planned), "Planned").
- **Dynamic note references** from an upstream cell, behind an explicit opt-in
  ([#71](https://github.com/cronai-labs/vaultore/issues/71)).
- **Choosing what a permission grant is bound to**
  ([#70](https://github.com/cronai-labs/vaultore/issues/70)).
- **A container-free tier** for `ore:ts` cells (QuickJS in WebAssembly), and WASI components
  for compiled cells ([sandbox spec](../specs/sandbox-spec.md), Tiers 2 and 3).
- **More cell types**: `ore:py`, and `ore:go` with build caching
  ([Go cell spec](../specs/go-cell-spec.md)).
- **Parallel cells and a warm container pool**
  ([architecture](../ARCHITECTURE.md#parallel-execution-not-built)).
- **CronAI cloud execution**: the cloud side of the
  [handover spec](../specs/cronai-handover-spec.md), and local schedulers honouring
  `.vaultore/handover.json`.
- **OKF bundle export** and an OKF ingestion helper ([interoperability](interoperability.md)).
- **Local retrieval** for AI cells ([local intelligence](local-intelligence.md)).
- **Other surfaces**: a Quarto engine extension; editor extensions beyond Obsidian.

To propose an item or discuss one, open an
[issue](https://github.com/cronai-labs/vaultore/issues).
