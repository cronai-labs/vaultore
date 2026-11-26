# VaultOre

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13.0%2B%20desktop-purple.svg)](https://obsidian.md)

VaultOre runs workflows written as Markdown notes: a note holds TypeScript, shell and AI cells,
and VaultOre runs them in order, each code cell in its own container, and writes every result
back under the cell. Workflows can read and write your notes, call OpenAI or Anthropic with
your own key, and run on a cron schedule while Obsidian is open. The note format is Ore, an
open format with its own [specification](https://github.com/cronai-labs/ore-spec).

> [!WARNING]
> **VaultOre runs code from your notes.** A workflow note is executable content: it starts
> containers through your container engine and can, if it declares the permissions, reach the
> network and change files in your vault. A permission a note sets to `allow` applies without
> asking. Only run workflows you have read and trust, including notes that arrive through sync.

## Example

Create a note with this content:

````markdown
---
ore: true
name: Hello World
---

```ore:ts id=hello
const message = "Hello from VaultOre!";
message;
```

```ore:ts id=shout depends=[hello]
cell("hello").toUpperCase();
```
````

Open the command palette and run **VaultOre: Run all cells**. Each cell runs in a container,
and a callout with its result appears under it; the full output is stored under `_vaultore/`.
This example needs a container engine and no API key.

## Requirements

| | |
|---|---|
| **Obsidian 1.13.0 or later, desktop only** | VaultOre starts programs and reads the vault from disk; it does not load on mobile. Its settings use the settings API that 1.13.0 introduced, so Obsidian's settings search finds them. VaultOre 0.1.3 is the last release for Obsidian 1.11.4 to 1.12 |
| **A container engine, installed and running** | [Docker](https://www.docker.com), [Podman](https://podman.io), [Colima](https://github.com/abiosoft/colima) (macOS), or [Apple `container`](https://github.com/apple/container) (macOS 26+, Apple silicon). Every run needs it, even a workflow with only AI cells |
| **An OpenAI or Anthropic API key** *(optional)* | Only for `ore:ai` cells |

Colima users: see [Known limitations](#known-limitations) for the file-sharing mode to use.
Windows has not been tested; there, VaultOre looks for Docker Desktop or Podman.

## Disclosures

**Network use.**

- **AI cells** send their prompt to `api.openai.com` or `api.anthropic.com`, with your API
  key, when a workflow with an `ore:ai` cell runs and is granted `network`. The prompt can
  contain note contents (`{{note:…}}`) and other cells' outputs.
- **Container images** that are not on your machine yet are downloaded by your container
  engine from its registry (the default image, `oven/bun:1-alpine`, from Docker Hub). VaultOre
  does not contact registries itself.
- **Workflow code** in TS and shell cells reaches the network only when the workflow is
  granted `network: allow`, and can then contact any host.
- Nothing else: no telemetry, no analytics, no update checks.

**Accounts and payment.** AI cells need an account with OpenAI or Anthropic that has paid API
access, and your own API key; the provider bills you for each request. Everything else
(TypeScript and shell cells, scheduling, the CLI) works without an account.

**Runs external programs.** VaultOre starts your container engine's command-line tool
(`docker`, `podman`, `colima` or `container`) to detect it and to run each code cell, and the
cell runs the code written in the note. See the warning above.

**Files outside the vault.** VaultOre reads and writes your notes, its outputs and its
`.vaultore/` folder inside the vault; [Where VaultOre keeps things](#where-vaultore-keeps-things)
lists all of it. Outside the vault, it writes one small lock file per running note, in
`~/.config/vaultore/locks` (`%APPDATA%\vaultore\locks` on Windows), so that Obsidian and the
command-line runner never run one note at the same time; the file is removed when the run
ends. For each scheduled run it writes a small record in `~/.config/vaultore/slots`
(`%APPDATA%\vaultore\slots`), so that one occurrence of a schedule runs once in either runner,
kept for 30 days at most (the "Scheduled-run history" setting shortens it). The "Late after"
setting, shared by both runners, is kept in `~/.config/vaultore/settings.json`
(`%APPDATA%\vaultore\settings.json`). Your consent is kept there too, never in the vault, so
that sync cannot grant it: "Run scheduled workflows" and the notes you approved to run on
schedule, with their permissions, in `schedules.json`; your answers to notes' permission
requests in `answers.json`. While `vaultore agent` runs a vault, it holds a lock file in
`agents/`. It also looks for the engine's command-line tool in the directories on your `PATH` and in fixed
install locations (macOS: `/usr/local/bin`, `/opt/homebrew/bin`,
`/Applications/Docker.app/Contents/Resources/bin/docker`; Linux: `/usr/bin`; Windows: the
Docker Desktop and Podman folders under `C:\Program Files`), and starts it. The engine mounts
the vault folder into containers as the workflow's permissions allow; what the engine itself
reads, such as its own configuration and image store, is the engine's business.

## Installation

- **From the community plugin directory:** **Settings → Community plugins → Browse**,
  search for "VaultOre", install and enable
  ([listing](https://community.obsidian.md/plugins/vaultore)).
- **From a release:** download `main.js`, `manifest.json` and `styles.css` from a
  [release](https://github.com/cronai-labs/vaultore/releases) into
  `<your vault>/.obsidian/plugins/vaultore/`, then enable VaultOre under **Settings →
  Community plugins**.
- **From source:**

  ```bash
  git clone https://github.com/cronai-labs/vaultore.git
  cd vaultore
  bun install
  bun run build
  bun run obsidian:package   # writes packages/obsidian/package/vaultore/
  ```

  Copy `packages/obsidian/package/vaultore/` into `<your vault>/.obsidian/plugins/` and enable
  the plugin.

Then open **Settings → VaultOre**, pick your container engine, and, for AI cells, select the
secret that holds your API key.

## Using VaultOre

### Commands

Offered only on workflow notes (frontmatter `ore: true`). No hotkeys are set; assign them under
**Settings → Hotkeys**.

| Command | What it does |
|---------|--------------|
| **Run all cells** | Runs every cell of the note, in dependency order |
| **Run cell** | Runs the cell under the cursor and the cells it depends on |
| **Run cell only (skip dependencies)** | Runs the cell under the cursor, with its dependencies' last outputs |

### Cells

| Cell | Runs | Notes |
|------|------|-------|
| ` ```ore:ts ` | TypeScript on Bun, in a container | The last expression is the output. `cell("id")` reads another cell's output; `vault.read`, `vault.write`, `vault.exists`, `vault.mkdirp` work on notes; `vault.write` is applied after the cell, only if the notes it read are unchanged |
| ` ```ore:shell ` | `sh` in a container | stdout is the output |
| ` ```ore:ai ` | One request to your AI provider | `{{cellId}}` inserts an output, `{{note:Path/To/Note.md}}` a note. Needs `network: allow` |

Both container cells use the workflow's `runtime.image` (default `oven/bun:1-alpine`). The
[Ore specification](https://github.com/cronai-labs/ore-spec) defines the format, including
cell attributes (`depends`, `timeout`, `model`, `temperature`, `maxTokens`) and the output
files; [VaultOre's implementation](specs/ore-implementation.md) adds what VaultOre decides on
top of it.

### Settings

| Setting | Default | |
|---------|---------|---|
| Default provider | OpenAI | OpenAI or Anthropic, for every `ore:ai` cell |
| Default model | `gpt-5-mini` | Used when a cell sets no `model=`. Clearing the field sets the current provider's default (`claude-haiku-5-5` for Anthropic); switching the provider does the same while the field holds the old provider's default |
| Temperature | provider default | |
| Max tokens | 800 | |
| AI request timeout | 120 seconds | |
| Default runtime engine | Docker | A workflow's `runtime.engine` overrides it |
| Output folder | `_vaultore` | Where run outputs are written |
| OpenAI API key, Anthropic API key | none | The name of a secret in Obsidian's secret storage |
| Scheduled-run history | 30 days | How long what each scheduled run came to is kept, 0 to 30 days; 0 keeps each for a day only |
| Late after | 2 minutes | How late a scheduled run may start and still run, 2 to 60 minutes; later, it is listed under "Missed runs". One value for your account on this computer, shared with `vaultore agent`, not stored in the vault |
| Run scheduled workflows | off | See [Scheduling](#scheduling) |

### Scheduling

```yaml
---
ore: true
name: Daily Summary
schedule: "0 18 * * *"   # every day at 18:00, local time
---
```

Nothing runs on a schedule until you opt in. **Settings → VaultOre → Scheduled workflows**
lists every note with a schedule, with its next run or why the schedule is invalid. For each note you choose who runs it on this computer: **Off**, **In Obsidian**, or **By the agent** (`vaultore agent`, below). A note runs in one of them, never in both. For the notes run in Obsidian, turn on
**Run scheduled workflows**. An approval covers the note's path, its content and its permissions: an edit, a renamed note, or a note that arrives through sync is listed but does not run until you approve it again. **What an approval covers** can be set to *Narrow* for Obsidian: then only a change of the schedule or the permissions stops a note, and edited cells run unreviewed; `vaultore agent` is always strict. A row for `vaultore agent` says whether an agent runs this vault, and Obsidian tells you once when notes are handed to an agent that does not. The switch and your approvals
belong to your account on this computer: they are kept outside the vault, in your account's folder, so sync carries them nowhere and another account does not share them. Earlier releases kept them in the plugin's settings, which sync carries; after upgrading from one, scheduling is off on each computer until you turn it on there and approve your notes again, and the plugin says so once on each computer where it was on. Scheduled runs happen only while
Obsidian is open; `vaultore agent` runs them without Obsidian ([Command-Line
Interface](#command-line-interface)).

What holds for both runners:

- **Scheduled runs ask nothing.** When you approve a note, you answer each `ask` permission for its scheduled runs; they, and catch-ups, run with exactly the permissions approved, and never use answers you gave when running the note yourself. Approving again after an edit asks only about what changed: an edited cell needs one click, a new `ask` needs only its answer. Each run's `run.json` says how it was started and where each permission came from ([unattended permissions](specs/permissions-spec.md#63-unattended-permissions)).
- **Each occurrence runs at most once**, in Obsidian or in `vaultore agent`, whichever claims
  it first; the other names who did. What each one came to is kept for 30 days at most
  ("Scheduled-run history", `vaultore agent --keep-days`); `vaultore schedules log` shows it.
- **An occurrence no runner fired is a missed run**: the computer slept, or nothing was running.
  It is recorded when a runner looks again and said once (Obsidian as a notice, the agent on
  stderr). Catch it up, one run for all the missed occurrences, or dismiss it: "Catch up" and
  "Dismiss" under **Missed runs** in the settings, or `vaultore schedules catch-up | dismiss
  <note.md>`. A failed catch-up is not retried. A note Obsidian runs is caught up only while
  "Run scheduled workflows" is on.
- **Late is more than two minutes**: an occurrence that would start later than that, because the
  computer was asleep at its time, is not run but listed as missed. "Late after" (2 to 60
  minutes) changes that for the computer, for both runners; `vaultore schedules late-after`
  is the same setting.

The model, its states and its limits: [schedule record spec](specs/schedule-record-spec.md).

#### Several computers, one synced vault

Each computer schedules on its own: **Run scheduled workflows**, the approvals and who runs each note,
the record that lets an occurrence run once, the run locks and "Late after" are kept per
computer, outside the vault. Two computers on which a note is approved each run it.

Strictly, they are kept per account: each account on a computer has its own. Two accounts that
open the same vault folder, and computers that share one on a network drive, are like two
computers, except that they run at the same moment into the same files, and a note one of them
runs is not refused to the other. A vault opened through a symbolic link is the same vault: both
paths share the approvals, the record and the locks. Running once beyond one account:
[#287](https://github.com/cronai-labs/vaultore/issues/287).

What sync carries depends on your sync. iCloud, Nextcloud, Syncthing and Obsidian Sync with
plugin settings on carry `.obsidian/plugins/vaultore/data.json`, which holds the plugin's other
settings. Your answers to a note's permission requests are kept for your account on each computer, outside the vault, so a note that arrives through sync asks again on each computer; carrying answers between computers you trust is planned ([#305](https://github.com/cronai-labs/vaultore/issues/305)). Run records and the result callouts
in notes travel with the vault, so two computers write into the same notes.

**Let one computer schedule:** approve the note there only, in Obsidian or for the agent.
Sync cannot keep two computers from both running a note: each would take a lock or a lease in
its own copy and learn of the other only after both had run. That needs one service all
computers ask, which is what [CronAI](specs/cronai-handover-spec.md) is for. A warning when a
note runs on two computers: [#274](https://github.com/cronai-labs/vaultore/issues/274).

## Security Model

**Permissions** are declared per workflow in frontmatter, each `allow`, `deny` or `ask`.
The defaults ([permissions spec](specs/permissions-spec.md), the single source):

| Permission | Default | Controls |
|------------|---------|----------|
| `network` | `deny` | Network for container cells; required by AI cells |
| `vaultRead` | `allow` | Whether the vault is mounted into containers; `{{note:}}` |
| `vaultWrite` | `deny` | Whether that mount is writable |
| `buildNetwork` | `deny` | Nothing yet (reserved for planned Python and Go cells) |

**The mount enforces them.** A container cell sees the whole vault read-only, the whole vault
read-write, only its own run directory, or nothing, depending on `vaultRead` and `vaultWrite`.
Obsidian's config folder (`.obsidian/`, or the folder Obsidian is set to use instead), which
holds the plugin and its settings, and `.vaultore/`, which holds the CLI's settings, are hidden
from every cell; so is VaultOre's own folder (`~/.config/vaultore`) in a vault that holds it,
such as a vault at your home folder.

**Containers are hardened** on every engine: read-only root filesystem, a `noexec` `/tmp`, no
Linux capabilities, a non-root user, no network unless granted, and memory and CPU limits.
Docker, Podman and Colima also get `no-new-privileges` and a limit of 256 processes, which
Apple's `container` cannot express (it runs each container in its own VM). Exact flags per
engine: [sandbox spec](specs/sandbox-spec.md) and permissions spec §4.

**`ask` is asked once per content.** The decision is stored for that note and bound to a hash
of its frontmatter and cells; when either changes, including through sync, you are asked
again. A permission set to `allow` or `deny` in the note is applied without a prompt.

**Scheduling needs consent**, off by default, per note and schedule (above).

**API keys** live in Obsidian's secret storage. VaultOre's settings hold only the name of the
secret you selected, never the key, and the plugin never writes to the secret storage. Keys
are used for the provider request only, not passed to containers.

## Known Limitations

- **Colima with sshfs file sharing** can show a container a stale, cut-off copy of a file
  written a moment earlier ([#124](https://github.com/cronai-labs/vaultore/issues/124)).
  `vault.write` cannot save such a copy: the host applies it only if the note is still what
  the cell read, and otherwise fails the cell and writes nothing, so run it again. A cell that
  only reads still sees the stale copy, and shell cells and raw writes to `/workspace`
  (`Bun.write`, `node:fs`) get no such check. Use virtiofs:
  `colima start --vm-type vz --mount-type virtiofs`.
- **Symbolic links are not followed out of the vault** by anything VaultOre reads or writes on
  the host (`vault.write`, `{{note:}}`, output files, the workflow note), and a link as the last
  component of a path is refused wherever it points. A workflow in a folder linked from outside
  the vault therefore cannot run.
- **Several computers on one synced vault** each run a scheduled note; let one schedule
  ([above](#several-computers-one-synced-vault)). The same holds for several accounts on one
  computer and for a vault on a network drive ([#287](https://github.com/cronai-labs/vaultore/issues/287)).
- **The Apple `container` engine** is covered by unit tests only, not yet by runs against a
  real installation.

## Command-Line Interface

`@vaultore/cli` runs the same workflows without Obsidian, on any folder of Markdown. It is not
on npm yet ([#112](https://github.com/cronai-labs/vaultore/issues/112)); build it from a checkout:

```bash
git clone https://github.com/cronai-labs/vaultore.git
cd vaultore && bun install && bun run build
alias vaultore="node $PWD/packages/cli/dist/cli.js"
```

```
vaultore run <workflow.md> [--vault <dir>] [--config-dir <name>] [--cell <id>] [--skip-deps] [--yes] [--quiet]
vaultore list [--vault <dir>] [--config-dir <name>]
vaultore agent [--vault <dir>] [--config-dir <name>] [--rescan <seconds>] [--keep-days <n>] [--quiet]
vaultore schedules list [--vault <dir>] [--config-dir <name>]
vaultore schedules approve <workflow.md>... [--owner agent|obsidian] [--allow <names>] [--deny <names>] [--vault <dir>]
vaultore schedules revoke <workflow.md>... [--vault <dir>]
vaultore schedules export [--vault <dir>] [--config-dir <name>] [--out <file>]
vaultore schedules log [<workflow.md>] [--vault <dir>]
vaultore schedules catch-up <workflow.md> [<slot>] [--vault <dir>] [--config-dir <name>] [--quiet]
vaultore schedules dismiss <workflow.md> [<slot>] [--vault <dir>]
vaultore schedules late-after [<minutes> | default]
vaultore permissions forget <workflow.md> [<permission>...] [--vault <dir>]
vaultore --version | --help
```

- Settings come from `<vault>/.vaultore/config.json` (read again when it changes, and changed under a lock, so commands running at once, an agent and a `vaultore run`, keep each other's changes; one that is not JSON is refused, not replaced): `defaultProvider`, `defaultModel`,
  `aiTemperature`, `aiMaxTokens`, `aiTimeoutSeconds`, `runtimeEngine`, `outputRoot`. API keys come from the environment
  (`VAULTORE_OPENAI_APIKEY` or `OPENAI_API_KEY`, `VAULTORE_ANTHROPIC_APIKEY` or
  `ANTHROPIC_API_KEY`).
- `--config-dir <name>`: when Obsidian is set to use another config folder than `.obsidian`,
  name it, so that it is skipped when looking for workflows and hidden from cells.
- In `vaultore run`, permissions at `ask` that are not answered yet are denied for the run unless you pass `--yes`; `--yes` allows them, and
  that answer is kept for this account on this computer, until the note changes, in `~/.config/vaultore/answers.json`, which Obsidian uses too: an answer given in either applies in both, a Deny included, which `--yes` does not change. A run says which kept answer it used. A run without `--yes` stores nothing. `vaultore permissions forget <note.md> [<permission>...]` forgets a note's answers, or those named, so that the next run asks again; in Obsidian, the command **Forget permission answers for this note** does the same.
- `vaultore agent` is a scheduler daemon. **It runs a scheduled note only after
  `vaultore schedules approve <note.md>`**, or **By the agent** in Obsidian's settings, and only while the note's frontmatter and cells are
  what you approved: an edit to either, including one that arrives through sync, stops it until
  you approve again. `vaultore schedules list` shows where each note stands and who runs it, and the agent
  names what it does not run. It runs each note with the permissions approved: answer an `ask` with `vaultore schedules approve <note.md> --allow network` (or `--deny`); `schedules approve` prints what each permission is and what changed since the last approval. `vaultore agent --yes` was removed. One agent runs a vault at a time; a second one is refused.
- `vaultore schedules approve --owner obsidian` hands a note to Obsidian instead; approving it for the other runner hands it over. The approvals are kept outside the vault, so that sync cannot deliver one, in one file Obsidian reads too ([where](#where-vaultore-keeps-things)).
- A note runs once at a time, whether Obsidian, `vaultore run` or `vaultore agent` starts it: a
  second run is refused and told who has the note
  ([one run per note](specs/ore-implementation.md)). This holds for one account on one
  computer ([several computers](#several-computers-one-synced-vault)).
- Scheduled runs, missed runs and "Late after" work as in Obsidian
  ([Scheduling](#scheduling)).
- `vaultore schedules export` writes the manifest that hands scheduled workflows to CronAI
  ([handover spec](specs/cronai-handover-spec.md)).

More in [docs/interoperability.md](docs/interoperability.md).

## Where VaultOre keeps things

| Where | What | Written by |
|---|---|---|
| **In the vault** | | |
| `.obsidian/plugins/vaultore/` | The plugin; `data.json` holds its settings | Obsidian, the plugin |
| `_vaultore/` (the output folder setting) | `runs/<workflow>/<run id>/`: each run's record, each cell's JSON and Markdown; `runs/<workflow>/index.json` | both runners |
| Your workflow notes | The `ore-output` callout under each cell that ran | both runners |
| Wherever a workflow writes | What its cells write with `vault.write` or into the mounted vault | your workflows |
| `.vaultore/` | Created by every run that may read the vault, so a cell cannot plant it; `config.json` holds the CLI's settings | both runners |
| **Outside the vault**, per account (`~/.config/vaultore/`; `%APPDATA%\vaultore\` on Windows) | | |
| `locks/` | One lock file per running note, removed when the run ends | both runners |
| `slots/` | What each scheduled occurrence came to, and missed runs; 30 days at most | both runners |
| `settings.json` | "Late after", for your account on this computer | both runners |
| `answers.json` and `.lock` | Your answers to notes' permission requests, for runs you start, per vault and note, with the content they were given for | both runners |
| `schedules.json` and `.lock` | **Run scheduled workflows**, and each approved note with who runs it, per vault | both runners |
| `schedules.json.imports.json` | Which `approvals.json` of an earlier version was copied in, with its SHA-256, so it is copied once | both runners |
| `agents/` | One lock per vault while `vaultore agent` runs it, which Obsidian reads to say whether it does | the agent |
| **Elsewhere** | | |
| Obsidian's secret storage | The API keys you stored there; VaultOre only reads them | you |
| Your container engine | The images cells ran in (`oven/bun:1-alpine`, and any `runtime.image` a note names) | your engine |

All of it is found from your account's home directory, not from `$HOME` or `$XDG_CONFIG_HOME`, so that no environment can separate the two runners; nothing moves it. The agent's approvals of earlier versions (`approvals.json`, also in `$XDG_CONFIG_HOME/vaultore` when that was set) are copied into `schedules.json` once, as notes the agent runs, by whichever runner starts first; the old file is left as it was and no longer read, and a change to it afterwards is reported, not copied.

## Upgrading

Each release's notes, and the [changelog](CHANGELOG.md), say under **Breaking changes** and
**Upgrading** what a release asks of you. Update the plugin and the CLI together where you use both: they read each other's
files in `~/.config/vaultore/`. An older runner treats a scheduled occurrence it cannot read as
taken, so it never runs one twice, but it may not show it; versioned formats and a warning about
a newer runner are planned ([#278](https://github.com/cronai-labs/vaultore/issues/278)).

The CLI built from source is updated with `git pull`, `bun install` and `bun run build`.

## Uninstalling

**Uninstall** in **Settings → Community plugins** removes `.obsidian/plugins/vaultore/` with
the plugin's settings; disabling it only stops it. Its scheduling approvals and your permission answers are in
`~/.config/vaultore/` (step 4). What stays, to remove by hand
if you want it gone:

1. **The output folder** (`_vaultore/` by default) in each vault: your run records. Keep it if
   you need them.
2. **The result callouts** in your workflow notes: they are part of the notes. Delete them in
   the notes, or keep them.
3. **`.vaultore/`** in each vault: the CLI's settings.
4. **`~/.config/vaultore/`** (`%APPDATA%\vaultore\` on Windows): shared by the plugin and the
   CLI, so remove it once you use neither, after stopping `vaultore agent`. With
   `XDG_CONFIG_HOME` set, also an old `approvals.json` in `$XDG_CONFIG_HOME/vaultore` that VaultOre no longer reads.
5. **API keys** you stored in Obsidian's secret storage for VaultOre.
6. **Container images** VaultOre ran, if nothing else uses them: `docker image rm
   oven/bun:1-alpine`, or your engine's equivalent.

The CLI from source is removed with its checkout. A command that lists and removes all of this:
[#275](https://github.com/cronai-labs/vaultore/issues/275).

## Documentation

- [Ore specification](https://github.com/cronai-labs/ore-spec): the format itself
- [Ore implementation](specs/ore-implementation.md): what VaultOre decides and adds on top of the format
- [Permissions spec](specs/permissions-spec.md): permissions, mounts, stored decisions
- [Sandbox spec](specs/sandbox-spec.md): container engines and hardening
- [Schedule record spec](specs/schedule-record-spec.md): one run per scheduled occurrence, missed runs
- [Roadmap](docs/roadmap.md): what exists, what is next
- [All documentation](docs/index.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions and the release process, and the
[plugin development quickstart](docs/quickstart-plugin-dev.md) for running a dev build.

## License

MIT © [CronAI UG](https://cronai.de)
