import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowExecutor } from "./index";
import type { ContainerExecOptions, PlatformAdapter } from "../types";

/**
 * `vault.write` in a TS cell is applied by the host, not through the mount
 * (#83). The cell hands its writes over on stdout after its output; the host
 * checks each one against the note as it is now and applies all of them, or
 * none. The container is mocked: each test hands over the writes a cell would
 * have made. The in-container half runs in vault-writes.integration.test.ts.
 */

vi.mock("../runtime", () => ({
	detectRuntimes: vi.fn(async () => ({ available: ["docker"], errors: new Map() })),
	execContainer: vi.fn(),
}));

import { execContainer } from "../runtime";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type Base = { sha256: string } | { absent: true } | null;
interface Write {
	path: string;
	content: string;
	base: Base;
}

/** The nonce of the cell the mocked container is running, from its script. */
let nonce = "";

/** A block as the runtime frames it: start marker, one line, end marker. */
function block(kind: "OUTPUT" | "WRITES", payload: string, key = nonce): string {
	return [`__VAULTORE_${kind}_START_${key}__`, payload, `__VAULTORE_${kind}_END_${key}__`].join("\n");
}

/** What a TS cell prints when it ends: its output, then its pending writes. */
function stdout(writes: Write[] | string, value: unknown = "done"): string {
	const payload = typeof writes === "string" ? writes : JSON.stringify(writes);
	return ["some log line", block("OUTPUT", JSON.stringify(value)), block("WRITES", payload), ""].join("\n");
}

/** The container exits with `exitCode` and prints what `print` returns for its options. */
function container(print: (opts: ContainerExecOptions) => string, exitCode = 0) {
	vi.mocked(execContainer).mockImplementation(async (_engine, opts) => {
		nonce = /__VAULTORE_OUTPUT_START_([0-9a-f]{32})__/.exec(opts.stdin ?? "")?.[1] ?? "";
		return {
			exitCode,
			stdout: print(opts),
			stderr: exitCode === 0 ? "" : "boom",
			duration: 1,
		};
	});
}

function note(read: string, write: string): string {
	return `---
ore: true
name: t
permissions:
  network: deny
  vaultRead: ${read}
  vaultWrite: ${write}
---

\`\`\`ore:ts id=c
1
\`\`\`
`;
}

/**
 * In-memory vault recording the order of writes outside the run directory and
 * every path read. `links` stands in for symbolic links: resolveInVault maps a
 * path to where it really leads, or refuses it with the Error given.
 */
function vault(
	files: Record<string, string>,
	links: Record<string, string | Error> = {},
	configDir = ".obsidian"
) {
	const written: string[] = [];
	const reads: string[] = [];
	const platform = {
		platform: "cli",
		configDir,
		readFile: async (path: string) => {
			reads.push(path);
			if (!(path in files)) throw new Error(`File not found: ${path}`);
			return files[path] as string;
		},
		writeFile: async (path: string, content: string) => {
			if (!path.startsWith("_vaultore/") && path !== "wf.md") written.push(path);
			files[path] = content;
		},
		exists: async (path: string) =>
			path in files || Object.keys(files).some((file) => file.startsWith(`${path}/`)),
		mkdirp: async () => undefined,
		listFiles: async () => [],
		getVaultRoot: async () => "/vault",
		resolveInVault: async (path: string) => {
			const link = links[path];
			if (link instanceof Error) throw link;
			return link ?? path;
		},
		getSetting: () => undefined,
		setSetting: async () => undefined,
		getSecret: async () => undefined,
		setSecret: async () => undefined,
		deleteSecret: async () => undefined,
		log: () => undefined,
	} as unknown as PlatformAdapter;
	return { platform, files, written, reads };
}

async function run(
	files: Record<string, string>,
	read = "allow",
	write = "allow",
	links: Record<string, string | Error> = {},
	configDir?: string
) {
	const content = note(read, write);
	const v = vault({ "wf.md": content, ...files }, links, configDir);
	const workflow = await new WorkflowExecutor().runWorkflow({
		platform: v.platform,
		workflowPath: "wf.md",
		content,
	});
	const output = workflow.outputs.get("c");
	return { ...v, status: output?.meta.status, value: output?.value };
}

beforeEach(() => {
	vi.mocked(execContainer).mockReset();
});

describe("compare-and-swap", () => {
	it("applies a write whose base is the note as it is now", async () => {
		container(() =>
			stdout([{ path: "Inbox.md", content: "- [x] a\n", base: { sha256: sha("- [ ] a\n") } }])
		);

		const r = await run({ "Inbox.md": "- [ ] a\n" });

		expect(r.status).toBe("success");
		expect(r.value).toBe("done");
		expect(r.files["Inbox.md"]).toBe("- [x] a\n");
	});

	it("fails the cell and applies none of its writes when one note changed since it was read", async () => {
		container(() =>
			stdout([
				{ path: "Processed/Work.md", content: "filed", base: null },
				{ path: "Inbox.md", content: "- [x] a\n", base: { sha256: sha("- [ ] a\n") } },
			])
		);

		// The user added a line after the cell read the inbox, or the container
		// saw a copy cut off at the old length (#83).
		const r = await run({ "Inbox.md": "- [ ] a\n- [ ] b\n" });

		expect(r.status).toBe("error");
		expect(String(r.value)).toContain("Inbox.md");
		expect(String(r.value)).toContain("changed since this cell read it");
		expect(String(r.value)).toContain("#83");
		expect(r.files["Inbox.md"]).toBe("- [ ] a\n- [ ] b\n");
		expect(r.files["Processed/Work.md"]).toBeUndefined();
		expect(r.written).toEqual([]);
	});

	it("names every note that changed", async () => {
		container(() =>
			stdout([
				{ path: "a.md", content: "A", base: { sha256: sha("a") } },
				{ path: "b.md", content: "B", base: { sha256: sha("b") } },
			])
		);

		const r = await run({ "a.md": "a edited", "b.md": "b edited" });

		expect(r.status).toBe("error");
		expect(String(r.value)).toContain("a.md");
		expect(String(r.value)).toContain("b.md");
		expect(r.written).toEqual([]);
	});

	it("refuses to overwrite a note that was created after the cell found it missing", async () => {
		container(() => stdout([{ path: "new.md", content: "mine", base: { absent: true } }]));

		const r = await run({ "new.md": "the user's" });

		expect(r.status).toBe("error");
		expect(String(r.value)).toContain("new.md");
		expect(String(r.value)).toMatch(/exists now/);
		expect(r.files["new.md"]).toBe("the user's");
	});

	it("refuses to recreate a note that was deleted after the cell read it", async () => {
		container(() => stdout([{ path: "gone.md", content: "edited", base: { sha256: sha("x") } }]));

		const r = await run({});

		expect(r.status).toBe("error");
		expect(String(r.value)).toContain("gone.md");
		expect(String(r.value)).toMatch(/no longer exists/);
		expect(r.files["gone.md"]).toBeUndefined();
	});

	it("creates a note the cell found missing and that is still missing", async () => {
		container(() => stdout([{ path: "Processed/Work.md", content: "filed", base: { absent: true } }]));

		const r = await run({});

		expect(r.status).toBe("success");
		expect(r.files["Processed/Work.md"]).toBe("filed");
	});

	it("applies a write without a base as given: the cell never read that note", async () => {
		container(() => stdout([{ path: "out.md", content: "new", base: null }]));

		const r = await run({ "out.md": "whatever was there" });

		expect(r.status).toBe("success");
		expect(r.files["out.md"]).toBe("new");
	});

	it("applies the writes in the order the cell made them", async () => {
		container(() =>
			stdout([
				{ path: "z.md", content: "1", base: null },
				{ path: "a.md", content: "2", base: null },
				{ path: "m.md", content: "3", base: null },
			])
		);

		const r = await run({});

		expect(r.status).toBe("success");
		expect(r.written).toEqual(["z.md", "a.md", "m.md"]);
	});

	it("compares a note with a byte-order mark as Bun's text() reads it, without the mark", async () => {
		container(() => stdout([{ path: "bom.md", content: "edited", base: { sha256: sha("text") } }]));

		const r = await run({ "bom.md": "\uFEFFtext" });

		expect(r.status).toBe("success");
		expect(r.files["bom.md"]).toBe("edited");
	});

	it("keeps output that has no hand-off block", async () => {
		container(() => `${block("OUTPUT", '"done"')}\n`);

		const r = await run({});

		expect(r.status).toBe("success");
		expect(r.value).toBe("done");
		expect(r.written).toEqual([]);
	});

	it("applies nothing when the cell failed", async () => {
		container(() => stdout([{ path: "out.md", content: "new", base: null }]), 1);

		const r = await run({ "out.md": "old" });

		expect(r.status).toBe("error");
		expect(r.files["out.md"]).toBe("old");
	});

	for (const [label, payload] of [
		["not JSON", "[{"],
		["not a list", JSON.stringify({ path: "a.md", content: "x", base: null })],
		["content that is not text", JSON.stringify([{ path: "a.md", content: 1, base: null }])],
		["a malformed base", JSON.stringify([{ path: "a.md", content: "x", base: { sha256: "nope" } }])],
		[
			"the same note twice",
			JSON.stringify([
				{ path: "a.md", content: "x", base: null },
				{ path: "a.md", content: "y", base: null },
			]),
		],
	] as const) {
		it(`fails the cell on a hand-off with ${label}`, async () => {
			container(() => stdout(payload));

			const r = await run({ "a.md": "old" });

			expect(r.status).toBe("error");
			expect(String(r.value)).toMatch(/vault\.write hand-off/);
			expect(r.files["a.md"]).toBe("old");
		});
	}
});

describe("the output framing carries a per-run nonce (#125)", () => {
	const forged = JSON.stringify([{ path: "forged.md", content: "forged", base: null }]);
	const real = JSON.stringify([{ path: "real.md", content: "real", base: null }]);
	const guessed = "0".repeat(32);

	it("frames every cell with a fresh 128-bit nonce", async () => {
		const seen: string[] = [];
		container(() => {
			seen.push(nonce);
			return stdout([]);
		});

		await run({});
		await run({});

		expect(seen).toHaveLength(2);
		for (const key of seen) expect(key).toMatch(/^[0-9a-f]{32}$/);
		expect(seen[0]).not.toBe(seen[1]);
	});

	it("ignores blocks the cell logged without this run's nonce, before and after the real ones", async () => {
		container(() =>
			[
				["__VAULTORE_WRITES_START__", forged, "__VAULTORE_WRITES_END__"].join("\n"),
				block("WRITES", forged, guessed),
				block("OUTPUT", '"done"'),
				block("WRITES", real),
				["__VAULTORE_WRITES_START__", forged, "__VAULTORE_WRITES_END__"].join("\n"),
				block("OUTPUT", '"forged value"', guessed),
				block("WRITES", forged, guessed),
			].join("\n")
		);

		const r = await run({});

		expect(r.status).toBe("success");
		expect(r.value).toBe("done");
		expect(r.written).toEqual(["real.md"]);
	});

	it("keeps a value that contains the old fixed end marker", async () => {
		const value = "a __VAULTORE_OUTPUT_END__ b\n__VAULTORE_OUTPUT_END__\nc";
		container(() => stdout([], value));

		const r = await run({});

		expect(r.status).toBe("success");
		expect(r.value).toBe(value);
	});

	for (const [label, print] of [
		["a second writes block with this run's nonce", () => `${stdout([])}${block("WRITES", forged)}\n`],
		["a second output block", () => `${stdout([])}${block("OUTPUT", '"again"')}\n`],
		["a writes block before the output block", () => `${block("WRITES", forged)}\n${block("OUTPUT", '"done"')}\n`],
		["an output block without its end", () => `${block("OUTPUT", '"done"').split("\n").slice(0, 2).join("\n")}\n`],
	] as const) {
		it(`fails the cell on ${label}, and applies nothing`, async () => {
			container(print);

			const r = await run({});

			expect(r.status).toBe("error");
			expect(String(r.value)).toMatch(/framing is broken/);
			expect(r.written).toEqual([]);
		});
	}
});

describe("the host enforces what vault.write may touch", () => {
	for (const path of [
		"../outside.md",
		"notes/../../outside.md",
		"notes\\..\\..\\outside.md",
		"/etc/passwd",
		"C:/Windows/win.ini",
		"",
	]) {
		it(`refuses ${JSON.stringify(path)}, outside the vault, and applies nothing`, async () => {
			container(() =>
				stdout([
					{ path: "fine.md", content: "x", base: null },
					{ path, content: "x", base: null },
				])
			);

			const r = await run({});

			expect(r.status).toBe("error");
			expect(String(r.value)).toMatch(/outside the vault/);
			expect(r.written).toEqual([]);
		});
	}

	for (const path of [
		".obsidian/plugins/vaultore/main.js",
		".obsidian",
		".vaultore/config.json",
		"./.vaultore/config.json",
		".Obsidian/plugins/vaultore/main.js",
	]) {
		it(`refuses ${path}`, async () => {
			container(() => stdout([{ path, content: "x", base: null }]));

			const r = await run({});

			expect(r.status).toBe("error");
			expect(String(r.value)).toMatch(/\.obsidian|\.vaultore/i);
			expect(r.written).toEqual([]);
		});
	}

	// Obsidian's config folder can be overridden (Vault#configDir). The
	// configured folder is refused, and so is the default one, which can hold
	// another device's config.
	for (const path of [".config-desk/plugins/vaultore/main.js", ".Config-Desk/x", ".obsidian/plugins/other/main.js"]) {
		it(`refuses ${path} when the config folder is .config-desk`, async () => {
			container(() => stdout([{ path, content: "x", base: null }]));

			const r = await run({}, "allow", "allow", {}, ".config-desk");

			expect(r.status).toBe("error");
			expect(String(r.value)).toMatch(/\.config-desk|\.obsidian/i);
			expect(r.written).toEqual([]);
		});
	}

	it("refuses every write under vaultWrite: deny, even one the cell handed over itself", async () => {
		container(() => stdout([{ path: "note.md", content: "x", base: null }]));

		const r = await run({}, "allow", "deny");

		expect(r.status).toBe("error");
		expect(String(r.value)).toMatch(/vault write permission denied/i);
		expect(r.written).toEqual([]);
	});

	it("without vaultRead, refuses a write outside this run's directory", async () => {
		container((opts) =>
			stdout([
				{ path: `${opts.env?.VAULTORE_RUN_DIR}/out.txt`, content: "x", base: null },
				{ path: "elsewhere.md", content: "x", base: null },
			])
		);

		const r = await run({}, "deny", "allow");

		expect(r.status).toBe("error");
		expect(String(r.value)).toContain("outside this run's directory");
		expect(r.files["elsewhere.md"]).toBeUndefined();
		expect(Object.keys(r.files).some((path) => path.endsWith("/out.txt"))).toBe(false);
	});

	it("without vaultRead, applies a write inside this run's directory", async () => {
		let runDir = "";
		container((opts) => {
			runDir = String(opts.env?.VAULTORE_RUN_DIR);
			return stdout([{ path: `${runDir}/out.txt`, content: "x", base: null }]);
		});

		const r = await run({}, "deny", "allow");

		expect(r.status).toBe("success");
		expect(r.files[`${runDir}/out.txt`]).toBe("x");
	});

	it("without vaultRead, refuses a path that climbs out of the run directory", async () => {
		container((opts) =>
			stdout([{ path: `${opts.env?.VAULTORE_RUN_DIR}/../../other/x.md`, content: "x", base: null }])
		);

		const r = await run({}, "deny", "allow");

		expect(r.status).toBe("error");
		expect(Object.keys(r.files).some((path) => path.includes("other"))).toBe(false);
	});
});

describe("symbolic links a cell may have planted", () => {
	const outside = (path: string) =>
		new Error(`${path} leads outside the vault through the symbolic link notes/x; refused`);

	it("refuses a write whose path leads outside the vault, and applies none of the cell's writes", async () => {
		container(() =>
			stdout([
				{ path: "fine.md", content: "x", base: null },
				{ path: "notes/x/authorized_keys", content: "ssh-ed25519 AAAA", base: null },
			])
		);

		const r = await run({}, "allow", "allow", { "notes/x/authorized_keys": outside("notes/x/authorized_keys") });

		expect(r.status).toBe("error");
		expect(String(r.value)).toContain("notes/x/authorized_keys leads outside the vault");
		expect(r.written).toEqual([]);
	});

	it("does not read a note through such a link to compare it", async () => {
		container(() =>
			stdout([{ path: "notes/x/id_rsa", content: "x", base: { sha256: sha("guess") } }])
		);

		const r = await run({ "notes/x/id_rsa": "a private key" }, "allow", "allow", {
			"notes/x/id_rsa": outside("notes/x/id_rsa"),
		});

		expect(r.status).toBe("error");
		expect(r.reads).not.toContain("notes/x/id_rsa");
		expect(r.files["notes/x/id_rsa"]).toBe("a private key");
	});

	it("refuses a write that an in-vault link leads into .obsidian/", async () => {
		container(() => stdout([{ path: "notes/cfg/main.js", content: "x", base: null }]));

		const r = await run({}, "allow", "allow", {
			"notes/cfg/main.js": ".obsidian/plugins/vaultore/main.js",
		});

		expect(r.status).toBe("error");
		expect(String(r.value)).toMatch(/\.obsidian/);
		expect(r.written).toEqual([]);
	});

	it("writes through an in-vault link to the real path", async () => {
		container(() => stdout([{ path: "notes/alias/new.md", content: "x", base: null }]));

		const r = await run({}, "allow", "allow", { "notes/alias/new.md": "real/new.md" });

		expect(r.status).toBe("success");
		expect(r.written).toEqual(["real/new.md"]);
	});

	it("refuses two writes that lead to the same note", async () => {
		container(() =>
			stdout([
				{ path: "real/a.md", content: "1", base: null },
				{ path: "notes/alias/a.md", content: "2", base: null },
			])
		);

		const r = await run({}, "allow", "allow", { "notes/alias/a.md": "real/a.md" });

		expect(r.status).toBe("error");
		expect(String(r.value)).toContain("notes/alias/a.md is real/a.md");
		expect(r.written).toEqual([]);
	});

	it("without vaultRead, refuses a link in the run directory that leads elsewhere in the vault", async () => {
		let runDir = "";
		container((opts) => {
			runDir = String(opts.env?.VAULTORE_RUN_DIR);
			return stdout([{ path: `${runDir}/up/note.md`, content: "x", base: null }]);
		});
		const v = vault({ "wf.md": note("deny", "allow") });
		// The link's real target is only known once the run directory is.
		const resolveInVault = v.platform.resolveInVault.bind(v.platform);
		v.platform.resolveInVault = async (path: string) =>
			path === `${runDir}/up/note.md` ? "Private/note.md" : resolveInVault(path);

		const workflow = await new WorkflowExecutor().runWorkflow({
			platform: v.platform,
			workflowPath: "wf.md",
			content: note("deny", "allow"),
		});

		const output = workflow.outputs.get("c");
		expect(output?.meta.status).toBe("error");
		expect(String(output?.value)).toContain("outside this run's directory");
		expect(v.files["Private/note.md"]).toBeUndefined();
	});

	it("skips a recorded output whose path leads outside the vault, and says so", async () => {
		container(() => stdout([]));
		const logs: string[] = [];
		const content = `${note("allow", "allow")}
> [!ore-output] old
> json: [[notes/x/secrets.json]]
`;
		const v = vault({ "wf.md": content, "notes/x/secrets.json": '{"cellId":"old","meta":{"status":"success"},"value":"secret"}' }, {
			"notes/x/secrets.json": outside("notes/x/secrets.json"),
		});
		(v.platform as { log: unknown }).log = (_level: string, message: string) => logs.push(message);

		const workflow = await new WorkflowExecutor().runWorkflow({
			platform: v.platform,
			workflowPath: "wf.md",
			content,
		});

		expect(workflow.outputs.has("old")).toBe(false);
		expect(v.reads).not.toContain("notes/x/secrets.json");
		expect(logs.join("\n")).toContain("notes/x/secrets.json leads outside the vault");
	});

	it("does not run a workflow whose note is a link", async () => {
		container(() => stdout([]));
		const content = note("allow", "allow");
		const v = vault({ "wf.md": content }, {
			"wf.md": new Error("wf.md is a symbolic link; VaultOre does not read or write through one"),
		});

		await expect(
			new WorkflowExecutor().runWorkflow({ platform: v.platform, workflowPath: "wf.md", content })
		).rejects.toThrow(/wf\.md is a symbolic link/);
		expect(v.files["wf.md"]).toBe(content);
		expect(vi.mocked(execContainer)).not.toHaveBeenCalled();
	});

	it("refuses to run on a platform that cannot resolve vault paths", async () => {
		container(() => stdout([{ path: "out.md", content: "x", base: null }]));
		const content = note("allow", "allow");
		const v = vault({ "wf.md": content });
		delete (v.platform as { resolveInVault?: unknown }).resolveInVault;

		await expect(
			new WorkflowExecutor().runWorkflow({ platform: v.platform, workflowPath: "wf.md", content })
		).rejects.toThrow(/no resolveInVault/);
		expect(v.files["out.md"]).toBeUndefined();
		expect(vi.mocked(execContainer)).not.toHaveBeenCalled();
	});
});
