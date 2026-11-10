# Changelog

All notable changes to VaultOre will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-10

### Upgrading

- **parser:** A note is refused before anything runs when a cell's `timeout` is not a number above zero, or when cells depend on each other in a circle. Correct the `timeout`, or the `depends` list the error names.
- **cli:** An option the command line does not know is a usage error (`unknown option --name`, exit code 2); before, it was ignored. Correct the option where a script calls `vaultore`.
- **cli:** `vaultore agent` runs a scheduled note only after `vaultore schedules approve <note.md>`, and nothing until one is approved. An approval holds for the note's front matter and cells as they are: after changing either, approve again. `vaultore schedules list` shows what the agent may run.
- **parser:** A note is refused when a limit has a value that cannot be enforced: `runtime.timeout` and a cell's `timeout` must be above 0 and at most 86400 seconds, `cpuLimit` above 0, and `memoryLimit` an amount above zero such as `512m`. Correct the value the error names.
- **executor:** `vaultore run <note.md> --cell <id>` fails for an id the note does not have; before, it ran nothing and reported a completed run. In a TypeScript cell, `cell(id)` throws for a name that is no cell's output, such as `constructor`.
- **parser:** A cell id is 1 to 64 characters from the letters A-Z and a-z, digits, `_` and `-`, and starts with a letter or digit. `run` and the Windows device names (`con`, `prn`, `aux`, `nul`, `com0` to `com9`, `lpt0` to `lpt9`) are reserved, and two ids that differ only in letter case are refused. Rename the cell the error names, also where `depends`, `cell()` and `{{id}}` use its id.

### Features

- **cli:** The agent runs only scheduled notes that were approved ([#220](https://github.com/cronai-labs/vaultore/issues/220))

### Bug Fixes

- **parser:** Refuse invalid timeouts, cycles and colliding ids; match output ids exactly ([#214](https://github.com/cronai-labs/vaultore/issues/214))
- **cli:** Read --config-dir <name> and refuse unknown flags ([#217](https://github.com/cronai-labs/vaultore/issues/217))
- **parser:** A note cannot switch off its time, memory or CPU limit ([#225](https://github.com/cronai-labs/vaultore/issues/225))
- **executor:** Cell() answers only for real outputs, and an unknown target cell is an error ([#226](https://github.com/cronai-labs/vaultore/issues/226))
- **parser:** Cell ids follow Ore 0.2: form, reserved names and letter case ([#230](https://github.com/cronai-labs/vaultore/issues/230))

### Dependencies

- **deps:** Bump @babel/parser from 7.29.9 to 7.29.11 in the production-dependencies group across 1 directory ([#188](https://github.com/cronai-labs/vaultore/issues/188))
- **deps-dev:** Bump @vitest/coverage-v8 from 4.1.10 to 5.0.5 ([#176](https://github.com/cronai-labs/vaultore/issues/176))
- **deps-dev:** Bump the dev-dependencies group across 1 directory with 2 updates ([#183](https://github.com/cronai-labs/vaultore/issues/183))
- **deps:** Move fast-uri to 3.1.9 ([#198](https://github.com/cronai-labs/vaultore/issues/198))
- **deps:** Build core and cli with tsup 9 ([#199](https://github.com/cronai-labs/vaultore/issues/199))
- **deps:** Move to TypeScript 6.0 with bundler module resolution ([#200](https://github.com/cronai-labs/vaultore/issues/200))
- **deps-dev:** Bump the dev-dependencies group with 2 updates ([#203](https://github.com/cronai-labs/vaultore/issues/203))
- **deps-dev:** Bump the dev-dependencies group with 4 updates ([#236](https://github.com/cronai-labs/vaultore/issues/236))

## [0.2.0] - 2026-10-28

### Breaking changes

- **obsidian:** Requires Obsidian 1.13.0 or later. VaultOre 0.1.3 remains the release for Obsidian 1.11.4 to 1.12.

### Features

- **obsidian:** Settings appear in Obsidian's settings search ([#190](https://github.com/cronai-labs/vaultore/issues/190))

### Bug Fixes

- **fixtures:** Run on the configured engine and model ([#185](https://github.com/cronai-labs/vaultore/issues/185))
- **core:** Report thrown values, skipped workflows and bad meta blocks ([#187](https://github.com/cronai-labs/vaultore/issues/187))
- **runtime:** A cell timeout kills the container and says so ([#189](https://github.com/cronai-labs/vaultore/issues/189))
- **obsidian:** Switching the provider switches its default model ([#191](https://github.com/cronai-labs/vaultore/issues/191))

### Dependencies

- **deps-dev:** Bump vitest from 4.1.12 to 5.0.5 ([#178](https://github.com/cronai-labs/vaultore/issues/178))

## [0.1.3] - 2026-10-19

### Bug Fixes

- **executor:** A TS cell that is only a string literal outputs the string ([#159](https://github.com/cronai-labs/vaultore/issues/159))

## [0.1.2] - 2026-10-18

### Bug Fixes

- **core:** Hide the config folder the platform reports (Vault#configDir), not only .obsidian ([#147](https://github.com/cronai-labs/vaultore/issues/147))

## [0.1.1] - 2026-10-18

### Bug Fixes

- **obsidian:** Drop the `main` key, which is not an Obsidian manifest key ([#134](https://github.com/cronai-labs/vaultore/issues/134))

### Dependencies

- **deps:** Bump the production-dependencies group across 1 directory with 3 updates ([#92](https://github.com/cronai-labs/vaultore/issues/92))
- **deps:** Bump zod from 3.25.76 to 4.6.7 ([#93](https://github.com/cronai-labs/vaultore/issues/93))
- **deps-dev:** Bump the dev-dependencies group across 1 directory with 10 updates ([#65](https://github.com/cronai-labs/vaultore/issues/65))
- **deps:** Refresh the lockfile within ranges, clearing the dev-tool advisories ([#141](https://github.com/cronai-labs/vaultore/issues/141))

## [0.1.0] - 2026-10-15

### Features

- **obsidian:** Prepare plugin for community marketplace launch
- **runtime:** Add Apple container engine support
- **obsidian:** Adopt current plugin template conventions
- **core:** Emit OKF-conformant frontmatter on outputs and artifacts
- **cli:** Add standalone CLI with headless agent and schedule export
- **release:** Derive semver and changelog from conventional commits

### Bug Fixes

- **obsidian:** Improve plugin quality for marketplace launch
- **obsidian:** Comply with plugin review guidelines and speed up startup
- **cli:** Resolve workflow paths against --vault and surface cell errors
- **cli:** Remove polynomial-backtracking regexes from vault scanning
- **core:** Explain engine selection, bound AI requests, finalise run records
- **core:** Close the gaps a review found in this PR's own changes
- **core:** Preserve edits made while a workflow runs ([#51](https://github.com/cronai-labs/vaultore/issues/51))
- **core:** Remove polynomial backtracking from the parser and scope CI permissions ([#50](https://github.com/cronai-labs/vaultore/issues/50))
- **executor:** Gate {{note:}} on vaultRead and stop rescanning output text ([#72](https://github.com/cronai-labs/vaultore/issues/72))
- **executor:** Enforce vaultRead at the container mount ([#74](https://github.com/cronai-labs/vaultore/issues/74))
- **executor:** Bind permission grants to the note's content ([#75](https://github.com/cronai-labs/vaultore/issues/75))
- **runtime:** Reliable engine detection and hardened cell containers ([#86](https://github.com/cronai-labs/vaultore/issues/86))
- **executor:** Write output notes as OKF v0.2 concepts ([#87](https://github.com/cronai-labs/vaultore/issues/87))
- **providers:** Send requests through the platform and reject a model the provider cannot serve ([#88](https://github.com/cronai-labs/vaultore/issues/88))
- **fixtures:** Make smart-inbox a working canonical example ([#89](https://github.com/cronai-labs/vaultore/issues/89))
- **obsidian:** Scheduled workflows need consent, and API keys come from the selected secret ([#90](https://github.com/cronai-labs/vaultore/issues/90))
- **executor:** Hide the CLI's .vaultore from cells ([#97](https://github.com/cronai-labs/vaultore/issues/97))
- **core:** Default buildNetwork to deny until a cell type uses it ([#98](https://github.com/cronai-labs/vaultore/issues/98))
- **executor:** Apply vault writes on the host, confined to the vault and checked against what the cell read ([#127](https://github.com/cronai-labs/vaultore/issues/127))
- **runtime:** Put the engine's own directory on its PATH ([#129](https://github.com/cronai-labs/vaultore/issues/129))

### Dependencies

- **deps:** Sync lockfile with esbuild 0.27 bump
- **deps-dev:** Bump vitest from 1.6.1 to 4.1.10
- **deps:** Bump actions/checkout
- **deps-dev:** Bump @types/node from 20.19.30 to 26.2.0
- **deps:** Bump the production-dependencies group across 2 directories with 1 update
- **deps-dev:** Bump the dev-dependencies group across 1 directory with 6 updates
- **deps-dev:** Bump @vitest/coverage-v8 from 1.6.1 to 4.1.10
- **deps-dev:** Bump @commitlint/cli from 20.4.2 to 21.2.2
- **deps-dev:** Bump @commitlint/config-conventional to 21.2.2
- **deps:** Bump cron-parser from 4.9.0 to 5.10.0 ([#39](https://github.com/cronai-labs/vaultore/issues/39))

