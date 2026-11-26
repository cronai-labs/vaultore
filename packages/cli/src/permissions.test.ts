import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { otherDevices } from "./permissions";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vaultore-permissions-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("otherDevices", () => {
	it("asks again by default, applies once set, and asks again once set back", async () => {
		const path = join(dir, "settings.json");

		expect(await otherDevices(undefined, path)).toBe("permission answers from other devices: ask again here (the default)");
		expect(await otherDevices("apply", path)).toBe(`permission answers from other devices: apply here (set in ${path})`);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ decisionsFromOtherDevices: true });
		expect(await otherDevices(undefined, path)).toBe(`permission answers from other devices: apply here (set in ${path})`);
		expect(await otherDevices("ask", path)).toBe("permission answers from other devices: ask again here (the default)");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
	});

	it("keeps the other settings in the file", async () => {
		const path = join(dir, "settings.json");
		const { writeMachineSettings } = await import("@vaultore/core");
		await writeMachineSettings({ lateAfterMinutes: 15 }, { path });

		await otherDevices("apply", path);

		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ lateAfterMinutes: 15, decisionsFromOtherDevices: true });
	});

	it("refuses another value and changes nothing", async () => {
		const path = join(dir, "settings.json");

		await expect(otherDevices("yes", path)).rejects.toThrow("other-devices takes apply or ask, got 'yes'");
		expect(() => readFileSync(path)).toThrow();
	});
});
