# VaultOre Architecture

> **Version:** 0.2.0  
> **Status:** Pre-MVP  
> **Last Updated:** 2026-01-10  
> **Repository:** [github.com/cronai-ug/vaultore](https://github.com/cronai-ug/vaultore)  
> **npm Scope:** `@vaultore/*`

## Design Principles

1. **Brick by Brick**: Each feature is a self-contained module that can be developed, tested, and shipped independently
2. **Core-First**: All logic lives in `@vaultore/core`; editor integrations are thin wrappers
3. **Portable**: Same core powers Obsidian, VS Code, Zed, and CLI
4. **Offline-First**: Everything works locally; cloud features are additive
5. **TDD-Driven**: Canonical workflows serve as acceptance tests
6. **Knowledge-First**: Your vault is the data source, not just a storage location
7. **Time-Triggered**: True scheduling, not just reactive automation

## Monorepo Structure

```
vaultore/
├── packages/
│   ├── core/                    # @vaultore/core - The brain
│   │   ├── src/
│   │   │   ├── parser/          # Workflow note parsing
│   │   │   ├── executor/        # Cell execution engine
│   │   │   ├── runtime/         # Container management
│   │   │   ├── scheduler/       # Cron scheduling
│   │   │   ├── providers/       # AI provider integrations
│   │   │   ├── vault/           # Vault API abstraction
│   │   │   └── types/           # Shared TypeScript types
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── obsidian/                # Obsidian plugin wrapper
│   │   ├── src/
│   │   │   ├── main.ts          # Plugin entry point
│   │   │   ├── adapter.ts       # PlatformAdapter implementation
│   │   │   ├── views/           # UI components
│   │   │   ├── commands/        # Command palette integration
│   │   │   └── settings/        # Settings tab
│   │   ├── manifest.json
│   │   └── styles.css
│   │
│   ├── vscode/                  # VS Code extension (v0.5+)
│   │   └── ...
│   │
│   ├── zed/                     # Zed extension (v0.5+)
│   │   └── ...
│   │
│   └── cli/                     # Standalone CLI (v0.4+)
│       └── ...
│
├── containers/                   # Runtime container definitions
│   ├── bun-base/                # Base Bun runtime (TS)
│   ├── bun-fetch/               # Bun + fetch utilities
│   ├── shell-base/              # Shell-only runtime
│   ├── python-base/             # Python runtime (v0.2)
│   └── go-builder/              # Go build + run (v0.3)
│
├── specs/                       # Specifications (TDD anchors)
│   ├── workflow-note-spec.md    # Workflow format v0.1
│   ├── cell-types-spec.md       # Cell type definitions
│   ├── go-cell-spec.md          # Go cell spec (v0.3)
│   ├── permissions-spec.md      # Security model
│   └── caching-spec.md          # Build/run caching
│
├── fixtures/                    # Canonical test workflows
│   ├── canonical/
│   │   ├── hello-world.md       # Minimal smoke test
│   │   ├── link-digest.md       # Primary use case
│   │   ├── daily-summary.md     # Scheduling test
│   │   ├── smart-inbox.md       # Semantic conditions test
│   │   ├── sys-snapshot.md      # Shell + Go integration
│   │   └── proc-snapshot.md     # Process aggregation
│   └── unit/
│       ├── parser/              # Parser test cases
│       ├── executor/            # Executor test cases
│       └── runtime/             # Runtime test cases
│
├── docs/                        # User documentation
│   ├── getting-started.md
│   ├── workflow-guide.md
│   ├── api-reference.md
│   └── security.md
│
├── turbo.json                   # Turborepo config
├── pnpm-workspace.yaml          # pnpm workspace
└── package.json                 # Root package.json
```

## Module Dependency Graph

```
                    ┌─────────────────┐
                    │  @vaultore/core │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│    obsidian     │ │     vscode      │ │       cli       │
│    plugin       │ │   extension     │ │                 │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

## Brick-by-Brick Roadmap

Each "brick" is a self-contained PR that adds one capability.  
Bricks are numbered by version: `BRICK-0XX` = v0.1, `BRICK-2XX` = v0.2, etc.

### v0.1 Bricks (MVP) — Week 1

| Brick | Name | Description | Acceptance Criteria |
|-------|------|-------------|---------------------|
| BRICK-001 | Project scaffolding | Monorepo, build system, CI | `pnpm build` succeeds |
| BRICK-002 | Workflow parser | Parse frontmatter + cells | Parses `hello-world.md` |
| BRICK-003 | Runtime detection | Detect Docker/Podman/Colima | Returns available engines |
| BRICK-004 | Bun executor | Execute `ore:ts` cells | Runs TS, captures output |
| BRICK-005 | Shell executor | Execute `ore:shell` cells | Runs shell, captures output |
| BRICK-006 | Output persistence | Write ore-output callouts + JSON | Outputs survive reload |
| BRICK-007 | AI provider abstraction | Provider interface | Interface defined |
| BRICK-008 | OpenAI provider | OpenAI API integration | Completes prompts |
| BRICK-009 | Anthropic provider | Anthropic API integration | Completes prompts |
| BRICK-010 | Obsidian plugin shell | Basic plugin structure | Loads in Obsidian |
| BRICK-011 | Run Cell command | Execute cell at cursor | `Cmd+Enter` works |
| BRICK-012 | Run All command | Execute all cells | `Cmd+Shift+Enter` works |
| BRICK-013 | Settings UI | API keys, runtime selection | Settings persist |
| BRICK-014 | Status sidebar | Show execution status | Displays runs |
| BRICK-015 | Template interpolation | `{{cellId}}`, `{{note:path}}` | Variables resolve |
| BRICK-016 | Basic scheduling | Cron in frontmatter | Triggers when due |

### v0.2 Bricks (Notebooks That Don't Rot) — Month 1-2

| Brick | Name | Description |
|-------|------|-------------|
| BRICK-020 | Cell dependency parser | Extract `depends=[...]` |
| BRICK-021 | DAG builder | Build execution graph |
| BRICK-022 | Staleness detection | Track input changes |
| BRICK-023 | "Run Affected" command | Only run stale cells |
| BRICK-024 | Python executor | `ore:py` cells |
| BRICK-025 | Warm container pool | Reuse containers |
| BRICK-026 | Vault API helpers | `vault.read()`, `vault.write()`, `cell()` |
| BRICK-027 | Semantic conditions | `when` attribute with `{{ai: condition}}` |
| BRICK-028 | Workflow-level runIf | `runIf` in frontmatter |
| BRICK-029 | Implicit parallel | Auto-parallelize independent cells |

### v0.3 Bricks (Go + Control Flow) — Month 2-3

| Brick | Name | Description |
|-------|------|-------------|
| BRICK-030 | Go cell spec | `ore:go` cell type |
| BRICK-031 | Go build caching | Cache compiled binaries |
| BRICK-032 | Go executor | Build + run Go cells |
| BRICK-033 | Control blocks parser | Parse `control:` in frontmatter |
| BRICK-034 | Loop execution | `loop:` with `until` and `max` |
| BRICK-035 | Loop iteration context | `{{loop.iteration}}`, `{{cell.previous}}` |
| BRICK-036 | Branching data model | Fork workflow runs |
| BRICK-037 | Branch UI | Visual branch management |
| BRICK-038 | Branch diff view | Compare branch outputs |

### v0.4 Bricks (Automation) — Month 3-4

| Brick | Name | Description |
|-------|------|-------------|
| BRICK-040 | Scheduler engine | Production scheduler |
| BRICK-041 | CLI runner | Headless execution |
| BRICK-042 | CronAI cloud executor | Cloud execution option |
| BRICK-043 | Event triggers | File change, webhook |

### v0.5 Bricks (Portability) — Month 4-6

| Brick | Name | Description |
|-------|------|-------------|
| BRICK-050 | VS Code extension shell | Basic extension |
| BRICK-051 | Zed extension shell | Basic extension |
| BRICK-052 | Language Server Protocol | Syntax support |

---

## Container Strategy

### Base Images (v0.1)

| Image | Purpose | Size | Cold Start |
|-------|---------|------|------------|
| `vaultore/bun-base` | TypeScript cells | ~80MB | <100ms |
| `vaultore/bun-fetch` | TS + HTTP client | ~85MB | <100ms |
| `vaultore/shell-base` | Shell cells | ~50MB | <50ms |

### Future Images (v0.2+)

| Image | Purpose | Size | Cold Start |
|-------|---------|------|------------|
| `vaultore/python-base` | Python cells | ~150MB | <200ms |
| `vaultore/go-builder` | Go compile + run | ~250MB | <300ms (build) |

### Warm Container Pool (v0.2)

Instead of `docker run` per cell, we:
1. On plugin load: Start 1-2 "warm" containers per runtime type
2. On cell execution: `docker exec` into warm container
3. On workflow complete: Reset container state (clear /tmp, reset env)
4. On plugin unload: Stop warm containers

This gives Devcontainer-like performance without the complexity.

---

## Parallel Execution (Open Design)

Parallel cell execution is **not enabled in v0.1**. We run cells sequentially to keep behavior predictable and resource use bounded. The v0.2 roadmap introduces implicit parallelism for independent cells, but it must be gated by explicit budgets and safety rules.

### Constraints & Edge Cases

- **CPU/Mem Budget:** Avoid saturating the machine; limit total container CPU + memory.
- **Runtime Mixing:** TS, shell, and AI containers have different profiles; concurrency should be per-runtime and global.
- **Dependency DAG:** Only parallelize cells with no shared dependencies.
- **Vault Writes:** Avoid write collisions; serialize writes or scope to separate paths.
- **Network Load:** Cap concurrent AI calls to avoid rate limits or provider bans.
- **User Experience:** Keep UI responsive; expose a pause/cancel control.

### Proposed Settings (v0.2+)

- `maxParallelCells` (global)
- `maxParallelPerRuntime` (ts/shell/ai)
- `cpuBudget` (e.g., 2.0 cores)
- `memoryBudget` (e.g., 2GB)
- `maxConcurrentAI` (per provider)

### Implementation Sketch

1. Build DAG from `depends[]`
2. Queue ready nodes by runtime
3. Dispatch with a resource-aware scheduler
4. Track running cells, release budget on completion
5. Fail fast or continue depending on user preference

---

## Runtime Helpers

VaultOre provides these helpers inside `ore:ts` cells:

```typescript
// Read a note from the vault
const content = await vault.read("Path/To/Note.md");

// Write a note to the vault
await vault.write("Path/To/Output.md", content);

// Check if a note exists
const exists = await vault.exists("Path/To/Note.md");

// Create directories
await vault.mkdirp("Path/To/Folder");

// Get parsed output of another cell
const data = cell("other-cell-id");

// Read raw container paths (for /proc, etc.)
const meminfo = await vault.readRaw("/proc/meminfo");
```

---

## Security Model

### Container Isolation

```dockerfile
# All containers run with:
# --network=none (unless permissions.network: allow)
# --read-only (except /tmp and /workspace)
# --memory=512m
# --cpus=1
# --user=1000:1000 (non-root)
```

### Permission Layers

| Permission | Default | Scope |
|------------|---------|-------|
| `network` | `deny` | Runtime network access |
| `buildNetwork` | `ask` | Network during Go/Python builds |
| `vaultRead` | `allow` | Read notes in vault |
| `vaultWrite` | `ask` | Write/create notes |

### Permission Prompts

Before first run of a workflow with elevated permissions:
1. Parse `permissions:` from frontmatter
2. If any permission is `ask`, show confirmation dialog
3. Store user decision (per-workflow, not global)
4. On subsequent runs, use stored decision

---

## Go Runtime (v0.3) — Design Preview

Go cells provide a "compiled tools" lane with caching and repeatability.

### Execution Model

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  ore:go     │ ──► │   Build     │ ──► │    Run      │
│  source     │     │  (cached)   │     │  (sandbox)  │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                    ┌──────┴──────┐
                    │ Cache Key   │
                    │ = hash(src  │
                    │   + go.mod  │
                    │   + flags)  │
                    └─────────────┘
```

### Cache Key Components

- Go source of the cell
- `go.mod` + `go.sum` (resolved modules)
- Go version
- Build flags (cgo, tags, ldflags)
- Target platform (GOOS/GOARCH)
- Builder image digest

### Interop Pattern

```
TS orchestrates → Go accelerates → Python visualizes
     │                  │                 │
     │    JSON/stdin    │    JSON/stdout  │
     └──────────────────┴─────────────────┘
```

---

## TDD Approach

### Canonical Fixtures as Tests

Each fixture in `fixtures/canonical/` serves as an acceptance test:

| Fixture | Tests | Pass Criteria |
|---------|-------|---------------|
| `hello-world.md` | Parser, TS executor | Output appears |
| `link-digest.md` | Full pipeline, AI | Creates digest note |
| `daily-summary.md` | Scheduling | Runs at scheduled time |
| `smart-inbox.md` | Semantic conditions | Conditional cells work |
| `sys-snapshot.md` | Shell + Go | Artifacts created |

### Test Pyramid

```
           ┌─────────────────┐
           │  Canonical      │  ← End-to-end
           │  Fixtures       │
           └────────┬────────┘
                    │
         ┌──────────┴──────────┐
         │  Integration Tests  │  ← Module combos
         └──────────┬──────────┘
                    │
    ┌───────────────┴───────────────┐
    │        Unit Tests             │  ← Functions
    └───────────────────────────────┘
```

### Running Tests

```bash
# Unit tests
pnpm test

# Integration tests
pnpm test:integration

# Canonical fixture tests (requires Docker)
pnpm test:canonical
```
