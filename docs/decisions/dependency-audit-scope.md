---
type: decision
title: The CI audit fails on high and critical advisories only
description: Two lower-severity advisories sit in development-only chains with no fix in reach; gating on them would keep every PR red without reducing exposure.
tags: [ci, security, bun-audit, dependencies]
sources:
  - { name: "bun audit and bun audit --json on bun.lock at 4ea8240, bun 1.3.14 and 1.4.3, 2026-10-22", credibility: verified-firsthand }
  - { name: "bun audit --help, bun 1.3.14", credibility: verified-firsthand }
  - { name: "bun audit on bun.lock with typescript-eslint 8.73.0 and the eslint-plugin-n override, bun 1.4.5, 2026-11-22", credibility: verified-firsthand }
  - { name: "cronai-labs/web-cronai-app docs/decisions/dependency-audit-scope.md", credibility: documented }
verified: true
verified_on: 2026-11-22
stale_after: 2027-04-22
status: active
---

# The CI audit fails on high and critical advisories only

## Decision

`bun run audit` runs `bun audit --audit-level=high` in the `code` job (`code.yml`; until 2026-11-22 the `security` job, which fed `ci-required`). On 2026-10-22 it exits 0 with 2 advisories below the threshold. A plain `bun audit` still lists every advisory, and Dependabot reports them.

Rejected: gating on every severity. It would fail every PR on the two advisories below, which nobody here can fix. A production-only scope, as cronai-labs/web-cronai-app uses with `npm audit --omit=dev`, is not available: `bun audit` (1.3.14) has no flag to leave out development dependencies.

## Why

Advisories reported by `bun audit` on 2026-10-22:

| Advisory | Vulnerable copy and path | Why it stays |
|---|---|---|
| `moment` path traversal via a crafted locale name (moderate, GHSA-4p3w-j4w9-5jqw, `>=2.29.2 <2.31.0`) | `moment@2.29.4` via `eslint-plugin-obsidianmd` → `obsidian@1.12.3` | Lint-time only. The plugin's own `obsidian` dependency pins it; the root `obsidian@1.14.4` already resolves `moment@2.31.0`. `obsidian` is external in `packages/obsidian/esbuild.config.mjs`, and no source file imports `moment`. |
| `esbuild` arbitrary file read through the dev server on Windows (low, GHSA-g7r4-m6w7-qqqr, `>=0.27.3 <0.28.1`) | `esbuild@0.27.7` via `tsup` | Build-time only, for `@vaultore/cli`. The dev server is not used, and the plugin's own `esbuild` is `0.28.2`. |

### State on 2026-11-22: no advisory

Both advisories above are gone (`moment` 2.31.0 throughout, `esbuild` 0.28). The community directory's review of 0.3.0 warned about a third, `minimatch` (moderate, GHSA-g3hv-75wg-m249, `>=7.0.0 <11.0.1`), reached only through lint tooling (#246):

- `minimatch@10.2.6` via `typescript-eslint` 8.72.1: gone with `typescript-eslint` 8.73.0, whose `typescript-estree` asks for `^11.0.1`.
- `minimatch@9.0.9` via `eslint-plugin-obsidianmd` → `@microsoft/eslint-plugin-sdl` 1.1.0, which pins `eslint-plugin-n` to exactly 17.10.3. The root `package.json` **overrides `eslint-plugin-n` to 17.24.0**, the same major, which no longer depends on `minimatch`. Lint gave the same findings before and after.

`bun audit` then reports no vulnerabilities (499 packages). **Remove the override** when `@microsoft/eslint-plugin-sdl` releases a version that no longer pins `eslint-plugin-n` 17.10.3 (1.1.0 is its latest on 2026-11-22), or when `eslint-plugin-obsidianmd` drops it; check with `bun audit` after removing it.

## Consequences

A moderate or low advisory in a production dependency would not fail CI either. The runtime dependencies are few and are watched by Dependabot, whose PRs show up in review.

## Re-check triggers

- `eslint-plugin-obsidianmd` moves to an `obsidian` release that resolves `moment` ≥ 2.31.0, or `tsup` moves to `esbuild` ≥ 0.28.1: then try the next lower level.
- `bun audit` gains a production-only option: scope the gate to production and lower the level, as web-cronai-app does.
- A development dependency starts handling input that does not come from this repository.
