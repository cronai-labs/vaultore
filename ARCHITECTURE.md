# VaultOre Architecture

> **Last Updated:** 2026-10-15
> **Repository:** [github.com/cronai-labs/vaultore](https://github.com/cronai-labs/vaultore)

How the code is organised and how a run moves through it. Behaviour is specified elsewhere,
once: the workflow format in [specs/workflow-note-spec.md](specs/workflow-note-spec.md),
permissions and their defaults in [specs/permissions-spec.md](specs/permissions-spec.md),
container flags in [specs/sandbox-spec.md](specs/sandbox-spec.md) (exact flags in
permissions-spec §4.1), plans in [docs/roadmap.md](docs/roadmap.md).

## Principles

1. **Core first.** All engine logic lives in `@vaultore/core`. The Obsidian plugin and the CLI
   are adapters: each implements `PlatformAdapter` and calls the same executor.
2. **Local first.** Everything runs on the user's machine; the only remote services are the AI
   providers a workflow calls.
3. **Fail closed.** No container engine means no run; a permission nobody granted is denied.
4. **Fixtures as acceptance tests.** The notes in `fixtures/canonical/` are real workflows and
   test inputs at the same time.

## Repository

Every tracked file outside `.github/`:

```
vaultore/
├── ARCHITECTURE.md, CHANGELOG.md, CONTRIBUTING.md, LICENSE, README.md
├── package.json              # bun workspaces (packages/*), turbo scripts
├── bun.lock
├── turbo.json
├── manifest.json             # Obsidian manifest (copy of packages/obsidian/manifest.json)
├── versions.json             # plugin version → minAppVersion, for Obsidian
├── version-bump.mjs          # sets the version in every location
├── cliff.toml                # git-cliff changelog config
├── commitlint.config.cjs
├── containers/               # Dockerfiles that nothing builds or uses (see "Container images")
│   ├── bun-base/Dockerfile
│   ├── go-builder/Dockerfile
│   ├── python-base/{Dockerfile,requirements.txt}
│   └── shell-base/Dockerfile
├── docs/
│   ├── index.md, interoperability.md, local-intelligence.md
│   ├── quickstart-plugin-dev.md, roadmap.md, testing-fixtures.md
├── fixtures/canonical/       # daily-summary, hello-world, link-digest, smart-inbox, sys-snapshot (.md)
├── packages/
│   ├── core/                 # @vaultore/core
│   │   ├── src/
│   │   │   ├── index.ts      # public exports
│   │   │   ├── version.ts    # VERSION, rewritten by version-bump.mjs
│   │   │   ├── types/        # types, defaults, the frontmatter schema
│   │   │   ├── parser/       # note → workflow; output callouts; templates
│   │   │   ├── executor/     # runs a workflow (index.ts); output notes (output-note.ts)
│   │   │   ├── runtime/      # engine detection; container command line
│   │   │   ├── providers/    # OpenAI and Anthropic
│   │   │   ├── scheduler/    # cron registrations and ticks
│   │   │   ├── vault/        # exported vault helpers (not used by the executor)
│   │   │   ├── fixtures/     # canonical and smart-inbox tests
│   │   │   └── testing/      # integration-test helpers, network guard
│   │   ├── tsup.config.ts, tsconfig.json, eslint.config.mjs
│   │   └── vitest.config.ts, vitest.canonical.config.ts, vitest.integration.config.ts
│   ├── obsidian/             # the plugin
│   │   ├── src/main.ts       # plugin, ObsidianAdapter, settings tab, permission modal
│   │   ├── src/main.test.ts, src/__mocks__/obsidian.ts
│   │   ├── manifest.json, styles.css
│   │   └── esbuild.config.mjs, tsconfig.json, eslint.config.mts, vitest.config.ts
│   └── cli/                  # @vaultore/cli
│       ├── src/cli.ts        # the vaultore command
│       ├── src/adapter.ts    # NodeAdapter
│       ├── src/scan.ts       # workflow discovery, schedule manifest
│       ├── src/args.ts, src/agent.ts, src/index.ts, *.test.ts
│       └── tsup.config.ts, tsconfig.json, eslint.config.mjs, vitest.config.ts
├── scripts/                  # package-obsidian.mjs, release*.mjs, release-gate.sh
└── specs/                    # cronai-handover, go-cell, permissions, sandbox, workflow-note (-spec.md)
```

`.github/` holds `ci.yml`, `release.yml`, `dependabot.yml` and the pull request template.

## Packages

```
            @vaultore/core
            ┌──────┴──────┐
            ▼             ▼
  @vaultore/obsidian   @vaultore/cli
  (Obsidian plugin)    (vaultore command, NodeAdapter)
```

| | Obsidian plugin | CLI |
|---|---|---|
| Built by | esbuild → `packages/obsidian/dist/main.js` (one CommonJS bundle, core included) | tsup → `packages/cli/dist/cli.js`, `index.js` |
| Files | Obsidian's vault API; `.vaultore/` through the adapter | Node `fs`, confined to the vault root |
| Settings | Plugin data (`.obsidian/plugins/vaultore/data.json`) | `<vault>/.vaultore/config.json` |
| Secrets | Obsidian secret storage, by the name the user selected | Environment variables |
| HTTP | `requestUrl` | `fetch` |
| `ask` permissions | Modal | Deny, or allow with `--yes` |
| Scheduling | Approved notes only, while Obsidian is open | `vaultore agent`, every scheduled note |

## Core Modules

| Module | Responsibility | Main symbols |
|--------|----------------|--------------|
| `types` | Shared types; `DEFAULT_PERMISSIONS`, `DEFAULT_RUNTIME`, `WorkflowFrontmatterSchema` (zod) | |
| `parser` | Frontmatter and cells from note text; reading and writing output callouts; `{{…}}` templates | `WorkflowParser`, `OutputSerializer`, `TemplateInterpolator`, `isWorkflowFrontmatter` |
| `executor` | A whole run: permissions, engine check, order, each cell, outputs, run records | `WorkflowExecutor`, `renderOutputMarkdown` |
| `runtime` | Which engines answer; the `run` command line with its hardening; spawning it | `detectRuntimes`, `buildRunCommand`, `execContainer` |
| `providers` | Requests to OpenAI and Anthropic, through the adapter's `request` (core has no transport of its own); model/provider check; timeouts | `createProviderFromSettings`, `assertModelMatchesProvider`, `DEFAULT_MODELS` |
| `scheduler` | Cron registrations, a 60-second tick, due runs handed to a callback | `WorkflowScheduler`, `computeNextRun` |
| `vault` | `createVaultAPI`, `generateRuntimeScript`: exported, but the executor injects its own copy (`buildTypeScriptRuntime`), and the two have diverged ([#45](https://github.com/cronai-labs/vaultore/issues/45)) | |

## How a Run Works

`WorkflowExecutor.runWorkflow` (`packages/core/src/executor/index.ts`):

1. **Parse** the note: frontmatter against the schema, cells, existing outputs.
2. **Create the run**: a run id, `<outputRoot>/runs/<workflow>/<runId>/run.json` with status
   `running`.
3. **Resolve permissions**: defaults, then frontmatter, then a stored decision or a prompt for
   each `ask`, bound to a hash of the frontmatter and cells (permissions-spec §5).
4. **Choose and check the engine**: frontmatter, else setting, else `docker`; `detectRuntimes`
   probes all four engines in parallel, each with a 10-second timeout.
5. **Order the cells** by `depends`; for a single-cell run, keep the target and what it needs.
6. **Hydrate** earlier outputs from the JSON files the note's callouts link, so `cell()` and
   dependency checks can use them for cells that do not run this time.
7. **For each cell, one at a time:** check its dependencies succeeded; run it (a container for
   `ts` and `shell`, a provider request for `ai`); write its JSON record, Markdown view and the
   run index; re-read the note and replace the cell's callout.
8. **Finish** `run.json`: `completed`, `failed` (a cell failed) or `aborted` (the run threw).

A container cell is `docker run --rm …` (or `podman`, or `container` for Apple; Colima uses
the `docker` CLI). TS cells get a generated script on stdin that defines `cell()`, `vault` and
`vaultore`, runs the cell body, and prints the last expression's value as JSON between markers
the executor extracts.

## Container Images

| Image | Used for |
|-------|----------|
| `runtime.image`, default `oven/bun:1-alpine` | Every `ore:ts` and `ore:shell` cell |
| `alpine:3.19` | Only the integration-test helper `waitForContainerView` |

The Dockerfiles under `containers/` are not built by CI, not published, and not referenced by
the code. They sketch images for a possible future (`bun-base`, `shell-base`, `python-base`,
`go-builder`); each says so in its header.

## Security

What a cell may do, the mount model, prompts and stored decisions:
[specs/permissions-spec.md](specs/permissions-spec.md). The container flags per engine:
[specs/sandbox-spec.md](specs/sandbox-spec.md) and permissions-spec §4.1. Neither is repeated
here.

## Parallel Execution (Not Built)

Cells run one at a time. Running independent cells at the same time is under consideration
([roadmap](docs/roadmap.md#under-consideration)); these are the constraints a design has to
meet:

- **CPU and memory budget:** total container CPU and memory must not saturate the machine.
- **Runtime mix:** TS, shell and AI cells load the machine differently; concurrency limits per
  kind and globally.
- **Vault writes:** two cells writing the same path must not race.
- **Provider limits:** concurrent AI calls bounded per provider.
- **Write-back:** the note is re-read before every callout write (step 7 above); parallel cells
  would make those writes concurrent.

A warm container pool (starting containers ahead and `exec`-ing cells into them) is part of
the same consideration. It would change the isolation model: cells of one run would share a
container's filesystem and processes unless it is reset between them.

## Go Cells (Not Built)

A design for compiled `ore:go` cells with build caching is in
[specs/go-cell-spec.md](specs/go-cell-spec.md).

## Tests

| Suite | Command | Needs |
|-------|---------|-------|
| Unit | `bun run test` | Nothing; a shared setup fails any unstubbed `fetch` |
| Canonical fixtures | `bun run test:canonical` | Nothing: it parses each fixture, it does not run them |
| Container integration | `VAULTORE_IT_ENGINE=docker bun run --cwd packages/core test:integration` | A running engine (default `colima`); vaults are created under `~/.cache` |
| Typecheck, lint | `bun run typecheck`, `bun run lint` | |

CI runs all of them, the integration tests on Docker, and a reproducible-build check; see
[CONTRIBUTING.md](CONTRIBUTING.md#pull-requests). How each fixture is exercised:
[docs/testing-fixtures.md](docs/testing-fixtures.md).
