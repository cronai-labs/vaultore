# Go Cell Specification v0.1

> **Status:** Future (v0.3+)  
> **Version:** 0.1.0  
> **Last Updated:** 2026-01-10  
> **Roadmap:** See [Roadmap](../docs/roadmap.md#v03-go--control-flow-month-2-3)

## Overview

The `ore:go` cell type provides a "compiled tools" lane for VaultOre workflows. **Go is not a replacement for TS/Bun** — it's a complementary performance lane for stable, deterministic transforms.

Go cells compile to cached binaries and run in a container sandbox, offering:

- **Performance:** Compile once, run many times
- **Reproducibility:** Deterministic builds with cached artifacts
- **Security:** Same sandbox model as other cells
- **Interoperability:** JSON stdin/stdout for easy chaining with TS/Python

## 1. Goals

| Goal | Description |
|------|-------------|
| Performance | Artifact caching keyed on code + deps + toolchain |
| Reproducibility | Builds in controlled container; repeatable across machines |
| Security | Same sandbox model as other cells (no host execution) |
| Interoperability | stdin/stdout JSON for data flow with TS/Python |
| Git-friendly | Outputs persisted as ore-output callouts + JSON records |

### Language Positioning

**Go is positioned as a "compiled tools" lane, not a replacement for TS/Bun:**

- **TS/Bun:** Orchestration, interactive notebooks, rapid iteration, prompt hacking, web APIs
- **Go:** Fast, cached steps for stable tooling (parsers, extractors, deterministic transforms, heavy compute)
- **Python:** Data science, analytics, visualization (v0.2+)

**Best model:** TS orchestrates; Go accelerates stable hot-path steps.

See [Roadmap](../docs/roadmap.md#v03-go--control-flow-month-2-3) for version timeline.

### Non-Goals (v0.1)

- Full multi-file Go projects in-note
- Distributed cache / remote build farm
- Automatic DAG re-run (staleness belongs to core v0.2+)

---

## 2. Cell Syntax

### 2.1 Basic Form

````markdown
```ore:go id=transform
package main

import "fmt"

func main() {
    fmt.Println("hello from go")
}
```
````

### 2.2 Attributes

#### Required

| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | `string` | Unique cell identifier |

#### Common Optional

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `depends` | `string[]` | `[]` | Cells that must run first |
| `timeout` | `number` | `60` | Execution timeout (seconds) |
| `env` | `object` | `{}` | Environment variables |
| `workdir` | `string` | `/workspace` | Container working directory |

#### Go-Specific

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode` | `string` | `"tool"` | `tool` or `module` |
| `stdin` | `string` | `"none"` | Input: `none`, `cell:<id>`, `note:<path>`, `file:<path>` |
| `stdout` | `string` | `"text"` | Output format: `text`, `json`, `jsonl` |
| `goVersion` | `string` | (from config) | Go version |
| `builderImage` | `string` | (from config) | Build container image |
| `cgo` | `number` | `0` | CGO_ENABLED value |
| `tags` | `string` | `""` | Build tags |
| `ldflags` | `string` | `"-s -w"` | Linker flags |
| `args` | `string` | `""` | CLI args passed to tool |

---

## 3. Frontmatter Extensions

Add a `go` section to configure defaults:

```yaml
---
ore: true
name: Example with Go

runtime:
  engine: docker
  image: oven/bun:1-alpine  # Default for TS

go:
  version: "1.23"
  builderImage: "ghcr.io/vaultore/go-builder:1.23"
  cgo: 0
  tags: ""
  ldflags: "-s -w"
  cache:
    enabled: true
    dir: ".vaultore/cache/go"
---
```

---

## 4. Execution Model

### 4.1 Build-Then-Run Pipeline

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Parse cell │ ──► │ Check cache │ ──► │ Build/Skip  │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
                    ┌─────────────────────────►│
                    │                          ▼
              ┌─────┴─────┐              ┌─────────────┐
              │ Store in  │ ◄─────────── │   Execute   │
              │  cache    │              │   binary    │
              └───────────┘              └─────────────┘
```

For each `ore:go` cell run:

1. **Resolve inputs** (stdin, env, args, workdir)
2. **Compute cache key** (see §6)
3. **Check cache:**
   - If cached binary exists → skip build
   - Else → build inside builder container
4. **Execute binary** in sandbox container
5. **Capture output** (stdout/stderr)
6. **Persist output** to note as an ore-output callout and JSON record

### 4.2 State and Determinism

- Go cells are **stateless by default**
- Each run is a fresh process
- State must be expressed through:
  - Input via stdin
  - Files in the workspace (vault)
  - Explicit env vars
- This encourages reproducible "pure-ish" transforms

---

## 5. Modes

### 5.1 `mode=tool` (Default)

VaultOre treats the cell as a single-file Go program:

1. Write cell source to temp dir (`.vaultore/tmp/<cell-id>/main.go`)
2. Run `go mod init` (tool mode)
3. Run `go mod tidy` (if network allowed)
4. Run `go build`
5. Store binary in cache
6. Execute binary

#### Dependency Policy

- **Default:** Allow `go mod` resolution if `buildNetwork: allow`
- **Strict mode (future):** Require vendored deps for offline builds

### 5.2 `mode=module` (Advanced)

Compile a Go program from a module directory in the workspace:

````markdown
```ore:go id=mytool mode=module modulePath="tools/mytool" args="--fast"
```
````

- `modulePath` must contain a Go module with `go.mod`
- Caching uses the module's `go.mod`, `go.sum`, and all `.go` files

---

## 6. Caching Specification

### 6.1 Cache Key (tool mode)

```
cacheKey = sha256(
  "ore:go:v0.1" +
  source +
  goVersion +
  cgo + tags + ldflags +
  GOOS + GOARCH +
  builderImageRef +
  goMod + goSum
)
```

Components:
- Go source of the cell
- Resolved build settings (goVersion, cgo, tags, ldflags)
- Target platform (GOOS/GOARCH)
- Builder image identifier (digest if available)
- Module resolution (`go.mod` + `go.sum` after tidy)

### 6.2 Cache Directory Layout

Default cache root: `.vaultore/cache/go`

```
.vaultore/cache/go/
  <cacheKey>/
    tool           # compiled binary
    meta.json      # build metadata
    build.log      # build output (optional)
```

### 6.3 meta.json Schema

```json
{
  "cacheKey": "<sha256>",
  "goVersion": "1.23",
  "builderImage": "ghcr.io/vaultore/go-builder:1.23",
  "cgo": 0,
  "tags": "",
  "ldflags": "-s -w",
  "platform": "linux/amd64",
  "sourceHash": "<sha256>",
  "depsHash": "<sha256>",
  "artifactSize": 1234567,
  "artifactHash": "<sha256>",
  "builtAt": "2026-01-09T08:00:00Z"
}
```

### 6.4 Cache Key (module mode)

For `mode=module`, additionally include:
- `modulePath`
- Hash of all `*.go`, `go.mod`, `go.sum` under modulePath

### 6.5 Cache Invalidation

- **Manual:** User toggles "clean cache" in settings
- **Automatic:** Builder image update (digest change)
- **Never:** Time-based (artifacts don't expire)

---

## 7. Input/Output

### 7.1 stdin Sources

| Value | Description |
|-------|-------------|
| `none` | No stdin (default) |
| `cell:<id>` | Output of another cell (JSON if structured) |
| `note:<path>` | Content of a vault note |
| `file:<path>` | Content of a workspace file |

### 7.2 stdout Formats

| Value | Description | Validation |
|-------|-------------|------------|
| `text` | Raw text (default) | None |
| `json` | Single JSON value | Parse and pretty-print |
| `jsonl` | Newline-delimited JSON | Validate each line |

If `stdout=json` and output is invalid JSON:
- Mark `status: error`
- Store raw stdout in payload
- Include parse error in `meta.error`

### 7.3 Recommended Conventions

For interoperability, Go tools should:
- Accept input from stdin (optional)
- Emit results on stdout (JSON preferred)
- Emit logs/errors on stderr
- Exit with code 0 on success

---

## 8. Output Persistence

Same format as other cells:

```markdown
> [!ore-output] transform
> view: [[_vaultore/runs/my-workflow/RUN_ID/transform.md]]
> json: [[_vaultore/runs/my-workflow/RUN_ID/transform.json]]
> run: RUN_ID
> status: success | duration: 0.38s | at: 2026-01-09T08:00:00Z
> cache: hit
> artifact: _vaultore/cache/go/<cacheKey>/tool
```

### 8.1 Go-Specific Metadata

| Field | Description |
|-------|-------------|
| `cache` | `hit` or `miss` |
| `artifact` | Path to cached binary |
| `go.version` | Go version used |
| `go.cgo` | CGO setting |
| `go.tags` | Build tags |
| `go.ldflags` | Linker flags |

### 8.2 Error Cases

**Build failure:**
```yaml
meta:
  status: error
  error: "build failed: undefined: someFunction"
  buildLog: ".vaultore/cache/go/<key>/build.log"
```

**Runtime failure:**
```yaml
meta:
  status: error
  error: "exit code 1"
  exitCode: 1
```

---

## 9. Security

### 9.1 Build Network

Go builds may need to fetch modules. Introduce `buildNetwork` permission:

```yaml
permissions:
  network: deny        # Runtime network
  buildNetwork: ask    # Build-time network (for go mod)
```

| `buildNetwork` | Behavior |
|----------------|----------|
| `deny` | Builds must be offline (vendored or no deps) |
| `ask` | Prompt on first build needing modules |
| `allow` | Always allow module fetching |

### 9.2 Container Flags

Same as other cells:
- `--network=none` for execution (unless `network: allow`)
- `--cpus=1`, `--memory=512m`
- `--pids-limit=256` (optional hardening)
- Run as non-root user
- Default seccomp profile

### 9.3 Build Container

Build container may have network if `buildNetwork: allow`:
- Only during build phase
- Not during execution phase

---

## 10. Interoperability

### 10.1 TS → Go → TS Pattern

```markdown
```ore:ts id=get-data
({ items: [1, 2, 3], tag: "x" });
```

```ore:go id=transform stdin=cell:get-data stdout=json
package main
// ... reads JSON from stdin, writes JSON to stdout
```

```ore:ts id=use-result depends=[transform]
const result = cell("transform");
console.log(result.sum);
```
```

### 10.2 Go → Python Pattern (v0.2+)

```markdown
```ore:go id=compute stdout=json
// Compute and output JSON
```

```ore:py id=visualize depends=[compute]
import json
data = json.loads(cell("compute"))
# Create charts
```
```

---

## 11. Implementation Notes

### 11.1 Order of Implementation

1. `mode=tool` only (single-file programs)
2. Cache key + build + run
3. Output persistence with Go-specific metadata
4. `stdin=cell:<id>` support
5. `stdout=json` validation
6. `mode=module` (advanced, later)

### 11.2 Container Images

**Builder image:** `ghcr.io/vaultore/go-builder:1.23`
- Based on `golang:1.23-alpine`
- Includes: git, ca-certificates
- Non-root user configured

**Optional runner image (future):**
- `scratch` or `distroless` for minimal runtime
- Multi-stage build support

---

## 12. Future Enhancements

- `runnerImage` for distroless/scratch execution
- Offline builds with vendoring + module proxy
- Artifact signing for shared workflows
- DAG-aware run caching (separate from build cache)
- WASM compilation target

---

## Appendix A: Example Cell

````markdown
```ore:go id=extract-links mode=tool stdin=cell:note-content stdout=jsonl
package main

import (
    "bufio"
    "encoding/json"
    "fmt"
    "os"
    "regexp"
)

func main() {
    re := regexp.MustCompile(`https?://\S+`)
    s := bufio.NewScanner(os.Stdin)
    for s.Scan() {
        for _, m := range re.FindAllString(s.Text(), -1) {
            out, _ := json.Marshal(map[string]string{"url": m})
            fmt.Println(string(out))
        }
    }
}
```
````
