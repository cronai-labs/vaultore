# VaultOre

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.11.4%2B%20desktop-purple.svg)](https://obsidian.md)

VaultOre runs workflows written as Markdown notes: a note holds TypeScript, shell and AI cells,
and VaultOre runs them in order, each code cell in its own container, and writes every result
back under the cell. Workflows can read and write your notes, call OpenAI or Anthropic with
your own key, and run on a cron schedule while Obsidian is open.

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
| **Obsidian 1.11.4 or later, desktop only** | VaultOre starts programs and reads the vault from disk; it does not load on mobile |
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

**Files outside the vault.** VaultOre reads and writes files only inside the vault. Outside it,
it looks for the engine's command-line tool in the directories on your `PATH` and in fixed
install locations (macOS: `/usr/local/bin`, `/opt/homebrew/bin`,
`/Applications/Docker.app/Contents/Resources/bin/docker`; Linux: `/usr/bin`; Windows: the
Docker Desktop and Podman folders under `C:\Program Files`), and starts it. The engine mounts
the vault folder into containers as the workflow's permissions allow; what the engine itself
reads, such as its own configuration and image store, is the engine's business.

## Installation

- **From the community plugin directory**, once VaultOre is listed there: **Settings →
  Community plugins → Browse**, search for "VaultOre", install and enable.
- **From a release:** download `main.js`, `manifest.json` and `styles.css` from a
  [release](https://github.com/cronai-labs/vaultore/releases) into
  `<your vault>/.obsidian/plugins/vaultore/`, then enable VaultOre under **Settings →
  Community plugins**.
- **From source**, if no release is listed yet:

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
| ` ```ore:ts ` | TypeScript on Bun, in a container | The last expression is the output. `cell("id")` reads another cell's output; `vault.read`, `vault.write`, `vault.exists`, `vault.mkdirp` work on notes |
| ` ```ore:shell ` | `sh` in a container | stdout is the output |
| ` ```ore:ai ` | One request to your AI provider | `{{cellId}}` inserts an output, `{{note:Path/To/Note.md}}` a note. Needs `network: allow` |

Both container cells use the workflow's `runtime.image` (default `oven/bun:1-alpine`). The
[workflow note spec](specs/workflow-note-spec.md) has the full format, including cell
attributes (`depends`, `timeout`, `model`, `temperature`, `maxTokens`) and the output files.

### Settings

| Setting | Default | |
|---------|---------|---|
| Default provider | OpenAI | OpenAI or Anthropic, for every `ore:ai` cell |
| Default model | `gpt-5-mini` | Used when a cell sets no `model=`. Clearing the field sets the current provider's default (`claude-haiku-5-5` for Anthropic) |
| Temperature | provider default | |
| Max tokens | 800 | |
| AI request timeout | 120 seconds | |
| Default runtime engine | Docker | A workflow's `runtime.engine` overrides it |
| Output folder | `_vaultore` | Where run outputs are written |
| OpenAI API key, Anthropic API key | none | The name of a secret in Obsidian's secret storage |
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
lists every note with a schedule, with its next run or why the schedule is invalid. Turn on
**Run scheduled workflows**, then approve each note you want to run. An approval covers that
note's path and exact schedule: a changed schedule, a renamed note, or a note that arrives
through sync is listed but does not run until you approve it. Scheduled runs happen only while
Obsidian is open.

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
`.obsidian/`, which holds the plugin and its settings, and `.vaultore/`, which holds the CLI's
settings and stored permission decisions, are hidden from every cell.

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
  written a moment earlier, so a cell that reads a note and writes it back can truncate it
  ([#83](https://github.com/cronai-labs/vaultore/issues/83)). Use virtiofs:
  `colima start --vm-type vz --mount-type virtiofs`.
- **Dependency cycles are not detected**: the cells run in document order
  ([#45](https://github.com/cronai-labs/vaultore/issues/45)).
- **A cell timeout stops the engine's CLI, not the container**, which may keep running until it
  exits; the error reads `exit 1`.
- **Only `.obsidian/` and `.vaultore/` are hidden** from cells. Obsidian's "Override config
  folder" setting is not followed.
- **Switching the provider keeps the default model** of the other provider; AI cells then fail
  with a message saying so, until you change the model.
- **The Apple `container` engine** is covered by unit tests only, not yet by runs against a
  real installation.

## Command-Line Interface

`@vaultore/cli` runs the same workflows without Obsidian, on any folder of Markdown. It is not
on npm yet; build it from source (`bun run build`) and run `node packages/cli/dist/cli.js`.

```
vaultore run <workflow.md> [--vault <dir>] [--cell <id>] [--skip-deps] [--yes] [--quiet]
vaultore list [--vault <dir>]
vaultore agent [--vault <dir>] [--yes] [--rescan <seconds>] [--quiet]
vaultore schedules export [--vault <dir>] [--out <file>]
```

- Settings come from `<vault>/.vaultore/config.json` (`defaultProvider`, `defaultModel`,
  `runtimeEngine`, `outputRoot`, `aiTimeoutSeconds`, …), API keys from the environment
  (`VAULTORE_OPENAI_APIKEY` or `OPENAI_API_KEY`, `VAULTORE_ANTHROPIC_APIKEY` or
  `ANTHROPIC_API_KEY`).
- Permissions at `ask` are denied unless you pass `--yes`, and the decision is stored in the
  config file. A `deny` stored that way sticks until the note changes
  ([#28](https://github.com/cronai-labs/vaultore/issues/28)).
- `vaultore agent` is a scheduler daemon. **It runs every workflow in the vault that has a
  schedule; it has no approval step.**
- `vaultore schedules export` writes the manifest that hands scheduled workflows to CronAI
  ([handover spec](specs/cronai-handover-spec.md)).

More in [docs/interoperability.md](docs/interoperability.md).

## Documentation

- [Workflow note spec](specs/workflow-note-spec.md): the format, and what is planned
- [Permissions spec](specs/permissions-spec.md): permissions, mounts, stored decisions
- [Sandbox spec](specs/sandbox-spec.md): container engines and hardening
- [Roadmap](docs/roadmap.md): what exists, what is next
- [All documentation](docs/index.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions and the release process, and the
[plugin development quickstart](docs/quickstart-plugin-dev.md) for running a dev build.

## License

MIT © [CronAI UG](https://cronai.de)
