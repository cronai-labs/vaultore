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
  mount, the run directory only, the vault read-only, or the vault read-write. `.obsidian/` and
  `.vaultore/` are hidden from cells.
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

## Released: 0.1.0 to 0.1.2, and the listing

- [0.1.0](https://github.com/cronai-labs/vaultore/releases/tag/0.1.0) on 2026-10-15,
  [0.1.1](https://github.com/cronai-labs/vaultore/releases/tag/0.1.1) and
  [0.1.2](https://github.com/cronai-labs/vaultore/releases/tag/0.1.2) on 2026-10-18, each
  immutable and attested. Listed in Obsidian's
  [community plugins](https://community.obsidian.md/plugins/vaultore) since 2026-10-18; the
  directory's reviews of all three releases found no errors.
- A live test in a real vault before 0.1.0 (AI providers through Obsidian's `requestUrl`,
  the secret selection, the settings screens), with OpenAI; Anthropic is not tested live yet.
- [#83](https://github.com/cronai-labs/vaultore/issues/83): Colima with sshfs file sharing
  can serve a container a stale copy of a note. `vault.write` is applied by the host and
  refused when the note changed since the cell read it, so a stale copy is never saved; reads,
  shell cells and raw writes through the mount stay exposed
  ([#124](https://github.com/cronai-labs/vaultore/issues/124)).

## After 0.1.0

Everything deliberately left out of the first release is in the
[After 0.1.0 milestone](https://github.com/cronai-labs/vaultore/milestone/1). Committed to
in principle; the order is not fixed. Grouped:

**Cells and workflows**

- Conditions and structured outputs (`runIf`, `when=`, `{{cell.field}}`, JSON-mode AI cells),
  which the full smart-inbox needs ([#80](https://github.com/cronai-labs/vaultore/issues/80);
  [workflow note spec](../specs/workflow-note-spec.md#planned), "Planned").
- `ore:py` cells ([#106](https://github.com/cronai-labs/vaultore/issues/106)); CSV helpers
  ([#107](https://github.com/cronai-labs/vaultore/issues/107)); dynamic note references
  behind an opt-in ([#71](https://github.com/cronai-labs/vaultore/issues/71)).
- A loop guard for workflows that read their own outputs
  ([#111](https://github.com/cronai-labs/vaultore/issues/111)); structural index and
  retrieval ([#110](https://github.com/cronai-labs/vaultore/issues/110);
  [local intelligence](local-intelligence.md)).

**AI**

- Claude Code as a cell provider, using the user's Claude Code login
  ([#102](https://github.com/cronai-labs/vaultore/issues/102)).
- A confidentiality lock for notes that must not reach a provider
  ([#109](https://github.com/cronai-labs/vaultore/issues/109)).

**Permissions and sandboxing**

- Write permission per path ([#108](https://github.com/cronai-labs/vaultore/issues/108)),
  choosing what a grant is bound to ([#70](https://github.com/cronai-labs/vaultore/issues/70)),
  the remaining items of [#28](https://github.com/cronai-labs/vaultore/issues/28) (a sticky CLI
  `deny`, global caps), and Obsidian's override config folder
  ([#114](https://github.com/cronai-labs/vaultore/issues/114)).
- Sandbox options beyond containers: an OS process sandbox, embeddable microVMs, the WASM tier
  ([#103](https://github.com/cronai-labs/vaultore/issues/103);
  [sandbox spec](../specs/sandbox-spec.md)).

**Interoperability**

- Workflows callable by agents over MCP/ACP, and an Obsidian skill for writing `ore:` notes
  ([#104](https://github.com/cronai-labs/vaultore/issues/104)).
- Runs as OKF Attested Computations
  ([#105](https://github.com/cronai-labs/vaultore/issues/105)); OKF bundle export
  ([interoperability](interoperability.md)).
- The CLI on npm ([#112](https://github.com/cronai-labs/vaultore/issues/112)), with consent
  for `vaultore agent` schedules ([#116](https://github.com/cronai-labs/vaultore/issues/116)).
- CronAI cloud execution: the cloud side of the
  [handover spec](../specs/cronai-handover-spec.md).

**Engineering follow-ups**

- Parser and executor defects ([#45](https://github.com/cronai-labs/vaultore/issues/45)),
  cell timeouts that leave the container running
  ([#113](https://github.com/cronai-labs/vaultore/issues/113)), error handling
  ([#121](https://github.com/cronai-labs/vaultore/issues/121)), the provider switch keeping
  the old default model ([#115](https://github.com/cronai-labs/vaultore/issues/115)),
  fixtures ([#120](https://github.com/cronai-labs/vaultore/issues/120)).
- Stale container reads beyond `vault.write`
  ([#124](https://github.com/cronai-labs/vaultore/issues/124)).
- Platform coverage for Windows and rootless engines
  ([#122](https://github.com/cronai-labs/vaultore/issues/122)); the adapter contract
  ([#117](https://github.com/cronai-labs/vaultore/issues/117)); formatting
  ([#118](https://github.com/cronai-labs/vaultore/issues/118)); install and demo vault
  ([#47](https://github.com/cronai-labs/vaultore/issues/47)); repository baseline
  ([#42](https://github.com/cronai-labs/vaultore/issues/42)); container coverage and docs
  ([#29](https://github.com/cronai-labs/vaultore/issues/29), [#55](https://github.com/cronai-labs/vaultore/issues/55)).

## Under consideration

Not committed to; no issue yet.

- **Parallel cells and a warm container pool**
  ([architecture](../ARCHITECTURE.md#parallel-execution-not-built)).
- **`ore:go`** with build caching ([Go cell spec](../specs/go-cell-spec.md)).
- **Other surfaces**: a Quarto engine extension; editor extensions beyond Obsidian.

To propose an item or discuss one, open an
[issue](https://github.com/cronai-labs/vaultore/issues).
