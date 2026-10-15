# Contributing to VaultOre

Thanks for your interest in contributing! This guide covers project setup, conventions, and the release process.

## Development Setup

**Prerequisites:** Node.js 20+ and [Bun](https://bun.sh) 1.3+. The unit and canonical tests run without a container runtime; you need Docker (or Podman/Colima) to *execute* a workflow and for the container integration tests.

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
| `packages/cli` | `@vaultore/cli` — the `vaultore` command and its `NodeAdapter` |
| `fixtures/canonical` | Canonical workflow notes that double as acceptance tests |
| `specs/` | Format and behavior specifications |
| `docs/` | Guides, the roadmap |
| `scripts/` | Packaging and release scripts |

Core-first rule: all logic lives in `@vaultore/core`; the plugin and the CLI only adapt it to their platform via the `PlatformAdapter` interface. [ARCHITECTURE.md](ARCHITECTURE.md) maps the code.

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

**The PR title and every branch commit are linted.** The title becomes the squash commit
subject and therefore the changelog entry; the `policy` job checks that it is a Conventional
Commit. The `commitlint` job checks each commit between the base and your head against
`commitlint.config.cjs`: an unknown type fails, an unlisted scope only warns. Write branch
commits for whoever reads the PR.

**Tick the Definition of done.** Those boxes are checked by CI once the PR leaves draft; an
unticked box fails `policy` and blocks the merge.

**The steps:**

1. Branch from `main` (`<issue>-<slug>`)
2. Make focused commits following the conventions below
3. Run `bun run build`, `bun run test`, `bun run typecheck`, `bun run lint` and
   `bun run test:canonical`
4. Open the PR against `main`. CI runs the policy checks, commitlint, build, packaging, tests,
   typecheck, lint, the container integration tests on Docker and a build-reproducibility
   check, all aggregated into the one `ci-required` check

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

**Scopes** (from `commitlint.config.cjs`; another scope warns): `core`, `obsidian`, `cli`, `parser`, `executor`, `runtime`, `scheduler`, `providers`, `vault`, `fixtures`, `deps`, `release`

Examples:

```
feat(parser): support ore:py cell type
fix(obsidian): debounce schedule refresh on vault changes
docs: clarify permission model in README
```

## Testing

```bash
bun run test              # unit tests (all packages)
bun run typecheck         # TypeScript across all packages, tests included
bun run lint              # the Obsidian review's ESLint config (obsidianmd recommended), all packages
bun run test:canonical    # parse every canonical fixture (no container needed)
VAULTORE_IT_ENGINE=docker bun run --cwd packages/core test:integration   # against a real container engine (default engine: colima)
```

Please keep tests green and add coverage for new behavior. Canonical fixtures in `fixtures/canonical/` are the acceptance bar — if you change the workflow format, update the spec in `specs/` first.

## Release Process

`main` only changes through pull requests, so a release is a pull request too, followed by
a tag. Two commands, each run locally; neither pushes anything.

**1. Prepare the release pull request** on an up-to-date `main`:

```bash
bun run release              # version derived from the commits since the last tag
bun run release --dry-run    # show the version and changelog, change nothing
bun run release 0.4.0        # override the derived version
```

`release` fetches origin and refuses on a dirty tree, off `main`, when `main` differs from
`origin/main`, or when nothing since the last tag warrants a release. It derives the next
version from your conventional commits via [git-cliff](https://git-cliff.org/) (`feat` →
minor, `fix`/`perf`/`revert` → patch; pre-1.0 a breaking change bumps the minor rather than
jumping to 1.0.0), creates branch `release/<version>`, syncs every version location,
regenerates `CHANGELOG.md`, checks that the version's changelog section has entries (it
becomes the release notes) and commits `chore(release): <version>`. It prints the commands
to push the branch and open the pull request:

```bash
git push -u origin release/0.4.0
gh pr create --base main --head release/0.4.0 --title "chore(release): 0.4.0" --body "..."
```

Keep the title exactly `chore(release): <version>`: squash-merging turns it into the commit
subject that step 2 looks for.

**2. Tag the merged commit** once the pull request is squash-merged:

```bash
bun run release:tag 0.4.0
git push origin 0.4.0
```

`release:tag` fetches origin and refuses unless the tip of `origin/main` is the release
commit (`chore(release): 0.4.0 (#N)`) with both manifests, every package and `versions.json`
at that version and a usable changelog section. It then creates an annotated tag on that
commit and prints the push command.

Pushing the tag runs [`release.yml`](.github/workflows/release.yml). It waits until the
tagged commit is on `main` and its `ci-required` check has passed, re-verifies the tag
against both manifests and `versions.json`, builds, tests, typechecks and lints, then
creates a draft release with `main.js`, `manifest.json` and `styles.css`, attests their
build provenance, checks the uploaded files against the build and publishes it. The
release notes are the version's `CHANGELOG.md` section.

Releases are immutable once published: neither the assets nor the tag can change. A
re-run never replaces an asset. It succeeds only if the published files are identical to
the build; anything else needs a new version.

This deliberately needs no GitHub Actions permission to open pull requests — the release is
prepared on your machine and CI only reacts to the tag.

### Version locations

`bun run release` (via `version-bump.mjs`) is the only supported way to change the version.
It updates the root `package.json`, both `manifest.json` files, all three package manifests,
`versions.json`, and the `VERSION` constant in `packages/core/src/version.ts`. A test fails the
build if that constant ever drifts from the package version.

`CHANGELOG.md` is generated — edit `cliff.toml` rather than the file itself. The commit type
to section mapping there mirrors the bump semantics documented in `commitlint.config.cjs`;
if you add a type to one, add it to the other.

## Questions?

Open an [issue](https://github.com/cronai-labs/vaultore/issues).
