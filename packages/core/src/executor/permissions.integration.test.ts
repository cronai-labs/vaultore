import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

async function runCell(read: string, write: string, fence: string) {
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
	writeFileSync(join(root, "wf.md"), content);
	const workflow = await new WorkflowExecutor().runWorkflow({
		platform: filesystemPlatform(root),
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
