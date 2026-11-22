import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunLockHeldError, acquireRunLock, runLockDirectory, runLockPath } from "./run-lock";

let dir: string;
let vaultRoot: string;
let locks: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vaultore-run-lock-"));
	vaultRoot = join(dir, "Vault");
	locks = join(dir, "locks");
	mkdirSync(join(vaultRoot, "Notes"), { recursive: true });
	writeFileSync(join(vaultRoot, "Notes", "Daily.md"), "---\nore: true\n---\n");
	writeFileSync(join(vaultRoot, "Notes", "Other.md"), "---\nore: true\n---\n");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function take(notePath: string, by = "vaultore run") {
	return acquireRunLock({ vaultRoot, notePath, by, directory: locks });
}

describe("runLockDirectory", () => {
	// Both runners have to meet in one place, so nothing a runner's
	// environment says moves it.
	it("is under the account's home directory, whatever $HOME says", () => {
		const directory = runLockDirectory("darwin", { HOME: "/somewhere/else" });

		expect(directory).toBe(join(userInfo().homedir, ".config", "vaultore", "locks"));
	});

	it("is under %APPDATA% on Windows", () => {
		expect(runLockDirectory("win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" })).toBe(
			join("C:\\Users\\a\\AppData\\Roaming", "vaultore", "locks")
		);
	});

	it("refuses to guess on Windows without %APPDATA%", () => {
		expect(() => runLockDirectory("win32", {})).toThrow("APPDATA is not set");
	});

	// A container may run the CLI under a user id with no account entry.
	it("refuses to guess for a user with no account, and says what to do", () => {
		const noAccount = () => {
			throw new Error("ENOENT: no such file or directory, uv_os_get_passwd");
		};

		expect(() => runLockDirectory("linux", { HOME: "/tmp" }, noAccount)).toThrow(
			/no account with a home directory.*uv_os_get_passwd.*Run it as a user that has one/
		);
		expect(() => runLockDirectory("linux", {}, () => "")).toThrow("has no home directory");
	});
});

describe("runLockPath", () => {
	it("is one lock for one note, and another for another", async () => {
		const daily = await runLockPath(locks, vaultRoot, "Notes/Daily.md");

		expect(await runLockPath(locks, vaultRoot, "Notes/Daily.md")).toBe(daily);
		expect(await runLockPath(locks, vaultRoot, "Notes/Other.md")).not.toBe(daily);
	});

	// The plugin and `vaultore run --vault <a link to it>` name the vault differently.
	it("is the same lock when the vault is reached through a symbolic link", async () => {
		const link = join(dir, "VaultLink");
		symlinkSync(vaultRoot, link);

		expect(await runLockPath(locks, link, "Notes/Daily.md")).toBe(
			await runLockPath(locks, vaultRoot, "Notes/Daily.md")
		);
	});

	// macOS and Windows: `notes/daily.md` typed at the command line is the
	// plugin's `Notes/Daily.md`. Linux file systems tell them apart, and there
	// they are two notes.
	const caseInsensitive = (() => {
		const probe = mkdtempSync(join(tmpdir(), "vaultore-case-"));
		writeFileSync(join(probe, "A"), "");
		const result = existsSync(join(probe, "a"));
		rmSync(probe, { recursive: true, force: true });
		return result;
	})();
	it.runIf(caseInsensitive)("is the same lock for a note named in other letter case", async () => {
		expect(await runLockPath(locks, vaultRoot, "notes/daily.md")).toBe(
			await runLockPath(locks, vaultRoot, "Notes/Daily.md")
		);
	});

	it("refuses a note that does not exist", async () => {
		await expect(runLockPath(locks, vaultRoot, "Notes/Missing.md")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});

describe("acquireRunLock", () => {
	it("lets one run of a note in, and tells a second who has it", async () => {
		const release = await take("Notes/Daily.md", "vaultore agent");

		const refusal: unknown = await take("Notes/Daily.md", "Obsidian").catch((err: unknown) => err);

		expect(refusal).toBeInstanceOf(RunLockHeldError);
		const message = String((refusal as Error).message);
		expect(message).toContain(`Notes/Daily.md is already being run by process ${process.pid} (vaultore agent)`);
		expect(message).toContain("Nothing was run");
		expect(message).toContain(await runLockPath(locks, vaultRoot, "Notes/Daily.md"));
		expect((refusal as RunLockHeldError).holder?.by).toBe("vaultore agent");
		await release();
	});

	it("lets runs of two notes in at once", async () => {
		const daily = await take("Notes/Daily.md");
		const other = await take("Notes/Other.md");
		await daily();
		await other();
	});

	it("lets the next run in once the first released it", async () => {
		const first = await take("Notes/Daily.md");
		await first();
		const second = await take("Notes/Daily.md");
		await second();
	});

	it("creates its directory for this user only", async () => {
		const release = await take("Notes/Daily.md");
		if (process.platform !== "win32") {
			expect(statSync(locks).mode & 0o777).toBe(0o700);
		}
		await release();
	});

	// Two runners are two processes: Obsidian and `vaultore agent`.
	it("refuses while another process runs the note, and takes over once that process is killed", async () => {
		const child = holdInAnotherProcess("Notes/Daily.md");
		const pid = await child.holding;

		const refusal: unknown = await take("Notes/Daily.md").catch((err: unknown) => err);
		expect(refusal).toBeInstanceOf(RunLockHeldError);
		expect(String(refusal)).toContain(`process ${pid} (vaultore agent)`);

		child.process.kill("SIGKILL");
		await child.exited;
		const reasons: string[] = [];
		const release = await acquireRunLock({
			vaultRoot,
			notePath: "Notes/Daily.md",
			by: "Obsidian",
			directory: locks,
			onStale: (holder, why) => reasons.push(`${holder.pid} ${why}`),
		});

		expect(reasons).toEqual([`${pid} is no longer running`]);
		await release();
	}, 20_000);
});

/**
 * A second process, run by Bun from this source, that takes the note's run
 * lock as `vaultore agent` and holds it until it is killed.
 */
function holdInAnotherProcess(notePath: string) {
	const bun = spawnSync("bun", ["--version"]);
	if (bun.status !== 0) throw new Error("bun is needed to start the second process");
	const script = join(dir, "hold.ts");
	writeFileSync(
		script,
		`import { acquireRunLock } from ${JSON.stringify(join(realpathSync(__dirname), "run-lock.ts"))};\n` +
			`await acquireRunLock(${JSON.stringify({ vaultRoot, notePath, by: "vaultore agent", directory: locks })});\n` +
			`process.stdout.write(String(process.pid) + "\\n");\n` +
			`setInterval(() => {}, 1000);\n`
	);
	const child = spawn("bun", [script], { stdio: ["ignore", "pipe", "inherit"] });
	const holding = new Promise<number>((resolve, reject) => {
		let out = "";
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString();
			if (out.includes("\n")) resolve(Number(out.trim()));
		});
		child.on("exit", (code) => reject(new Error(`the second process ended early (${code})`)));
	});
	const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
	return { process: child, holding, exited };
}
