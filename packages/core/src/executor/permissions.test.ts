import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowExecutor } from "./index";
import { nodeTimers } from "../testing/timers";
import type { PlatformAdapter } from "../types";

/**
 * Permission enforcement through the same path `vaultore run` uses: the real
 * executor and provider, with the container runtime mocked and the adapter's
 * `request` recording, so a test can see exactly what would have left the
 * machine.
 */

vi.mock("../runtime", () => ({
	detectRuntimes: vi.fn(async () => ({ available: ["docker"], errors: new Map() })),
	execContainer: vi.fn(),
}));

import { execContainer } from "../runtime";
import { memoryRunLocks } from "../testing/run-locks";
import { mirrorToDisk } from "../testing/disk-mirror";
import { answersStore } from "../settings/answers";

const SECRET = "the contents of a private note";

function note(permissions: string, body: string): string {
	return `---
ore: true
name: repro
permissions:
${permissions}
---

${body}
`;
}

/**
 * In-memory vault and settings store. `links` and `redirects` stand in for
 * symbolic links: resolveInVault refuses a path mapped to an Error, and
 * resolves one in `redirects` to the real path given.
 */
function vault(
	files: Record<string, string>,
	links: Record<string, Error> = {},
	redirects: Record<string, string> = {},
	configDir = ".obsidian",
	root = realVault
) {
	mirrorToDisk(root, files);
	const settings = new Map<string, unknown>();
	const reads: string[] = [];
	// The answers file of the account on this computer (#299), in the test's
	// own folder; every use of it counted.
	const answers = { path: answersFile, uses: 0 };
	const platform = {
		permissionAnswers: () => {
			answers.uses += 1;
			return answersStore({ path: answers.path });
		},
		platform: "cli",
		configDir,
		readFile: async (path: string) => {
			reads.push(path);
			if (!(path in files)) throw new Error(`File not found: ${path}`);
			return files[path] as string;
		},
		writeFile: async (path: string, content: string) => {
			files[path] = content;
			mirrorToDisk(root, { [path]: content });
		},
		exists: async (path: string) =>
			path in files || Object.keys(files).some((file) => file.startsWith(`${path}/`)),
		mkdirp: async () => undefined,
		listFiles: async () => [],
		getVaultRoot: async () => root,
		acquireRunLock: memoryRunLocks().acquireRunLock,
		resolveInVault: async (path: string) => {
			const refused = Object.prototype.hasOwnProperty.call(links, path) ? links[path] : undefined;
			if (refused) throw refused;
			return Object.prototype.hasOwnProperty.call(redirects, path) ? (redirects[path] as string) : path;
		},
		getSetting: <T>(key: string) => settings.get(key) as T | undefined,
		setSetting: async (key: string, value: unknown) => {
			settings.set(key, value);
		},
		getSecret: async () => "sk-test",
		setSecret: async () => undefined,
		deleteSecret: async () => undefined,
		timers: nodeTimers,
		request: async (request: { body?: string }) => {
			requests.push(request.body ?? "");
			return {
				status: 200,
				text: JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
			};
		},
		log: () => undefined,
	} as unknown as PlatformAdapter;
	return { platform, files, reads, settings, answers };
}

let requests: string[];
// A vault root that exists: answers are kept under the vault's real path.
let realVault: string;
let stateDir: string;
let answersFile: string;

beforeEach(() => {
	requests = [];
	realVault = mkdtempSync(join(tmpdir(), "vaultore-permissions-vault-"));
	stateDir = mkdtempSync(join(tmpdir(), "vaultore-permissions-state-"));
	answersFile = join(stateDir, "vaultore", "answers.json");
	vi.mocked(execContainer).mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(realVault, { recursive: true, force: true });
	rmSync(stateDir, { recursive: true, force: true });
});

async function run(
	content: string,
	files: Record<string, string> = {},
	links: Record<string, Error> = {},
	redirects: Record<string, string> = {},
	configDir?: string
) {
	const v = vault({ "Private/secret.md": SECRET, "wf.md": content, ...files }, links, redirects, configDir);
	const workflow = await new WorkflowExecutor().runWorkflow({
		platform: v.platform,
		workflowPath: "wf.md",
		content,
	});
	return { ...v, workflow };
}

describe("{{note:}} in AI cells (#67)", () => {
	it("fails the cell under vaultRead: deny and sends nothing", async () => {
		const { workflow, reads } = await run(
			note(
				"  network: allow\n  vaultRead: deny",
				"```ore:ai id=summary\nSummarise: {{note:Private/secret.md}}\n```"
			)
		);

		const output = workflow.outputs.get("summary");
		expect(output?.meta.status).toBe("error");
		expect(String(output?.value)).toMatch(/vault read permission denied/i);
		expect(reads).not.toContain("Private/secret.md");
		expect(requests).toEqual([]);
	});

	it("does not resolve a note reference arriving through an upstream output", async () => {
		vi.mocked(execContainer).mockResolvedValue({
			exitCode: 0,
			stdout: "{{note:Private/secret.md}}",
			stderr: "",
		} as never);

		const { workflow, reads } = await run(
			note(
				"  network: allow\n  vaultRead: allow",
				[
					"```ore:shell id=fetched",
					"echo",
					"```",
					"",
					"```ore:ai id=summary depends=[fetched]",
					"Summarise: {{fetched}}",
					"```",
				].join("\n")
			)
		);

		expect(workflow.outputs.get("summary")?.meta.status).toBe("success");
		expect(reads).not.toContain("Private/secret.md");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("{{note:Private/secret.md}}");
		expect(requests[0]).not.toContain(SECRET);
	});

	it("sends the note under vaultRead: allow", async () => {
		const { workflow } = await run(
			note(
				"  network: allow\n  vaultRead: allow",
				"```ore:ai id=summary\nSummarise: {{note:Private/secret.md}}\n```"
			)
		);

		expect(workflow.outputs.get("summary")?.meta.status).toBe("success");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain(SECRET);
	});

	it("fails the cell when the note leads outside the vault through a symlink, and sends nothing", async () => {
		const { workflow, reads } = await run(
			note(
				"  network: allow\n  vaultRead: allow",
				"```ore:ai id=summary\nSummarise: {{note:notes/x/id_rsa}}\n```"
			),
			{ "notes/x/id_rsa": "a private key" },
			{ "notes/x/id_rsa": new Error("notes/x/id_rsa leads outside the vault through the symbolic link notes/x; refused") }
		);

		const output = workflow.outputs.get("summary");
		expect(output?.meta.status).toBe("error");
		expect(String(output?.value)).toContain("{{note:notes/x/id_rsa}}");
		expect(String(output?.value)).toContain("outside the vault");
		expect(reads).not.toContain("notes/x/id_rsa");
		expect(requests).toEqual([]);
	});

	for (const [path, real] of [
		[".obsidian/plugins/vaultore/data.json", ".obsidian/plugins/vaultore/data.json"],
		[".vaultore/config.json", ".vaultore/config.json"],
		[".Obsidian/plugins/vaultore/data.json", ".Obsidian/plugins/vaultore/data.json"],
		["notes/cfg/config.json", ".vaultore/config.json"],
	] as const) {
		it(`refuses {{note:${path}}}, which leads into a directory hidden from cells, and sends nothing`, async () => {
			const { workflow, reads } = await run(
				note("  network: allow\n  vaultRead: allow", `\`\`\`ore:ai id=summary\nSummarise: {{note:${path}}}\n\`\`\``),
				{ [real]: "stored settings" },
				{},
				{ [path]: real }
			);

			const output = workflow.outputs.get("summary");
			expect(output?.meta.status).toBe("error");
			expect(String(output?.value)).toContain(`{{note:${path}}}`);
			expect(String(output?.value)).toMatch(/hidden from cells/);
			expect(reads).not.toContain(real);
			expect(requests).toEqual([]);
		});
	}

	it("fails the cell when a referenced note does not exist", async () => {
		const { workflow } = await run(
			note(
				"  network: allow\n  vaultRead: allow",
				"```ore:ai id=summary\nSummarise: {{note:Moved.md}}\n```"
			)
		);

		const output = workflow.outputs.get("summary");
		expect(output?.meta.status).toBe("error");
		expect(String(output?.value)).toContain("Moved.md");
		expect(requests).toEqual([]);
	});
});

describe("container mounts follow vaultRead (#68)", () => {
	type Mount = { source: string; target: string; readonly?: boolean };

	async function mountsFor(type: "ts" | "shell", read: string, write: string, files: Record<string, string> = {}) {
		vi.mocked(execContainer).mockResolvedValue({
			exitCode: 0,
			stdout: "1",
			stderr: "",
		} as never);
		const { workflow } = await run(
			note(
				`  network: deny\n  vaultRead: ${read}\n  vaultWrite: ${write}`,
				`\`\`\`ore:${type} id=c\n1\n\`\`\``
			),
			files
		);
		expect(workflow.outputs.get("c")?.meta.status).toBe("success");
		const opts = vi.mocked(execContainer).mock.calls[0]?.[2] as {
			mounts?: Mount[];
		};
		return opts.mounts ?? [];
	}

	for (const type of ["ts", "shell"] as const) {
		it(`${type}: mounts the vault read-only under vaultRead: allow`, async () => {
			expect(await mountsFor(type, "allow", "deny")).toEqual([
				{ source: realVault, target: "/workspace", readonly: true },
			]);
		});

		it(`${type}: mounts the vault read-only and each folder read-write over it under vaultWrite: allow (#336)`, async () => {
			const mounts = await mountsFor(type, "allow", "allow");
			expect(mounts[0]).toEqual({ source: realVault, target: "/workspace", readonly: true });
			expect(mounts).toContainEqual({ source: `${realVault}/Private`, target: "/workspace/Private", readonly: false });
			// A top-level file is not a mount of its own: the count stays small.
			expect(mounts.map((m) => m.target)).not.toContain("/workspace/wf.md");
		});

		it(`${type}: mounts nothing under vaultRead and vaultWrite: deny`, async () => {
			expect(await mountsFor(type, "deny", "deny")).toEqual([]);
		});

		it(`${type}: mounts only this run's directory under vaultRead: deny, vaultWrite: allow`, async () => {
			const mounts = await mountsFor(type, "deny", "allow");
			expect(mounts).toHaveLength(1);
			const [mount] = mounts as [Mount];
			expect(mount.readonly).toBe(false);
			expect(mount.source.startsWith(`${realVault}/_vaultore/runs/wf/`)).toBe(true);
			expect(mount.target).toBe(mount.source.replace(realVault, "/workspace"));
		});
	}
});

describe("grants are bound to the note's content (#69)", () => {
	// One `ask` key, so each run that asks prompts exactly once.
	const GRANTED = note(
		"  network: ask\n  buildNetwork: deny\n  vaultRead: allow",
		"```ore:ai id=summary\nSay hello.\n```"
	);

	/** One vault and settings store across runs, as in a real session. */
	function session(confirm?: (message: string) => Promise<boolean>) {
		const v = vault({ "Private/secret.md": SECRET }, {}, {}, ".obsidian", realVault);
		const prompts: string[] = [];
		if (confirm) {
			(v.platform as { confirm?: unknown }).confirm = async (message: string) => {
				prompts.push(message);
				return confirm(message);
			};
		}
		async function runNote(content: string) {
			v.files["wf.md"] = content;
			const workflow = await new WorkflowExecutor().runWorkflow({
				platform: v.platform,
				workflowPath: "wf.md",
				content,
			});
			return workflow.outputs.get("summary")?.meta.status;
		}
		return { ...v, prompts, runNote };
	}

	it("does not ask about buildNetwork, which nothing uses yet (#95)", async () => {
		const s = session(async () => true);
		await s.runNote(GRANTED.replace("  buildNetwork: deny\n", ""));
		expect(s.prompts).toHaveLength(1);
		expect(s.prompts[0]).toContain("network");
		expect(s.prompts[0]).not.toContain("buildNetwork");
	});

	it("does not ask again for the same content", async () => {
		const s = session(async () => true);
		await s.runNote(GRANTED);
		await s.runNote(GRANTED);
		expect(s.prompts).toHaveLength(1);
	});

	it("does not ask again when a run only rewrote output stubs", async () => {
		const s = session(async () => true);
		await s.runNote(GRANTED);
		const afterRun = s.files["wf.md"] as string;
		expect(afterRun).toContain("[!ore-output] summary");

		await s.runNote(afterRun);
		expect(s.prompts).toHaveLength(1);
	});

	it("asks again when a cell body changes", async () => {
		const s = session(async () => true);
		await s.runNote(GRANTED);
		await s.runNote(GRANTED.replace("Say hello.", "Summarise: {{note:Private/secret.md}}"));
		expect(s.prompts).toHaveLength(2);
	});

	it("asks again when the frontmatter changes, including keys the schema ignores", async () => {
		const s = session(async () => true);
		await s.runNote(GRANTED);
		await s.runNote(GRANTED.replace("name: repro", "name: repro\nrunIf: always"));
		expect(s.prompts).toHaveLength(2);
	});

	it("denies a changed note when nobody can be asked", async () => {
		const s = session(async () => true);
		await s.runNote(GRANTED);
		delete (s.platform as { confirm?: unknown }).confirm;

		const status = await s.runNote(
			GRANTED.replace("Say hello.", "Summarise: {{note:Private/secret.md}}")
		);
		expect(status).toBe("error");
		expect(requests).toHaveLength(1); // the first run's request only
	});

	it("asks again for a decision stored before grants carried a hash", async () => {
		const s = session(async () => true);
		s.settings.set("vaultore.permissionDecisions", {
			"wf.md": { network: "allow", buildNetwork: "allow", vaultWrite: "deny", vaultRead: "allow" },
		});
		await s.runNote(GRANTED);
		expect(s.prompts).toHaveLength(1);
	});
});

describe("answers kept for this account on this computer, outside the vault (#299)", () => {
	const GRANTED = note(
		"  network: ask\n  buildNetwork: deny\n  vaultRead: allow",
		"```ore:ai id=summary\nSay hello.\n```"
	);

	/** A runner on this computer: the plugin and the CLI share the answers file, not their settings. Null: nobody can be asked. */
	function runner(answer: boolean | null = true) {
		const v = vault({ "Private/secret.md": SECRET }, {}, {}, ".obsidian", realVault);
		const prompts: string[] = [];
		(v.platform as { confirm?: unknown }).confirm = async (message: string) => {
			prompts.push(message);
			return answer ?? undefined;
		};
		async function runNote(content = GRANTED) {
			v.files["wf.md"] = content;
			const workflow = await new WorkflowExecutor().runWorkflow({ platform: v.platform, workflowPath: "wf.md", content });
			return workflow.outputs.get("summary")?.meta.status;
		}
		return { ...v, prompts, runNote };
	}
	const file = () => JSON.parse(readFileSync(answersFile, "utf8")) as { format: string; version: number; vaults: Record<string, { notes: Record<string, Record<string, unknown>> }> };
	// Kept under the vault's real path.
	const kept = (note = "wf.md") => file().vaults[realpathSync(realVault)]?.notes[note];

	it("keeps the answer in the account's file, per vault and note, with the content it was given for, and not in the runner's settings", async () => {
		const r = runner();
		expect(await r.runNote()).toBe("success");

		expect(file().format).toBe("vaultore.permission-answers");
		expect(kept()).toMatchObject({ network: "allow", workflowHash: expect.stringMatching(/^[0-9a-f]{64}$/), grantedAt: expect.any(String) });
		expect(Object.keys(kept() ?? {}).sort()).toEqual(["grantedAt", "network", "workflowHash"]);
		expect([...r.settings.keys()]).toEqual([]);
	});

	it("is shared by the plugin and the CLI on this computer: an answer given in one is not asked in the other", async () => {
		const plugin = runner();
		await plugin.runNote();
		const cli = runner(null);

		expect(await cli.runNote()).toBe("success");
		expect(cli.prompts).toHaveLength(0);
	});

	// #310: a deny given in Obsidian holds for `vaultore run --yes` too; it is said, not applied unseen.
	it("says which kept answer it used, and when it was given", async () => {
		await runner(false).runNote();
		const cli = runner(true);
		const log = vi.fn();
		Object.assign(cli.platform, { log });

		await cli.runNote();

		expect(cli.prompts).toHaveLength(0);
		expect(log).toHaveBeenCalledWith(
			"warn",
			expect.stringMatching(/^network for wf\.md: deny, as answered on \S+ for this content on this computer \(kept in .*answers\.json\)$/)
		);
	});

	it("asks again in a vault whose answers file is another's: another account, or another computer", async () => {
		await runner().runNote();
		answersFile = join(stateDir, "other-account", "answers.json");
		const elsewhere = runner(null);

		expect(await elsewhere.runNote()).toBe("error");
		expect(requests).toHaveLength(1);
	});

	it("is the same answer for the vault opened through a symbolic link", async () => {
		const r = runner();
		await r.runNote();
		const link = `${realVault}-link`;
		symlinkSync(realVault, link);
		try {
			(r.platform as { getVaultRoot: unknown }).getVaultRoot = async () => link;
			await r.runNote();
		} finally {
			rmSync(link, { force: true });
		}

		expect(r.prompts).toHaveLength(1);
	});

	it("keeps a note named __proto__ as an entry like any other", async () => {
		const r = runner();
		Object.defineProperty(r.files, "__proto__", { value: GRANTED, enumerable: true, writable: true });
		await new WorkflowExecutor().runWorkflow({ platform: r.platform, workflowPath: "__proto__", content: GRANTED });

		expect(Object.keys(file().vaults[realpathSync(realVault)]?.notes ?? {})).toEqual(["__proto__"]);
	});

	// The CLI without --yes asks nobody: the permission is denied for that run,
	// and nothing is kept, so a later run with --yes is asked and can allow.
	it("keeps no deny when nobody could be asked, so a later run that can ask allows", async () => {
		const r = runner(null);
		const logs: string[] = [];
		(r.platform as { log: unknown }).log = (_level: string, message: string) => logs.push(message);

		expect(await r.runNote()).toBe("error");
		expect(() => readFileSync(answersFile)).toThrow();
		expect(logs).toContain("network for wf.md is denied for this run: nobody could be asked, and nothing was kept");

		(r.platform as { confirm?: unknown }).confirm = async () => true;
		expect(await r.runNote()).toBe("success");
		expect(kept()?.["network"]).toBe("allow");
	});

	it("keeps a deny a person gave", async () => {
		const r = runner(false);
		await r.runNote();
		(r.platform as { confirm?: unknown }).confirm = async () => true;

		expect(await r.runNote()).toBe("error");
		expect(kept()?.["network"]).toBe("deny");
	});

	it("replaces the answers for content that changed", async () => {
		const r = runner();
		await r.runNote();
		const before = kept()?.["workflowHash"];
		await r.runNote(GRANTED.replace("Say hello.", "Say hi."));

		expect(r.prompts).toHaveLength(2);
		expect(kept()?.["workflowHash"]).not.toBe(before);
	});

	// The modal may stay open for minutes; the other runner may answer the
	// same content meanwhile. The two are merged in the file's lock.
	it("keeps the other runner's deny given while this one asked", async () => {
		const r = runner();
		(r.platform as { confirm?: unknown }).confirm = async () => {
			const other = runner(false);
			await other.runNote();
			return true;
		};

		await r.runNote();

		expect(kept()?.["network"]).toBe("deny");
	});

	it("neither reads nor writes the answers for a note that asks nothing", async () => {
		const r = runner();
		await r.runNote(note("  network: deny\n  vaultRead: allow", "```ore:ai id=summary\nSay hello.\n```"));

		expect(r.answers.uses).toBe(0);
		expect(() => readFileSync(answersFile)).toThrow();
	});

	it("does not run a note that asks when the answers file cannot be used, and names it", async () => {
		const r = runner();
		mkdirSync(join(stateDir, "vaultore"), { recursive: true });
		writeFileSync(answersFile, "{not json");
		r.files["wf.md"] = GRANTED;

		await expect(
			new WorkflowExecutor().runWorkflow({ platform: r.platform, workflowPath: "wf.md", content: GRANTED })
		).rejects.toThrow(answersFile);
		expect(requests).toHaveLength(0);
		expect(r.prompts).toHaveLength(0);
	});

	// Answers kept in data.json or config.json by earlier versions, or by
	// builds that bound them to a device, came through sync: none applies.
	it("asks again for answers earlier versions kept in the runner's settings, and leaves them as they are", async () => {
		const r = runner();
		const legacy = { "wf.md": { network: "allow", workflowHash: "x" } };
		r.settings.set("vaultore.permissionDecisions", legacy);
		r.settings.set("vaultore.deviceDecisions", { "wf.md": { someone: { network: "allow" } } });
		await r.runNote();

		expect(r.prompts).toHaveLength(1);
		expect(r.settings.get("vaultore.permissionDecisions")).toBe(legacy);
	});
});

describe("container image (#26)", () => {
	async function imageFor(type: "ts" | "shell", runtime: string) {
		vi.mocked(execContainer).mockResolvedValue({
			exitCode: 0,
			stdout: "1",
			stderr: "",
		} as never);
		const content = `---
ore: true
name: repro
${runtime}permissions:
  network: deny
---

\`\`\`ore:${type} id=c
1
\`\`\`
`;
		const { workflow } = await run(content);
		expect(workflow.outputs.get("c")?.meta.status).toBe("success");
		const opts = vi.mocked(execContainer).mock.calls[0]?.[2] as { image: string };
		return opts.image;
	}

	for (const type of ["ts", "shell"] as const) {
		it(`${type}: runs the default image when the note sets none`, async () => {
			expect(await imageFor(type, "")).toBe("oven/bun:1-alpine");
		});

		it(`${type}: runs the note's runtime.image`, async () => {
			expect(await imageFor(type, "runtime:\n  image: example/custom:2\n")).toBe(
				"example/custom:2"
			);
		});
	}
});

describe(".obsidian and .vaultore are hidden from cells (#28, #94, #336)", () => {
	const FILES = {
		".obsidian/plugins/vaultore/data.json": "{}",
		".vaultore/config.json": "{}",
		".git/config": "[core]",
		".claude/settings.json": "{}",
		".vscode/tasks.json": "{}",
		".envrc": "",
		"Notes/.git/config": "[core]",
	};

	async function containerFor(type: "ts" | "shell", read: string, write: string, files: Record<string, string> = FILES) {
		vi.mocked(execContainer).mockResolvedValue({
			exitCode: 0,
			stdout: "1",
			stderr: "",
		} as never);
		const { workflow } = await run(
			note(
				`  network: deny\n  vaultRead: ${read}\n  vaultWrite: ${write}`,
				`\`\`\`ore:${type} id=c\n1\n\`\`\``
			),
			files
		);
		expect(workflow.outputs.get("c")?.meta.status).toBe("success");
		const opts = vi.mocked(execContainer).mock.calls[0]?.[2] as {
			mounts?: { target: string; readonly?: boolean }[];
			maskedPaths?: string[];
		};
		const writable = (opts.mounts ?? []).filter((m) => m.readonly === false).map((m) => m.target);
		return { writable, masked: opts.maskedPaths ?? [] };
	}

	for (const type of ["ts", "shell"] as const) {
		for (const write of ["deny", "allow"]) {
			it(`${type}: covers .obsidian and .vaultore under the full vault mount (vaultWrite: ${write})`, async () => {
				const { masked } = await containerFor(type, "allow", write);
				expect(masked).toEqual(["/workspace/.obsidian", "/workspace/.vaultore"]);
			});
		}

		it(`${type}: covers nothing when the vault is not mounted`, async () => {
			expect((await containerFor(type, "deny", "deny")).masked).toEqual([]);
		});

		it(`${type}: covers nothing when only the run directory is mounted`, async () => {
			expect((await containerFor(type, "deny", "allow")).masked).toEqual([]);
		});

		it(`${type}: covers only what exists, creating nothing (#336)`, async () => {
			expect((await containerFor(type, "allow", "allow", {})).masked).toEqual([]);
		});

		it(`${type}: mounts no hidden or host tool folder read-write, and other folders whole`, async () => {
			const { writable } = await containerFor(type, "allow", "allow");
			expect(writable.filter((t) => /\/\.(obsidian|vaultore|git|claude|vscode)$/i.test(t))).toEqual([]);
			expect(writable).toContain("/workspace/Notes");
			expect(writable).not.toContain("/workspace/.envrc");
		});
	}

	it("mounts no hidden folder read-write whatever its spelling on disk", async () => {
		const { writable } = await containerFor("shell", "allow", "allow", {
			".Obsidian/plugins/vaultore/data.json": "{}",
			".VaultOre/config.json": "{}",
			".GIT/config": "",
			"Notes/a.md": "",
		});
		expect(writable.filter((t) => /\/\.(obsidian|vaultore|git)$/i.test(t))).toEqual([]);
		expect(writable).toContain("/workspace/Notes");
	});

	it("mounts neither a symbolic link nor a name the engine cannot take", async () => {
		mirrorToDisk(realVault, { "Outside/secret.md": SECRET, "a,b/x.md": "" });
		symlinkSync(join(realVault, "Outside"), join(realVault, "link"));
		const { writable } = await containerFor("shell", "allow", "allow");
		expect(writable).not.toContain("/workspace/link");
		expect(writable).not.toContain("/workspace/a,b");
		expect(writable).toContain("/workspace/Outside");
	});
});

describe("a custom config folder is hidden from cells too (Vault#configDir)", () => {
	async function shellRun(configDir: string, files: Record<string, string>) {
		vi.mocked(execContainer).mockResolvedValue({
			exitCode: 0,
			stdout: "1",
			stderr: "",
		} as never);
		const { workflow } = await run(
			note("  network: deny\n  vaultRead: allow\n  vaultWrite: allow", "```ore:shell id=c\n1\n```"),
			files,
			{},
			{},
			configDir
		);
		const opts = vi.mocked(execContainer).mock.calls[0]?.[2] as
			| { mounts?: { target: string; readonly?: boolean }[]; maskedPaths?: string[] }
			| undefined;
		return {
			output: workflow.outputs.get("c"),
			writable: (opts?.mounts ?? []).filter((m) => m.readonly === false).map((m) => m.target),
			masked: opts?.maskedPaths ?? [],
		};
	}

	it("covers the configured folder and the default one when both exist, and mounts neither read-write", async () => {
		const { output, masked, writable } = await shellRun(".config-desk", {
			".config-desk/plugins/vaultore/data.json": "{}",
			".obsidian/plugins/other/main.js": "",
		});
		expect(output?.meta.status).toBe("success");
		expect(masked).toEqual(["/workspace/.config-desk", "/workspace/.obsidian"]);
		expect(writable.filter((t) => /config-desk|obsidian/.test(t))).toEqual([]);
	});

	it("covers the configured folder when there is no default one", async () => {
		const { masked } = await shellRun("./.config-desk/", { ".config-desk/plugins/vaultore/data.json": "{}" });
		expect(masked).toEqual(["/workspace/.config-desk"]);
	});

	for (const configDir of ["", ".", "..", "a/b"]) {
		it(`fails the cell, rather than hide nothing, for configDir ${JSON.stringify(configDir)}`, async () => {
			const { output } = await shellRun(configDir, {});
			expect(output?.meta.status).toBe("error");
			expect(String(output?.value)).toMatch(/config folder must be one vault-relative folder/);
			expect(vi.mocked(execContainer)).not.toHaveBeenCalled();
		});
	}

	it("refuses {{note:}} into the configured folder and sends nothing", async () => {
		const path = ".config-desk/plugins/vaultore/data.json";
		const { workflow, reads } = await run(
			note("  network: allow\n  vaultRead: allow", `\`\`\`ore:ai id=summary\nSummarise: {{note:${path}}}\n\`\`\``),
			{ [path]: "stored settings" },
			{},
			{},
			".config-desk"
		);

		const output = workflow.outputs.get("summary");
		expect(output?.meta.status).toBe("error");
		expect(String(output?.value)).toMatch(/hidden from cells/);
		expect(reads).not.toContain(path);
		expect(requests).toEqual([]);
	});
});

describe("{{note:}} does not reach VaultOre's own folder where the vault holds it (#306)", () => {
	for (const path of [".config/vaultore/answers.json", ".CONFIG/vaultore/schedules.json"]) {
		it(`refuses {{note:${path}}} and sends nothing`, async () => {
			const content = note("  network: allow\n  vaultRead: allow", `\`\`\`ore:ai id=summary\nSummarise: {{note:${path}}}\n\`\`\``);
			const v = vault({ "wf.md": content, [path]: "{}" }, {}, {}, ".obsidian", realVault);
			Object.assign(v.platform, { stateDirectory: join(realVault, ".config", "vaultore") });

			const workflow = await new WorkflowExecutor().runWorkflow({ platform: v.platform, workflowPath: "wf.md", content });

			const output = workflow.outputs.get("summary");
			expect(output?.meta.status).toBe("error");
			expect(String(output?.value)).toMatch(/hidden from cells/);
			expect(v.reads).not.toContain(path);
			expect(requests).toEqual([]);
		});
	}
});

// A timed-out cell used to read "exit 1", like any failed command (#113).
describe("cell timeouts (#113)", () => {
	for (const type of ["ts", "shell"] as const) {
		it(`${type}: names the timeout and its length`, async () => {
			vi.mocked(execContainer).mockResolvedValue({
				exitCode: 1,
				stdout: "",
				stderr: "",
				duration: 2000,
				timedOut: true,
			});
			const { workflow, files } = await run(
				note("  network: deny", `\`\`\`ore:${type} id=slow timeout=2\nsleep 60\n\`\`\``)
			);

			const output = workflow.outputs.get("slow");
			expect(output?.meta.status).toBe("timeout");
			expect(String(output?.value)).toBe(`${type} cell timed out after 2s`);
			// What `vaultore run` prints after the cell's status.
			expect(output?.meta.error).toBe(`${type} cell timed out after 2s`);
			// The run that held it failed.
			const indexPath = Object.keys(files).find((path) => path.endsWith("/index.json"));
			const index = JSON.parse(files[indexPath!] as string) as { runs: Array<{ status: string }> };
			expect(index.runs.at(-1)?.status).toBe("error");
		});
	}
});
