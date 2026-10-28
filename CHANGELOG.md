# Changelog

All notable changes to VaultOre will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

