# Testing Fixtures: Canonical Workflows

> **Location:** `fixtures/canonical/`

The notes in `fixtures/canonical/` are real workflows that double as tests and as examples.
Each one shows a use of VaultOre and is read by the test suites below.

---

## How They Are Tested

| Suite | What it checks | Needs |
|-------|----------------|-------|
| `bun run test:canonical` | Every fixture parses: it is a workflow, has cells, and its cell ids are unique (`packages/core/src/fixtures/fixtures.canonical.test.ts`). **It does not run them** | Nothing: no engine, no vault, no API key |
| `bun run --cwd packages/core test:integration` | Runs `smart-inbox.md` end to end in real containers, with the AI provider stubbed (`smart-inbox.integration.test.ts`) | A running engine (`VAULTORE_IT_ENGINE`, default `colima`) |
| By hand | Running a fixture in Obsidian or with the CLI | An engine; API keys for fixtures with `ore:ai` cells |

One fixture's parse test can be run alone by name:

```bash
bun run --cwd packages/core test:canonical -t hello-world
```

---

## Fixture Index

| Fixture | Shows | Cells | Permissions | Executed automatically |
|---------|-------|-------|-------------|------------------------|
| [hello-world.md](../fixtures/canonical/hello-world.md) | Smallest workflow; `cell()` across containers | ts, ts | defaults | No |
| [sys-snapshot.md](../fixtures/canonical/sys-snapshot.md) | Shell output parsed by TS, artifacts with an index | shell, ts ×3 | `vaultWrite: allow` | No |
| [link-digest.md](../fixtures/canonical/link-digest.md) | Fetch URLs, summarise with AI, write artifacts and a digest note | ts ×3, ai, ts ×2 | `network`, `vaultWrite: allow` | No |
| [daily-summary.md](../fixtures/canonical/daily-summary.md) | A scheduled run that reads a daily note and writes a summary | ts, ai, ts | `network`, `vaultWrite: allow` | No |
| [smart-inbox.md](../fixtures/canonical/smart-inbox.md) | Inbox triage with one AI call and strictly checked output | ts ×2, ai, ts ×3 | `network`, `vaultWrite: allow` | Yes, with a stubbed provider |

No fixture sets `runtime.engine` or a cell's `model=`, so each runs on the engine, provider
and model chosen in the settings. The canonical tests check this.

---

## Fixture Details

### hello-world.md

Two TS cells: `hello` returns a string, `transform` reads it with `cell("hello")` and
upper-cases it.

- `hello` output: `"Hello from VaultOre!"`; `transform` output: `"HELLO FROM VAULTORE!"`
- Each cell gets an output callout and a JSON record under `_vaultore/runs/…`

### sys-snapshot.md

A shell cell prints system information; TS cells normalise it to JSON and derive memory
usage; the last cell writes artifacts and returns `{ artifactDir, files }`.

- Artifacts in `_vaultore/artifacts/sys-snapshot/<timestamp>/`: `snapshot.json`, `raw.txt`
- `_index.md` in that directory, linking both files
- Runs offline (`network: deny`)

### link-digest.md

Reads URLs from a seed note (`Inbox/reading.md`), fetches them, asks the AI for JSON
summaries, writes artifacts, and creates a digest note.

- Artifacts in `_vaultore/artifacts/link-digest/<timestamp>/`: `summaries.json`,
  `fetch-data.json`, `README.md`
- A digest note under `Digests/`
- The `summarize` cell sets no model, so it uses the default model of the configured
  provider, OpenAI or Anthropic.

```bash
mkdir -p ~/vaultore-test-vault/Inbox
echo "- https://example.com/" > ~/vaultore-test-vault/Inbox/reading.md
```

### daily-summary.md

Scheduled `"0 18 * * *"`. Reads `Daily/<today>.md` if it exists, asks the AI for a summary,
and writes `Summaries/<date>-summary.md`.

- In the plugin it runs on schedule only after **Run scheduled workflows** is on and the note
  is approved (**Settings → VaultOre → Scheduled workflows**); "Run all cells" runs it now.
- `vaultore agent` runs it on schedule without approval.

### smart-inbox.md

Files the open items of `Inbox.md` (path set at the top of `readInbox`) into one note per
category, using what the engine supports today
([#79](https://github.com/cronai-labs/vaultore/issues/79)); the full design with conditions
and structured outputs is [#80](https://github.com/cronai-labs/vaultore/issues/80).

- Open items (`- [ ] …`) are read and numbered; one `ore:ai` call gets the prompt built by a TS
  cell through `{{prompt}}`
- The AI answer is checked strictly: anything malformed fails `parseAnswer`, and the inbox and
  notes stay untouched
- One note per category under `Processed/`, appended to, with OKF frontmatter
- Exactly the filed lines change from `- [ ]` to `- [x]`; every other line is byte-identical; a
  line edited during the run is left alone and listed under `notTicked`
- A second run files only items added since

On Colima, use virtiofs file sharing. With sshfs, a cell can read a stale copy of the inbox
([#83](https://github.com/cronai-labs/vaultore/issues/83)): `readInbox` then misses items added
a moment before the run, which the next run files, and `tickInbox`'s write is refused, so the
cell fails and the inbox stays as it was.

---

## Running a Fixture

**In Obsidian:** copy the fixture into a test vault, open it, and run **VaultOre: Run all
cells**. Check the callouts, and the artifacts and notes listed above.

```bash
cp fixtures/canonical/hello-world.md ~/vaultore-test-vault/
```

**With the CLI**, from a checkout after `bun run build`:

```bash
node packages/cli/dist/cli.js run hello-world.md --vault fixtures/canonical --yes
```

This writes `_vaultore/` and `.vaultore/config.json` into `fixtures/canonical/` (both
gitignored).

---

## Adding a Fixture

Add one when a feature needs an end-to-end example, a real use case comes up, or a bug needs a
regression case. The parse test picks up every `.md` file in the folder.

````markdown
---
ore: true
name: Fixture Name
version: "0.1"
author: VaultOre Team
tags: [canonical, <category>]
description: >
  What this fixture shows.

runtime:
  image: oven/bun:1-alpine

permissions:
  network: deny
  vaultRead: allow
  vaultWrite: deny
  buildNetwork: deny
---

# Fixture Name

## Step 1: Description

```ore:ts id=step1
// code
```

## Expected Results

1. …
````

Checklist:

- Frontmatter has `ore: true`, `name`, and a quoted `version`
- Each cell has a unique `id`; dependencies are declared with `depends=[…]`
- Only the permissions it needs, at `allow` or `deny`
- Expected results written down
- Only features VaultOre implements ([Ore implementation](../specs/ore-implementation.md)),
  none of the reserved features of Ore §12

When the format changes, update the spec first, then the fixtures.

---

Related: [Ore specification](https://github.com/cronai-labs/ore-spec), [Ore implementation](../specs/ore-implementation.md),
[plugin development quickstart](quickstart-plugin-dev.md),
[architecture](../ARCHITECTURE.md#tests).
