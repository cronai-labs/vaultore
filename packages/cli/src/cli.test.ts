import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeAdapter } from "./adapter";
import { buildScheduleManifest, discoverWorkflows } from "./scan";

const WORKFLOW = `---
ore: true
name: Scheduled Test
schedule: "0 9 * * 1-5"
permissions:
  network: deny
---

# Test

\`\`\`ore:ts id=hello
1 + 1;
\`\`\`
`;

const UNSCHEDULED = `---
ore: true
name: Manual Test
---

\`\`\`ore:ts id=only
"hi";
\`\`\`
`;

let vault: string;

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "vaultore-test-"));
});

afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
});

describe("NodeAdapter", () => {
	// The CLI keeps global fetch for provider calls (#78); the plugin uses
	// requestUrl. Both go through the adapter's request capability.
	it("sends provider requests with fetch and resolves error statuses", async () => {
		const seen: Array<{ url: string; init: RequestInit }> = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return new Response("rate limited", { status: 429 });
		});
		try {
			const adapter = new NodeAdapter({ vaultRoot: vault, quiet: true });
			const response = await adapter.request({
				url: "https://api.openai.com/v1/chat/completions",
				method: "POST",
				headers: { Authorization: "Bearer k" },
				body: "{}",
				timeoutMs: 5000,
			});

			expect(response).toEqual({ status: 429, text: "rate limited" });
			expect(seen).toHaveLength(1);
			expect(seen[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
			expect(seen[0]?.init).toMatchObject({
				method: "POST",
				headers: { Authorization: "Bearer k" },
				body: "{}",
			});
			expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("reads and writes vault-relative files", async () => {
		const adapter = new NodeAdapter({ vaultRoot: vault, quiet: true });
		await adapter.writeFile("Notes/hello.md", "# Hi");

		expect(await adapter.exists("Notes/hello.md")).toBe(true);
		expect(await adapter.readFile("Notes/hello.md")).toBe("# Hi");
	});

	it("rejects paths escaping the vault root", async () => {
		const adapter = new NodeAdapter({ vaultRoot: vault, quiet: true });
		await expect(adapter.readFile("../outside.md")).rejects.toThrow(/escapes vault root/);
	});

	it("lists files recursively with forward slashes, skipping dot dirs", async () => {
		const adapter = new NodeAdapter({ vaultRoot: vault, quiet: true });
		await adapter.writeFile("a/b/c.md", "x");
		mkdirSync(join(vault, ".obsidian"), { recursive: true });
		writeFileSync(join(vault, ".obsidian", "app.json"), "{}");

		const files = await adapter.listFiles("");
		expect(files).toContain("a/b/c.md");
		expect(files.some((f) => f.startsWith(".obsidian"))).toBe(false);
	});

	it("persists settings to .vaultore/config.json", async () => {
		const adapter = new NodeAdapter({ vaultRoot: vault, quiet: true });
		await adapter.setSetting("vaultore.defaultModel", "test-model");

		const raw = JSON.parse(readFileSync(join(vault, ".vaultore", "config.json"), "utf8"));
		expect(raw.defaultModel).toBe("test-model");

		const fresh = new NodeAdapter({ vaultRoot: vault, quiet: true });
		expect(fresh.getSetting("vaultore.defaultModel")).toBe("test-model");
	});

	it("reads secrets from environment with fallbacks", async () => {
		const adapter = new NodeAdapter({ vaultRoot: vault, quiet: true });
		process.env.OPENAI_API_KEY = "sk-fallback";
		try {
			expect(await adapter.getSecret("openai.apiKey")).toBe("sk-fallback");
		} finally {
			delete process.env.OPENAI_API_KEY;
		}
		expect(await adapter.getSecret("openai.apiKey")).toBeUndefined();
	});

	it("denies confirmations unless --yes", async () => {
		const denying = new NodeAdapter({ vaultRoot: vault, quiet: true });
		expect(await denying.confirm("allow?")).toBe(false);

		const granting = new NodeAdapter({ vaultRoot: vault, quiet: true, assumeYes: true });
		expect(await granting.confirm("allow?")).toBe(true);
	});
});

describe("discoverWorkflows / buildScheduleManifest", () => {
	it("finds workflow notes and skips the output folder", async () => {
		const adapter = new NodeAdapter({ vaultRoot: vault, quiet: true });
		await adapter.writeFile("Workflows/sched.md", WORKFLOW);
		await adapter.writeFile("Workflows/manual.md", UNSCHEDULED);
		await adapter.writeFile("Plain.md", "# not a workflow");
		await adapter.writeFile("_vaultore/runs/sched/x.md", WORKFLOW);

		const discovered = await discoverWorkflows(adapter);
		const paths = discovered.map((d) => d.path).sort();

		expect(paths).toEqual(["Workflows/manual.md", "Workflows/sched.md"]);
		expect(discovered[0]?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("builds a manifest containing only scheduled workflows", async () => {
		const adapter = new NodeAdapter({ vaultRoot: vault, quiet: true });
		await adapter.writeFile("Workflows/sched.md", WORKFLOW);
		await adapter.writeFile("Workflows/manual.md", UNSCHEDULED);

		const discovered = await discoverWorkflows(adapter);
		const manifest = buildScheduleManifest(discovered, vault);

		expect(manifest.format).toBe("vaultore.schedule-manifest");
		expect(manifest.version).toBe("0.1");
		expect(manifest.workflows).toHaveLength(1);

		const entry = manifest.workflows[0]!;
		expect(entry.path).toBe("Workflows/sched.md");
		expect(entry.name).toBe("Scheduled Test");
		expect(entry.schedule).toBe("0 9 * * 1-5");
		expect(entry.permissions).toEqual({ network: "deny" });
		expect(entry.contentSha256).toMatch(/^[0-9a-f]{64}$/);
	});
});
