import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRequest } from "./fetch-request";

const request = {
	url: "https://api.openai.com/v1/chat/completions",
	method: "POST",
	headers: { Authorization: "Bearer k" },
	body: "{}",
	timeoutMs: 5000,
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fetchRequest", () => {
	it("passes an abort signal so a hung request cannot stall a workflow", async () => {
		let seenSignal: AbortSignal | undefined;
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			seenSignal = init.signal as AbortSignal;
			return new Response("ok", { status: 200 });
		});

		expect(await fetchRequest(request)).toEqual({ status: 200, text: "ok" });
		expect(seenSignal).toBeInstanceOf(AbortSignal);
	});

	// The abort signal stays attached to the body stream, so a body that stalls
	// after the headers must reject like a timeout rather than hang.
	it("rejects when reading the body times out", async () => {
		vi.stubGlobal("fetch", async () => ({
			status: 200,
			text: async () => {
				const err = new Error("The operation was aborted");
				err.name = "TimeoutError";
				throw err;
			},
		}));

		await expect(fetchRequest(request)).rejects.toMatchObject({ name: "TimeoutError" });
	});
});
