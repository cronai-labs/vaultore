import { describe, expect, it } from "vitest";

// Two provider tests once ran before `fetch` was stubbed and reached the real
// OpenAI and Anthropic APIs. The setup file makes that a test failure.
describe("unit test network guard", () => {
	it("fails a fetch that no test stubbed", async () => {
		await expect(fetch("https://api.openai.com/v1/models")).rejects.toThrow(
			/must not reach the network/
		);
	});
});
