# Quickstart: Plugin Development

> **For:** developers working on VaultOre
> **Needs:** Node.js 20+, Bun 1.3+, a container engine

Build the plugin, load it into a test vault, and run a canonical fixture.

---

## 1. Prerequisites

- **Node.js 20+**: [nodejs.org](https://nodejs.org/)
- **Bun 1.3+** (CI uses 1.3.14): [bun.sh](https://bun.sh/)
- **A container engine**, running: [Docker](https://www.docker.com/products/docker-desktop),
  [Podman](https://podman.io/), [Colima](https://github.com/abiosoft/colima) (macOS), or
  [Apple container](https://github.com/apple/container) (macOS 26+, Apple silicon). On Colima,
  use virtiofs file sharing (`colima start --vm-type vz --mount-type virtiofs`); sshfs can serve
  stale file contents ([#83](https://github.com/cronai-labs/vaultore/issues/83)).

Check that the engine answers. VaultOre treats an engine as available only when this exits 0:

```bash
docker version          # Docker, and Colima (which uses the docker CLI)
podman version
colima status
container system status # Apple container
```

---

## 2. Clone, Install, Build

```bash
git clone https://github.com/cronai-labs/vaultore.git
cd vaultore
bun install
bun run build             # all packages; or bun run core:build / bun run obsidian:build
```

Each package gets a `dist/` folder; the plugin bundle is `packages/obsidian/dist/main.js`.

---

## 3. Package the Plugin

```bash
bun run obsidian:package
```

This copies `main.js`, `manifest.json` and `styles.css` into
`packages/obsidian/package/vaultore/`. It builds only when `packages/obsidian/dist/` is
missing: after a watch session (§5) it packages the development bundle, so run
`bun run build` first ([#47](https://github.com/cronai-labs/vaultore/issues/47)).

---

## 4. Load It into a Test Vault

Use a vault without notes you care about.

1. Create a vault in Obsidian, for example `~/vaultore-test-vault`.
2. Copy the packaged plugin into it:

   ```bash
   mkdir -p ~/vaultore-test-vault/.obsidian/plugins/vaultore
   cp packages/obsidian/package/vaultore/* ~/vaultore-test-vault/.obsidian/plugins/vaultore/
   ```

3. In Obsidian: **Settings → Community plugins**, turn off restricted mode if asked, and
   enable **VaultOre**.

---

## 5. Rebuild While You Work

```bash
bun run obsidian:dev
```

This runs esbuild in watch mode: it rebuilds `packages/obsidian/dist/main.js`, with an inline
source map, on every change. **It does not copy anything into a vault.** After a rebuild, copy
`dist/main.js` to `<vault>/.obsidian/plugins/vaultore/` and reload the plugin (turn it off and
on, or reload Obsidian). A one-command install is planned in
[#47](https://github.com/cronai-labs/vaultore/issues/47).

Changes to `packages/core` reach the plugin bundle only after core is rebuilt
(`bun run core:build`, or `bun run build`).

---

## 6. Configure VaultOre

**Settings → VaultOre** (Obsidian 1.11.4 or later, for secret storage):

1. **Default runtime engine:** the engine you run. A workflow whose frontmatter sets
   `runtime.engine` overrides it.
2. **Output folder:** default `_vaultore`.
3. **API keys** (only for `ore:ai` cells): for "OpenAI API key" or "Anthropic API key", select
   or create a secret in Obsidian's secret storage. VaultOre stores the secret's name, not the
   key. Keys come from [platform.openai.com](https://platform.openai.com) or
   [console.anthropic.com](https://console.anthropic.com).
4. **Default provider, Default model, Temperature, Max tokens, AI request timeout:** optional;
   defaults OpenAI, `gpt-5-mini`, provider default, 800, 120 seconds.

---

## 7. Run a Fixture

```bash
cp fixtures/canonical/hello-world.md ~/vaultore-test-vault/Hello-World.md
```

`hello-world.md` sets `runtime.engine: docker`. On another engine, delete that line so your
setting applies.

Open the note and run **VaultOre: Run all cells** from the command palette (`Cmd+P` /
`Ctrl+P`). No hotkeys are set by default; assign them under **Settings → Hotkeys**.

The first run asks about `buildNetwork`, which the fixture does not set; nothing uses it, so
either answer works. The answer is remembered until the note changes.

After a few seconds each cell has a callout under it:

```markdown
> [!ore-output] hello
> view: [[_vaultore/runs/Hello-World/RUN_ID/hello.md]]
> ![[_vaultore/runs/Hello-World/RUN_ID/hello.md]]
> json: [[_vaultore/runs/Hello-World/RUN_ID/hello.json]]
> run: RUN_ID
> status: success | duration: 1.20s | at: 2026-10-15T08:00:00.000Z
```

`transform`'s output is `HELLO FROM VAULTORE!`. Outputs are stored under
`_vaultore/runs/Hello-World/<runId>/`; the format is in the
[workflow note spec](../specs/workflow-note-spec.md#7-outputs).

---

## 8. Troubleshooting

**`Container runtime "docker" is not available: …`**
The engine did not answer its probe (`docker version`, `podman version`, `colima status` or
`container system status`) with exit code 0 within 10 seconds. Start it, or pick the engine
you run in the settings. The message says whether the note or the settings chose the engine,
and which engines were detected.

**The plugin is not listed under Community plugins**
Check that `.obsidian/plugins/vaultore/` holds `manifest.json` and `main.js`, reload Obsidian,
and look for errors in the developer console (`Cmd+Option+I` / `Ctrl+Shift+I`).

**`No secret selected for "OpenAI API key"`** (or Anthropic)
Select a secret under **Settings → VaultOre → API keys**. If the message says the secret is
missing or empty, set its value in Obsidian's secret storage.

**`Model "…" is an Anthropic model, but the configured provider is OpenAI`** (or the reverse)
Set the default provider to match the model, or change the cell's `model=` or the default
model.

**Pulling the image fails**
Your engine pulls `oven/bun:1-alpine` (or the workflow's `runtime.image`) on first use. Check
its network and proxy settings, or pull by hand: `docker pull oven/bun:1-alpine`.

**`Vault read permission denied`, `Vault write permission denied`, `AI cells require network permission`**
The workflow lacks that permission. Check its `permissions:`; a permission at `ask` that was
denied stays denied until the note changes
([permissions spec](../specs/permissions-spec.md#5-permission-decisions)). On Linux, also
check that your user may use the engine (for Docker, the `docker` group).

**A cell fails with `status: error`**
The callout's `error:` line has the message, usually the cell's stderr. Check the cell against
the [workflow note spec](../specs/workflow-note-spec.md). Plugin messages appear in the
developer console, prefixed `[VaultOre]`.

---

## 9. Next Steps

- Run the other fixtures: [Testing Fixtures](testing-fixtures.md) says what each needs.
- Run the tests:

  ```bash
  bun run test              # unit tests, no engine needed
  bun run test:canonical    # parses every fixture, no engine needed
  VAULTORE_IT_ENGINE=docker bun run --cwd packages/core test:integration   # needs an engine
  ```

- Read the code: `packages/core/src/` (parser, executor, runtime) and
  `packages/obsidian/src/main.ts`; the [Architecture Guide](../ARCHITECTURE.md) maps it.

## Quick Reference

| Task | Command |
| --- | --- |
| Install dependencies | `bun install` |
| Build all packages | `bun run build` |
| Build core / plugin only | `bun run core:build` / `bun run obsidian:build` |
| Watch-build the plugin | `bun run obsidian:dev` |
| Package the plugin | `bun run obsidian:package` |
| Unit tests | `bun run test` |
| Fixture parse tests | `bun run test:canonical` |

Questions: [GitHub Issues](https://github.com/cronai-labs/vaultore/issues). More docs:
[index](index.md). **Ready to build?** Start with the [Architecture Guide](../ARCHITECTURE.md);
the [roadmap](roadmap.md) says what is planned.
