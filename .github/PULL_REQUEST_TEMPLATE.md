<!--
  The PR title becomes the squash commit subject, so it must be a Conventional Commit:
    ^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(scope\))?!?: subject

  Open this as a DRAFT while the work is in progress. A draft cannot be merged,
  which is what stops auto-merge landing unfinished work.
-->

Closes #

## What changed and why

<!-- The defect or the need, with file:line where it helps. Not a restatement of the diff. -->

## Verification

<!--
  What you ran, and what it said. "Should work" is not a result.
  State plainly anything you could NOT verify and why — that is more useful than omitting it.
-->

| Gate | Result |
|---|---|
| build | |
| test | |
| typecheck | |
| lint | |

## Known follow-ups

<!-- What you deliberately left, so review does not have to guess. Link issues. -->

## Definition of done

<!--
  These are checked by CI once the PR leaves draft — an unticked box fails the
  `policy` job, and therefore blocks auto-merge. Convert back to draft if the
  work is not finished.
-->

- [ ] Task boxes ticked in the linked issue for everything this PR implements — and nothing it does not
- [ ] The gate above was actually run, and those are its real numbers
- [ ] Branch is rebased on the base, with no merge commits
