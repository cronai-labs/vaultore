# Agent instructions

VaultOre runs [Ore](https://github.com/cronai-labs/ore-spec) workflows: an Obsidian plugin and a command-line runner over one TypeScript core. Start with [CONTRIBUTING.md](CONTRIBUTING.md) (setup, pull requests, commits, releases) and [ARCHITECTURE.md](ARCHITECTURE.md) (packages, modules, how a run flows).

## Where behaviour is defined

- **The format** is the [Ore specification](https://github.com/cronai-labs/ore-spec/blob/main/SPEC.md). A change to what a workflow note means starts there, as an issue in cronai-labs/ore-spec, not here.
- **What VaultOre decides or adds** on top of it: [specs/ore-implementation.md](specs/ore-implementation.md). Permissions, mounts and stored decisions: [specs/permissions-spec.md](specs/permissions-spec.md). Container flags: [specs/sandbox-spec.md](specs/sandbox-spec.md).
- When code and a spec disagree, say which one is wrong in the pull request; fix the spec in the same change, or file an issue.

## Rules agents most often miss

- **Core first.** Logic lives in `packages/core`; `packages/obsidian` and `packages/cli` only adapt it through `PlatformAdapter`. Core calls no global `fetch` or timer: it uses the adapter's `request` and `timers`.
- **Draft pull requests** from a branch linked to its issue. Tick the issue's task boxes and fill in the template's Verification table with the commands you ran and their real numbers before marking it ready; CI checks the Definition of done boxes.
- **Conventional Commits** with the scopes in `commitlint.config.cjs`; the PR title becomes the squash commit and the changelog line. No tool or AI attribution anywhere.
- **Never hand-edit a version.** `bun run release` changes every version location; releases and tags are the maintainer's act.
- **Workflow notes in `fixtures/canonical/`** are acceptance tests: use only features VaultOre implements. The [writing-ore-workflows](https://github.com/cronai-labs/ore-spec/blob/main/skills/writing-ore-workflows/SKILL.md) skill has the rules.

## Gates

```bash
bun install --frozen-lockfile
bun run build && bun run test && bun run typecheck && bun run lint
bun run --cwd packages/core test:integration   # needs a container engine (default: colima)
```

colima shares only the home directory with its VM. The integration tests therefore create their vaults under `~/.cache`; a vault you run by hand (`vaultore run … --vault <dir>`) must live under `$HOME` too, or the container sees it empty.
