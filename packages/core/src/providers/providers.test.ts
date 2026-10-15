import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformAdapter } from "../types";
import {
	AI_PROVIDERS,
	DEFAULT_AI_TIMEOUT_SECONDS,
	DEFAULT_MODELS,
	DEFAULT_PROVIDER,
	assertModelMatchesProvider,
	createAnthropicProvider,
	createOpenAIProvider,
	resolveProviderName,
} from "./index";

/** Minimal adapter: these tests only exercise secrets, settings and fetch. */
function adapter(settings: Record<string, unknown> = {}): PlatformAdapter {
	return {
		getSecret: async () => "test-key",
		getSetting: <T>(key: string) => settings[key] as T,
	} as unknown as PlatformAdapter;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("provider request timeouts", () => {
	it("passes an abort signal so a hung request cannot stall a workflow", async () => {
		let seenSignal: AbortSignal | undefined;
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			seenSignal = init.signal as AbortSignal;
			return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
				status: 200,
			});
		});

		const result = await createOpenAIProvider(adapter()).complete({
			model: "gpt-5-mini",
			prompt: "hi",
		});

		expect(result.content).toBe("ok");
		expect(seenSignal).toBeInstanceOf(AbortSignal);
	});

	it("reports the provider, model and configured timeout when the request times out", async () => {
		vi.stubGlobal("fetch", async () => {
			const err = new Error("The operation was aborted");
			err.name = "TimeoutError";
			throw err;
		});

		await expect(
			createOpenAIProvider(adapter({ "vaultore.aiTimeoutSeconds": 30 })).complete({
				model: "gpt-5-mini",
				prompt: "hi",
			})
		).rejects.toThrow(/OpenAI request for model "gpt-5-mini" timed out after 30s/);
	});

	// The reported failure was a bare "Failed to fetch" after 15.5 minutes, which
	// says nothing about what to do next.
	it("adds context to a bare transport failure", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new TypeError("Failed to fetch");
		});

		await expect(
			createOpenAIProvider(adapter()).complete({ model: "gpt-5-mini", prompt: "hi" })
		).rejects.toThrow(/OpenAI request for model "gpt-5-mini" failed after .*Failed to fetch.*API key/s);
	});

	it("falls back to the default timeout when the setting is absent or nonsense", async () => {
		for (const setting of [undefined, 0, -5, Number.NaN, "soon"]) {
			vi.stubGlobal("fetch", async () => {
				const err = new Error("aborted");
				err.name = "TimeoutError";
				throw err;
			});

			await expect(
				createOpenAIProvider(adapter({ "vaultore.aiTimeoutSeconds": setting })).complete({
					model: "m",
					prompt: "hi",
				})
			).rejects.toThrow(new RegExp(`timed out after ${DEFAULT_AI_TIMEOUT_SECONDS}s`));
		}
	});
});

describe("response body handling", () => {
	// The abort signal stays attached to the body stream, so a stalled body must
	// still produce the actionable message rather than a bare TimeoutError.
	it("describes a failure that happens while reading the body", async () => {
		vi.stubGlobal("fetch", async () => ({
			ok: true,
			status: 200,
			text: async () => {
				const err = new Error("The operation was aborted");
				err.name = "TimeoutError";
				throw err;
			},
		}));

		await expect(
			createOpenAIProvider(adapter({ "vaultore.aiTimeoutSeconds": 45 })).complete({
				model: "gpt-5-mini",
				prompt: "hi",
			})
		).rejects.toThrow(/OpenAI request for model "gpt-5-mini" timed out after 45s/);
	});

	it("keeps the HTTP status when the response is not ok", async () => {
		vi.stubGlobal("fetch", async () => ({
			ok: false,
			status: 429,
			text: async () => "rate limited",
		}));

		await expect(
			createOpenAIProvider(adapter()).complete({ model: "gpt-5-mini", prompt: "hi" })
		).rejects.toThrow(/OpenAI error: 429 rate limited/);
	});

	it("does not rewrite an HTTP error as a transport failure", async () => {
		vi.stubGlobal("fetch", async () => ({ ok: false, status: 500, text: async () => "" }));

		await expect(
			createOpenAIProvider(adapter()).complete({ model: "m", prompt: "hi" })
		).rejects.toThrow(/OpenAI error: 500 <empty body>/);
	});
});

// =============================================================================
// PLATFORM REQUEST (#78)
// =============================================================================

type Sent = Parameters<NonNullable<PlatformAdapter["request"]>>[0];

/** Adapter with a `request` capability that records what it was asked to send. */
function requestingAdapter(
	respond: (req: Sent) => Promise<{ status: number; text: string }>,
	settings: Record<string, unknown> = {}
) {
	const sent: Sent[] = [];
	const platform = {
		...adapter(settings),
		request: async (req: Sent) => {
			sent.push(req);
			return respond(req);
		},
	} as unknown as PlatformAdapter;
	return { platform, sent };
}

describe("requests through the platform adapter", () => {
	// Global fetch from Obsidian's renderer carries a browser Origin, which
	// Anthropic rejects; the plugin supplies requestUrl instead. Stubbed for
	// every test here so a regression cannot reach the real APIs.
	let fetchSpy: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		fetchSpy = vi.fn(async () => {
			throw new Error("global fetch must not be used when the adapter can send");
		});
		vi.stubGlobal("fetch", fetchSpy);
	});

	it("sends an OpenAI completion through adapter.request", async () => {
		const { platform, sent } = requestingAdapter(async () => ({
			status: 200,
			text: JSON.stringify({ choices: [{ message: { content: "via adapter" } }] }),
		}), { "vaultore.aiTimeoutSeconds": 30 });

		const result = await createOpenAIProvider(platform).complete({
			model: "gpt-5-mini",
			prompt: "hi",
		});

		expect(result.content).toBe("via adapter");
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(sent).toHaveLength(1);
		const [req] = sent as [Sent];
		expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
		expect(req.method).toBe("POST");
		expect(req.headers).toMatchObject({
			"Content-Type": "application/json",
			Authorization: "Bearer test-key",
		});
		expect(JSON.parse(req.body as string)).toMatchObject({
			model: "gpt-5-mini",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(req.timeoutMs).toBe(30_000);
	});

	it("sends an Anthropic message through adapter.request", async () => {
		const { platform, sent } = requestingAdapter(async () => ({
			status: 200,
			text: JSON.stringify({ content: [{ text: "claude says hi" }] }),
		}));

		const result = await createAnthropicProvider(platform).complete({
			model: "claude-haiku-4-5",
			prompt: "hi",
		});

		expect(result.content).toBe("claude says hi");
		expect(fetchSpy).not.toHaveBeenCalled();
		const [req] = sent as [Sent];
		expect(req.url).toBe("https://api.anthropic.com/v1/messages");
		expect(req.headers).toMatchObject({
			"x-api-key": "test-key",
			"anthropic-version": "2023-06-01",
		});
		expect(JSON.parse(req.body as string)).toMatchObject({ model: "claude-haiku-4-5" });
	});

	it("keeps the status and body of an HTTP error the adapter returns", async () => {
		const { platform } = requestingAdapter(async () => ({
			status: 401,
			text: '{"error":"invalid x-api-key"}',
		}));

		await expect(
			createAnthropicProvider(platform).complete({ model: "claude-haiku-4-5", prompt: "hi" })
		).rejects.toThrow(/Anthropic error: 401 \{"error":"invalid x-api-key"\}/);
	});

	it("describes a transport failure from the adapter with provider, model and elapsed time", async () => {
		const { platform } = requestingAdapter(async () => {
			throw new Error("net::ERR_INTERNET_DISCONNECTED");
		});

		await expect(
			createOpenAIProvider(platform).complete({ model: "gpt-5-mini", prompt: "hi" })
		).rejects.toThrow(
			/OpenAI request for model "gpt-5-mini" failed after \d+(\.\d)?s: net::ERR_INTERNET_DISCONNECTED/
		);
	});

	// requestUrl cannot be aborted, so the bound has to come from core.
	it("times out an adapter request that never settles", async () => {
		const { platform } = requestingAdapter(
			() => new Promise(() => undefined),
			{ "vaultore.aiTimeoutSeconds": 0.05 }
		);

		await expect(
			createOpenAIProvider(platform).complete({ model: "gpt-5-mini", prompt: "hi" })
		).rejects.toThrow(/OpenAI request for model "gpt-5-mini" timed out after 0.05s/);
	});
});

// =============================================================================
// MODEL ↔ PROVIDER (#78)
// =============================================================================

describe("model and provider resolution", () => {
	it("defines exactly one default model per provider", () => {
		expect(Object.keys(DEFAULT_MODELS).sort()).toEqual([...AI_PROVIDERS].sort());
		expect(DEFAULT_MODELS.openai).toBe("gpt-5-mini");
		expect(DEFAULT_MODELS.anthropic).toMatch(/^claude-/);
		expect(AI_PROVIDERS).toContain(DEFAULT_PROVIDER);
	});

	it("each default model passes its own provider's check", () => {
		for (const provider of AI_PROVIDERS) {
			expect(() => assertModelMatchesProvider(provider, DEFAULT_MODELS[provider])).not.toThrow();
		}
	});

	it.each([
		["openai", "claude-sonnet-4-20250514"],
		["openai", "Claude-Haiku-4-5"],
		["anthropic", "gpt-5-mini"],
		["anthropic", "o1-preview"],
		["anthropic", "o3-mini"],
		["anthropic", "o4-mini"],
	] as const)("rejects %s with model %s, naming both and the fix", (provider, model) => {
		const other = provider === "openai" ? "Anthropic" : "OpenAI";
		const own = provider === "openai" ? "OpenAI" : "Anthropic";
		expect(() => assertModelMatchesProvider(provider, model)).toThrow(
			new RegExp(
				`Model "${model}" is an ${other} model, but the configured provider is ${own}.*defaultProvider`,
				"s"
			)
		);
	});

	it.each([
		["openai", "gpt-5-mini"],
		["openai", "o3-mini"],
		["anthropic", "claude-haiku-4-5"],
		// Ids that belong to neither are the provider's to judge, not ours.
		["openai", "my-fine-tune"],
		["anthropic", "my-proxy-model"],
	] as const)("accepts %s with model %s", (provider, model) => {
		expect(() => assertModelMatchesProvider(provider, model)).not.toThrow();
	});

	it("resolves an unknown provider name to an error, not to OpenAI", () => {
		expect(() => resolveProviderName("gemini")).toThrow(
			/Unknown AI provider "gemini".*openai, anthropic/
		);
		expect(resolveProviderName(undefined)).toBe(DEFAULT_PROVIDER);
		expect(resolveProviderName("anthropic")).toBe("anthropic");
	});
});
