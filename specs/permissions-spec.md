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
| `.vaultore/` | `--tmpfs /workspace/.vaultore:ro,noexec,nosuid,nodev` | same | Under the full vault mount, hides the CLI's settings and stored permission decisions, so a cell cannot forge a grant for another workflow (#94). Always applied: the host creates `.vaultore/` before the run, so a cell cannot create the config in a vault that has none yet |

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

At the start of each run, every permission the frontmatter sets to `ask` is looked up in the stored decisions. A stored `allow` or `deny`
for the same note, the same content and this device (§5.3) is used. Otherwise the user is asked, once per
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

After the prompts, the answers to the permissions at `ask` are stored per note path and then per **device**, with the hash of the content they were given for and a MAC:

```json
{
  "Workflows/link-digest.md": {
    "<device id>": {
      "network": "allow",
      "workflowHash": "<sha256>",
      "grantedAt": "2026-10-15T08:00:00.000Z",
      "mac": "<hmac-sha256>"
    }
  }
}
```

They are kept as `deviceDecisions` in the plugin's settings (`.obsidian/plugins/vaultore/data.json`) or in the CLI's `<vault>/.vaultore/config.json`; both are hidden from cells.

**The device** is an account on a computer ([#284](https://github.com/cronai-labs/vaultore/issues/284)): `device.json` in VaultOre's folder for the account (`~/.config/vaultore/`, `%APPDATA%\vaultore\` on Windows), outside every vault, made on first use and shared by the plugin and the CLI. It holds a random public `id` and a random secret `key`, and nothing about the machine. Two runners that make it at once agree on one. A device file that cannot be read is an error naming it, and a note that asks is not run; it is never replaced silently, as a new one withdraws every decision made here.

**The MAC** is HMAC-SHA256 with the device's key over the vault's path, the note's path, the device id, `workflowHash`, `grantedAt` and the answers. A decision applies only when its MAC verifies. So one written by anyone who can only write the vault, one changed from `deny` to `allow`, and one copied to another note, vault or device are not decisions: the user is asked again, and the log says so. Each device keeps its own entry, so computers that share a vault do not replace each other's answers.

**Decisions from other devices** apply only when this machine's `settings.json` (beside `device.json`, not in the vault, so sync cannot turn it on) sets `decisionsFromOtherDevices: true`: in the plugin, **Permission answers from other devices**; in the CLI, `vaultore permissions other-devices apply`. Then the decisions from other devices for the same content, and one stored before decisions carried a device, apply together: where they disagree on a permission, a deny wins, whatever order the file lists them in. A value other than `true` or `false` is an error naming the file.

**An answer taken from another device becomes this device's own:** the run stores it under this device's id, with this device's MAC, as if it had been given here. Turning the setting off again therefore does not withdraw answers already taken over; they apply until the note changes. And a deny wins only among answers not yet taken over: a deny that another device gives later, or that arrives through sync later, does not replace an allow this device took over before. This device's own decision is looked up first.

**Stored before #284,** decisions were one per note under `permissionDecisions`. That key is read only when decisions from other devices apply, and never written, so an older runner on another computer keeps its own until it is updated.

`workflowHash` is the SHA-256 of the note's frontmatter as written (including keys the
schema does not know) and each cell's attributes and source, with object keys sorted. Line
numbers and output callouts are not part of it: the engine rewrites outputs into the note on
every run, and that must not prompt again. Which parts a grant is bound to may become a user
setting ([#70](https://github.com/cronai-labs/vaultore/issues/70)).

**Asked again when:**

- the frontmatter or any cell changes (the hash differs), including an edit arriving through
  sync or another note saved under the same path;
- the stored decision has no hash (stored before hashes were introduced);
- the decision was made on another device, or before decisions carried a device, unless decisions from other devices apply;
- its MAC does not verify.

A stored `deny` is reused like an `allow`; only an answer a person gave (a modal, or `--yes`) is
stored. There is no command or setting to clear decisions
([#28](https://github.com/cronai-labs/vaultore/issues/28)); remove the note's entry from the
file above.

---

## 6. Scheduled Runs

A `schedule:` in frontmatter does not by itself make a note run unattended, in the plugin or under `vaultore agent`. On each computer a scheduled note has at most one approval, which names the runner that owns it: Obsidian or the agent ([#301](https://github.com/cronai-labs/vaultore/issues/301)). Only the owner arms the note; the other runner shows it as handed over and never fires it, so the two runners on one computer cannot both schedule it.

### 6.0 The approvals

- **Where:** `schedules.json` in VaultOre's folder for the account, beside the run locks and the schedule record: `~/.config/vaultore` from the account's home directory, not from `$HOME` or `$XDG_CONFIG_HOME`; on Windows `%APPDATA%\vaultore` (core `schedulesStore`). Outside every vault: anything inside a vault can arrive through sync, and an approval must not. Both runners read and write it; no flag moves it, so both always meet there. The user tree is the account's: another account on the same machine has its own ([#287](https://github.com/cronai-labs/vaultore/issues/287)).
- **What:** per vault, keyed by its real path, the plugin's **Run scheduled workflows** and each approved note:

  ```json
  {
    "format": "vaultore.schedules",
    "version": 1,
    "vaults": {
      "/home/me/notes": {
        "obsidianScheduling": true,
        "notes": {
          "Workflows/digest.md": {
            "owner": "agent",
            "hash": "<sha256>",
            "schedule": "0 9 * * 1-5",
            "approvedAt": "2026-11-09T12:00:00.000Z"
          }
        }
      }
    }
  }
  ```

  `hash` is the hash a permission decision is bound to (§5.3: the frontmatter as written and each cell's attributes and source).
- **When an approval applies,** checked when the owner arms the note and again when a run is due:
  - owned by the agent: while `hash` is the note's, so a changed schedule, permission or cell withdraws it; an output callout written by a run, or an edit to the prose, does not;
  - owned by Obsidian: while **Run scheduled workflows** is on and `schedule` is the note's exact schedule string. An edit to its cells that leaves the schedule alone keeps it approved ([#219](https://github.com/cronai-labs/vaultore/issues/219)).
- **Approving** a note for one runner replaces any approval it had, so handing it to the other runner is approving it there. Revoking takes it from both. A renamed or deleted note loses its approval in Obsidian; a note that arrives through sync has none.
- **Changes** happen under a lock (`schedules.json.lock`, a directory holding one file that names the process, machine and start time), so two changes cannot each write what they read plus their own; a change that finds it held by a live process waits up to two seconds before it is refused, naming that process ([#291](https://github.com/cronai-labs/vaultore/issues/291)); the file is replaced by renaming a temporary file into place, so a reader sees the old list or the new one. A lock whose process no longer exists on this machine, or that was taken before the machine last started, is taken over and said; a lock that is held, held on another machine, or unreadable is never removed, and the error names it (`packages/core/src/lock/index.ts`). A file that cannot be read, or is not a schedules file, is an error that names it: the agent does not start, a running agent arms nothing until it can be read, the plugin keeps scheduling off and says so, and nothing is written over it.
- **From 0.4.x:** the agent's approvals in `approvals.json` (in `$XDG_CONFIG_HOME/vaultore` when that was set, else `~/.config/vaultore` from `$HOME`; `%APPDATA%\vaultore` on Windows) are copied in as notes the agent owns, once: `schedules.json` records the file it copied, under its lock, so a revoke afterwards stays revoked. Both runners do it when they open the file, so whichever runs first after the upgrade carries them over; a note approved here already keeps its approval. The old file is left as it was and no longer read. The plugin's approvals of 0.4.x, in its `data.json`, are not carried over (§6.1).

### 6.1 Plugin

- **Run scheduled workflows** is off by default.
- Each scheduled note is set in **Settings → VaultOre → Scheduled workflows**: **Off**, **In Obsidian**, or **By the agent**. The row says why a note does not run: not approved, its schedule changed since, scheduling off, handed to the agent and changed since, or handed to an agent that does not run this vault.
- **The agent's status:** a row says whether `vaultore agent` runs this vault (from the agent's lock, §6.2), since when, and what that means for the notes handed to it. When notes are handed to it and no agent runs, the plugin says so once per start. It reads the status, and `schedules.json`, again each minute, and `schedules.json` again before a run is due, so a hand-over made with the CLI is followed.
- Earlier releases kept the switch and the approvals in the plugin's `data.json`; they are not carried over, as a synced `data.json` is what this keeps from granting consent ([#276](https://github.com/cronai-labs/vaultore/issues/276)). They stay in `data.json`, written back as found, so an older plugin on another computer keeps scheduling until it is upgraded; a later release removes them ([#286](https://github.com/cronai-labs/vaultore/issues/286)). When they say scheduling was on and it is off on this computer, the plugin says so once on this computer (a flag in Obsidian's per-device storage, which sync does not carry), and its settings say so until scheduling is turned on here.
- A scheduled run resolves permissions like any other run (§5).

### 6.2 `vaultore agent` (CLI)

- `vaultore schedules approve <note.md>... [--owner agent|obsidian]` approves the notes as they are now, for the agent unless `--owner obsidian`; all of them or none. `vaultore schedules revoke <note.md>...` withdraws them. `vaultore schedules list` shows every scheduled note with who runs it and whether it runs (runs, not approved, changed since approval, Obsidian's scheduling off), and approvals whose note is gone.
- **One agent per vault:** while it runs, the agent holds a lock on the vault (`~/.config/vaultore/agents/<sha256 of the vault's real path>.lock`, naming its process, machine and start). A second agent on the same vault is refused, naming the first; a lock left by an agent that is gone is taken over and said. The plugin reads it for the agent's status.
- The agent arms the notes it owns whose approval applies. Approval is re-checked when a run is due: the note and the approvals are read again, and the content that was checked is the content that runs. A scheduled run then resolves permissions non-interactively (§5.2). `--yes` grants `ask` permissions; it does not approve a schedule.
- The agent names each scheduled note it does not run, with the reason, when it starts and whenever that set changes; notes handed to Obsidian are left out, and when every scheduled note is Obsidian's, it says so once.

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
| Forging the CLI's stored decisions | `.vaultore/` hidden from every cell, created before the run (§4.1) |
| Resource exhaustion | Memory, CPU and timeout limits; a process limit on Docker, Podman and Colima |
| Privilege escalation in the container | Non-root user, no capabilities, `no-new-privileges` (not on Apple) |
| A note changing after it was granted `ask` permissions | Decisions bound to the content (§5.3) |
| A decision arriving through sync, or written into the vault by someone who can write it | Decisions bound to the device that made them, with a MAC whose key is outside the vault (§5.3) |
| A synced or renamed note running unattended | Scheduling consent: per path and schedule in the plugin (§6.1), per path and content under `vaultore agent` (§6.2) |
| An approved scheduled note changing under `vaultore agent` | The approval is bound to the content and re-checked when a run is due (§6.2) |
| Sync delivering an approval, or turning scheduling on | Both runners keep their scheduling consent outside the vault, per machine (§6.1, §6.2) |
| The plugin and the CLI running one note at once | One run lock per note, outside the vault, shared by both runners (ore-implementation, "One run per note") |

### 8.2 Not Mitigated

| Threat | Notes |
|--------|-------|
| A note that declares `allow` | Applied without a prompt. Read a workflow before running it |
| An approved scheduled note changing in the plugin | Its approval covers path and schedule, not the cells (§6.1, [#219](https://github.com/cronai-labs/vaultore/issues/219)) |
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
For each permission at "ask":
  stored decision for this path, this device and the same content hash, whose MAC verifies?
    yes → use it
  else, with decisions from other devices on: those from other devices,
  and one stored before decisions carried a device, for the same content hash?
    yes → use them, a deny winning; store the result as this device's own
    no  → prompt (plugin modal; CLI: --yes allows, else deny)
  │
  ▼
Store all four values with the content hash
  │
  ▼
Check the engine (fail the run if unavailable)
  │
  ▼
Run cells: network on or off, vault mounted per §3.3, AI cells refused without network
```
