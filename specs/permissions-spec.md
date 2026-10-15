# Permissions and Security Specification

> **Status:** Canonical. Sections 1–8 describe what the code does at version 0.1.0;
> [Planned](#planned) lists what is specified but not built.
> **Last Updated:** 2026-10-15

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

`.obsidian/` and `.vaultore/` are hidden (§4.1). Other dot-directories in the vault are visible
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
also refuses a write to a note that is no longer what the cell read (workflow-note-spec §5.1).
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
| `.obsidian/` | `--tmpfs /workspace/.obsidian:ro,noexec,nosuid,nodev` | same | Under the full vault mount, an empty read-only tmpfs hides the plugin's own code and settings, so a cell can neither read nor rewrite them. Applied only when `.obsidian/` exists in the vault: masking a missing directory would make the engine create it. Obsidian's per-device "Override config folder" setting is not honoured; only `.obsidian` is masked |
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
| Memory | 512m | Per workflow: `runtime.memoryLimit` |
| CPU | 1 core | Per workflow: `runtime.cpuLimit` |
| Timeout | 60s | Per workflow (`runtime.timeout`) or per cell (`timeout`) |
| PIDs | 256 | No; `DEFAULT_PIDS_LIMIT`, overridable only through the `pidsLimit` option of `execContainer` |

At the timeout VaultOre kills the engine's CLI process. The cell's error then reads `exit 1`
rather than naming the timeout, and the container itself may keep running until it exits
(a known follow-up of [#86](https://github.com/cronai-labs/vaultore/pull/86)).

### 4.4 No Unsafe Fallback

Every run checks the engine before any cell runs. When it is not available, the run fails with
`Container runtime "<engine>" is not available: …`, says whether the note or the settings
chose that engine, and lists the engines that were detected. There is no option to run cell
code on the host.

---

## 5. Permission Decisions

### 5.1 When a Prompt Appears

At the start of each run, every permission the frontmatter sets to `ask` is looked up in the stored decisions. A stored `allow` or `deny`
for the same note and the same content (§5.3) is used. Otherwise the user is asked, once per
permission.

### 5.2 The Prompt

- **Obsidian plugin:** a modal per permission, "VaultOre permission request: `<permission>`
  for `<path>`. Allow?", with **Allow** and **Deny**. Closing it denies.
- **CLI:** non-interactive. Without `--yes` the answer is `deny`; with `--yes` it is `allow`.
  Either is printed to stderr.
- **No way to ask** (an adapter without `confirm`): `deny`.

A denied permission does not stop the run: it runs without that permission, and cells that
needed it fail.

### 5.3 Stored Decisions

After the prompts, the resolved values of all four permissions are stored per note path, with
the hash of the content they were given for:

```json
{
  "Workflows/link-digest.md": {
    "network": "allow",
    "buildNetwork": "deny",
    "vaultWrite": "allow",
    "vaultRead": "allow",
    "workflowHash": "<sha256>",
    "grantedAt": "2026-10-15T08:00:00.000Z"
  }
}
```

They are kept as `permissionDecisions` in the plugin's settings
(`.obsidian/plugins/vaultore/data.json`) or in the CLI's `<vault>/.vaultore/config.json`; both
are hidden from cells.

`workflowHash` is the SHA-256 of the note's frontmatter as written (including keys the
schema does not know) and each cell's attributes and source, with object keys sorted. Line
numbers and output callouts are not part of it: the engine rewrites outputs into the note on
every run, and that must not prompt again. Which parts a grant is bound to may become a user
setting ([#70](https://github.com/cronai-labs/vaultore/issues/70)).

**Asked again when:**

- the frontmatter or any cell changes (the hash differs), including an edit arriving through
  sync or another note saved under the same path;
- the stored decision has no hash (stored before hashes were introduced).

A stored `deny` is reused like an `allow`. In the CLI this means one run without `--yes` keeps
the permission denied for that content, even on later runs with `--yes`
([#28](https://github.com/cronai-labs/vaultore/issues/28)). There is no command or setting to
clear decisions; remove the note's entry from the file above.

---

## 6. Scheduled Runs

A `schedule:` in frontmatter does not by itself make a note run unattended in the plugin:

- The "Run scheduled workflows" setting is off by default.
- Each scheduled note must be approved in **Settings → VaultOre → Scheduled workflows**. The
  approval is stored for the note's path and its exact schedule string. A changed schedule, a
  renamed or deleted note, or a note that arrives through sync is listed but does not run until
  approved again.
- Approval is re-checked when a run is due. A scheduled run then resolves permissions like any
  other run (§5).

`vaultore agent` (CLI) has no approval step: it runs every workflow in the vault that has a
schedule, with permissions resolved non-interactively (§5.2).

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
| A synced or renamed note running unattended | Scheduling consent per path and schedule (§6), in the plugin |

### 8.2 Not Mitigated

| Threat | Notes |
|--------|-------|
| A note that declares `allow` | Applied without a prompt. Read a workflow before running it |
| `vaultore agent` | Runs every scheduled workflow without approval (§6) |
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
  stored decision for this path with the same content hash?
    yes → use it
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
