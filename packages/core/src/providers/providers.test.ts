import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformAdapter } from "../types";
import { DEFAULT_AI_TIMEOUT_SECONDS, createOpenAIProvider } from "./index";

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
