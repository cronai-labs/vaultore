# VaultOre Product Requirements Document

> **Version:** 1.1.0  
> **Status:** Final  
> **Last Updated:** 2026-01-10  
> **Repository:** [github.com/cronai-ug/vaultore](https://github.com/cronai-ug/vaultore)  
> **npm Scope:** `@vaultore/*`

---

## Executive Summary

**VaultOre** is a Markdown-native notebook and workflow runner for Obsidian that enables AI-assisted automation through executable cells. It bridges the gap between static notes and dynamic automation by allowing AI to generate, execute, and iterate on multi-step pipelines safely within markdown files.

### One-Line Pitch

> A Markdown-native notebook + workflow runner for Obsidian that lets AI generate, execute, and iterate on multi-step pipelines safely, with shareable workflow notes and **time-triggered scheduling**.

### Core Differentiators

| Dimension | VaultOre | Others |
|-----------|----------|--------|
| **Data Source** | Your Obsidian vault (notes, links, tags) | Generic files or none |
| **Scheduling** | Time-triggered automation (CronAI) | Manual execution only |
| **Knowledge Graph** | Native Obsidian integration | None |
| **Workflow Format** | Markdown frontmatter (portable, git-friendly) | Custom DSLs or YAML configs |
| **Target User** | Knowledge workers | Developers |

### Design Principles

> **Treat workflows as first-class notes:**
> - Human-readable (Markdown)
> - LLM-readable (easy to generate/modify)
> - Git-friendly (diffs cleanly)
> - Obsidian-native (links, embeds, graph)

> **Time-triggered, not just task-triggered:**
> - "Every Monday at 9am, summarize my meeting notes"
> - "Daily at 6pm, generate my journal prompt"
> - True cron scheduling, not just reactive automation

> **Knowledge-first, not code-first:**
> - Your notes are the data source
> - Workflows mine value from your vault
> - Outputs become linkable knowledge artifacts

---

## 1. Vision & Objectives

### 1.1 Vision

Enable Obsidian users of all skill levels to build and run repeatable, shareable, and safe workflows within their vault — using notebook-style cells (code and AI) inside Markdown notes, with outputs saved back into those notes.

VaultOre aims to make automation and data processing in note-taking as natural as writing notes, treating automation scripts as part of the knowledge base.

### 1.2 Objectives

| Objective | Description |
|-----------|-------------|
| **Lower the barrier** | Allow everyday users to leverage AI and scripts through pre-built recipes |
| **Reproducible & Editable** | Provide notebook-like environment where each step is visible and re-runnable |
| **Obsidian-Integrated** | Local-first, plain text, integrated with linking and graph |
| **Safety & Transparency** | Sandboxed execution with full visibility into code and outputs |
| **Shareability** | Workflows as portable markdown files for community sharing |

---

## 2. Target Users

### 2.1 User Segments

| Segment | Description | Primary Need |
|---------|-------------|--------------|
| **Everyday Users** | Non-programmers wanting automation | Run pre-built recipes, minimal setup |
| **Semi-Technical** | Can tweak prompts and variables | Customize workflows, light scripting |
| **Power Users/Devs** | Want TS/shell/Git integration | Build complex pipelines, contribute |

### 2.2 User Stories

**As an everyday user:**
- I want to run a pre-made workflow to summarize my reading list
- I want to see what the automation did without understanding code

**As a semi-technical user:**
- I want to modify a workflow's prompts to fit my use case
- I want to combine two workflows into a larger pipeline

**As a power user:**
- I want to write TypeScript to process data from APIs
- I want to version control my workflows with Git
- I want to contribute workflows to the community

---

## 3. Use Cases

### 3.1 Primary Use Case: Link Digest Pipeline

The killer use case that validates the platform:

1. User has a note with collected URLs (articles to read)
2. VaultOre fetches content from each URL (TypeScript cell)
3. AI summarizes and extracts themes (AI cell)
4. Creates atomic notes with summaries and backlinks (TypeScript cell)

**This validates:** Input handling, HTTP requests, AI integration, output persistence, vault writing.

### 3.2 Secondary Use Cases

| Use Case | Description | Features Exercised |
|----------|-------------|-------------------|
| Data Pipeline | Shell fetches API data → AI formats → notes updated | Shell + AI + vault write |
| Interactive Exploration | REPL-style prompt iteration | Fast iteration, branching |
| Scheduled Maintenance | Daily/weekly vault housekeeping | Scheduling, vault read/write |
| System Monitoring | Collect metrics → aggregate → dashboard | Shell + Go + artifacts |

---

## 4. Core Features

### 4.1 MVP Features (v0.1)

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

### 4.2 v0.2 Features (Notebooks That Don't Rot)

| Feature | Description |
|---------|-------------|
| Python Runtime | `ore:py` cells |
| Dependency Graph | Cell dependency tracking |
| Staleness Detection | Know which cells need re-run |
| "Run Affected" | Only run changed cells |
| Warm Container Pool | Faster execution |

### 4.3 v0.3 Features (Go + Exploration)

| Feature | Description |
|---------|-------------|
| Go Runtime | `ore:go` compiled cells with caching |
| Branching | Fork workflow runs |
| Branch UI | Visual management |
| Branch Diff | Compare outputs |

### 4.4 v0.4 Features (Automation)

| Feature | Description |
|---------|-------------|
| CLI Runner | Headless execution |
| CronAI Integration | Cloud scheduling |
| Event Triggers | File change, webhook |

### 4.5 v0.5 Features (Portability)

| Feature | Description |
|---------|-------------|
| VS Code Extension | Same core, VS Code UI |
| Zed Extension | Same core, Zed UI |
| LSP Support | Syntax highlighting, completion |

---

## 5. Technical Architecture

### 5.1 High-Level Design

```
┌─────────────────────────────────────────────────────────────────┐
│                     VaultOre Plugin (TypeScript)                │
├──────────────┬──────────────┬──────────────┬───────────────────┤
│   Workflow   │     Cell     │  Scheduler   │     Settings      │
│    Parser    │   Executor   │   Engine     │     Manager       │
└──────┬───────┴──────┬───────┴──────┬───────┴─────────┬─────────┘
       │              │              │                 │
       ▼              ▼              ▼                 ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│  Obsidian   │ │  Container  │ │  node-cron  │ │ AI Provider │
│  Vault API  │ │   Runtime   │ │             │ │    APIs     │
└─────────────┘ └──────┬──────┘ └─────────────┘ └─────────────┘
                       │
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│   Docker    │ │   Podman    │ │   Colima    │
└─────────────┘ └─────────────┘ └─────────────┘
```

### 5.2 Monorepo Structure

```
vaultore/
├── packages/
│   ├── core/        # @vaultore/core - Editor-agnostic
│   ├── obsidian/    # Obsidian plugin
│   ├── vscode/      # VS Code extension (future)
│   └── cli/         # Standalone CLI (future)
├── containers/      # Runtime images
├── specs/           # Specifications
├── fixtures/        # Test workflows
└── docs/            # Documentation
```

### 5.3 Core Principles

| Principle | Implementation |
|-----------|----------------|
| Core-First | All logic in `@vaultore/core` |
| Editor-Thin | Plugins are thin wrappers |
| Portable | Same core for all editors |
| Offline-First | Works without network |

---

## 6. Security Model

### 6.1 Sandbox Architecture

- All code runs in Docker containers
- No host execution fallback
- Network disabled by default
- Non-root user execution
- Resource limits enforced

### 6.2 Permission System

| Permission | Default | Description |
|------------|---------|-------------|
| `network` | `deny` | Runtime network access |
| `vaultRead` | `allow` | Read vault notes |
| `vaultWrite` | `deny` | Write vault notes |
| `buildNetwork` | `ask` | Build-time network |

### 6.3 Container Configuration

```bash
docker run \
  --rm \
  --network=none \
  --memory=512m \
  --cpus=1 \
  --user=1000:1000 \
  --read-only \
  $IMAGE $COMMAND
```

---

## 7. Workflow Format

### 7.1 Frontmatter

```yaml
---
ore: true
name: My Workflow
version: 0.1

runtime:
  engine: docker
  image: oven/bun:1-alpine

permissions:
  network: ask
  vaultWrite: ask
  vaultRead: allow

schedule: "0 9 * * 1-5"
---
```

### 7.2 Cell Types

| Type | Syntax | Description |
|------|--------|-------------|
| TypeScript | `ore:ts` | Bun/Node.js execution |
| Shell | `ore:shell` | Bash commands |
| AI | `ore:ai` | LLM completion |
| Python | `ore:py` | Python 3 (v0.2) |
| Go | `ore:go` | Compiled Go (v0.3) |

### 7.3 Cell Attributes

```markdown
```ore:ts id=fetch depends=[config] timeout=120
// code
```
```

### 7.4 Output Format

```markdown
> [!ore-output] fetch
> view: [[_vaultore/runs/my-workflow/RUN_ID/fetch.md]]
> json: [[_vaultore/runs/my-workflow/RUN_ID/fetch.json]]
> run: RUN_ID
> status: success | duration: 1.2s | at: 2026-01-09T08:00:00Z
```

---

## 8. Runtime Strategy

### 8.1 Language Positioning

| Language | Role | Use Case |
|----------|------|----------|
| TypeScript | Orchestration | APIs, glue, iteration |
| Shell | System access | Files, CLI tools |
| Go | Performance | Heavy transforms, caching |
| Python | Data science | Analytics, visualization |

### 8.2 Container Images

| Image | Size | Cold Start | Purpose |
|-------|------|------------|---------|
| bun-base | ~80MB | <100ms | TypeScript |
| shell-base | ~50MB | <50ms | Shell |
| python-base | ~150MB | <200ms | Python |
| go-builder | ~250MB | <300ms | Go build |

### 8.3 Warm Container Pool (v0.2)

- Pre-start containers on plugin load
- Reuse via `docker exec`
- Reset state between runs
- Near-instant execution

---

## 9. Success Metrics

### 9.1 MVP Success (Week 1)

| Metric | Target |
|--------|--------|
| Functional completeness | 100% of MVP features |
| Link Digest pipeline | Works end-to-end |
| Setup success rate | >80% with Docker |
| Crash rate | 0 during normal use |

### 9.2 6-Month Success

| Metric | Target |
|--------|--------|
| GitHub stars | 1,000+ |
| Community plugins list | Listed |
| Community workflows | 10+ contributed |
| Discord activity | 100+ weekly active |
| CronAI integration | Beta users |

---

## 10. Risk Matrix

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Docker not installed | High | High | Clear docs; cloud fallback (v0.4) |
| Plugin review delays | Medium | Medium | Security docs; early engagement |
| Security vulnerabilities | Medium | High | Container isolation; no network default |
| Competition | Medium | Medium | Differentiate on execution + offline |
| Scope creep | High | Medium | Strict MVP scope; backlog |

---

## 11. Development Timeline

### 11.1 Week 1: MVP Sprint

| Day | Focus | Deliverable |
|-----|-------|-------------|
| 1-2 | Execution backbone | TS + shell cells execute |
| 3 | AI integration | AI cells work |
| 4 | Workflow features | Run All, templates |
| 5 | Scheduling + status | Cron, sidebar |
| 6-7 | Polish + examples | Error handling, docs |

### 11.2 Post-MVP

| Version | Timeline | Theme |
|---------|----------|-------|
| v0.2 | Month 1-2 | Python, DAG, staleness |
| v0.3 | Month 2-3 | Go, branching |
| v0.4 | Month 3-4 | CLI, cloud, triggers |
| v0.5 | Month 4-6 | VS Code, Zed, LSP |

---

## 12. OSS & Business Strategy

### 12.1 Open Source Model

| Component | License |
|-----------|---------|
| VaultOre Core | MIT |
| Example Workflows | CC0 |
| CronAI Integration | Proprietary |

### 12.2 CronAI Synergy

| Tier | Price | Features |
|------|-------|----------|
| Free | $0 | Full local functionality |
| Pro | $10-15/mo | Cloud execution, true scheduling |
| Team | $25+/seat | Shared workflows, RBAC, audit |

---

## 13. Competitive Analysis

### 13.1 Obsidian AI Plugins

| Plugin | Stars | What It Does | Gap |
|--------|-------|--------------|-----|
| Copilot | 5.6k | Chat, QA, Agent Mode | No code execution |
| Smart Connections | 4.3k | Semantic search | Basic chat, no workflows |
| Text Generator | 1.8k | Template prompting | No RAG, no agents |
| JupyMD | — | Jupyter editing | No AI integration |

### 13.2 AI Orchestration Tools

| Tool | Platform | Strengths | VaultOre Advantage |
|------|----------|-----------|-------------------|
| **OpenProse** | Claude Code plugin | Explicit control flow DSL, semantic conditions | Obsidian-native, time-triggered, knowledge graph |
| **LangChain** | Python library | Ecosystem, composability | No scheduling, developer-only |
| **CrewAI** | Python framework | Multi-agent patterns | Heavy, no note integration |
| **n8n/Zapier** | Web apps | Visual builder, integrations | Not knowledge-native, cloud-dependent |

### 13.3 OpenProse Deep Comparison

OpenProse introduced valuable concepts we adopt and improve:

| Concept | OpenProse | VaultOre Adaptation |
|---------|-----------|---------------------|
| **Semantic conditions** | `**condition**` syntax | `when:` clause with `{{ai: condition}}` |
| **Control flow** | Explicit `loop`, `parallel` | Implicit via `depends[]`, explicit in v0.2+ |
| **Runtime** | Claude Code sessions | Docker containers (portable) |
| **Data source** | Whatever Claude sees | Your vault (structured knowledge) |
| **Scheduling** | None | Native cron + CronAI cloud |

**Key Insight:** OpenProse is for developers orchestrating AI coding agents. VaultOre is for knowledge workers automating their Obsidian vault. Different problems, complementary solutions.

### 13.4 Strategic Positioning

```
                    Developer-Focused
                          ▲
                          │
        OpenProse ●       │
                          │
    ──────────────────────┼────────────────────── Manual ◄──► Scheduled
                          │
                          │       ● VaultOre
                          │
                          ▼
                    Knowledge-Worker-Focused
```

**VaultOre's moat:**
1. **Time-triggered** — true scheduling, not just reactive
2. **Obsidian-native** — vault as structured data source
3. **Knowledge-first** — outputs become linked notes
4. **CronAI synergy** — clear path to cloud monetization

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| Workflow | A markdown file with `ore: true` frontmatter |
| Cell | An executable code block (`ore:*`) |
| Output | Result of cell execution (ore-output callout + JSON) |
| Warm Container | Pre-started container for fast execution |
| DAG | Directed Acyclic Graph of cell dependencies |

---

## Appendix B: References

- [Workflow Note Specification](specs/workflow-note-spec.md)
- [Permissions Specification](specs/permissions-spec.md)
- [Go Cell Specification](specs/go-cell-spec.md)
- [Architecture Document](ARCHITECTURE.md)
