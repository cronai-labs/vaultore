import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowExecutor } from "./index";
import { IT_ENGINE, filesystemPlatform, makeIntegrationVaultRoot } from "../testing/integration-vault";

/**
 * vaultRead enforced at the mount (#68) and the container hardening (#28),
 * against a real container. Needs a running engine: VAULTORE_IT_ENGINE,
 * default colima. The vault lives under $HOME because colima mounts only that.
 *
 *   bun run --cwd packages/core test:integration
 */

const SECRET = "the contents of a private note";
const PLUGIN_SETTINGS = '{"apiKey":"the plugin settings"}';

let root: string;

beforeAll(() => {
	root = makeIntegrationVaultRoot();
	mkdirSync(join(root, "Private"));
	writeFileSync(join(root, "Private/secret.md"), SECRET);
	mkdirSync(join(root, ".obsidian/plugins/vaultore"), { recursive: true });
	writeFileSync(join(root, ".obsidian/plugins/vaultore/data.json"), PLUGIN_SETTINGS);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

async function runCell(read: string, write: string, fence: string, vaultRoot = root) {
	const content = `---
ore: true
name: it
permissions:
  network: deny
  vaultRead: ${read}
  vaultWrite: ${write}
---

${fence}
`;
	writeFileSync(join(vaultRoot, "wf.md"), content);
	const workflow = await new WorkflowExecutor().runWorkflow({
		platform: filesystemPlatform(vaultRoot),
		workflowPath: "wf.md",
		content,
	});
	const output = workflow.outputs.get("c");
	return { status: output?.meta.status, value: output?.value };
}

const ts = (code: string) => `\`\`\`ore:ts id=c\n${code}\n\`\`\``;
const shell = (code: string) => `\`\`\`ore:shell id=c\n${code}\n\`\`\``;

describe("vaultRead: deny, vaultWrite: deny", { timeout: 120_000 }, () => {
	it("vault.readRaw cannot reach a note", async () => {
		const r = await runCell("deny", "deny", ts(`await vault.readRaw("/workspace/Private/secret.md")`));
		expect(r.status).toBe("error");
		expect(JSON.stringify(r.value)).not.toContain(SECRET);
	});

	it("Bun.file cannot reach a note", async () => {
		const r = await runCell("deny", "deny", ts(`await Bun.file("/workspace/Private/secret.md").text()`));
		expect(r.status).toBe("error");
		expect(JSON.stringify(r.value)).not.toContain(SECRET);
	});

	it("an ore:shell cat cannot reach a note", async () => {
		const r = await runCell("deny", "deny", shell("cat /workspace/Private/secret.md"));
		expect(r.status).toBe("error");
		expect(JSON.stringify(r.value)).not.toContain(SECRET);
	});

	it("vault.readRaw still reads container paths", async () => {
		const r = await runCell("deny", "deny", ts(`(await vault.readRaw("/proc/meminfo")).split("\\n")[0]`));
		expect(r.status).toBe("success");
		expect(String(r.value)).toMatch(/^MemTotal:/);
	});
});

describe("vaultRead: deny, vaultWrite: allow", { timeout: 120_000 }, () => {
	it("writes into this run's directory and cannot read the vault", async () => {
		const r = await runCell(
			"deny",
			"allow",
			ts(`await vault.write(vaultore.runDir + "/out.txt", "written");
let read;
try { read = await Bun.file("/workspace/Private/secret.md").text(); } catch (e) { read = "threw"; }
({ runDir: vaultore.runDir, read })`)
		);
		expect(r.status).toBe("success");
		const value = r.value as { runDir: string; read: string };
		expect(value.read).toBe("threw");
		expect(readFileSync(join(root, value.runDir, "out.txt"), "utf8")).toBe("written");
	});

	it("rejects a write outside this run's directory", async () => {
		const r = await runCell("deny", "allow", ts(`await vault.write("elsewhere.md", "x")`));
		expect(r.status).toBe("error");
		expect(String(r.value)).toContain("outside this run's directory");
		expect(existsSync(join(root, "elsewhere.md"))).toBe(false);
	});
});

describe("vaultRead: allow (control)", { timeout: 120_000 }, () => {
	it("an ore:shell cat reads the note", async () => {
		const r = await runCell("allow", "deny", shell("cat /workspace/Private/secret.md"));
		expect(r.status).toBe("success");
		expect(String(r.value)).toContain(SECRET);
	});
});

describe("hardened container (#28)", { timeout: 120_000 }, () => {
	const hostUid = process.getuid?.();

	it("a TS cell reads a note and writes its run directory, and nothing else", async () => {
		const r = await runCell(
			"allow",
			"allow",
			ts(`const attempt = async (f) => { try { await f(); return "ok"; } catch { return "denied"; } };
const note = await vault.read("Private/secret.md");
await vault.write(vaultore.runDir + "/ts.txt", "from ts");
({
	note,
	runDir: vaultore.runDir,
	uid: process.getuid(),
	etc: await attempt(() => Bun.write("/etc/vaultore-probe", "x")),
	obsidianRead: await attempt(() => Bun.file("/workspace/.obsidian/plugins/vaultore/data.json").text()),
	obsidianWrite: await attempt(() => Bun.write("/workspace/.obsidian/plugins/vaultore/main.js", "x")),
})`)
		);
		expect(r.status).toBe("success");
		const value = r.value as Record<string, string | number>;
		expect(value.note).toBe(SECRET);
		expect(value.uid).not.toBe(0);
		expect(value.etc).toBe("denied");
		expect(value.obsidianRead).toBe("denied");
		expect(value.obsidianWrite).toBe("denied");
		expect(JSON.stringify(r.value)).not.toContain("the plugin settings");

		const written = join(root, String(value.runDir), "ts.txt");
		expect(readFileSync(written, "utf8")).toBe("from ts");
		if (hostUid !== undefined && hostUid !== 0) {
			expect(value.uid).toBe(hostUid);
			// The point of running as the host uid: written files keep their owner.
			expect(statSync(written).uid).toBe(hostUid);
		}
		expect(readFileSync(join(root, ".obsidian/plugins/vaultore/data.json"), "utf8")).toBe(
			PLUGIN_SETTINGS
		);
		expect(existsSync(join(root, ".obsidian/plugins/vaultore/main.js"))).toBe(false);
	});

	it("a shell cell runs unprivileged on a read-only root without .obsidian", async () => {
		const r = await runCell(
			"allow",
			"allow",
			shell(`echo "uid=$(id -u)"
cat /workspace/Private/secret.md; echo
echo "from shell" > "/workspace/$VAULTORE_RUN_DIR/sh.txt" && echo "run=ok"
echo "$VAULTORE_RUN_DIR" | sed 's/^/runDir=/'
echo x > /etc/vaultore-probe 2>/dev/null && echo "etc=ok" || echo "etc=denied"
cat /workspace/.obsidian/plugins/vaultore/data.json 2>/dev/null && echo "obsRead=ok" || echo "obsRead=denied"
touch /workspace/.obsidian/evil 2>/dev/null && echo "obsWrite=ok" || echo "obsWrite=denied"
grep -E '^(CapEff|NoNewPrivs):' /proc/self/status | tr -d ' \t'`)
		);
		expect(r.status).toBe("success");
		const out = String(r.value);
		const field = (key: string) => out.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1];

		expect(out).toContain(SECRET);
		expect(field("uid")).not.toBe("0");
		if (hostUid !== undefined && hostUid !== 0) expect(field("uid")).toBe(String(hostUid));
		expect(field("run")).toBe("ok");
		expect(field("etc")).toBe("denied");
		expect(field("obsRead")).toBe("denied");
		expect(field("obsWrite")).toBe("denied");
		expect(out).not.toContain("the plugin settings");
		expect(out).toMatch(/^CapEff:0+$/m);
		// Apple's CLI has no no-new-privileges flag (permissions-spec §4.1).
		if (IT_ENGINE !== "apple") expect(out).toMatch(/^NoNewPrivs:1$/m);

		const written = join(root, String(field("runDir")), "sh.txt");
		expect(readFileSync(written, "utf8")).toBe("from shell\n");
		if (hostUid !== undefined && hostUid !== 0) expect(statSync(written).uid).toBe(hostUid);
		expect(existsSync(join(root, ".obsidian/evil"))).toBe(false);
	});

	it("network: deny leaves the container without a route out", async () => {
		const r = await runCell(
			"deny",
			"deny",
			ts(`let fetched;
try { await fetch("http://1.1.1.1", { signal: AbortSignal.timeout(5000) }); fetched = "ok"; } catch { fetched = "failed"; }
({ fetched, interfaces: (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: "/sys/class/net", onlyFiles: false }))).sort() })`)
		);
		expect(r.status).toBe("success");
		const value = r.value as { fetched: string; interfaces: string[] };
		expect(value.fetched).toBe("failed");
		expect(value.interfaces).toEqual(["lo"]);
	});
});

describe("the CLI's .vaultore/ is hidden from cells (#94)", { timeout: 120_000 }, () => {
	const CONFIG = '{"permissionDecisions":{"other.md":{"network":"deny"}}}';
	const probe = ts(`const attempt = async (f) => { try { await f(); return "ok"; } catch { return "denied"; } };
({
	read: await attempt(() => Bun.file("/workspace/.vaultore/config.json").text()),
	// Create the directory first, as a cell forging a config in a fresh vault would.
	write: await attempt(async () => {
		require("node:fs").mkdirSync("/workspace/.vaultore", { recursive: true });
		await Bun.write("/workspace/.vaultore/config.json", '{"permissionDecisions":{"other.md":{"network":"allow"}}}');
	}),
})`);

	it("a cell cannot create the config in a vault that has no .vaultore yet", async () => {
		// A vault of its own: every full-mount run creates .vaultore, and on
		// sshfs-backed engines a directory removed on the host can stay visible to
		// the next container for a moment (#83).
		const fresh = makeIntegrationVaultRoot();
		try {
			const r = await runCell("allow", "allow", probe, fresh);

			expect(r.status).toBe("success");
			expect(r.value).toMatchObject({ write: "denied" });
			expect(existsSync(join(fresh, ".vaultore/config.json"))).toBe(false);
		} finally {
			rmSync(fresh, { recursive: true, force: true });
		}
	});

	it("a cell with vaultRead and vaultWrite can neither read nor rewrite the stored decisions", async () => {
		mkdirSync(join(root, ".vaultore"), { recursive: true });
		writeFileSync(join(root, ".vaultore/config.json"), CONFIG);

		const r = await runCell("allow", "allow", probe);

		expect(r.status).toBe("success");
		expect(r.value).toEqual({ read: "denied", write: "denied" });
		expect(readFileSync(join(root, ".vaultore/config.json"), "utf8")).toBe(CONFIG);
	});
});

describe("VaultOre's own folder is hidden from cells where the vault holds it (#306)", { timeout: 120_000 }, () => {
	const APPROVALS = '{"format":"vaultore.schedules","version":1,"vaults":{}}';

	it("a cell with vaultRead and vaultWrite can neither read nor rewrite schedules.json", async () => {
		// A vault at the home folder holds .config/vaultore.
		const home = makeIntegrationVaultRoot();
		try {
			mkdirSync(join(home, ".config/vaultore"), { recursive: true });
			writeFileSync(join(home, ".config/vaultore/schedules.json"), APPROVALS);
			writeFileSync(join(home, ".config/other.json"), "[]");
			mkdirSync(join(home, ".config/other"));
			const content = `---
ore: true
name: it
permissions:
  network: deny
  vaultRead: allow
  vaultWrite: allow
---

${ts(`const attempt = async (f) => { try { await f(); return "ok"; } catch { return "denied"; } };
({
	read: await attempt(() => Bun.file("/workspace/.config/vaultore/schedules.json").text()),
	write: await attempt(() => Bun.write("/workspace/.config/vaultore/schedules.json", "{}")),
	beside: await attempt(() => Bun.write("/workspace/.config/other.json", "{}")),
	// .config is split around VaultOre's folder (#336): its folders are
	// writable, its files read-only, and nothing new can be created in it.
	besideInFolder: await attempt(() => Bun.write("/workspace/.config/other/x.json", "{}")),
	besideNew: await attempt(() => Bun.write("/workspace/.config/new.json", "{}")),
	otherCase: await attempt(() => Bun.write("/workspace/.config/VaultOre/schedules.json", "{}")),
})`)}
`;
			writeFileSync(join(home, "wf.md"), content);
			const platform = { ...filesystemPlatform(home), stateDirectory: join(home, ".config/vaultore") };

			const workflow = await new WorkflowExecutor().runWorkflow({ platform, workflowPath: "wf.md", content });

			const output = workflow.outputs.get("c");
			expect(output?.meta.status).toBe("success");
			expect(output?.value).toEqual({ read: "denied", write: "denied", beside: "denied", besideInFolder: "ok", besideNew: "denied", otherCase: "denied" });
			expect(readFileSync(join(home, ".config/vaultore/schedules.json"), "utf8")).toBe(APPROVALS);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("only folders are writable, and not VaultOre's or the host tools' ones (#336)", { timeout: 120_000 }, () => {
	const probe = ts(`const fs = require("node:fs");
const attempt = (f) => { try { f(); return "ok"; } catch { return "denied"; } };
const w = "/workspace";
({
	readConfig: attempt(() => fs.readFileSync(w + "/.obsidian/plugins/vaultore/data.json")),
	// Another spelling of a hidden folder is read-only on any host. (Reading it
	// works on a host whose file system ignores letter case: permissions-spec §4.1.)
	writeConfigOtherCase: attempt(() => fs.writeFileSync(w + "/.Obsidian/plugins/vaultore/data.json", "{}")),
	writeStateOtherCase: attempt(() => { fs.mkdirSync(w + "/.VAULTORE", { recursive: true }); fs.writeFileSync(w + "/.VAULTORE/x", "y"); }),
	// What tools on the host act on can be read, not changed.
	readGitConfig: attempt(() => fs.readFileSync(w + "/.git/config")),
	writeGitHook: attempt(() => fs.writeFileSync(w + "/.git/hooks/post-commit", "#!/bin/sh\\n")),
	writeGitConfig: attempt(() => fs.appendFileSync(w + "/.git/config", "\\n")),
	writeClaude: attempt(() => fs.writeFileSync(w + "/.claude/settings.json", "{}")),
	writeEnvrc: attempt(() => fs.appendFileSync(w + "/.envrc", "\\n")),
	// The top level is read-only; folders are writable.
	createTopLevel: attempt(() => fs.writeFileSync(w + "/new.md", "n")),
	writeTopLevelNote: attempt(() => fs.writeFileSync(w + "/top.md", "changed")),
	writeInFolder: attempt(() => fs.writeFileSync(w + "/Notes/a.md", "changed")),
	createInFolder: attempt(() => fs.writeFileSync(w + "/Notes/new.md", "n")),
	renameInFolder: attempt(() => fs.renameSync(w + "/Notes/new.md", w + "/Notes/renamed.md")),
	// Two folders are two mounts: a rename between them fails with EXDEV.
	renameAcrossFolders: attempt(() => fs.renameSync(w + "/Notes/renamed.md", w + "/Archive/renamed.md")),
	writeFolderOtherCase: attempt(() => fs.writeFileSync(w + "/NOTES/other.md", "n")),
	readNestedNote: attempt(() => fs.readFileSync(w + "/Notes/repo/readme.md")),
	// A folder's name as people write it: a comma, spaces, an umlaut.
	writeInNamedFolders: attempt(() => ["Meetings, 2026", "Two words", "Übersicht"].forEach((dir) => fs.writeFileSync(w + "/" + dir + "/n.md", "n"))),
	readThroughLink: attempt(() => fs.readFileSync(w + "/outside/secret.md")),
})`);

	it("keeps the top level, VaultOre's folders and the tools' folders read-only, and folders writable", async () => {
		const vault = makeIntegrationVaultRoot();
		const outside = makeIntegrationVaultRoot();
		try {
			const files: Record<string, string> = {
				".obsidian/plugins/vaultore/data.json": PLUGIN_SETTINGS,
				".git/config": "[core]\n",
				".git/hooks/.keep": "",
				".claude/settings.json": '{"hooks":{}}',
				".envrc": "export A=1\n",
				"top.md": "top",
				"Notes/a.md": "a",
				"Notes/repo/readme.md": "nested",
				"Archive/.keep": "",
				"Meetings, 2026/.keep": "",
				"Two words/.keep": "",
				"Übersicht/.keep": "",
			};
			for (const [path, text] of Object.entries(files)) {
				mkdirSync(join(vault, path, ".."), { recursive: true });
				writeFileSync(join(vault, path), text);
			}
			writeFileSync(join(outside, "secret.md"), SECRET);
			symlinkSync(outside, join(vault, "outside"));

			const r = await runCell("allow", "allow", probe, vault);

			expect(r.status).toBe("success");
			expect(r.value).toEqual({
				readConfig: "denied",
				writeConfigOtherCase: "denied",
				writeStateOtherCase: "denied",
				readGitConfig: "ok",
				writeGitHook: "denied",
				writeGitConfig: "denied",
				writeClaude: "denied",
				writeEnvrc: "denied",
				createTopLevel: "denied",
				writeTopLevelNote: "denied",
				writeInFolder: "ok",
				createInFolder: "ok",
				renameInFolder: "ok",
				renameAcrossFolders: "denied",
				writeFolderOtherCase: "denied",
				readNestedNote: "ok",
				writeInNamedFolders: "ok",
				readThroughLink: "denied",
			});
			expect(existsSync(join(vault, ".git/hooks/post-commit"))).toBe(false);
			expect(readFileSync(join(vault, ".git/config"), "utf8")).toBe("[core]\n");
			expect(readFileSync(join(vault, ".envrc"), "utf8")).toBe("export A=1\n");
			expect(readFileSync(join(vault, ".obsidian/plugins/vaultore/data.json"), "utf8")).toBe(PLUGIN_SETTINGS);
			expect(existsSync(join(vault, ".vaultore/x"))).toBe(false);
			expect(readFileSync(join(vault, "top.md"), "utf8")).toBe("top");
			expect(readFileSync(join(vault, "Notes/a.md"), "utf8")).toBe("changed");
		} finally {
			rmSync(vault, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
