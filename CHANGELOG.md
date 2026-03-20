# Changelog

All notable changes to VaultOre will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

- Repository: [github.com/cronai-ug/vaultore](https://github.com/cronai-ug/vaultore)
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

[Unreleased]: https://github.com/cronai-ug/vaultore/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/cronai-ug/vaultore/releases/tag/v0.1.0
