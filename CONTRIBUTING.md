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

## Pull Requests

`main` is protected: squash merge only, linear history, and CI must pass. The mechanics that
are easy to get wrong:

**Open the PR as a draft while the work is in progress.** A draft cannot be merged at all, which
is what stops auto-merge landing something unfinished. Mark it ready only once the linked
issue's task boxes are ticked and the gate below has actually been run.

**Update a branch by rebasing, never by merging.** GitHub's *Update branch* button offers
"Update with merge commit" and "Update with rebase" and there is no repository setting to remove
the first, so this is enforced by CI instead — the `policy` job fails on any merge commit
between the base and your head. Use:

```bash
git fetch origin && git rebase origin/main
git push --force-with-lease          # never a bare --force
```

**The PR title is linted, not your branch commits.** It becomes the squash commit subject and
therefore the changelog entry, so it must be a Conventional Commit. Write branch commits for
whoever reads the PR.

**Tick the Definition of done.** Those boxes are checked by CI once the PR leaves draft; an
unticked box fails `policy` and blocks the merge.

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

Releases are cut locally with one command and published by pushing the tag.

```bash
bun run release              # version derived from the commits since the last tag
bun run release --dry-run    # show the version and changelog, change nothing
bun run release 0.4.0        # override the derived version
```

`release` derives the next version from your conventional commits via
[git-cliff](https://git-cliff.org/) (`feat` → minor, `fix`/`perf`/`revert` → patch;
pre-1.0 a breaking change bumps the minor rather than jumping to 1.0.0), syncs every
version location, regenerates `CHANGELOG.md`, then commits and tags. It refuses to run
on a dirty tree, off `main`, or when nothing since the last tag warrants a release.

Nothing is pushed. Review, then publish:

```bash
git show HEAD --stat
git push origin main 0.2.0
```

Pushing the tag runs [`release.yml`](.github/workflows/release.yml), which re-verifies the
tag against both manifests and `versions.json`, builds and tests, then publishes a GitHub
release with `main.js`, `manifest.json` and `styles.css` attached.

This deliberately needs no GitHub Actions permission to open pull requests — the release is
prepared on your machine and CI only reacts to the tag.

### Version locations

`bun run release` (via `version-bump.mjs`) is the only supported way to change the version.
It updates the root `package.json`, both `manifest.json` files, all three package manifests,
`versions.json`, and the `VERSION` constant in `packages/core/src/index.ts`. A test fails the
build if that constant ever drifts from the package version.

`CHANGELOG.md` is generated — edit `cliff.toml` rather than the file itself. The commit type
to section mapping there mirrors the bump semantics documented in `commitlint.config.cjs`;
if you add a type to one, add it to the other.

## Questions?

Open a [discussion](https://github.com/cronai-labs/vaultore/discussions) or [issue](https://github.com/cronai-labs/vaultore/issues).
