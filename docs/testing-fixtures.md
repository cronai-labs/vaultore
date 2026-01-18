# Testing Fixtures: Canonical Workflows

> **Purpose:** TDD-driven development using canonical workflows as acceptance tests  
> **Location:** `fixtures/canonical/`  
> **Status:** Active development

VaultOre uses **canonical workflows** as acceptance tests. Each fixture in `fixtures/canonical/` represents a real-world use case and serves as both documentation and a test case.

---

## Philosophy

**Canonical fixtures are:**
- ✅ Real workflows users would write
- ✅ Self-documenting (read the fixture to understand the feature)
- ✅ Executable tests (run them to validate functionality)
- ✅ Version-controlled (changes to fixtures signal breaking changes)

**Canonical fixtures are not:**
- ❌ Unit test mocks
- ❌ Synthetic edge cases
- ❌ Performance benchmarks

---

## Fixture Index

| Fixture | Purpose | Tests | Status |
|---------|---------|-------|--------|
| [hello-world.md](../fixtures/canonical/hello-world.md) | Minimal smoke test | Parser, TS executor, output persistence | ✅ MVP |
| [link-digest.md](../fixtures/canonical/link-digest.md) | Primary use case | Full pipeline, AI, vault write | ✅ MVP |
| [daily-summary.md](../fixtures/canonical/daily-summary.md) | Scheduling | Cron scheduling, time-based triggers | 📋 v0.1 |
| [smart-inbox.md](../fixtures/canonical/smart-inbox.md) | Semantic conditions | AI-evaluated conditions, conditional cells | 📋 v0.2 |
| [sys-snapshot.md](../fixtures/canonical/sys-snapshot.md) | Shell + TS integration | Shell execution, cross-cell data flow | ✅ MVP |

---

## Fixture Details

### 1. hello-world.md

**Purpose:** Minimal smoke test to verify basic functionality.

**Tests:**
- ✅ Parser extracts frontmatter correctly
- ✅ Parser identifies both cells
- ✅ TypeScript cell executes
- ✅ Output appears as ore-output callout
- ✅ Second cell receives first cell's output via `cell()` helper

**Acceptance Criteria:**
- Running "Run All" produces outputs for both cells
- `hello` output: `"Hello from VaultOre!"`
- `transform` output: `"HELLO FROM VAULTORE!"`
- Outputs link to JSON files with metadata

**Run Command:**
```bash
# Copy to vault and run in Obsidian
cp fixtures/canonical/hello-world.md ~/vaultore-test-vault/Hello-World.md
```

---

### 2. link-digest.md

**Purpose:** Primary use case that validates the entire platform.

**Tests:**
- ✅ Config cell provides parameters
- ✅ URL extraction from seed note
- ✅ HTTP fetch (requires `network: allow`)
- ✅ AI summarization produces valid JSON
- ✅ Artifact files are created
- ✅ (Optional) Digest note is created with backlinks

**Acceptance Criteria:**
- Artifacts created in `_vaultore/artifacts/link-digest/<timestamp>/`
  - `summaries.json` exists and is valid JSON
  - `fetch-data.json` exists and is valid JSON
  - `README.md` exists
- Digest note created at `Digests/digest-<date>.md` (if optional step runs)
- All cell outputs persisted as ore-output callouts

**Prerequisites:**
- `network: allow` permission (for fetching URLs and AI)
- `vaultWrite: allow` permission (for creating artifacts and notes)
- AI provider API key configured

**Run Command:**
```bash
# Copy to vault
cp fixtures/canonical/link-digest.md ~/vaultore-test-vault/Link-Digest.md

# Create seed note (optional)
echo "- https://example.com/article-1" > ~/vaultore-test-vault/Inbox/reading.md
```

---

### 3. daily-summary.md

**Purpose:** Test scheduling and time-based automation.

**Tests:**
- ✅ Cron schedule parsing
- ✅ Workflow triggers at scheduled time
- ✅ Time-based note reading (e.g., daily journal)
- ✅ AI summarization of time-series data

**Acceptance Criteria:**
- Workflow runs automatically at scheduled time (when Obsidian is open)
- Summary note is created/updated with daily content
- Outputs reflect the scheduled run timestamp

**Prerequisites:**
- `schedule` field in frontmatter (e.g., `"0 9 * * 1-5"` for 9am weekdays)
- `vaultWrite: allow` permission
- AI provider API key (if using AI cells)

**Status:** 📋 Planned for v0.1 (basic scheduling)

---

### 4. smart-inbox.md

**Purpose:** Test semantic conditions and conditional execution.

**Tests:**
- ✅ `runIf` workflow-level condition
- ✅ `when` cell-level condition
- ✅ AI-evaluated conditions (`{{ai: condition}}`)
- ✅ Conditional cell skipping

**Acceptance Criteria:**
- Workflow skips if `runIf` evaluates to false
- Cells with `when` attribute skip if condition is false
- Skipped cells show `status: skipped` in output
- Conditions can reference `{{note:path}}` and `{{cellId}}`

**Prerequisites:**
- AI provider API key (for condition evaluation)
- `v0.2+` features (semantic conditions)

**Status:** 📋 Planned for v0.2

---

### 5. sys-snapshot.md

**Purpose:** Test shell execution and cross-cell data flow.

**Tests:**
- ✅ Shell cell executes and captures stdout
- ✅ TypeScript can parse shell output
- ✅ Structured JSON is produced
- ✅ Artifacts are written correctly

**Acceptance Criteria:**
- Shell output captured with system info sections
- Normalized JSON with structured memory data
- Derived metrics including memory usage percentage
- Artifacts in `_vaultore/artifacts/sys-snapshot/<timestamp>/`
  - `snapshot.json` exists and is valid JSON
  - `raw.txt` exists with raw shell output

**Prerequisites:**
- `vaultWrite: allow` permission
- No network required (runs offline)

**Run Command:**
```bash
# Copy to vault
cp fixtures/canonical/sys-snapshot.md ~/vaultore-test-vault/System-Snapshot.md
```

---

## Running Fixtures

### Manual Testing

1. **Copy fixture to vault:**
   ```bash
   cp fixtures/canonical/<fixture>.md ~/vaultore-test-vault/
   ```

2. **Open in Obsidian** and run:
   - `Cmd+Shift+Enter` (Mac) or `Ctrl+Shift+Enter` (Windows/Linux) to run all cells
   - Or use command palette: "VaultOre: Run All Cells"

3. **Verify outputs:**
   - Check ore-output callouts below each cell
   - Verify artifacts (if applicable)
   - Check created notes (if applicable)

### Automated Testing

```bash
# Run all canonical fixture tests
bun run test:canonical

# Run specific fixture
bun run test:canonical -- fixtures/canonical/hello-world.md
```

**Note:** Automated tests require:
- Docker running
- Test vault configured
- AI provider keys (for AI-dependent fixtures)

---

## Adding New Fixtures

### When to Add a Fixture

Add a canonical fixture when:
- ✅ A new feature needs end-to-end validation
- ✅ A real-world use case emerges
- ✅ A bug fix needs regression testing

### Fixture Template

```markdown
---
ore: true
name: Fixture Name
version: 0.1
author: VaultOre Team
tags: [canonical, <category>]
description: >
  Brief description of what this fixture tests.

runtime:
  engine: docker
  image: oven/bun:1-alpine

permissions:
  network: deny|allow|ask
  vaultWrite: deny|allow|ask
  vaultRead: allow
---

# Fixture Name

## Test Criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

---

## Step 1: Description

```ore:ts id=step1
// Code here
```

## Expected Results

After running successfully:
1. Result 1
2. Result 2
3. Result 3

## Validation

```bash
# Validation commands
test -f "expected-file"
jq . "expected-json.json"
```
```

### Fixture Checklist

- [ ] Frontmatter includes `ore: true` and `name`
- [ ] Test criteria listed at top
- [ ] Each cell has unique `id`
- [ ] Dependencies specified with `depends=[...]`
- [ ] Expected results documented
- [ ] Validation commands provided (if applicable)
- [ ] Tags include `canonical`

---

## TDD Workflow

### 1. Write Fixture First

Before implementing a feature, write a canonical fixture that demonstrates the desired behavior.

### 2. Run Fixture (Should Fail)

The fixture should fail or produce incorrect results until the feature is implemented.

### 3. Implement Feature

Implement the feature to make the fixture pass.

### 4. Verify Fixture Passes

Run the fixture and verify all acceptance criteria are met.

### 5. Commit Both

Commit the fixture and implementation together.

---

## Future Fixtures (Planned)

| Fixture | Version | Purpose |
|---------|---------|---------|
| `proc-snapshot.md` | v0.3 | Go cell integration, process aggregation |
| `timeseries.md` | v0.3 | Time-series sampling, Go aggregation |
| `branch-explore.md` | v0.3 | Branching workflow runs |
| `loop-refine.md` | v0.3 | Iterative refinement with loops |

---

## Fixture Maintenance

### Updating Fixtures

- **Breaking changes:** Update fixtures to reflect new behavior
- **Bug fixes:** Update fixtures if they exposed incorrect behavior
- **New features:** Add new fixtures for new capabilities

### Versioning

Fixtures include a `version` field in frontmatter. When a fixture's format changes significantly, increment the version.

---

## Related Documentation

- [Workflow Note Specification](../specs/workflow-note-spec.md) — Format and syntax
- [Quickstart: Plugin Development](quickstart-plugin-dev.md) — How to run fixtures
- [Architecture Guide](../ARCHITECTURE.md) — TDD approach

---

**Questions?** Open an [issue](https://github.com/cronai-ug/vaultore/issues) or start a [discussion](https://github.com/cronai-ug/vaultore/discussions).
