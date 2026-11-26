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
import { testDecisionDevice } from "../testing/decision-device";
import type { DecisionDevice } from "../settings/device";

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
	configDir = ".obsidian"
) {
	const settings = new Map<string, unknown>();
	const reads: string[] = [];
	const devices = { current: testDecisionDevice(), reads: 0 };
	const platform = {
		decisionDevice: async (): Promise<DecisionDevice> => {
			devices.reads += 1;
			return devices.current;
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
		},
		exists: async (path: string) =>
			path in files || Object.keys(files).some((file) => file.startsWith(`${path}/`)),
		mkdirp: async () => undefined,
		listFiles: async () => [],
		getVaultRoot: async () => "/vault",
		acquireRunLock: memoryRunLocks().acquireRunLock,
		resolveInVault: async (path: string) => {
			const refused = links[path];
			if (refused) throw refused;
			return redirects[path] ?? path;
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
	return { platform, files, reads, settings, devices };
}

let requests: string[];

beforeEach(() => {
	requests = [];
	vi.mocked(execContainer).mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
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

	async function mountsFor(type: "ts" | "shell", read: string, write: string) {
		vi.mocked(execContainer).mockResolvedValue({
			exitCode: 0,
			stdout: "1",
			stderr: "",
		} as never);
		const { workflow } = await run(
			note(
				`  network: deny\n  vaultRead: ${read}\n  vaultWrite: ${write}`,
				`\`\`\`ore:${type} id=c\n1\n\`\`\``
			)
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
				{ source: "/vault", target: "/workspace", readonly: true },
			]);
		});

		it(`${type}: mounts the vault read-write under vaultRead and vaultWrite: allow`, async () => {
			expect(await mountsFor(type, "allow", "allow")).toEqual([
				{ source: "/vault", target: "/workspace", readonly: false },
			]);
		});

		it(`${type}: mounts nothing under vaultRead and vaultWrite: deny`, async () => {
			expect(await mountsFor(type, "deny", "deny")).toEqual([]);
		});

		it(`${type}: mounts only this run's directory under vaultRead: deny, vaultWrite: allow`, async () => {
			const mounts = await mountsFor(type, "deny", "allow");
			expect(mounts).toHaveLength(1);
			const [mount] = mounts as [Mount];
			expect(mount.readonly).toBe(false);
			expect(mount.source).toMatch(/^\/vault\/_vaultore\/runs\/wf\/[^/]+$/);
			expect(mount.target).toBe(mount.source.replace(/^\/vault/, "/workspace"));
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
		const v = vault({ "Private/secret.md": SECRET });
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

describe("decisions are bound to the device that made them (#284)", () => {
	const GRANTED = note(
		"  network: ask\n  buildNetwork: deny\n  vaultRead: allow",
		"```ore:ai id=summary\nSay hello.\n```"
	);
	const HERE = "a".repeat(32);
	const THERE = "b".repeat(32);

	/** One vault and its settings, as sync shares them, run on whichever device is current. */
	function shared(answer = true) {
		const v = vault({ "Private/secret.md": SECRET });
		const prompts: string[] = [];
		(v.platform as { confirm?: unknown }).confirm = async (message: string) => {
			prompts.push(message);
			return answer;
		};
		async function runOn(id: string, content = GRANTED, options: { acceptOtherDevices?: boolean } = {}) {
			v.devices.current = testDecisionDevice(id, options);
			v.files["wf.md"] = content;
			const workflow = await new WorkflowExecutor().runWorkflow({ platform: v.platform, workflowPath: "wf.md", content });
			return workflow.outputs.get("summary")?.meta.status;
		}
		const stored = () => v.settings.get("vaultore.deviceDecisions") as Record<string, Record<string, Record<string, unknown>>>;
		return { ...v, prompts, runOn, stored };
	}

	it("keeps the answer for this device, with a MAC, and does not ask here again", async () => {
		const s = shared();
		await s.runOn(HERE);
		await s.runOn(HERE);

		expect(s.prompts).toHaveLength(1);
		const entry = s.stored()["wf.md"]?.[HERE];
		expect(entry).toMatchObject({ network: "allow", workflowHash: expect.any(String), grantedAt: expect.any(String) });
		expect(entry?.["mac"]).toMatch(/^[0-9a-f]{64}$/);
	});

	it("asks again on another device that has the same vault, and denies there when nobody can be asked", async () => {
		const s = shared();
		await s.runOn(HERE);
		await s.runOn(THERE);
		expect(s.prompts).toHaveLength(2);

		delete (s.platform as { confirm?: unknown }).confirm;
		const third = "c".repeat(32);
		expect(await s.runOn(third)).toBe("error");
		expect(requests).toHaveLength(2);
	});

	it("keeps each device's answer, so two devices sharing a vault each ask once", async () => {
		const s = shared();
		for (const id of [HERE, THERE, HERE, THERE, HERE]) await s.runOn(id);

		expect(s.prompts).toHaveLength(2);
		expect(Object.keys(s.stored()["wf.md"] ?? {}).sort()).toEqual([HERE, THERE]);
	});

	it.each([
		["planted for this device without its key", (entry: Record<string, unknown>) => ({ ...entry, mac: "0".repeat(64) })],
		["changed from deny to allow", (entry: Record<string, unknown>) => ({ ...entry, network: "allow" })],
	])("asks again for an answer %s, and says why in the log", async (_what, tamper) => {
		const s = shared(false);
		const logs: string[] = [];
		(s.platform as { log: unknown }).log = (_level: string, message: string) => logs.push(message);
		await s.runOn(HERE);
		const decisions = s.stored();
		decisions["wf.md"]![HERE] = tamper(decisions["wf.md"]![HERE]!);
		s.settings.set("vaultore.deviceDecisions", decisions);

		await s.runOn(HERE);

		expect(s.prompts).toHaveLength(2);
		expect(logs).toContain("The stored permission decision for wf.md was not made here or was changed; asking again");
	});

	it("asks again for an answer copied to another note", async () => {
		const s = shared();
		await s.runOn(HERE);
		const decisions = s.stored();
		decisions["other.md"] = decisions["wf.md"]!;
		s.settings.set("vaultore.deviceDecisions", decisions);
		s.files["other.md"] = GRANTED;

		await new WorkflowExecutor().runWorkflow({ platform: s.platform, workflowPath: "other.md", content: GRANTED });

		expect(s.prompts).toHaveLength(2);
	});

	it("neither reads the device nor stores anything for a note that asks nothing", async () => {
		const s = shared();
		await s.runOn(HERE, note("  network: deny\n  vaultRead: allow", "```ore:ai id=summary\nSay hello.\n```"));

		expect(s.devices.reads).toBe(0);
		expect(s.settings.has("vaultore.deviceDecisions")).toBe(false);
	});

	it("does not run a note that asks when the device cannot be read, and says why", async () => {
		const s = shared();
		(s.platform as { decisionDevice: unknown }).decisionDevice = async () => {
			throw new Error("Cannot use VaultOre's device file /x/device.json: it is not JSON");
		};
		s.files["wf.md"] = GRANTED;

		await expect(
			new WorkflowExecutor().runWorkflow({ platform: s.platform, workflowPath: "wf.md", content: GRANTED })
		).rejects.toThrow("Cannot use VaultOre's device file");
		expect(requests).toHaveLength(0);
		expect(s.prompts).toHaveLength(0);
	});

	it("never writes the decisions stored before #284, and keeps them for an older runner", async () => {
		const s = shared();
		const legacy = { "wf.md": { network: "deny", workflowHash: "x" } };
		s.settings.set("vaultore.permissionDecisions", legacy);
		await s.runOn(HERE);

		expect(s.settings.get("vaultore.permissionDecisions")).toBe(legacy);
	});

	describe("with answers from other devices turned on in this machine's settings", () => {
		it("applies an answer given on another device for the same content", async () => {
			const s = shared();
			await s.runOn(THERE);
			await s.runOn(HERE, GRANTED, { acceptOtherDevices: true });

			expect(s.prompts).toHaveLength(1);
			expect(Object.keys(s.stored()["wf.md"] ?? {}).sort()).toEqual([HERE, THERE]);
		});

		it("applies an answer stored before answers carried a device, for the same content", async () => {
			const s = shared();
			await s.runOn(THERE);
			const hash = s.stored()["wf.md"]![THERE]!["workflowHash"];
			s.settings.set("vaultore.deviceDecisions", {});
			s.settings.set("vaultore.permissionDecisions", { "wf.md": { network: "allow", workflowHash: hash } });

			expect(await s.runOn(HERE, GRANTED, { acceptOtherDevices: true })).toBe("success");
			expect(s.prompts).toHaveLength(1);
		});

		it("still asks when the content changed since", async () => {
			const s = shared();
			await s.runOn(THERE);
			await s.runOn(HERE, GRANTED.replace("Say hello.", "Say goodbye."), { acceptOtherDevices: true });

			expect(s.prompts).toHaveLength(2);
		});
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

describe(".obsidian and .vaultore are hidden from cells (#28, #94)", () => {
	const PLUGIN = { ".obsidian/plugins/vaultore/data.json": "{}" };

	async function maskedFor(
		type: "ts" | "shell",
		read: string,
		write: string,
		files: Record<string, string>
	) {
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
		const opts = vi.mocked(execContainer).mock.calls[0]?.[2] as { maskedPaths?: string[] };
		return opts.maskedPaths ?? [];
	}

	for (const type of ["ts", "shell"] as const) {
		for (const write of ["deny", "allow"]) {
			it(`${type}: masks /workspace/.obsidian under the full vault mount (vaultWrite: ${write})`, async () => {
				expect(await maskedFor(type, "allow", write, PLUGIN)).toEqual([
					"/workspace/.obsidian",
					"/workspace/.vaultore",
				]);
			});
		}

		it(`${type}: masks nothing when the vault is not mounted`, async () => {
			expect(await maskedFor(type, "deny", "deny", PLUGIN)).toEqual([]);
		});

		it(`${type}: masks nothing when only the run directory is mounted`, async () => {
			expect(await maskedFor(type, "deny", "allow", PLUGIN)).toEqual([]);
		});

		it(`${type}: masks .vaultore even in a vault that has none yet`, async () => {
			// A cell must not be able to create the CLI's config with forged
			// decisions; .obsidian stays unmasked when missing, since masking would
			// make the engine create it in the vault.
			expect(await maskedFor(type, "allow", "allow", {})).toEqual(["/workspace/.vaultore"]);
		});
	}
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
		const opts = vi.mocked(execContainer).mock.calls[0]?.[2] as { maskedPaths?: string[] } | undefined;
		return { output: workflow.outputs.get("c"), masked: opts?.maskedPaths ?? [] };
	}

	it("masks the configured folder and the default one when both exist", async () => {
		const { output, masked } = await shellRun(".config-desk", {
			".config-desk/plugins/vaultore/data.json": "{}",
			".obsidian/plugins/other/main.js": "",
		});
		expect(output?.meta.status).toBe("success");
		expect(masked).toEqual(["/workspace/.config-desk", "/workspace/.obsidian", "/workspace/.vaultore"]);
	});

	it("masks the configured folder when there is no default one", async () => {
		const { masked } = await shellRun("./.config-desk/", { ".config-desk/plugins/vaultore/data.json": "{}" });
		expect(masked).toEqual(["/workspace/.config-desk", "/workspace/.vaultore"]);
	});

	for (const configDir of ["", ".", "..", "a/b"]) {
		it(`fails the cell, rather than mask nothing, for configDir ${JSON.stringify(configDir)}`, async () => {
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
