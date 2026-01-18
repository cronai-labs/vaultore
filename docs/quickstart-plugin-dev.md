# Quickstart: Plugin Development

> **Target:** Developers building VaultOre  
> **Time:** 15-20 minutes  
> **Prerequisites:** Node.js 20+, Bun 1.3+, Docker

This guide walks you through setting up VaultOre for plugin development, building it, loading it in an Obsidian dev vault, and running a canonical fixture to verify everything works.

---

## 1. Prerequisites

### Required

- **Node.js 20+** — [Download](https://nodejs.org/)
- **Bun 1.3+** — [Install](https://bun.sh/)
- **Docker** — [Install Docker Desktop](https://www.docker.com/products/docker-desktop) or [Podman](https://podman.io/) or [Colima](https://github.com/abiosoft/colima) (macOS)

### Verify Installation

```bash
node --version   # Should be 20.x or higher
bun --version    # Should be 1.3.x or higher
docker --version  # Should show Docker/Podman/Colima
```

---

## 2. Clone and Install

```bash
# Clone the repository
git clone https://github.com/cronai-ug/vaultore.git
cd vaultore

# Install dependencies
bun install
```

This installs dependencies for all packages in the monorepo.

---

## 3. Build the Project

```bash
# Build all packages
bun run build

# Or build individually
bun run core:build        # Build @vaultore/core
bun run obsidian:build    # Build Obsidian plugin
```

Expected output: `dist/` folders in each package.

---

## 4. Package the Plugin (Recommended)

```bash
# Package the Obsidian plugin for easy copying
bun run obsidian:package
```

This creates a ready-to-copy plugin folder at:

```text
packages/obsidian/package/vaultore
```

It includes `main.js`, `manifest.json`, and `styles.css`.

---

## 5. Set Up Obsidian Dev Vault

### Option A: Create a Test Vault

1. Open Obsidian
2. Create a new vault (e.g., `~/vaultore-test-vault`)
3. Enable Developer Mode:
   - Settings → Community Plugins → Developer Mode (toggle ON)

### Option B: Use Existing Vault

If you have an existing vault, enable Developer Mode as above.

---

## 6. Load the Plugin in Obsidian

### Development Mode (Hot Reload)

```bash
# From the vaultore repo root
bun run obsidian:dev
```

This:

- Watches for changes
- Builds the plugin
- Copies it to your dev vault's `.obsidian/plugins/vaultore/`

### Manual Installation

If `obsidian:dev` isn't set up yet:

1. Build or package the plugin:

   ```bash
   bun run obsidian:package
   ```

2. Create plugin directory:

   ```bash
   mkdir -p ~/vaultore-test-vault/.obsidian/plugins/vaultore
   ```

3. Copy built files:

   ```bash
   cp -r packages/obsidian/package/vaultore/* ~/vaultore-test-vault/.obsidian/plugins/vaultore/
   ```

4. In Obsidian:

   - Settings → Community Plugins
   - Find "VaultOre" and toggle it ON

---

## 7. Configure VaultOre

1. Open Obsidian Settings → VaultOre
2. Ensure Obsidian 1.11.4+ for SecretStorage support
3. **Container Runtime:** Select Docker (or Podman/Colima if you prefer)
4. **Output Folder:** Default `_vaultore` (used for run outputs and artifacts)
5. **AI Provider (optional):** Add API keys if you want to test `ore:ai` cells:

   - OpenAI: Get key from [platform.openai.com](https://platform.openai.com)
   - Anthropic: Get key from [console.anthropic.com](https://console.anthropic.com)
6. **AI Defaults (optional):** Set Temperature and Max Tokens if you want explicit defaults

---

## 8. Run Your First Workflow

### Copy a Canonical Fixture

Copy a test workflow from `fixtures/canonical/` into your vault:

```bash
# Example: Copy hello-world workflow
cp fixtures/canonical/hello-world.md ~/vaultore-test-vault/Hello-World.md
```

### Run the Workflow

1. Open `Hello-World.md` in Obsidian
2. Place cursor in the note
3. Press **`Cmd+Shift+Enter`** (Mac) or **`Ctrl+Shift+Enter`** (Windows/Linux) to run all cells

Or use the command palette:

- **`Cmd+P`** (Mac) or **`Ctrl+P`** (Windows/Linux)
- Type "Run All" and select "VaultOre: Run All Cells"

### Expected Result

After a few seconds, you should see ore-output callouts appear below each cell:

````markdown
```ore:ts id=hello
const message = "Hello from VaultOre!";
message;
```

> [!ore-output] hello
> file: [[_vaultore/runs/hello-world/RUN_ID/hello.json]]
> run: RUN_ID
> status: success | duration: 0.12s | at: 2026-01-10T08:00:00Z
````

**Note:** Outputs are stored as JSON under `_vaultore/runs/...`. The callout links are clickable in Obsidian.

---

## 9. Troubleshooting

### Docker Not Running

**Error:** `Cannot connect to Docker daemon`

**Fix:**

- Start Docker Desktop
- Or verify Podman/Colima is running:

  ```bash
  podman ps    # Should not error
  # or
  colima status
  ```

### Plugin Not Loading

**Error:** Plugin doesn't appear in Community Plugins list

**Fix:**

1. Check `.obsidian/plugins/vaultore/manifest.json` exists
2. Verify `main.js` exists in the plugin directory
3. Reload Obsidian: `Cmd+R` (Mac) or `Ctrl+R` (Windows/Linux)
4. Check Developer Console: `Cmd+Option+I` (Mac) or `Ctrl+Shift+I` (Windows/Linux) for errors

### Secret Storage Not Available

**Error:** `VaultOre: Failed to save OpenAI key (Secret storage not available in this Obsidian version)`

**Fix:**

1. Update Obsidian to 1.11.4 or newer
2. Reload Obsidian after update

### Container Pull Fails

**Error:** `Unable to pull image oven/bun:1-alpine`

**Fix:**

- Ensure Docker has network access
- Manually pull: `docker pull oven/bun:1-alpine`
- Check Docker Desktop settings for proxy/network issues

### Permission Denied

**Error:** `Permission denied` when running cells

**Fix:**

1. Check workflow frontmatter `permissions:` section
2. If `network: ask` or `vaultWrite: ask`, approve the prompt
3. Verify Docker permissions: your user should be in the `docker` group (Linux) or have Docker Desktop access (Mac/Windows)

### Cell Execution Fails

**Error:** Cell shows `status: error` in output

**Fix:**

1. Check the ore-output callout for error details
2. Open Developer Console for runtime errors
3. Verify the cell syntax matches the [Workflow Note Spec](specs/workflow-note-spec.md)
4. For `ore:ts` cells, ensure code is valid JavaScript/TypeScript

---

## 9. Next Steps

### Run More Canonical Fixtures

Test different workflows:

```bash
# Copy all canonical fixtures
cp fixtures/canonical/*.md ~/vaultore-test-vault/

# Then run them in Obsidian
```

See [Testing Fixtures](testing-fixtures.md) for details on each fixture.

### Explore the Codebase

- **Core Engine:** `packages/core/src/` — Parser, executor, runtime
- **Specifications:** `specs/` — TDD anchors and format definitions
- **Architecture:** [ARCHITECTURE.md](../ARCHITECTURE.md) — System design

### Run Tests

```bash
# Unit tests
bun run test

# Integration tests
bun run test:integration

# Canonical fixture tests (requires Docker)
bun run test:canonical
```

---

## 10. Development Workflow

### Making Changes

1. Edit code in `packages/core/src/` or `packages/obsidian/src/`
2. Run `bun run build` (or `bun run obsidian:dev` for hot reload)
3. Reload Obsidian plugin: `Cmd+R` (Mac) or `Ctrl+R` (Windows/Linux)
4. Test with a canonical fixture

### Debugging

- **Obsidian Dev Console:** `Cmd+Option+I` (Mac) or `Ctrl+Shift+I` (Windows/Linux)
- **Container Logs:** Check Docker Desktop logs or `docker logs <container-id>`
- **Plugin Logs:** Check Obsidian console for VaultOre messages

---

## Quick Reference

| Task | Command |
| --- | --- |
| Install dependencies | `bun install` |
| Build all packages | `bun run build` |
| Build core only | `bun run core:build` |
| Build plugin only | `bun run obsidian:build` |
| Watch mode (dev) | `bun run obsidian:dev` |
| Run tests | `bun run test` |
| Run fixture tests | `bun run test:canonical` |

---

## Getting Help

- **Issues:** [GitHub Issues](https://github.com/cronai-ug/vaultore/issues)
- **Discussions:** [GitHub Discussions](https://github.com/cronai-ug/vaultore/discussions)
- **Documentation:** [docs/](index.md)

---

**Ready to build?** Start with the [Architecture Guide](ARCHITECTURE.md) or dive into the [PRD](PRD.md) for the full vision.
