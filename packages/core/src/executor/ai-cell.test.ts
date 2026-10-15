import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowExecutor } from "./index";
import { DEFAULT_MODELS } from "../providers";
import type { PlatformAdapter } from "../types";

/**
 * Which model and provider an `ore:ai` cell uses (#78), through the real
 * executor and providers. The adapter's `request` is the only way out; global
 * fetch is stubbed to fail so nothing can leave the machine.
 */

vi.mock("../runtime", () => ({
	detectRuntimes: vi.fn(async () => ({ available: ["docker"], errors: new Map() })),
	execContainer: vi.fn(),
}));

type Sent = Parameters<NonNullable<PlatformAdapter["request"]>>[0];

function note(cell: string): string {
	return `---
ore: true
name: ai
permissions:
  network: allow
---

${cell}
`;
}

function vault(settings: Record<string, unknown> = {}) {
	const files: Record<string, string> = {};
	const sent: Sent[] = [];
	const platform = {
		platform: "cli",
		readFile: async (path: string) => {
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
		resolveInVault: async (path: string) => path,
		getSetting: <T>(key: string) => settings[key] as T | undefined,
		setSetting: async (key: string, value: unknown) => {
			settings[key] = value;
		},
		getSecret: async () => "sk-test",
		setSecret: async () => undefined,
		deleteSecret: async () => undefined,
		log: () => undefined,
		request: async (req: Sent) => {
			sent.push(req);
			const text = req.url.includes("anthropic")
				? JSON.stringify({ content: [{ text: "ok" }] })
				: JSON.stringify({ choices: [{ message: { content: "ok" } }] });
			return { status: 200, text };
		},
	} as unknown as PlatformAdapter;
	return { platform, files, sent };
}

async function run(cell: string, settings: Record<string, unknown> = {}) {
	const v = vault(settings);
	const content = note(cell);
	v.files["wf.md"] = content;
	const workflow = await new WorkflowExecutor().runWorkflow({
		platform: v.platform,
		workflowPath: "wf.md",
		content,
	});
	const output = workflow.outputs.get("summary");
	const sentModels = v.sent.map((req) => (JSON.parse(req.body as string) as { model: string }).model);
	return { ...v, output, sentModels };
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("global fetch must not be used");
		})
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ore:ai model and provider", () => {
	it("fails a Claude model on the OpenAI provider before any request", async () => {
		const { output, sent } = await run(
			"```ore:ai id=summary model=claude-sonnet-4-20250514\nSay hi.\n```"
		);

		expect(output?.meta.status).toBe("error");
		expect(output?.meta.error).toMatch(
			/Model "claude-sonnet-4-20250514" is an Anthropic model, but the configured provider is OpenAI/
		);
		expect(sent).toHaveLength(0);
	});

	it("fails a GPT model on the Anthropic provider before any request", async () => {
		const { output, sent } = await run("```ore:ai id=summary model=gpt-5-mini\nSay hi.\n```", {
			"vaultore.defaultProvider": "anthropic",
		});

		expect(output?.meta.status).toBe("error");
		expect(output?.meta.error).toMatch(
			/Model "gpt-5-mini" is an OpenAI model, but the configured provider is Anthropic/
		);
		expect(sent).toHaveLength(0);
	});

	it("fails an unknown provider instead of sending to OpenAI", async () => {
		const { output, sent } = await run("```ore:ai id=summary\nSay hi.\n```", {
			"vaultore.defaultProvider": "gemini",
		});

		expect(output?.meta.status).toBe("error");
		expect(output?.meta.error).toMatch(/Unknown AI provider "gemini"/);
		expect(sent).toHaveLength(0);
	});

	it("uses the OpenAI default model when neither cell nor settings name one", async () => {
		const { output, sentModels, sent } = await run("```ore:ai id=summary\nSay hi.\n```");

		expect(output?.meta.status).toBe("success");
		expect(sentModels).toEqual([DEFAULT_MODELS.openai]);
		expect(sent[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
	});

	it("uses the Anthropic default model when the provider is Anthropic", async () => {
		const { output, sentModels, sent } = await run("```ore:ai id=summary\nSay hi.\n```", {
			"vaultore.defaultProvider": "anthropic",
		});

		expect(output?.meta.status).toBe("success");
		expect(sentModels).toEqual([DEFAULT_MODELS.anthropic]);
		expect(sent[0]?.url).toBe("https://api.anthropic.com/v1/messages");
	});

	it("prefers the cell's model over the configured default", async () => {
		const { sentModels } = await run("```ore:ai id=summary model=o3-mini\nSay hi.\n```", {
			"vaultore.defaultModel": "gpt-5-mini",
		});

		expect(sentModels).toEqual(["o3-mini"]);
	});
});
