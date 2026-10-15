#!/usr/bin/env bash
#
# Refuses a release unless the commit is on the default branch and its
# ci-required check run concluded success. The release reads the evidence CI
# already produced instead of re-running the gate, so .github/workflows/ci.yml
# stays the only definition of what "passed" means.
#
#   scripts/release-gate.sh <owner/repo> <commit-sha> [options]
#
#   --timeout <seconds>   how long to wait for CI still running on the commit (1800)
#   --interval <seconds>  how often to poll while waiting (20)
#   --grace <seconds>     how long to wait for CI to start at all (180)
#
# Waiting is a normal case, not an edge case: the tag is usually pushed
# minutes after the release pull request is squash-merged, while CI on the
# merge commit is still running.
#
# Exit status: 0 the commit may be released, 1 refused, 2 usage or API error.
# Reads GitHub through `gh api`; the token needs read access to contents,
# checks and actions.

set -uo pipefail

readonly REQUIRED_CHECK="ci-required"
# The GitHub Actions app on github.com. A check run of the same name created by
# any other app, or by a token through the Checks API, does not count.
readonly ACTIONS_APP_ID=15368
readonly CI_WORKFLOW_PATH=".github/workflows/ci.yml"

refuse() {
	# GitHub renders ::error:: as an annotation on the run; locally it is a line.
	printf '::error::release gate refused: %s\n' "$1" >&2
	exit 1
}

broken() {
	printf '::error::release gate could not run: %s\n' "$1" >&2
	exit 2
}

command -v gh >/dev/null || broken "gh is not installed"
command -v jq >/dev/null || broken "jq is not installed"

[ $# -ge 2 ] || broken "usage: release-gate.sh <owner/repo> <commit-sha> [--timeout s] [--interval s] [--grace s]"
repo="$1"
sha="$2"
shift 2

timeout=1800
interval=20
grace=180
while [ $# -gt 0 ]; do
	[ $# -ge 2 ] || broken "$1 needs a value"
	case "$1" in
		--timeout) timeout="$2" ;;
		--interval) interval="$2" ;;
		--grace) grace="$2" ;;
		*) broken "unknown option: $1" ;;
	esac
	shift 2
done

[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || broken "not an owner/repo: $repo"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || broken "not a full 40-character commit SHA: $sha"
[[ "$timeout" =~ ^[0-9]+$ && "$grace" =~ ^[0-9]+$ && "$interval" =~ ^[0-9]+$ ]] ||
	broken "--timeout, --interval and --grace take whole seconds"

# --- on the default branch ---------------------------------------------------
#
# A green ci-required alone is not enough: a pull request's head commit carries
# one too, and a tag can point at any commit.

default_branch="$(gh api "repos/$repo" --jq '.default_branch // empty')" ||
	broken "could not read repos/$repo"
[ -n "$default_branch" ] || broken "repos/$repo returned no default branch"

relation="$(gh api "repos/$repo/compare/$default_branch...$sha" --jq '.status // empty')" ||
	broken "could not compare $sha with $default_branch"
case "$relation" in
	identical | behind) ;;
	ahead | diverged)
		refuse "$sha is not on $default_branch ($relation); only a commit reachable from $default_branch may be released" ;;
	*)
		broken "unexpected comparison status '$relation'" ;;
esac
echo "on $default_branch: $sha ($relation)"

# --- passed ci-required ------------------------------------------------------

started=$SECONDS
while true; do
	elapsed=$((SECONDS - started))
	check_runs="$(gh api "repos/$repo/commits/$sha/check-runs?check_name=$REQUIRED_CHECK&filter=all&per_page=100")" ||
		broken "could not read check runs for $sha"
	# The latest run decides, as it does for a required check: a re-run that
	# failed overrides an earlier pass.
	latest="$(jq -c --argjson app "$ACTIONS_APP_ID" \
		'[.check_runs[] | select(.app.id == $app)] | max_by(.id) // empty' <<<"$check_runs")"

	if [ -n "$latest" ]; then
		run_status="$(jq -r '.status' <<<"$latest")"
		conclusion="$(jq -r '.conclusion // ""' <<<"$latest")"
		run_url="$(jq -r '.html_url // ""' <<<"$latest")"
		if [ "$run_status" = completed ]; then
			[ "$conclusion" = success ] ||
				refuse "$REQUIRED_CHECK concluded '$conclusion' on $sha $run_url"
			echo "$REQUIRED_CHECK: success $run_url"
			echo "release may proceed"
			exit 0
		fi
		waiting_for="$REQUIRED_CHECK, which is $run_status"
	else
		# Absent is ambiguous: CI may still be creating its jobs, or it may never
		# produce this check. Only the CI workflow's own run tells them apart.
		ci_state="$(gh api "repos/$repo/actions/runs?head_sha=$sha&per_page=100" --jq "
			[.workflow_runs[] | select(.path == \"$CI_WORKFLOW_PATH\")] as \$ci
			| if (\$ci | length) == 0 then \"none\"
			  elif any(\$ci[]; .status != \"completed\") then \"running\"
			  else \"finished\" end")" ||
			broken "could not read workflow runs for $sha"
		case "$ci_state" in
			running)
				waiting_for="CI on $sha to create $REQUIRED_CHECK" ;;
			finished)
				refuse "CI ran on $sha but produced no $REQUIRED_CHECK; the commit predates the check, or its run was cut short" ;;
			none)
				[ "$elapsed" -lt "$grace" ] ||
					refuse "CI never ran on $sha, so nothing shows it passed $REQUIRED_CHECK"
				waiting_for="CI to start on $sha" ;;
			*)
				broken "unexpected CI state '$ci_state'" ;;
		esac
	fi

	[ "$elapsed" -lt "$timeout" ] ||
		refuse "gave up after ${timeout}s waiting for $waiting_for; re-run this workflow once CI on $sha has finished"
	echo "waiting for $waiting_for (${elapsed}s)"
	sleep "$interval"
done
