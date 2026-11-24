# VaultOre Architecture

A map of the repository, for finding your way. How a run moves through the code is in [docs/internals/run-flow.md](docs/internals/run-flow.md); behaviour is specified once, in [specs/](specs/) and the [Ore specification](https://github.com/cronai-labs/ore-spec).

## Principles

1. **Core first.** All engine logic lives in `@vaultore/core`. The Obsidian plugin and the CLI are adapters: each implements `PlatformAdapter` and calls the same executor. Core calls no global `fetch` or timer; it uses the adapter's.
2. **Local first.** Everything runs on the user's machine; the only remote services are the AI providers a workflow calls.
3. **Fail closed.** No container engine means no run; a permission nobody granted is denied.
4. **Fixtures as acceptance tests.** The notes in `fixtures/canonical/` are real workflows and test inputs at the same time.

## Packages

```
            @vaultore/core
            ┌──────┴──────┐
            ▼             ▼
  @vaultore/obsidian   @vaultore/cli
  (Obsidian plugin)    (vaultore command and agent)
```

## Where things are

```
vaultore/
├── packages/
│   ├── core/src/            # @vaultore/core; index.ts is the public surface
│   │   ├── parser/          #   note → workflow; output callouts; {{…}} templates
│   │   ├── executor/        #   a whole run (index.ts); output notes
│   │   ├── runtime/         #   container engines; the hardened `run` command line
│   │   ├── providers/       #   OpenAI and Anthropic
│   │   ├── scheduler/       #   cron ticks; the schedule record (slot-record.ts)
│   │   ├── lock/            #   run locks; where per-machine state lives
│   │   ├── settings/        #   settings both runners share on one machine
│   │   ├── types/           #   types, defaults, the front matter schema
│   │   ├── vault/           #   exported vault helpers (#45)
│   │   └── fixtures/, testing/
│   ├── obsidian/src/main.ts # the plugin: ObsidianAdapter, settings tab, permission modal
│   └── cli/src/             # cli.ts (the command), adapter.ts (NodeAdapter), agent.ts,
│                            # schedules.ts, approvals.ts, scan.ts, args.ts
├── fixtures/canonical/      # workflow notes that are also acceptance tests
├── specs/                   # what VaultOre does: one spec per topic
├── docs/                    # guides, internals, designs, decisions, roadmap (docs/index.md)
├── scripts/                 # release, changelog, packaging and CI helpers, with their tests
├── containers/              # Dockerfiles nothing builds yet (docs/internals/container-images.md)
├── .github/                 # policy.yml and code.yml (the two required checks), release.yml
└── manifest.json, versions.json, version-bump.mjs, package.json, turbo.json, cliff.toml
```

## To change something, start here

| To change | Start in | Specified in |
|---|---|---|
| What a workflow note means | the [Ore specification](https://github.com/cronai-labs/ore-spec), as an issue there | |
| How a note is parsed | `core/src/parser/` | [ore-implementation.md](specs/ore-implementation.md) |
| How a run goes, outputs, run records | `core/src/executor/index.ts` | [ore-implementation.md](specs/ore-implementation.md) |
| Permissions, mounts, stored decisions | `core/src/executor/index.ts`, `core/src/runtime/` | [permissions-spec.md](specs/permissions-spec.md) |
| Container flags, engines | `core/src/runtime/` | [sandbox-spec.md](specs/sandbox-spec.md) |
| Scheduling, missed runs, the late threshold | `core/src/scheduler/`, `core/src/settings/` | [schedule-record-spec.md](specs/schedule-record-spec.md) |
| An AI provider | `core/src/providers/` | [ore-implementation.md](specs/ore-implementation.md) |
| Something only the plugin does (settings tab, notices) | `obsidian/src/main.ts` | |
| A CLI command or flag | `cli/src/cli.ts`, logic in the module beside it | README, Command-Line Interface |
| The CronAI handover | `cli/src/scan.ts` | [cronai-handover-spec.md](specs/cronai-handover-spec.md) |
| Releases, the changelog | `scripts/` | [CONTRIBUTING.md](CONTRIBUTING.md) |

## Tests

Each package's tests sit beside the code (`*.test.ts`); the script tests sit in `scripts/`. The commands and what they need: [CONTRIBUTING.md](CONTRIBUTING.md); how each fixture is exercised: [docs/testing-fixtures.md](docs/testing-fixtures.md).
