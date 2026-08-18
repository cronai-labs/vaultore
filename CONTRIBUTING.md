# Contributing to VaultOre

Thanks for your interest in contributing! This guide covers project setup, conventions, and the release process.

## Development Setup

**Prerequisites:** Node.js 20+ and [Bun](https://bun.sh) 1.3+. The whole test suite runs without a container runtime; you only need Docker (or Podman/Colima) to actually *execute* a workflow.

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

This repo uses [Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint in CI. The type does not bump the version automatically — see [Release Process](#release-process) — but it does drive the generated release notes, so write the subject for someone reading the changelog.

```
<type>(<scope>): <subject>
```

| Type | Suggests | Use for |
|------|----------|---------|
| `feat` | minor bump | New features |
| `fix` | patch bump | Bug fixes |
| `perf` | patch bump | Performance improvements |
| `docs`, `style`, `refactor`, `test`, `build`, `ci`, `chore` | no bump | Everything else |

Add `BREAKING CHANGE:` in the commit body when the change warrants a major bump.

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
bun run test:canonical    # parse every canonical fixture (no container needed)
```

Please keep tests green and add coverage for new behavior. Canonical fixtures in `fixtures/canonical/` are the acceptance bar — if you change the workflow format, update the spec in `specs/` first.

## Pull Requests

1. Branch from `main`
2. Make focused commits following the conventions above
3. Ensure `bun run build`, `bun run test`, and `bun run typecheck` pass
4. Open a PR against `main` — CI runs commitlint, build, tests, and typecheck

## Release Process

Releases are cut by pushing a semver tag. Pick the version yourself, using the commit types
since the last release as the guide.

```bash
bun run version:bump 0.2.0          # syncs all 8 version locations
git commit -am "chore(release): 0.2.0"
git tag 0.2.0                        # no 'v' prefix — Obsidian matches the bare version
git push origin main 0.2.0
```

Pushing the tag runs [`release.yml`](.github/workflows/release.yml), which verifies the tag
against both manifests and `versions.json`, builds and tests, then publishes a GitHub release
with `main.js`, `manifest.json` and `styles.css` attached and notes generated from the merged
PRs.

`version:bump` is the only supported way to change the version. It updates the root
`package.json`, both `manifest.json` files, all three package manifests, `versions.json`, and
the `VERSION` constant in `packages/core/src/index.ts` — and a test fails the build if that
constant ever drifts from the package version.

If the tag and the manifests disagree, the release job fails before publishing anything. Fix
the version, commit, delete the tag and re-push it.

## Questions?

Open a [discussion](https://github.com/cronai-labs/vaultore/discussions) or [issue](https://github.com/cronai-labs/vaultore/issues).
