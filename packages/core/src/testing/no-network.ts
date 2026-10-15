import { beforeEach, vi } from "vitest";

// Vitest setup for every package's unit tests: no test reaches the network.
// A test that needs `fetch` stubs it itself (`vi.stubGlobal`), which replaces
// this one for that test; anything else fails here instead of calling a real
// API with whatever key happens to be configured.
beforeEach(() => {
	vi.stubGlobal("fetch", async (input: unknown) => {
		throw new Error(
			`Unit tests must not reach the network (fetch ${String(input)}): stub fetch in the test`
		);
	});
});
