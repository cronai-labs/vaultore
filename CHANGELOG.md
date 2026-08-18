# Changelog

All notable changes to VaultOre will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1](https://github.com/cronai-labs/vaultore/compare/0.1.0...0.1.1) (2026-08-18)


### Features

* **cli:** add standalone CLI with headless agent and schedule export ([a7c19c5](https://github.com/cronai-labs/vaultore/commit/a7c19c5372fe7d28df7509afcf5360f16aa9a718))
* consolidate plugin launch work and fix launch blockers ([3d35901](https://github.com/cronai-labs/vaultore/commit/3d359016a0e317bef9a511fe06f69fabd3fa50ef))
* **core:** emit OKF-conformant frontmatter on outputs and artifacts ([c35881f](https://github.com/cronai-labs/vaultore/commit/c35881f3861fbf1f83b605c9a4e70450219726f0))
* **obsidian:** adopt current plugin template conventions ([d23b35f](https://github.com/cronai-labs/vaultore/commit/d23b35fb6db0c52cc9b07108d26382e27cf50043))
* **obsidian:** prepare plugin for community marketplace launch ([cbad2d0](https://github.com/cronai-labs/vaultore/commit/cbad2d0daf0483e4804f5b7c45a81dee75d10207))
* **runtime:** add Apple container engine support ([9ee425b](https://github.com/cronai-labs/vaultore/commit/9ee425bd51b38116247178f91ddd4f766fa3ae00))


### Bug Fixes

* **cli:** remove polynomial-backtracking regexes from vault scanning ([bbad8c4](https://github.com/cronai-labs/vaultore/commit/bbad8c40cc6f8cf888e60b1dc6ab81da80190cac))
* **cli:** resolve workflow paths against --vault and surface cell errors ([8792ed4](https://github.com/cronai-labs/vaultore/commit/8792ed4a81833359536dae020c8299a2cd925f91))
* **obsidian:** comply with plugin review guidelines and speed up startup ([d6ebe78](https://github.com/cronai-labs/vaultore/commit/d6ebe78160ead5c5ee2bd3f4f7b8b6973321ed1d))
* **obsidian:** improve plugin quality for marketplace launch ([f7747db](https://github.com/cronai-labs/vaultore/commit/f7747dbf49ada42a4946f26d68dc048e08815b12))

## [Unreleased]

### Added

- **Semantic Conditions** (v0.2 feature, spec complete)
  - `runIf` frontmatter field for workflow-level conditions
  - `when` attribute for cell-level conditions
  - `{{ai: condition}}` syntax for AI-evaluated conditions
  - Condition context with `{{note:path}}`, `{{cellId}}`, `{{meta:*}}`

- **Control Flow Evolution Path** (v0.2-v0.3 spec complete)
  - v0.2: Implicit parallel execution for independent cells
  - v0.3: Explicit `control:` blocks (loop, parallel)
  - Designed for zero breaking changes

- **New Canonical Fixtures**
  - `smart-inbox.md` — Demonstrates semantic conditions
  - `daily-summary.md` — Demonstrates scheduling

- **Competitive Positioning**
  - Added OpenProse comparison in PRD
  - Clarified VaultOre's unique value: time-triggered, knowledge-first, Obsidian-native

### Changed

- Updated PRD to v1.1.0 with competitive analysis
- Updated workflow spec to v0.2.0 with semantic conditions
- Updated architecture doc with new bricks for v0.2 and v0.3
- Enhanced README with "Why VaultOre?" section

### Repository

- Repository: [github.com/cronai-labs/vaultore](https://github.com/cronai-labs/vaultore)
- npm scope: `@vaultore/*`
- License: MIT

## [0.1.0] - 2026-01-09

### Added

- Initial scaffold and specification
- Workflow note format with `ore:*` cells
- TypeScript, Shell, and AI cell types
- Go cell specification (v0.3+)
- Permissions system with sandbox isolation
- Monorepo structure with `@vaultore/core` and `@vaultore/obsidian`
- Brick-by-brick development roadmap
- Canonical test fixtures

---

[Unreleased]: https://github.com/cronai-labs/vaultore/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/cronai-labs/vaultore/releases/tag/v0.1.0
