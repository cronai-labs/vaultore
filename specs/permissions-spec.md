# Permissions and Security Specification

> **Status:** Canonical. Sections 1–8 describe what the code does, as checked in with it;
> [Planned](#planned) lists what is specified but not built.

## Overview

VaultOre runs code that a note contains. This specification defines what a workflow may do,
how that is decided, and how the container enforces it. It is the single source for the
permission defaults; other documents link here.

A workflow note is executable content. A permission set to `allow` in its frontmatter applies
without asking; only `ask` prompts. Running a note you did not write, or that changed through
sync, means trusting what it declares.

## 1. Design Principles

1. **Restrictive where it matters:** no network and no vault writes unless a workflow is
   granted them. Reading the vault is allowed by default.
2. **Enforced at the container:** a permission decides what the container is given (a network,
   a mount), not only what helper functions allow.
3. **Per workflow, per content:** a decision belongs to one note and to the content it was given
   for (§5.3).
4. **No host fallback:** without a container engine, nothing runs (§4.4).

---

## 2. Permission Types

### 2.1 Defaults

`DEFAULT_PERMISSIONS` (`packages/core/src/types/index.ts`):

| Permission | Default | Controls |
|------------|---------|----------|
| `network` | `deny` | Network access for container cells; required by AI cells (§3.1) |
| `buildNetwork` | `deny` | Nothing yet: reserved for dependency downloads of planned Python and Go cells (§3.2) |
| `vaultRead` | `allow` | Whether the vault is mounted into containers, and `{{note:}}` in AI cells (§3.3) |
| `vaultWrite` | `deny` | Whether the mount is writable (§3.4) |

A workflow sets any of them in frontmatter; unset ones take the default:

```yaml
permissions:
  network: allow
  vaultWrite: ask
```

### 2.2 Permission Values

| Value | Behaviour |
|-------|-----------|
| `allow` | Granted, without a prompt |
| `deny` | Refused, without a prompt |
| `ask` | Resolved to `allow` or `deny` by a prompt, and the answer stored for this content of the note (§5) |

---

## 3. Permission Details

### 3.1 `network`

**`deny` (default):** container cells run with no network attached (`--network=none`, Apple:
`--network none`), so `fetch` and any other connection fail. AI cells fail with
`AI cells require network permission`.

**`allow`:** containers get the engine's default network, and AI cells may call the provider.
A cell can then send anything it can read to any host.

Pulling a missing image is done by the engine before the container starts and is not governed
by this permission.

### 3.2 `buildNetwork`

No cell type uses it. It defaults to `deny`, so it never prompts unless a workflow sets it to
`ask`; it is resolved and stored like the others, then ignored. It is reserved for dependency
downloads (`go mod download`, `pip install`) of the planned `ore:go` and `ore:py` cells, and its
default becomes `ask` when they ship (#95).

### 3.3 `vaultRead`

The mount is the enforcement (`vaultMounts`, `packages/core/src/executor/index.ts`). With
`vaultRead` and `vaultWrite` together:

| `vaultRead` | `vaultWrite` | What a container cell sees at `/workspace` |
|-------------|--------------|--------------------------------------------|
| `allow` | `deny` | The whole vault, read-only, with `.obsidian/` hidden (§4.1) |
| `allow` | `allow` | The whole vault, read-write, with `.obsidian/` hidden |
| `deny` | `allow` | Only this run's directory, `<outputRoot>/runs/<workflow>/<runId>/`, read-write, at the same path it has under a full mount |
| `deny` | `deny` | Nothing |

**`allow` (default):** `vault.read()`, `vault.exists()` and `{{note:path}}` work. Every file
in the vault folder is readable except `.obsidian/` and `.vaultore/`, including other workflows'
run outputs.

**`deny`:** `vault.read()` and `vault.exists()` throw; `{{note:path}}` fails the AI cell before
anything is sent. A cell that may still write sees only its run directory, so it can record
output without seeing the vault or earlier runs; `vault.write()` elsewhere throws.

`vault.readRaw()` reads paths inside the container (`/proc`), not the vault, and is not
checked.

`.obsidian/` and `.vaultore/` are hidden (§4.1), from AI cells too: a `{{note:path}}` whose real
path, after any symbolic link, lies in either (in any letter case) fails the cell before
anything is sent. Other dot-directories in the vault are visible
under a full mount, and writable with `vaultWrite`.

### 3.4 `vaultWrite`

**`deny` (default):** the vault is mounted read-only, or not at all. `vault.write()` and
`vault.mkdirp()` throw.

**`allow`:** cells can create, modify and delete any file in the vault except under
`.obsidian/` and `.vaultore/`.

`vault.write()` does not write through the mount. The host applies it after the cell has
exited successfully, through the platform (Obsidian's vault API in the plugin, the file system
in the CLI), and the host is where its rules are enforced: it refuses paths outside the vault
(absolute, or with a `..` segment), under `.obsidian/` or `.vaultore/` (any letter case), every
write under `vaultWrite: deny`, and without `vaultRead` any path outside the run directory. It
also refuses a write to a note that is no longer what the cell read ([ore-implementation.md](ore-implementation.md), `ore:ts`).
One refused write fails the cell and none of its writes are applied.

**Symbolic links.** A cell with `vaultWrite` can create links through its mount, which the host
would follow outside the vault. So every vault path the host reads or writes (`vault.write`,
`{{note:path}}`, recorded outputs, output files, run records, the workflow note) is resolved
first (`PlatformAdapter.resolveInVault`): a link as the last component is refused wherever it
points, a directory link on the way is followed only if its real target lies inside the vault,
and the rules above then apply to the real path. A platform without `resolveInVault` cannot run
workflows.

Shell cells, `vault.mkdirp()` and raw writes to `/workspace` (`Bun.write`, `node:fs`) go
through the mount, limited only by the mount and the masks (§3.3, §4.1). Obsidian sees them as
external changes, and nothing checks them against what the cell read.

Output callouts, output files and run records are written by the host, not by cells, whatever
this permission says.

---

## 4. Container Sandbox

### 4.1 Default Container Flags

Every container cell (`ore:ts` and `ore:shell`) gets these flags from `buildRunCommand`
(`packages/core/src/runtime/index.ts`). They are not configurable per workflow, except the
limits in §4.3. Docker, Podman and Colima (which drives the docker CLI) get:

```bash
docker run --rm \
  --network=none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777 \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=256 \
  --user=<uid>:<gid> \
  -e HOME=/tmp \
  --memory 512m --cpus 1 \
  --workdir /workspace \
  -v <vault>:/workspace:ro \
  $IMAGE $COMMAND
```

| Flag | Docker / Podman / Colima | Apple `container` | Purpose |
|------|--------------------------|-------------------|---------|
| Network | `--network=none` unless `network: allow` | `--network none` unless `network: allow` | No network attachment at all (§3.1) |
| Root filesystem | `--read-only` | `--read-only` | Cells cannot modify the image (`/etc`, `/usr`) |
| Scratch space | `--tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777` | same | The only writable path outside the mounts; TS cells write their script to `/tmp/vaultore.ts`. Its pages count against the memory limit |
| `HOME` | `-e HOME=/tmp` | same | The cell's uid has no passwd entry, so `HOME` would be `/`, which is read-only; Bun writes its install cache under `$HOME` and fails with `EROFS` |
| Capabilities | `--cap-drop=ALL` | `--cap-drop ALL` | No Linux capabilities |
| Privilege escalation | `--security-opt=no-new-privileges` | **not supported** by the CLI | setuid binaries cannot gain privileges |
| Process limit | `--pids-limit=256` (`DEFAULT_PIDS_LIMIT`) | **not supported** by the CLI | Stops a fork bomb |
| User | `--user=<uid>:<gid>` (§4.2) | `--user <uid>:<gid>` | Never root |
| Memory / CPU | `--memory` / `--cpus` from `runtime.memoryLimit` / `runtime.cpuLimit` | same | §4.3 |
| Vault | §3.3, §3.4: no mount, the run directory only, or the vault read-only or read-write | same | |
| `.obsidian/` | `--tmpfs /workspace/.obsidian:ro,noexec,nosuid,nodev` | same | Under the full vault mount, an empty read-only tmpfs hides the plugin's own code and settings, so a cell can neither read nor rewrite them. Applied only when `.obsidian/` exists in the vault: masking a missing directory would make the engine create it. The config folder the platform reports is masked as well, when it is another one (Obsidian's per-device "Override config folder", the CLI's `--config-dir`; #147) |
| `.vaultore/` | `--tmpfs /workspace/.vaultore:ro,noexec,nosuid,nodev` | same | Under the full vault mount, hides the CLI's settings, so a cell cannot change how the CLI runs notes (#94). Always applied: the host creates `.vaultore/` before the run, so a cell cannot create the config in a vault that has none yet |
| VaultOre's own folder | `--tmpfs /workspace/<its path in the vault>:ro,noexec,nosuid,nodev` | same | `~/.config/vaultore` (`%APPDATA%\vaultore`) holds the schedule approvals, the answers, the locks and the schedule record. A vault that holds it, such as a vault at the home folder, has it masked under the full vault mount, created first like `.vaultore/`; `vault.write` and `{{note:}}` refuse it as they refuse the config folders. A vault inside that folder is refused (#306) |

On Apple `container` each container is its own micro-VM, which is the isolation boundary for
what the CLI cannot express (no `no-new-privileges`, no pids limit; checked against
apple/container's `docs/command-reference.md`, release 1.5.0). Apple paths are covered by unit
tests on the emitted arguments only; they have not been run against a real `container` install.

### 4.2 Container User

Cells run as the host's `uid:gid` (`containerUser()`), never as root:

- **Linux:** files a cell writes through a read-write vault mount belong to the vault's owner.
  This holds for rootful Docker and Podman. Rootless engines map container uids through a user
  namespace, so a non-zero uid lands on the host as a subordinate uid.
- **macOS (Colima, Docker Desktop):** the VM's file share maps ownership to the host user
  whatever the container uid (observed with Colima's sshfs mounts), and the host uid is the owner
  the share presents the files as, so permission checks inside the VM pass.
- **No POSIX ids (Windows) or a host running as root:** `65534:65534` (`nobody`,
  `FALLBACK_CONTAINER_USER`). Writes into the vault may then fail on permissions; that surfaces
  as a cell error.

### 4.3 Configurable Limits

| Limit | Default | Configurable |
|-------|---------|--------------|
| Memory | 512m | Per workflow: `runtime.memoryLimit`, an amount greater than zero |
| CPU | 1 core | Per workflow: `runtime.cpuLimit`, greater than 0 |
| Timeout | 60s | Per workflow (`runtime.timeout`) or per cell (`timeout`): greater than 0, at most 86400 seconds |
| PIDs | 256 | No; `DEFAULT_PIDS_LIMIT`, overridable only through the `pidsLimit` option of `execContainer` |

At the timeout VaultOre kills the engine's CLI process, then the container by the name it gave
it (`<engine> kill <name>`), and `--rm` removes it. The cell's output gets the status `timeout`
and the error `<type> cell timed out after <n>s`, and the run counts as failed
([#113](https://github.com/cronai-labs/vaultore/issues/113)).

### 4.4 No Unsafe Fallback

Every run checks the engine before any cell runs. When it is not available, the run fails with
`Container runtime "<engine>" is not available: …`, says whether the note or the settings
chose that engine, and lists the engines that were detected. There is no option to run cell
code on the host.

---

## 5. Permission Decisions

### 5.1 When a Prompt Appears

At the start of each run started by hand, every permission the frontmatter sets to `ask` is looked up in the stored decisions. A scheduled run or a catch-up asks nothing: its permissions come from the note's schedule approval (§6.3). A stored `allow` or `deny`
for the same note and the same content, kept for this account on this computer (§5.3), is used. Otherwise the user is asked, once per
permission. A note that asks nothing reads and stores no decision.

### 5.2 The Prompt

- **Obsidian plugin:** a modal per permission, "VaultOre permission request: `<permission>`
  for `<path>`. Allow?", with **Allow** and **Deny**. Closing it denies.
- **CLI:** non-interactive. With `--yes` the answer is `allow`. Without it nobody is asked: the
  permission is denied for this run and nothing is stored, so a later run with `--yes` is asked
  and can allow. Either is printed to stderr.
- **No way to ask** (an adapter without `confirm`): denied for this run, nothing stored.

A denied permission does not stop the run: it runs without that permission, and cells that
needed it fail.

### 5.3 Stored Decisions

After the prompts of a run started by hand, the answers to the permissions at `ask` are stored for the note, with the hash of the content they were given for ([#299](https://github.com/cronai-labs/vaultore/issues/299)):

- **Where:** `answers.json` in VaultOre's folder for the account, beside `schedules.json` (`~/.config/vaultore/` from the account's home directory, `%APPDATA%\vaultore\` on Windows; core `answersStore`). One file for the account on this computer, shared by the plugin and the CLI: an answer given in either counts in both. Outside every vault: what may grant a permission on this computer must not be something sync carries, or anyone who can write the vault can change. Another account, and another computer, has its own, so a note that arrives through sync, or was answered elsewhere, asks again.
- **What:** per vault, keyed by its real path (a vault opened through a symbolic link is the same vault), each note's answers:

  ```json
  {
    "format": "vaultore.permission-answers",
    "version": 1,
    "vaults": {
      "/home/me/notes": {
        "notes": {
          "Workflows/link-digest.md": {
            "network": "allow",
            "workflowHash": "<sha256>",
            "grantedAt": "2026-10-15T08:00:00.000Z"
          }
        }
      }
    }
  }
  ```

  A record holds nothing bound to this machine, so that answers can later be signed and carried to another computer that trusts this one ([#305](https://github.com/cronai-labs/vaultore/issues/305)).
- **Changes** happen under the file's lock, as for `schedules.json` (§6.0), waiting up to two seconds for the other runner. The answers are merged with what the file holds then: when the other runner answered the same content while this one asked (the modal may stay open), a deny wins. Answers for another content of the note are replaced. A file that cannot be read, or is not an answers file, is an error that names it: a note that asks is not run, and nothing is written over it. A note that asks nothing reads and writes nothing.
- **Earlier versions** kept answers in the plugin's `data.json` (`permissionDecisions`) and the CLI's `.vaultore/config.json`, which sync carries. They are not read: each note asks once on each computer. They are left as they are, so an older runner on another computer keeps its own.

`workflowHash` is the SHA-256 of the note's frontmatter as written (including keys the
schema does not know) and each cell's attributes and source, with object keys sorted. Line
numbers and output callouts are not part of it: the engine rewrites outputs into the note on
every run, and that must not prompt again. Which parts a grant is bound to may become a user
setting ([#70](https://github.com/cronai-labs/vaultore/issues/70)).

**Asked again when:**

- the frontmatter or any cell changes (the hash differs), including an edit arriving through
  sync or another note saved under the same path;
- the stored decision has no hash (stored before hashes were introduced);
- it was given on another computer or for another account, or kept by an earlier version (in `data.json` or `config.json`).

A stored `deny` is reused like an `allow`; only an answer a person gave (a modal, or `--yes`) is
stored. There is no command or setting to clear decisions
([#28](https://github.com/cronai-labs/vaultore/issues/28)); remove the note's entry from
`answers.json`.

---

## 6. Scheduled Runs

A `schedule:` in frontmatter does not by itself make a note run unattended, in the plugin or under `vaultore agent`. On each computer a scheduled note has at most one approval, which names the runner that owns it: Obsidian or the agent ([#301](https://github.com/cronai-labs/vaultore/issues/301)). Only the owner arms the note; the other runner shows it as handed over and never fires it, so the two runners on one computer cannot both schedule it.

### 6.0 The approvals

- **Where:** `schedules.json` in VaultOre's folder for the account, beside the run locks and the schedule record: `~/.config/vaultore` from the account's home directory, not from `$HOME` or `$XDG_CONFIG_HOME`; on Windows `%APPDATA%\vaultore` (core `schedulesStore`). Outside every vault: anything inside a vault can arrive through sync, and an approval must not. Both runners read and write it; no flag moves it, so both always meet there. The user tree is the account's: another account on the same machine has its own ([#287](https://github.com/cronai-labs/vaultore/issues/287)).
- **What:** per vault, keyed by its real path, the plugin's **Run scheduled workflows**, what the plugin's approvals bind (`obsidianBinding`, §6.1), and each approved note with the permissions its unattended runs get (§6.3):

  ```json
  {
    "format": "vaultore.schedules",
    "version": 1,
    "vaults": {
      "/home/me/notes": {
        "obsidianScheduling": true,
        "obsidianBinding": "strict",
        "notes": {
          "Workflows/digest.md": {
            "owner": "agent",
            "hash": "<sha256>",
            "schedule": "0 9 * * 1-5",
            "approvedAt": "2026-11-09T12:00:00.000Z",
            "permissions": {
              "network": { "value": "allow", "source": "answer" },
              "buildNetwork": { "value": "deny", "source": "frontmatter" },
              "vaultRead": { "value": "allow", "source": "frontmatter" },
              "vaultWrite": { "value": "deny", "source": "frontmatter" }
            }
          }
        }
      }
    }
  }
  ```

  `hash` is the hash a permission decision is bound to (§5.3: the frontmatter as written and each cell's attributes and source). `obsidianBinding` missing is `strict`.
- **When an approval applies,** checked when the owner arms the note, when a run is due, and by the executor against the content it runs:
  - its `permissions` cover the note as it is: each permission the frontmatter sets has the value held, from the frontmatter, and each `ask` has an answer (§6.3). Always, whoever owns the note;
  - owned by the agent: while `hash` is the note's, so a changed schedule, permission or cell withdraws it; an output callout written by a run, or an edit to the prose, does not;
  - owned by Obsidian, `strict` (the default): as the agent's, while **Run scheduled workflows** is on;
  - owned by Obsidian, `narrow`: while `schedule` is the note's exact schedule string and **Run scheduled workflows** is on. Its cells, image, engine and limits may change, and run unreviewed, as its cells' code may ([#219](https://github.com/cronai-labs/vaultore/issues/219)).
- **Approving** a note for one runner replaces any approval it had, so handing it to the other runner is approving it there, with the same review (§6.3). Revoking takes it from both. A renamed or deleted note loses its approval in Obsidian; a note that arrives through sync has none.
- **Changes** happen under a lock (`schedules.json.lock`, a directory holding one file that names the process, machine and start time), so two changes cannot each write what they read plus their own; a change that finds it held by a live process waits up to two seconds before it is refused, naming that process ([#291](https://github.com/cronai-labs/vaultore/issues/291)); the file is replaced by renaming a temporary file into place, so a reader sees the old list or the new one. A lock whose process no longer exists on this machine, or that was taken before the machine last started, is taken over and said; a lock that is held, held on another machine, or unreadable is never removed, and the error names it (`packages/core/src/lock/index.ts`). A file that cannot be read, or is not a schedules file, is an error that names it: the agent does not start, a running agent arms nothing until it can be read, the plugin keeps scheduling off and says so, and nothing is written over it. A file that turns unreadable while the plugin runs counts as holding no approvals, as it may hold a revoke the plugin has not read: the plugin disarms every note, runs and catches up nothing, says so once, and resumes once it can be read again ([#307](https://github.com/cronai-labs/vaultore/issues/307)).
- **From 0.4.x:** an approval copied from 0.4.x holds no permissions; it applies to a note with no `ask`, its permissions being the frontmatter's, and asks for review otherwise. The agent's approvals in `approvals.json` (in `$XDG_CONFIG_HOME/vaultore` when that was set, else `~/.config/vaultore` from `$HOME`; `%APPDATA%\vaultore` on Windows) are copied in as notes the agent owns, once: `schedules.json` records the file it copied, under its lock, so a revoke afterwards stays revoked. Both runners do it when they open the file, so whichever runs first after the upgrade carries them over; a note approved here already keeps its approval. The old file is left as it was and no longer read. The plugin's approvals of 0.4.x, in its `data.json`, are not carried over (§6.1).

### 6.1 Plugin

- **Run scheduled workflows** is off by default.
- Each scheduled note is set in **Settings → VaultOre → Scheduled workflows**: **Off**, **In Obsidian**, or **By the agent**. A dialog opens only when a permission changed or needs an answer (§6.3); cancelling it approves nothing. The row says why a note does not run: not approved, changed since it was approved (and what: the schedule, a permission, its frontmatter or a cell), scheduling off, or handed to an agent that does not run this vault. A changed note gets a **Review** button, and the plugin says once that it changed, not on every check.
- **What an approval covers:** `strict` (the default), the whole note; `narrow`, its schedule and permissions (§6.0). For the account on this computer, in `schedules.json`. The agent is always strict; the plugin offers the choice so that each person can weigh a cell edit running unreviewed against approving again after each edit.
- **The agent's status:** a row says whether `vaultore agent` runs this vault (from the agent's lock, §6.2), since when, and what that means for the notes handed to it. When notes are handed to it and no agent runs, the plugin says so once per start. It reads the status, and `schedules.json`, again each minute, and `schedules.json` again before a run is due, so a hand-over made with the CLI is followed.
- Earlier releases kept the switch and the approvals in the plugin's `data.json`; they are not carried over, as a synced `data.json` is what this keeps from granting consent ([#276](https://github.com/cronai-labs/vaultore/issues/276)). They stay in `data.json`, written back as found, so an older plugin on another computer keeps scheduling until it is upgraded; a later release removes them ([#286](https://github.com/cronai-labs/vaultore/issues/286)). When they say scheduling was on and it is off on this computer, the plugin says so once on this computer (a flag in Obsidian's per-device storage, which sync does not carry), and its settings say so until scheduling is turned on here.
- A scheduled run and a catch-up get their permissions from the approval (§6.3) and never open the permission modal.

### 6.2 `vaultore agent` (CLI)

- `vaultore schedules approve <note.md>... [--owner agent|obsidian] [--allow <names>] [--deny <names>]` approves the notes as they are now, for the agent unless `--owner obsidian`; all of them or none. It prints what each permission is, and what is kept, changed, new and dropped against the approval before; it refuses, naming them, while an `ask` has no answer. `--allow` and `--deny` take permission names, comma-separated, and answer for one note at a time; an answer for a permission the frontmatter sets is refused. `vaultore schedules revoke <note.md>...` withdraws them. `vaultore schedules list` shows every scheduled note with who runs it and whether it runs (runs, not approved, changed since approval, Obsidian's scheduling off), and approvals whose note is gone.
- **One agent per vault:** while it runs, the agent holds a lock on the vault (`~/.config/vaultore/agents/<sha256 of the vault's real path>.lock`, naming its process, machine and start). A second agent on the same vault is refused, naming the first; a lock left by an agent that is gone is taken over and said. The plugin reads it for the agent's status.
- The agent arms the notes it owns whose approval applies. Approval is re-checked when a run is due: the note and the approvals are read again, and the content that was checked is the content that runs, with the approval's permissions (§6.3). `vaultore agent --yes` is refused, naming `schedules approve`: answers for unattended runs are given when approving.
- `vaultore schedules catch-up` checks the note's approval before it takes the gap, and refuses `--yes`.
- The agent names each scheduled note it does not run, with the reason, when it starts and whenever that set changes; for a changed note, what changed and the command that approves it again, with `--allow`/`--deny` for a new `ask`. Notes handed to Obsidian are left out, and when every scheduled note is Obsidian's, it says so once.

### 6.3 Unattended permissions

Whether a person is there decides where an `ask` is answered ([#299](https://github.com/cronai-labs/vaultore/issues/299)):

| Trigger | Started by | `ask` permissions from | Asks | Stores |
|---|---|---|---|---|
| `manual`: Obsidian's run commands, `vaultore run` | a person | this device's answers (§5.3) | yes: the modal; the CLI with `--yes`, else denied for the run | the answer, for this device |
| `schedule`: the runner that owns the note | the clock | the note's approval | never | nothing |
| `catch-up`: Obsidian's **Catch up**, `vaultore schedules catch-up` | a person, standing in for the scheduled run | the note's approval, under its owner's binding, whichever runner catches up | never | nothing |

- Permissions the frontmatter sets come from the frontmatter, in every run; the approval holds them as they were approved, and one that changed withdraws the approval.
- An unattended run never reads the answers kept for runs started by hand.
- A note Obsidian runs is not scheduled while **Run scheduled workflows** is off, so neither runner catches it up then: its missed runs can be dismissed, or caught up once the switch is on. A note the agent runs stays scheduled while the agent is stopped, and can be caught up ([#307](https://github.com/cronai-labs/vaultore/issues/307)).
- A catch-up uses the note's approval as it is when the catch-up starts, which covers the note as it is then; not the approval in force when the runs were missed, which may cover content the note no longer has. `run.json` names when that approval was given.
- Without an approval that covers the note, a scheduled occurrence does not run: the runner does not arm the note, or skips the occurrence it already armed, and the change is said once per state of the note. A catch-up is refused before its gap is taken, naming what to approve. Should the note change between that check and the run, the executor refuses it and records the slot as skipped, with the reason; a catch-up's gap then stays resolved, as for a note that changed after it was read.
- **Approving again asks only about the change.** Each permission compared with the approval before: `kept`; `new` (a first approval); `changed`, when the frontmatter now sets another value, confirmed by approving; `needs an answer`, for an `ask` not answered before, also one the frontmatter set before; `answer dropped`, when the frontmatter now sets one that had an answer. An answer given before is kept, and may be replaced. A note whose permissions are as approved, after a cell changed, is approved again in one action.
- **The run record** (`run.json`) says how the run was started and where each permission came from:

  ```json
  "trigger": { "kind": "catch-up", "runner": "Obsidian", "slot": "2026-11-26T09:00:00.000Z", "owner": "agent", "approvedAt": "2026-11-20T08:00:00.000Z" },
  "permissions": {
    "network": { "value": "allow", "source": "approval", "at": "2026-11-20T08:00:00.000Z" },
    "vaultRead": { "value": "allow", "source": "frontmatter" }
  }
  ```

  `trigger.kind` is `manual`, `schedule` or `catch-up`; `runner` the runner that ran it; for an unattended run, `slot` (the occurrence, or a gap's first slot), `owner` and `approvedAt` of the approval it went by. A permission's `source` is `frontmatter`, `answer` (given for this device, `at` when), `approval` (answered when approving, `at` then), or `unanswered` (an `ask` nobody could answer, denied for the run).

---

## 7. AI Providers

### 7.1 API Keys

- **Plugin:** keys live in Obsidian's secret storage, which the user manages. VaultOre's
  settings hold only the name of the secret selected for each provider; the value is read when
  a request is sent. The plugin never writes or deletes a secret. A missing selection or an
  empty secret fails the cell with an error naming the setting.
- **CLI:** keys come from the environment: `VAULTORE_OPENAI_APIKEY` (or `OPENAI_API_KEY`),
  `VAULTORE_ANTHROPIC_APIKEY` (or `ANTHROPIC_API_KEY`).

Keys are used only by the host for the provider request. They are not passed to containers and
not written into outputs.

### 7.2 Data Sent to Providers

An AI cell sends one request: the model id, the prompt (the cell's text with `{{cellId}}`
outputs and `{{note:path}}` contents inserted), and the temperature and token limit when set.
No system prompt. It goes to `api.openai.com` or `api.anthropic.com` only, and only when the
workflow is granted `network`.

---

## 8. Threat Model

### 8.1 Mitigated

| Threat | Mitigation |
|--------|------------|
| Code execution on the host | Cells run only in containers (§4) |
| Data leaving the machine | `network: deny` by default; AI cells need `network` |
| Vault corruption | `vaultWrite: deny` by default; read-only or no mount |
| Rewriting the plugin or its settings | `.obsidian/` hidden from every cell (§4.1) |
| Changing the CLI's settings from a cell | `.vaultore/` hidden from every cell, created before the run (§4.1) |
| A cell approving notes or planting answers | VaultOre's own folder is outside the vault, and hidden from cells and refused for writes where a vault holds it (§4.1) |
| Resource exhaustion | Memory, CPU and timeout limits; a process limit on Docker, Podman and Colima |
| Privilege escalation in the container | Non-root user, no capabilities, `no-new-privileges` (not on Apple) |
| A note changing after it was granted `ask` permissions | Decisions bound to the content (§5.3) |
| A decision arriving through sync, or written into the vault by someone who can write it | Answers kept for the account on the computer, outside every vault (§5.3) |
| A synced or renamed note running unattended | Scheduling consent: per path, content and permissions (§6.0; per path, schedule and permissions in the plugin's narrow binding) |
| A permission granted by hand applying at night | Unattended runs take permissions only from the approval, never from answers given for runs started by hand (§6.3) |
| An approved scheduled note changing under `vaultore agent` | The approval is bound to the content and re-checked when a run is due (§6.2) |
| Sync delivering an approval, or turning scheduling on | Both runners keep their scheduling consent outside the vault, per machine (§6.1, §6.2) |
| The plugin and the CLI running one note at once | One run lock per note, outside the vault, shared by both runners (ore-implementation, "One run per note") |

### 8.2 Not Mitigated

| Threat | Notes |
|--------|-------|
| A note that declares `allow` | Applied without a prompt. Read a workflow before running it |
| An approved scheduled note's cells changing in the plugin under the narrow binding | Narrow covers the path, schedule and permissions, not the cells, by the user's choice (§6.1); the default, strict, covers the content |
| Two machines syncing one vault running a note at once | The run lock is per machine (ore-implementation, "One run per note") |
| Container escape, kernel side channels | Containers share a kernel or VM; VaultOre relies on the engine |
| Prompt injection, malicious AI responses | AI output is text that later cells may act on |
| Approving without reading | A prompt cannot judge the code it grants |

---

## Planned

Specified in earlier versions of this document and **not built**.

- **Trust warning for workflows from elsewhere:** a warning before the first run of a note the
  user did not write, with its source and requested permissions.
- **"Remember my choice" checkbox** in the prompt, and **one prompt listing all requested
  permissions** instead of one modal each.
- **Clearing stored decisions** from the settings, and from the CLI
  ([#28](https://github.com/cronai-labs/vaultore/issues/28)).
- **Audit log:** `.vaultore/audit.jsonl` with run, cell and permission events, retention and
  a setting to clear it. Today the run records (`run.json`, `index.json`) are the only log, and
  they do not record permission decisions.
- **`security:` settings and global caps:** defaults for new workflows, and caps a workflow
  cannot exceed (a global `deny` that frontmatter cannot loosen)
  ([#28](https://github.com/cronai-labs/vaultore/issues/28)).
- **`buildNetwork`** taking effect for the dependency downloads of `ore:py` and `ore:go` cells.
- **Choosing what a grant is bound to** ([#70](https://github.com/cronai-labs/vaultore/issues/70)).

---

## Appendix A: Permission Matrix

| Operation | `network` | `vaultRead` | `vaultWrite` |
|-----------|-----------|-------------|--------------|
| `fetch()` or any connection from a TS or shell cell | ✓ | | |
| AI cell | ✓ | | |
| `vault.read()`, `vault.exists()`, reading `/workspace` in a shell cell | | ✓ | |
| `{{note:path}}` in an AI cell | | ✓ | |
| `vault.write()` (host-applied), `vault.mkdirp()`, writing `/workspace` | | ✓ for paths outside the run directory | ✓ |
| `vault.readRaw()` (container paths) | | | |
| Output callouts, output files, run records (host) | | | |

## Appendix B: Decision Flow

```
Run starts
  │
  ▼
Merge frontmatter permissions over the defaults
  │
  ▼
Scheduled run or catch-up?
  yes → the note's approval covers it as it is (§6.0)?
          yes → its four permissions; nothing asked, nothing stored
          no  → refused; the slot is recorded as skipped
  │ no (started by hand)
  ▼
For each permission at "ask":
  an answer in answers.json for this vault, this path and the same content hash?
    yes → use it
    no  → prompt (plugin modal; CLI: --yes allows, else deny for this run)
  │
  ▼
Store the answers given, with the content hash, under the file's lock (a deny winning)
  │
  ▼
Check the engine (fail the run if unavailable)
  │
  ▼
Run cells: network on or off, vault mounted per §3.3, AI cells refused without network
```
