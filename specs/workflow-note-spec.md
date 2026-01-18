# Workflow Note Specification v0.2

> **Status:** Canonical  
> **Version:** 0.2.0  
> **Last Updated:** 2026-01-10  
> **Repository:** [github.com/cronai-ug/vaultore](https://github.com/cronai-ug/vaultore)

## Overview

A VaultOre "workflow" is a markdown file in the vault that contains executable cells. This specification defines the format, syntax, and semantics.

## 1. File Structure

A workflow note has two parts:
1. **YAML Frontmatter** — Metadata and configuration
2. **Markdown Body** — Content with embedded `ore:*` cells

````markdown
---
ore: true
name: My Workflow
...
---

# My Workflow

Description and documentation.

```ore:ts id=step1
// Code here
```

> [!ore-output] step1
> view: [[_vaultore/runs/my-workflow/RUN_ID/step1.md]]
> json: [[_vaultore/runs/my-workflow/RUN_ID/step1.json]]
> run: RUN_ID
> status: success | duration: 0.12s | at: 2026-01-09T08:00:00Z
````

---

## 2. Frontmatter Schema

### 2.1 Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `ore` | `true` | **Required.** Marks this note as a workflow. |
| `name` | `string` | **Required.** Human-readable workflow name. |

### 2.2 Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `version` | `string` | `"0.1"` | Semantic version of the workflow |
| `author` | `string` | — | Creator's name |
| `tags` | `string[]` | `[]` | Tags for categorization |
| `description` | `string` | — | Longer description |
| `runIf` | `string` | — | Semantic condition for workflow execution (v0.2+) |

### 2.3 Runtime Configuration

```yaml
runtime:
  engine: docker           # docker | podman | colima
  image: oven/bun:1-alpine # Default container image
  timeout: 60              # Default timeout per cell (seconds)
  memoryLimit: "512m"      # Container memory limit
  cpuLimit: 1              # Container CPU limit
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `runtime.engine` | `string` | `"docker"` | Container runtime |
| `runtime.image` | `string` | `"oven/bun:1-alpine"` | Default image for TS |
| `runtime.timeout` | `number` | `60` | Seconds per cell |
| `runtime.memoryLimit` | `string` | `"512m"` | Memory limit |
| `runtime.cpuLimit` | `number` | `1` | CPU limit |

### 2.4 Permissions

```yaml
permissions:
  network: ask          # allow | deny | ask
  vaultWrite: ask       # allow | deny | ask
  vaultRead: allow      # allow | deny | ask
  buildNetwork: ask     # allow | deny | ask (for Go/Python builds)
```

| Permission | Default | Description |
|------------|---------|-------------|
| `network` | `deny` | Runtime network access |
| `buildNetwork` | `ask` | Network during builds (Go modules, pip) |
| `vaultRead` | `allow` | Read notes from vault |
| `vaultWrite` | `deny` | Write/create notes |

### 2.5 Scheduling

```yaml
schedule: "0 9 * * 1-5"  # Cron expression
```

Standard 5-field cron syntax. Workflow runs when Obsidian is open and the time matches.

### 2.6 Semantic Conditions (v0.2+)

VaultOre supports AI-evaluated conditions using the `{{ai: condition}}` syntax. This allows dynamic workflow behavior based on content understanding.

```yaml
# Run only if condition is met
runIf: "{{ai: the inbox has more than 5 unprocessed items}}"

# Skip weekends intelligently
runIf: "{{ai: today is a workday and there are pending tasks}}"
```

#### Condition Evaluation

1. Conditions are evaluated **before** any cells run
2. The AI receives the condition text + relevant context (referenced notes)
3. AI returns `true` or `false`
4. If `false`, the workflow is skipped (logged, not errored)

#### Cell-Level Conditions

Individual cells can also have conditions:

````markdown
```ore:ai id=summarize when="{{ai: the content is longer than 500 words}}"
Summarize this content: {{fetch}}
```
````

#### Condition Context

Conditions can reference:
- `{{note:path}}` — content of a note
- `{{cellId}}` — output of a prior cell
- `{{meta:date}}` — current date/time
- `{{meta:vault}}` — vault metadata

### 2.7 Go Configuration (v0.3+, Future)

> **Status:** Planned for v0.3. See [Go Cell Specification](go-cell-spec.md) for complete details.

```yaml
go:
  version: "1.23"
  builderImage: "ghcr.io/vaultore/go-builder:1.23"
  cgo: 0
  tags: ""
  ldflags: "-s -w"
  cache:
    enabled: true
    dir: ".vaultore/cache/go"
```

**Note:** Go support is not part of the MVP (v0.1). TS/Bun is the primary runtime for rapid development and iteration. Go will be added in v0.3 as a complementary "compiled tools" lane for performance-critical, stable transforms. See [Roadmap](../docs/roadmap.md#v03-go--control-flow-month-2-3) for timeline.

---

## 3. Cell Syntax

### 3.1 Basic Form

Cells are fenced code blocks with the `ore:` prefix:

````markdown
```ore:<type> <attributes>
<content>
```
````

### 3.2 Cell Types

| Type | Syntax | Description | Version |
|------|--------|-------------|---------|
| TypeScript | `ore:ts` | JavaScript/TypeScript via Bun | v0.1 |
| Shell | `ore:shell` | Bash commands | v0.1 |
| AI Prompt | `ore:ai` | LLM completion | v0.1 |
| Python | `ore:py` | Python 3 | v0.2+ |
| Go | `ore:go` | Compiled Go with caching | v0.3+ (future) |

**Note:** Go cells are planned for v0.3. See [Go Cell Specification](go-cell-spec.md) for details.

### 3.3 Attributes

Attributes are specified as `key=value` or `key="value"` pairs:

```markdown
```ore:ts id=fetch depends=[config] timeout=120
```

#### Required Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | `string` | **Required.** Unique identifier within the workflow. |

#### Common Optional Attributes

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `depends` | `string[]` | `[]` | Cell IDs that must run first |
| `timeout` | `number` | `60` | Timeout in seconds |
| `env` | `object` | `{}` | Environment variables |
| `when` | `string` | — | Semantic condition (v0.2+) |
| `retry` | `number` | `0` | Retry count on failure |
| `continueOnError` | `boolean` | `false` | Continue workflow if cell fails |

#### Semantic Condition Attribute (v0.2+)

The `when` attribute accepts a semantic condition that's evaluated by AI:

````markdown
```ore:ai id=summarize when="{{ai: the content exceeds 500 words}}"
Summarize: {{fetch}}
```
````

If the condition evaluates to `false`, the cell is **skipped** (not errored). This enables:

- Conditional processing based on content
- Smart filtering without explicit code
- Dynamic workflow paths

#### AI-Specific Attributes

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `model` | `string` | (from settings) | Model to use |
| `temperature` | `number` | (from settings) | Model sampling temperature |
| `maxTokens` | `number` | (from settings) | Max tokens for the response |

#### Go-Specific Attributes (v0.3+, Future)

> **Status:** Planned for v0.3. See [Go Cell Specification](go-cell-spec.md) for complete details.

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode` | `string` | `"tool"` | `tool` or `module` |
| `stdin` | `string` | `"none"` | Input source: `none`, `cell:<id>`, `note:<path>`, `file:<path>` |
| `stdout` | `string` | `"text"` | Output format: `text`, `json`, `jsonl` |
| `goVersion` | `string` | (from config) | Go version |
| `builderImage` | `string` | (from config) | Build container image |
| `cgo` | `number` | `0` | CGO_ENABLED value |
| `tags` | `string` | `""` | Build tags |
| `ldflags` | `string` | `"-s -w"` | Linker flags |
| `args` | `string` | `""` | CLI args passed to tool |

---

## 4. Template Variables

Inside cell content (especially AI prompts), use double braces for interpolation:

| Syntax | Description |
|--------|-------------|
| `{{cellId}}` | Output of cell with given ID |
| `{{note:Path/To/Note.md}}` | Content of a vault note |
| `{{block:Note#^blockId}}` | Specific block from a note |

### 4.1 Examples

```markdown
```ore:ai id=summarize depends=[fetch]
Summarize this content:
{{fetch}}
```

```markdown
```ore:ai id=analyze
Based on my notes:
{{note:Research/findings.md}}
```

---

## 5. Output Persistence

### 5.1 Format

VaultOre writes a lightweight output stub (ore-output callout) after each cell and stores full outputs under the output root (default `_vaultore`):

````markdown
```ore:ts id=example
1 + 1
```

> [!ore-output] example
> view: [[_vaultore/runs/my-workflow/RUN_ID/example.md]]
> json: [[_vaultore/runs/my-workflow/RUN_ID/example.json]]
> run: RUN_ID
> status: success | duration: 0.12s | at: 2026-01-09T08:00:00Z
````

### 5.2 Output Files

- **JSON record:** `<outputRoot>/runs/<workflowPath>/<runId>/<cellId>.json`
- **Markdown view:** same path with `.md` extension (human-friendly)

Example JSON record:

```json
{
  "runId": "RUN_ID",
  "workflowPath": "vaultore/fixtures/canonical/hello-world.md",
  "cellId": "example",
  "value": 2,
  "meta": {
    "status": "success",
    "duration": 120,
    "timestamp": "2026-01-09T08:00:00Z",
    "runId": "RUN_ID",
    "outputPath": "_vaultore/runs/my-workflow/RUN_ID/example.json",
    "outputViewPath": "_vaultore/runs/my-workflow/RUN_ID/example.md"
  }
}
```

### 5.3 Payload Format

- **TypeScript/Shell:** Last expression or stdout
- **AI:** Model response text
- **JSON cells:** Pretty-printed JSON

### 5.4 Properties

- Output stubs are **visible in preview and source**
- Full outputs are stored as JSON for **diff/history**
- Output stubs **update in place** on re-run
- Output stubs can include **artifact links** when a cell returns `artifactDir` or `files`

---

## 6. Execution Order

### 6.1 Default Order (v0.1)

Cells execute **top-to-bottom** unless dependencies specify otherwise. This is simple, predictable, and covers 90% of use cases.

### 6.2 Dependency Resolution

If `depends` is specified, VaultOre builds a DAG and executes in topological order.

````markdown
```ore:ts id=a
// Runs first
```

```ore:ts id=b depends=[a]
// Runs second
```

```ore:ts id=c depends=[a]
// Runs second (parallel with b in v0.2+)
```

```ore:ts id=d depends=[b, c]
// Runs third
```
````

### 6.3 Cycle Detection

Circular dependencies are an error:

````markdown
```ore:ts id=a depends=[b]
```

```ore:ts id=b depends=[a]  # ERROR: Cycle detected
```
````

### 6.4 Control Flow Evolution (v0.2+)

VaultOre v0.1 uses implicit control flow via `depends[]`. Future versions add explicit control flow blocks **without breaking existing workflows**.

#### v0.2: Parallel Execution (Implicit)

Cells with the same dependencies run in parallel automatically:

````markdown
```ore:ts id=fetch1 depends=[config]
```

```ore:ts id=fetch2 depends=[config]
// fetch1 and fetch2 run in parallel
```
````

#### v0.3: Explicit Control Blocks (Optional)

For power users, explicit control flow blocks in frontmatter:

```yaml
control:
  - parallel:
      - fetch1
      - fetch2
      - fetch3
  - sequential:
      - transform
      - summarize
  - loop:
      cells: [refine]
      until: "{{ai: the output meets quality standards}}"
      max: 3
```

**Key design decision:** Control blocks are **optional and additive**. Existing workflows with `depends[]` continue to work unchanged.

#### Migration Path

| Version | Control Flow | Breaking Changes |
|---------|--------------|------------------|
| v0.1 | `depends[]` only | — |
| v0.2 | `depends[]` + implicit parallel | None |
| v0.3 | `depends[]` + `control:` blocks | None (additive) |

This ensures the "brick-by-brick" philosophy: each feature adds capability without requiring rewrites.

---

## 7. TypeScript Cell Semantics

### 7.1 Runtime Environment

- **Engine:** Bun (Node.js compatible)
- **Container:** Isolated per cell (stateless)
- **State:** Variables do not persist between cells; use `cell(id)` to pass data

### 7.2 Available Globals

```typescript
// Vault operations
vault.read(path: string): Promise<string>
vault.write(path: string, content: string): Promise<void>
vault.exists(path: string): Promise<boolean>
vault.mkdirp(path: string): Promise<void>
vault.readRaw(path: string): Promise<string>  // For /proc, etc.

// Cell references
cell(id: string): any  // Returns parsed output of cell

// Standard globals
fetch, console, JSON, Date, etc.
```

### 7.3 Output Capture

The **last expression** of the cell becomes its output:

````typescript
```ore:ts id=example
const x = 1;
const y = 2;
x + y;  // Output: 3
````

---

## 8. Shell Cell Semantics

### 8.1 Runtime Environment

- **Shell:** Bash (or sh on Alpine)
- **Container:** Isolated per cell (no shared state)
- **Working directory:** `/workspace` (vault mounted)

### 8.2 Output Capture

**stdout** is captured as the cell output.

````bash
```ore:shell id=example
echo "Hello"
ls -la
```
<!-- Output: "Hello\n<ls output>" -->
````

### 8.3 Exit Codes

Non-zero exit codes result in `status: error`.

---

## 9. AI Cell Semantics

### 9.1 Prompt Processing

1. Parse template variables (`{{...}}`)
2. Resolve references (cells, notes)
3. Send to configured provider
4. Capture response

### 9.2 Model Selection

Priority order:
1. `model` attribute on cell
2. `defaultModel` in workflow frontmatter
3. Default from plugin settings

### 9.3 Output Format

AI responses are captured as text. If the response is valid JSON, it's parsed for downstream cells.

---

## 10. Validation Rules

### 10.1 Frontmatter Validation

- `ore: true` is required
- `name` is required
- Unknown fields are warnings (not errors)

### 10.2 Cell Validation

- `id` is required
- `id` must be unique within the workflow
- `depends` must reference existing cells
- No circular dependencies

### 10.3 Template Validation

- `{{cellId}}` must reference a cell that runs before this one
- `{{note:path}}` must be a valid vault path

---

## 11. Example Workflow

### 11.1 Minimal Example

````markdown
---
ore: true
name: Hello World
version: 0.1

runtime:
  engine: docker
  image: oven/bun:1-alpine

permissions:
  network: deny
  vaultWrite: deny
---

# Hello World

A minimal VaultOre workflow.

## Step 1: Compute

````ore:ts id=compute
const message = "Hello from VaultOre!";
message;
```

## Step 2: Transform

```ore:ts id=transform depends=[compute]
const msg = cell("compute");
msg.toUpperCase();
```
````

### 11.2 Semantic Conditions Example

````markdown
---
ore: true
name: Smart Inbox Processor
version: 0.2

schedule: "0 9 * * 1-5"
runIf: "{{ai: the inbox note has unprocessed items marked with [ ]}}"

permissions:
  network: allow
  vaultWrite: allow
---

# Smart Inbox Processor

Processes inbox items only when there's work to do.

## Step 1: Load Inbox

```ore:ts id=loadInbox
const inbox = await vault.read("Inbox.md");
inbox;
```

## Step 2: Extract Items (conditional)

```ore:ts id=extractItems depends=[loadInbox] when="{{ai: the inbox has at least 3 items}}"
const inbox = cell("loadInbox");
const items = inbox.match(/- \[ \] .+/g) || [];
items;
```

## Step 3: Categorize with AI

```ore:ai id=categorize depends=[extractItems]
Categorize these inbox items into: Work, Personal, or Reference.

Items:
{{extractItems}}

Return as JSON: { "work": [...], "personal": [...], "reference": [...] }
```

## Step 4: Create Notes

```ore:ts id=createNotes depends=[categorize]
const categories = JSON.parse(cell("categorize"));

for (const [category, items] of Object.entries(categories)) {
  if (items.length > 0) {
    const content = items.map(i => `- [ ] ${i}`).join("\n");
    await vault.write(`${category}/Inbox-${Date.now()}.md`, content);
  }
}

"Notes created successfully";
```
````

### 11.3 Loop Example (v0.3+)

````markdown
---
ore: true
name: Iterative Refinement
version: 0.3

control:
  - loop:
      cells: [draft, review]
      until: "{{ai: the draft meets publication quality}}"
      max: 3
---

# Iterative Refinement

## Draft

```ore:ai id=draft
Write a blog post about {{note:Topics/Current.md}}
{{#loop.iteration > 1}}
Previous draft: {{draft.previous}}
Feedback: {{review}}
{{/loop}}
```

## Review

```ore:ai id=review depends=[draft]
Review this draft for clarity, accuracy, and engagement:
{{draft}}

Provide specific, actionable feedback.
```
````

---

## Appendix A: EBNF Grammar

```ebnf
workflow     = frontmatter body
frontmatter  = "---" newline yaml newline "---" newline
body         = (text | cell | outputStub)*
cell         = "```ore:" type attributes newline content "```"
outputStub   = "> [!ore-output] " id newline ("> " text newline)+
type         = "ts" | "shell" | "ai" | "py" | "go"
attributes   = (attribute)*
attribute    = id "=" value
id           = [a-zA-Z_][a-zA-Z0-9_-]*
value        = string | "[" string ("," string)* "]"
```

---

## Appendix B: JSON Schema

See `specs/schemas/workflow-frontmatter.json` for the complete JSON Schema.
