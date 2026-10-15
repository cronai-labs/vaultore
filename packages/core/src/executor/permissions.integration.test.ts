import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { WorkflowExecutor } from "./index";
import type { PlatformAdapter } from "../types";

/**
 * vaultRead enforced at the mount, against a real container
 * (#68). Needs a running engine: VAULTORE_IT_ENGINE,
 * default colima. The vault lives under $HOME because colima mounts only that.
 *
 *   bun run --cwd packages/core test:integration
 */

const ENGINE = process.env.VAULTORE_IT_ENGINE ?? "colima";
const SECRET = "the contents of a private note";

let root: string;

beforeAll(() => {
	const base = join(homedir(), ".cache");
	mkdirSync(base, { recursive: true });
	root = mkdtempSync(join(base, "vaultore-it-"));
	mkdirSync(join(root, "Private"));
	writeFileSync(join(root, "Private/secret.md"), SECRET);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function platform(): PlatformAdapter {
	const settings = new Map<string, unknown>([["vaultore.runtimeEngine", ENGINE]]);
	const abs = (path: string) => join(root, path);
	return {
		platform: "cli",
		readFile: async (path: string) => readFileSync(abs(path), "utf8"),
		writeFile: async (path: string, content: string) => {
			mkdirSync(dirname(abs(path)), { recursive: true });
			writeFileSync(abs(path), content);
		},
		exists: async (path: string) => existsSync(abs(path)),
		mkdirp: async (path: string) => {
			mkdirSync(abs(path), { recursive: true });
		},
		listFiles: async () => [],
		getVaultRoot: async () => root,
		getSetting: <T>(key: string) => settings.get(key) as T | undefined,
		setSetting: async (key: string, value: unknown) => {
			settings.set(key, value);
		},
		getSecret: async () => undefined,
		setSecret: async () => undefined,
		deleteSecret: async () => undefined,
		log: () => undefined,
	} as unknown as PlatformAdapter;
}

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
		platform: platform(),
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
