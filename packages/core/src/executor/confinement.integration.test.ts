import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowExecutor } from "./index";
import { filesystemPlatform, makeIntegrationVaultRoot } from "../testing/integration-vault";

/**
 * The host reads and writes vault paths for a cell (`vault.write`,
 * `{{note:}}`, output files). A cell with vaultWrite can plant a symbolic
 * link through the mount; the host must not follow one out of the vault.
 * Against a real container: VAULTORE_IT_ENGINE, default colima. Both
 * directories live under $HOME, the only part colima mounts.
 *
 *   bun run --cwd packages/core test:integration
 */

let root: string;
let outside: string;
const request = vi.fn(async () => {
	throw new Error("no request may be sent");
});

beforeEach(() => {
	root = makeIntegrationVaultRoot();
	outside = makeIntegrationVaultRoot();
	mkdirSync(join(root, "notes"));
	mkdirSync(join(root, "real"));
	writeFileSync(join(root, "real/a.md"), "in the vault");
	writeFileSync(join(outside, "secret.md"), "outside the vault");
});

afterEach(() => {
	request.mockClear();
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

/** A shell cell that runs `plant`, then the cell `then` that depends on it. */
async function run(plant: string, then: string, network = "deny") {
	const content = `---
ore: true
name: it
permissions:
  network: ${network}
  vaultRead: allow
  vaultWrite: allow
---

\`\`\`ore:shell id=plant
${plant}
\`\`\`

${then}
`;
	writeFileSync(join(root, "wf.md"), content);
	const workflow = await new WorkflowExecutor().runWorkflow({
		platform: filesystemPlatform(root, {
			settings: { "vaultore.defaultProvider": "openai" },
			secrets: { "openai.apiKey": "test-key" },
			request,
		}),
		workflowPath: "wf.md",
		content,
	});
	const status = (id: string) => workflow.outputs.get(id)?.meta.status;
	return { status, value: (id: string) => String(workflow.outputs.get(id)?.value) };
}

const ts = (code: string) => `\`\`\`ore:ts id=c depends=[plant]\n${code}\n\`\`\``;

describe("the host does not follow a planted symlink out of the vault", { timeout: 180_000 }, () => {
	it("refuses vault.write through a directory symlink that points outside", async () => {
		const r = await run(
			`ln -s '${outside}' /workspace/notes/x && echo planted`,
			ts(`await vault.write("notes/x/pwned", "written through the link");\n"done"`)
		);

		expect(r.status("plant")).toBe("success");
		expect(r.status("c")).toBe("error");
		expect(r.value("c")).toContain("notes/x");
		expect(r.value("c")).toMatch(/outside the vault/);
		expect(readdirSync(outside).sort()).toEqual(["secret.md"]);
	});

	it("refuses vault.write to a file symlink that points outside", async () => {
		const r = await run(
			`ln -s '${outside}/secret.md' /workspace/notes/file.md && echo planted`,
			ts(`await vault.write("notes/file.md", "overwritten");\n"done"`)
		);

		expect(r.status("c")).toBe("error");
		expect(r.value("c")).toMatch(/symbolic link/);
		expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe("outside the vault");
	});

	it("follows a directory symlink that stays inside the vault", async () => {
		const r = await run(
			"ln -s ../real /workspace/notes/alias && echo planted",
			ts(`await vault.write("notes/alias/new.md", "through an in-vault link");\n"done"`)
		);

		expect(r.status("c")).toBe("success");
		expect(readFileSync(join(root, "real/new.md"), "utf8")).toBe("through an in-vault link");
	});

	it("refuses vault.write to a file symlink even when it points inside the vault", async () => {
		const r = await run(
			"ln -s ../real/a.md /workspace/notes/a-link.md && echo planted",
			ts(`await vault.write("notes/a-link.md", "overwritten");\n"done"`)
		);

		expect(r.status("c")).toBe("error");
		expect(r.value("c")).toMatch(/symbolic link/);
		expect(readFileSync(join(root, "real/a.md"), "utf8")).toBe("in the vault");
	});

	it("refuses {{note:}} through a planted symlink and sends nothing", async () => {
		const r = await run(
			`ln -s '${outside}' /workspace/notes/x && echo planted`,
			"```ore:ai id=c depends=[plant]\nSummarise: {{note:notes/x/secret.md}}\n```",
			"allow"
		);

		expect(r.status("plant")).toBe("success");
		expect(r.status("c")).toBe("error");
		expect(r.value("c")).toContain("notes/x/secret.md");
		expect(request).not.toHaveBeenCalled();
		expect(existsSync(join(outside, "secret.md"))).toBe(true);
	});
});
