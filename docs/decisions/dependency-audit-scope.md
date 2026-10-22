---
type: decision
title: The CI audit fails on high and critical advisories only
description: Two lower-severity advisories sit in development-only chains with no fix in reach; gating on them would keep every PR red without reducing exposure.
tags: [ci, security, bun-audit, dependencies]
sources:
  - { name: "bun audit and bun audit --json on bun.lock at 4ea8240, bun 1.3.14 and 1.4.3, 2026-10-22", credibility: verified-firsthand }
  - { name: "bun audit --help, bun 1.3.14", credibility: verified-firsthand }
  - { name: "cronai-labs/web-cronai-app docs/decisions/dependency-audit-scope.md", credibility: verified-firsthand }
verified: true
verified_on: 2026-10-22
stale_after: 2027-04-22
status: active
---

# The CI audit fails on high and critical advisories only

## Decision

`bun run audit` runs `bun audit --audit-level=high` in the `security` job, which feeds `ci-required`. On 2026-10-22 it exits 0 with 2 advisories below the threshold. A plain `bun audit` still lists every advisory, and Dependabot reports them.

Rejected: gating on every severity. It would fail every PR on the two advisories below, which nobody here can fix. A production-only scope, as cronai-labs/web-cronai-app uses with `npm audit --omit=dev`, is not available: `bun audit` (1.3.14) has no flag to leave out development dependencies.

## Why

Advisories reported by `bun audit` on 2026-10-22:

| Advisory | Vulnerable copy and path | Why it stays |
|---|---|---|
| `moment` path traversal via a crafted locale name (moderate, GHSA-4p3w-j4w9-5jqw, `>=2.29.2 <2.31.0`) | `moment@2.29.4` via `eslint-plugin-obsidianmd` → `obsidian@1.12.3` | Lint-time only. The plugin's own `obsidian` dependency pins it; the root `obsidian@1.14.4` already resolves `moment@2.31.0`. `obsidian` is external in `packages/obsidian/esbuild.config.mjs`, and no source file imports `moment`. |
| `esbuild` arbitrary file read through the dev server on Windows (low, GHSA-g7r4-m6w7-qqqr, `>=0.27.3 <0.28.1`) | `esbuild@0.27.7` via `tsup` | Build-time only, for `@vaultore/cli`. The dev server is not used, and the plugin's own `esbuild` is `0.28.2`. |

## Consequences

A moderate or low advisory in a production dependency would not fail CI either. The runtime dependencies are few and are watched by Dependabot, whose PRs show up in review.

## Re-check triggers

- `eslint-plugin-obsidianmd` moves to an `obsidian` release that resolves `moment` ≥ 2.31.0, or `tsup` moves to `esbuild` ≥ 0.28.1: then try the next lower level.
- `bun audit` gains a production-only option: scope the gate to production and lower the level, as web-cronai-app does.
- A development dependency starts handling input that does not come from this repository.
