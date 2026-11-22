---
type: decision
title: Two required checks, policy and code, each its own workflow
description: The aggregate ci-required is replaced by policy (policy.yml, every PR event) and code (code.yml, only when the head commit moves), so an edit of a PR re-runs the PR checks alone and the code verdict stays the last real one.
tags: [ci, github, rulesets, required-checks]
sources:
  - { name: "cronai-labs working model, required checks contract, 2026-11-12", credibility: documented }
  - { name: "cronai-labs/web-cronai-app#543 and cronai-labs/web-cronai-de#122, the same move", credibility: verified-firsthand }
  - { name: "issue #239", credibility: documented }
verified: true
verified_on: 2026-11-22
stale_after: 2027-05-22
status: active
---

# Two required checks, policy and code, each its own workflow

## Decision

The default branch requires two checks from GitHub Actions, with "branch up to date" on:

| Check | Workflow | Runs on | Holds |
|---|---|---|---|
| `policy` | `.github/workflows/policy.yml` | pull request `opened`, `synchronize`, `reopened`, `edited`, `ready_for_review`; push to `main`; merge group; by hand | PR title, breaking footer, rebase-not-merge, Definition of done, no tool attribution, actions pinned to a SHA |
| `code` | `.github/workflows/code.yml` | pull request `opened`, `synchronize`, `reopened`; push to `main`; merge group; by hand | commitlint, secret scan, dependency audit, build, packaging, reproducible build, tests, script tests, typecheck, lint, container integration tests |

In cronai-labs the requirement comes from the organisation ruleset `org-required-checks`, which applies to repositories whose custom property `ci-model` is `two-checks`. The release gate (`scripts/release-gate.sh`) reads the `code` check of the tagged commit.

## Why

Until 2026-11-22 one aggregate check, `ci-required`, sat at the end of `ci.yml` over every job. An edit of a PR's title or body has to re-run the PR checks, so it started the whole workflow again: build, tests, a second clean build and the container tests, for a change to text. With one aggregate there is no cheaper option; an edit run must emit the aggregate too, and so must either wait for the full run of the same commit or fail while that run is going. The owner retired the aggregate across the organisation on 2026-11-12 ("this rule has no sense, wrt. to cost and delay").

With two workflows an edit starts `policy.yml` alone. `code.yml` is not triggered, no new `code` check run appears on the head commit, and the ruleset keeps reading the last real one.

## Rules that keep the checks honest

`scripts/ci-workflows.test.mjs` (`bun run test:scripts`) holds them:

- Each workflow has one job, named as the ruleset requires it, and no other workflow has a job of either name: a second check run of the same name could be read in its place.
- No job-level `if:` on `policy` or `code`: a skipped job reports success. Conditions sit on steps.
- No path or branch filter on their pull requests: a workflow that does not run leaves its required check pending forever, and a stacked layer targets the layer below it, not `main`.
- `code.yml` never runs on `edited` or `ready_for_review`.
- The release gate names `code` and `code.yml`.

## Trade-offs

- `code` is one job, not the five parallel jobs `ci.yml` had. One checkout and one install instead of five, and no aggregator that has to tell a cancelled dependency from a green one. A run takes longer from start to finish, since the steps run in sequence. This repository is public, so its minutes cost nothing either way.
- A commit made before the split carries `ci-required` and no `code`, so the release gate refuses it. 0.3.0 (`d0cc698`) is the last such release; every later commit on `main` gets `code`.
