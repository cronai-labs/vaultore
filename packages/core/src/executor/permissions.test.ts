import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowExecutor } from "./index";
import type { PlatformAdapter } from "../types";

/**
 * Permission enforcement through the same path `vaultore run` uses: the real
 * executor and provider, with the container runtime mocked and `fetch` stubbed
 * so a test can see exactly what would have left the machine.
 */

vi.mock("../runtime", () => ({
	detectRuntimes: vi.fn(async () => ({ available: ["docker"], errors: new Map() })),
	execContainer: vi.fn(),
}));

import { execContainer } from "../runtime";

const SECRET = "the contents of a private note";

function note(permissions: string, body: string): string {
	return `---
ore: true
name: repro
permissions:
${permissions}
---

${body}
`;
}

/** In-memory vault and settings store. */
function vault(files: Record<string, string>) {
	const settings = new Map<string, unknown>();
	const reads: string[] = [];
	const platform = {
		platform: "cli",
		readFile: async (path: string) => {
			reads.push(path);
			if (!(path in files)) throw new Error(`File not found: ${path}`);
			return files[path] as string;
		},
		writeFile: async (path: string, content: string) => {
			files[path] = content;
		},
		exists: async (path: string) => path in files,
		mkdirp: async () => undefined,
		listFiles: async () => [],
		getVaultRoot: async () => "/vault",
		getSetting: <T>(key: string) => settings.get(key) as T | undefined,
		setSetting: async (key: string, value: unknown) => {
			settings.set(key, value);
		},
		getSecret: async () => "sk-test",
		setSecret: async () => undefined,
		deleteSecret: async () => undefined,
		log: () => undefined,
	} as unknown as PlatformAdapter;
	return { platform, files, reads, settings };
}

let requests: string[];

beforeEach(() => {
	requests = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: { body: string }) => {
			requests.push(init.body);
			return new Response(
				JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
				{ status: 200 }
			);
		})
	);
	vi.mocked(execContainer).mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function run(content: string, files: Record<string, string> = {}) {
	const v = vault({ "Private/secret.md": SECRET, "wf.md": content, ...files });
	const workflow = await new WorkflowExecutor().runWorkflow({
		platform: v.platform,
		workflowPath: "wf.md",
		content,
	});
	return { ...v, workflow };
}

describe("{{note:}} in AI cells (#67)", () => {
	it("fails the cell under vaultRead: deny and sends nothing", async () => {
		const { workflow, reads } = await run(
			note(
				"  network: allow\n  vaultRead: deny",
				"```ore:ai id=summary\nSummarise: {{note:Private/secret.md}}\n```"
			)
		);

		const output = workflow.outputs.get("summary");
		expect(output?.meta.status).toBe("error");
		expect(String(output?.value)).toMatch(/vault read permission denied/i);
		expect(reads).not.toContain("Private/secret.md");
		expect(requests).toEqual([]);
	});

	it("does not resolve a note reference arriving through an upstream output", async () => {
		vi.mocked(execContainer).mockResolvedValue({
			exitCode: 0,
			stdout: "{{note:Private/secret.md}}",
			stderr: "",
		} as never);

		const { workflow, reads } = await run(
			note(
				"  network: allow\n  vaultRead: allow",
				[
					"```ore:shell id=fetched",
					"echo",
					"```",
					"",
					"```ore:ai id=summary depends=[fetched]",
					"Summarise: {{fetched}}",
					"```",
				].join("\n")
			)
		);

		expect(workflow.outputs.get("summary")?.meta.status).toBe("success");
		expect(reads).not.toContain("Private/secret.md");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("{{note:Private/secret.md}}");
		expect(requests[0]).not.toContain(SECRET);
	});

	it("sends the note under vaultRead: allow", async () => {
		const { workflow } = await run(
			note(
				"  network: allow\n  vaultRead: allow",
				"```ore:ai id=summary\nSummarise: {{note:Private/secret.md}}\n```"
			)
		);

		expect(workflow.outputs.get("summary")?.meta.status).toBe("success");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain(SECRET);
	});

	it("fails the cell when a referenced note does not exist", async () => {
		const { workflow } = await run(
			note(
				"  network: allow\n  vaultRead: allow",
				"```ore:ai id=summary\nSummarise: {{note:Moved.md}}\n```"
			)
		);

		const output = workflow.outputs.get("summary");
		expect(output?.meta.status).toBe("error");
		expect(String(output?.value)).toContain("Moved.md");
		expect(requests).toEqual([]);
	});
});
