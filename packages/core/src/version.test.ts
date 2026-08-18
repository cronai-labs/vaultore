import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "./index";

/**
 * VERSION is a literal so it survives bundling, which means nothing stops it
 * drifting from the package it ships in. version-bump.mjs rewrites it; this
 * test is what makes forgetting to run version-bump a red build rather than a
 * `vaultore --version` that quietly lies.
 */
describe("VERSION", () => {
	const pkg = JSON.parse(
		readFileSync(resolve(__dirname, "../package.json"), "utf8")
	) as { version: string };

	it("matches the package version", () => {
		expect(VERSION).toBe(pkg.version);
	});

	it("is a plain semver triple", () => {
		expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
