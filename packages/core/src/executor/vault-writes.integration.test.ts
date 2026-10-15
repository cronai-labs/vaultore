import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowExecutor } from "./index";
import { filesystemPlatform, makeIntegrationVaultRoot } from "../testing/integration-vault";

/**
 * `vault.write` applied by the host with compare-and-swap (#83), against a
 * real container. Needs a running engine: VAULTORE_IT_ENGINE, default colima.
 * The stale-view test is meant for colima with sshfs file sharing, where #83
 * was seen; elsewhere it passes without ever seeing a stale copy.
 *
 *   bun run --cwd packages/core test:integration
 */

let root: string;

beforeAll(() => {
	root = makeIntegrationVaultRoot();
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

const path = (rel: string) => join(root, rel);
const read = (rel: string) => readFileSync(path(rel), "utf8");

/** Run one `ore:ts` cell with vaultRead and vaultWrite. */
async function runCell(code: string) {
	const content = `---
ore: true
name: it
permissions:
  network: deny
  vaultRead: allow
  vaultWrite: allow
---

\`\`\`ore:ts id=c
${code}
\`\`\`
`;
	writeFileSync(path("wf.md"), content);
	const workflow = await new WorkflowExecutor().runWorkflow({
		platform: filesystemPlatform(root),
		workflowPath: "wf.md",
		content,
	});
	const output = workflow.outputs.get("c");
	return { status: output?.meta.status, value: output?.value };
}

/** Wait until the cell has created `marker` through the mount. */
async function waitFor(marker: string, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path(marker))) {
		if (Date.now() > deadline) throw new Error(`the cell never wrote ${marker}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("vault.write is applied by the host", { timeout: 180_000 }, () => {
	it("a read-modify-write succeeds when nobody touched the note", async () => {
		writeFileSync(path("plain.md"), "line 1\n");

		const r = await runCell(`const text = await vault.read("plain.md");
await vault.write("plain.md", text + "line 2\\n");
text.length`);

		expect(r.status).toBe("success");
		expect(r.value).toBe(7);
		expect(read("plain.md")).toBe("line 1\nline 2\n");
	});

	it("refuses to overwrite a note the user edited after the cell read it, and applies nothing", async () => {
		writeFileSync(path("edited.md"), "- [ ] a\n");
		const run = runCell(`const text = await vault.read("edited.md");
await Bun.write("/workspace/edited.marker", "read");
await Bun.sleep(5000);
await vault.write("side-effect.md", "written by the cell");
await vault.write("edited.md", text.replace("[ ]", "[x]"));
"done"`);

		await waitFor("edited.marker");
		writeFileSync(path("edited.md"), "- [ ] a\n- [ ] typed during the run\n");
		const r = await run;

		expect(r.status).toBe("error");
		expect(String(r.value)).toContain("edited.md changed since this cell read it");
		expect(read("edited.md")).toBe("- [ ] a\n- [ ] typed during the run\n");
		expect(existsSync(path("side-effect.md"))).toBe(false);
	});

	it("refuses to overwrite a note created after the cell found it missing", async () => {
		const run = runCell(`const found = await vault.exists("created.md");
await Bun.write("/workspace/created.marker", "checked");
await Bun.sleep(5000);
if (!found) await vault.write("created.md", "from the cell");
found`);

		await waitFor("created.marker");
		writeFileSync(path("created.md"), "the user's note");
		const r = await run;

		expect(r.status).toBe("error");
		expect(String(r.value)).toContain("created.md exists now");
		expect(read("created.md")).toBe("the user's note");
	});

	it("a cell reads its own pending writes", async () => {
		const r = await runCell(`await vault.write("ryw.md", "first");
const seen = await vault.read("ryw.md");
const exists = await vault.exists("ryw.md");
await vault.write("ryw.md", seen + " second");
({ seen, exists, last: await vault.read("ryw.md") })`);

		expect(r.status).toBe("success");
		expect(r.value).toEqual({ seen: "first", exists: true, last: "first second" });
		expect(read("ryw.md")).toBe("first second");
	});

	it("carries non-ASCII text across the hand-off unchanged", async () => {
		// Large enough to cross several 64 KiB pipe reads, so a character split
		// between two of them is near certain.
		const r = await runCell(`await vault.write("umlauts.md", "äöü€😀".repeat(40000) + "end");
"ok"`);

		expect(r.status).toBe("success");
		expect(read("umlauts.md")).toBe(`${"äöü€😀".repeat(40000)}end`);
	});

	it("fails a cell that writes something other than text", async () => {
		const r = await runCell(`await vault.write("bytes.md", new Uint8Array([104, 105]));
"ok"`);

		expect(r.status).toBe("error");
		expect(String(r.value)).toContain("vault.write takes text");
		expect(existsSync(path("bytes.md"))).toBe(false);
	});

	it("fails a cell that exits before handing its writes over, and writes nothing", async () => {
		const r = await runCell(`await vault.write("exited.md", "x");
process.exit(0);`);

		expect(r.status).toBe("error");
		expect(String(r.value)).toContain("exited before VaultOre could apply its 1 vault.write");
		expect(existsSync(path("exited.md"))).toBe(false);
	});

	it("never persists a truncated note when the container sees a stale copy (#83)", async () => {
		// The host rewrites the note longer and a cell reads it right away and
		// writes it back with a line added. On colima with sshfs the container can
		// see the new text cut off at the old length; the write must then be
		// refused, never applied.
		writeFileSync(path("stale.md"), "start\n");
		await runCell(`(await vault.read("stale.md")).length`);

		const outcomes: string[] = [];
		for (let i = 0; i < 5; i += 1) {
			const before = `${read("stale.md")}${`host line ${i} `.repeat(20)}\n`;
			writeFileSync(path("stale.md"), before);
			const r = await runCell(`const text = await vault.read("stale.md");
await vault.write("stale.md", text + "cell line ${i}\\n");
text.length`);
			const after = read("stale.md");

			if (r.status === "success") {
				expect(r.value).toBe(before.length);
				expect(after).toBe(`${before}cell line ${i}\n`);
				outcomes.push("applied");
			} else {
				expect(String(r.value)).toContain("stale.md changed since this cell read it");
				expect(after).toBe(before);
				outcomes.push("refused");
			}
		}
		console.log(`#83 stale-view loop: ${outcomes.join(", ")}`);
	});
});
