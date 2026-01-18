# VaultOre Roadmap

> **Last Updated:** 2026-01-10  
> **Status:** Active Development

This roadmap outlines VaultOre's evolution from MVP to a full-featured automation platform. Each version builds on the previous without breaking changes, following the "brick-by-brick" philosophy.

---

## Version Timeline

| Version | Theme | Timeline | Status |
|---------|-------|----------|--------|
| **v0.1** | MVP | Week 1 | 🚧 In Progress |
| v0.2 | Notebooks That Don't Rot | Month 1-2 | 📋 Planned |
| v0.3 | Go + Control Flow | Month 2-3 | 📋 Planned |
| v0.4 | Automation | Month 3-4 | 📋 Planned |
| v0.5 | Portability | Month 4-6 | 📋 Planned |

---

## v0.1: MVP (Week 1)

**Goal:** Core functionality to validate the platform with the Link Digest Pipeline.

### Features

| Feature | Description | Priority |
|---------|-------------|----------|
| Workflow Parser | Parse frontmatter and `ore:*` cells | P0 |
| TypeScript Execution | Execute `ore:ts` in Bun container | P0 |
| Shell Execution | Execute `ore:shell` in Alpine container | P0 |
| AI Integration | `ore:ai` with OpenAI/Anthropic | P0 |
| Output Persistence | ore-output callouts + JSON runs | P0 |
| Run Controls | Run Cell, Run All commands | P0 |
| Settings UI | API keys, runtime selection | P0 |
| Basic Scheduling | Cron in frontmatter | P1 |

### Success Criteria

- ✅ Link Digest Pipeline runs end-to-end
- ✅ All canonical fixtures pass
- ✅ Setup success rate >80% with Docker
- ✅ Zero crashes during normal use

### Out of Scope (Explicitly)

- ❌ Python runtime (`ore:py`) — v0.2
- ❌ Go runtime (`ore:go`) — v0.3
- ❌ Dependency graph auto-run — v0.2
- ❌ Branching UI — v0.3
- ❌ Visual workflow builder — v0.4+
- ❌ Cloud execution — v0.4

---

## v0.2: Notebooks That Don't Rot (Month 1-2)

**Goal:** Make workflows efficient and maintainable over time.

### Features

| Feature | Description |
|---------|-------------|
| Python Runtime | `ore:py` cell execution in Python container |
| Dependency Graph | Cell dependency tracking and visualization |
| Staleness Detection | Know which cells need re-run based on input changes |
| "Run Affected" | Only run stale cells, skip up-to-date ones |
| Warm Container Pool | Pre-started containers for near-instant execution |
| Semantic Conditions | `when` attribute with `{{ai: condition}}` |
| Workflow-Level `runIf` | Skip entire workflow if condition fails |
| Implicit Parallel | Auto-parallelize independent cells |

### Key Improvements

- **Performance:** Warm containers reduce startup time from ~100ms to <10ms
- **Efficiency:** Staleness detection prevents unnecessary re-runs
- **Intelligence:** Semantic conditions enable smart filtering

---

## v0.3: Go + Control Flow (Month 2-3)

**Goal:** Add compiled tools lane and explicit control flow.

### Features

| Feature | Description |
|---------|-------------|
| Go Runtime | `ore:go` compiled cells with caching |
| Go Build Caching | Cache compiled binaries keyed on source + deps |
| Control Blocks | Explicit `loop:`, `parallel:` blocks in frontmatter |
| Loop Execution | Iterative refinement with `until` and `max` |
| Loop Context | `{{loop.iteration}}`, `{{cell.previous}}` variables |
| Branching Data Model | Fork workflow runs for exploration |
| Branch UI | Visual branch management |
| Branch Diff View | Compare outputs across branches |

### Go Positioning

**Go is not a replacement for TS/Bun** — it's a complementary "compiled tools" lane:

- **TS/Bun:** Orchestration, interactive notebooks, rapid iteration
- **Go:** Fast, cached steps for stable tooling (parsers, transforms, heavy compute)
- **Python:** Data science, analytics, visualization

**Best model:** TS orchestrates; Go accelerates stable hot-path steps.

See [Go Cell Specification](../specs/go-cell-spec.md) for details.

---

## v0.4: Automation (Month 3-4)

**Goal:** True automation with cloud execution and event triggers.

### Features

| Feature | Description |
|---------|-------------|
| CLI Runner | Headless execution from command line |
| CronAI Cloud Integration | Cloud execution for true background scheduling |
| Event Triggers | File change, webhook, email triggers |
| Workflow Templates | Pre-built workflow recipes |
| Workflow Gallery | Community-shared workflows |

### CronAI Synergy

| Tier | Price | Features |
|------|-------|----------|
| Free | $0 | Full local functionality |
| Pro | $10-15/mo | Cloud execution, true scheduling |
| Team | $25+/seat | Shared workflows, RBAC, audit |

---

## v0.5: Portability (Month 4-6)

**Goal:** Expand beyond Obsidian to other editors.

### Features

| Feature | Description |
|---------|-------------|
| VS Code Extension | Same core, VS Code UI |
| Zed Extension | Same core, Zed UI |
| Language Server Protocol | Syntax highlighting, completion, validation |
| Workflow Hub | Community workflow exchange |

### Core-First Architecture

All editor integrations use the same `@vaultore/core`:

```
@vaultore/core (editor-agnostic)
    ├── @vaultore/obsidian (Obsidian plugin)
    ├── @vaultore/vscode (VS Code extension)
    ├── @vaultore/zed (Zed extension)
    └── @vaultore/cli (Standalone CLI)
```

---

## Control Flow Evolution

VaultOre follows a "brick-by-brick" approach to control flow:

| Version | Control Flow | Breaking Changes |
|---------|--------------|------------------|
| v0.1 | `depends[]` only | — |
| v0.2 | `depends[]` + implicit parallel + `when` conditions | None |
| v0.3 | `depends[]` + `control:` blocks (loop, parallel) | None (additive) |

**Key principle:** Each feature adds capability without requiring rewrites.

---

## Future Considerations (Post-v0.5)

- **WASM Compilation:** Compile Go cells to WASM for browser execution
- **Distributed Cache:** Shared build cache across team/cloud
- **Workflow Versioning:** Git-like branching for workflow evolution
- **Visual Editor:** Drag-and-drop workflow builder (optional)
- **Mobile Support:** Limited execution on mobile (likely not feasible due to Docker requirement)

---

## Success Metrics

### MVP (v0.1)

- Functional completeness: 100% of MVP features
- Link Digest pipeline: Works end-to-end
- Setup success rate: >80% with Docker
- Crash rate: 0 during normal use

### 6-Month (v0.5)

- GitHub stars: 1,000+
- Community plugins list: Listed
- Community workflows: 10+ contributed
- Discord activity: 100+ weekly active
- CronAI integration: Beta users

---

## Contributing to the Roadmap

The roadmap is a living document. To propose changes:

1. Open a [discussion](https://github.com/cronai-ug/vaultore/discussions) with the `roadmap` tag
2. Reference this document
3. Explain the rationale and impact

---

**Questions?** See the [PRD](PRD.md) for detailed requirements or open an [issue](https://github.com/cronai-ug/vaultore/issues).
