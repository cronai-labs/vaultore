# Contributing to VaultOre

Thanks for your interest in contributing! This guide covers project setup, conventions, and the release process.

## Development Setup

**Prerequisites:** Node.js 20+, [Bun](https://bun.sh) 1.3+, and Docker (or Podman/Colima) for running canonical fixture tests.

```bash
git clone https://github.com/cronai-labs/vaultore.git
cd vaultore
bun install
bun run build
bun run test
```

See the [Plugin Development Quickstart](docs/quickstart-plugin-dev.md) for loading the plugin into an Obsidian dev vault.

## Project Layout

| Path | Purpose |
|------|---------|
| `packages/core` | `@vaultore/core` — editor-agnostic engine (parser, executor, runtime, scheduler, providers) |
| `packages/obsidian` | The Obsidian plugin, a thin wrapper over core |
| `fixtures/canonical` | Canonical workflow notes that double as acceptance tests |
| `specs/` | Format and behavior specifications (TDD anchors) |

Core-first rule: all logic lives in `@vaultore/core`; the plugin only adapts it to Obsidian APIs via the `PlatformAdapter` interface.

## Commit Conventions

This repo uses [Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint in CI. Versioning and changelogs are automated from commit messages via release-please.

```
<type>(<scope>): <subject>
```

| Type | Version effect | Use for |
|------|---------------|---------|
| `feat` | minor bump | New features |
| `fix` | patch bump | Bug fixes |
| `perf` | patch bump | Performance improvements |
| `docs`, `style`, `refactor`, `test`, `build`, `ci`, `chore` | none | Everything else |

Add `BREAKING CHANGE:` in the commit body for a major bump.

**Scopes:** `core`, `obsidian`, `parser`, `executor`, `runtime`, `scheduler`, `providers`, `vault`, `deps`, `release`

Examples:

```
feat(parser): support ore:py cell type
fix(obsidian): debounce schedule refresh on vault changes
docs: clarify permission model in README
```

## Testing

```bash
bun run test              # unit tests (all packages)
bun run typecheck         # TypeScript across all packages
bun run test:canonical    # canonical fixture tests (requires Docker)
```

Please keep tests green and add coverage for new behavior. Canonical fixtures in `fixtures/canonical/` are the acceptance bar — if you change the workflow format, update the spec in `specs/` first.

## Pull Requests

1. Branch from `main`
2. Make focused commits following the conventions above
3. Ensure `bun run build`, `bun run test`, and `bun run typecheck` pass
4. Open a PR against `main` — CI runs commitlint, build, tests, and typecheck

## Release Process

Releases are automated:

1. Conventional commits land on `main`
2. [release-please](https://github.com/googleapis/release-please) opens/updates a release PR with the version bump and changelog
3. Merging the release PR creates a git tag and GitHub release with the plugin artifacts (`main.js`, `manifest.json`, `styles.css`) attached
4. `versions.json` is updated automatically for Obsidian's version compatibility lookup

For a manual release (fallback): `node version-bump.mjs <version>`, commit, tag `<version>` (no `v` prefix), and push the tag.

## Questions?

Open a [discussion](https://github.com/cronai-labs/vaultore/discussions) or [issue](https://github.com/cronai-labs/vaultore/issues).
