/**
 * Test helper: the changelog this repository's cliff.toml renders for a
 * throwaway repository, with one release 0.1.0, then `messages` as the commits
 * of 0.2.0. Used by the tests of the release notes' footers.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function changelogFor(t, messages) {
	const repo = mkdtempSync(join(tmpdir(), "vaultore-cliff-"));
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const git = (...args) =>
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
			cwd: repo,
			stdio: "pipe",
		});
	git("init", "-q");
	git("commit", "-q", "--allow-empty", "-m", "fix(core): before the release");
	git("tag", "0.1.0");
	for (const message of messages) git("commit", "-q", "--allow-empty", "-m", message);

	const changelog = execFileSync(
		join(root, "node_modules", ".bin", "git-cliff"),
		["--config", join(root, "cliff.toml"), "--repository", repo, "--tag", "0.2.0"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	return {
		changelog,
		release: changelog.slice(changelog.indexOf("## [0.2.0]"), changelog.indexOf("## [0.1.0]")),
		earlier: changelog.slice(changelog.indexOf("## [0.1.0]")),
	};
}
