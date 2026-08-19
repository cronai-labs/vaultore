import { describe, expect, it } from "vitest";
import { describeEngineFailure, finalizeRunContext, resolveEngine } from "./index";

describe("resolveEngine", () => {
	it("lets the workflow's frontmatter win over the configured default", () => {
		const choice = resolveEngine("docker", "colima");
		expect(choice.engine).toBe("docker");
		expect(choice.source).toBe("workflow");
		expect(choice.configuredDefault).toBe("colima");
	});

	it("does not record a configured default when it agrees with the note", () => {
		const choice = resolveEngine("colima", "colima");
		expect(choice.engine).toBe("colima");
		expect(choice.source).toBe("workflow");
		expect(choice.configuredDefault).toBeUndefined();
	});

	it("uses the setting when the note names no engine", () => {
		const choice = resolveEngine(undefined, "podman");
		expect(choice.engine).toBe("podman");
		expect(choice.source).toBe("setting");
		expect(choice.configuredDefault).toBeUndefined();
	});

	it("falls back to the built-in default when neither is set", () => {
		const choice = resolveEngine(undefined, undefined);
		expect(choice.engine).toBe("docker");
		expect(choice.source).toBe("default");
	});
});

describe("describeEngineFailure", () => {
	// The reported symptom: colima selected in settings, every fixture pinning
	// `engine: docker`, and an error naming only docker.
	it("names both the note's engine and the user's default when they differ", () => {
		const message = describeEngineFailure(
			resolveEngine("docker", "colima"),
			"docker daemon not running",
			["colima"]
		);

		expect(message).toContain("docker daemon not running");
		expect(message).toContain("frontmatter requests \"docker\"");
		expect(message).toContain("configured default is \"colima\"");
		expect(message).toContain("Remove \"engine: docker\"");
		expect(message).toContain("Detected on this machine: colima.");
	});

	it("does not blame the note when the engine came from settings", () => {
		const message = describeEngineFailure(
			resolveEngine(undefined, "podman"),
			"podman not found",
			[]
		);

		expect(message).toContain("your configured default");
		expect(message).not.toContain("frontmatter");
		expect(message).toContain("No container runtime was detected");
	});

	it("omits the default clause when the note and the setting agree", () => {
		const message = describeEngineFailure(
			resolveEngine("docker", "docker"),
			"not running",
			["colima", "podman"]
		);

		expect(message).toContain("frontmatter requests \"docker\"");
		expect(message).not.toContain("configured default is");
		expect(message).toContain("Detected on this machine: colima, podman.");
	});
});

describe("finalizeRunContext", () => {
	const runContext = {
		runId: "r1",
		runDir: "_vaultore/runs/wf/r1",
		runBaseDir: "_vaultore/runs/wf",
		startedAt: "2026-08-19T07:03:43.626Z",
		workflowPath: "wf.md",
		outputRoot: "_vaultore",
	};

	function capturingPlatform() {
		const written = new Map<string, string>();
		return {
			written,
			platform: {
				writeFile: async (path: string, content: string) => {
					written.set(path, content);
				},
			} as never,
		};
	}

	function output(status: string, duration: number) {
		return { meta: { status, duration } } as never;
	}

	// The live run left run.json at {"status":"running"} hours after it failed.
	it("records a terminal status instead of leaving the run open", async () => {
		const { platform, written } = capturingPlatform();
		await finalizeRunContext(platform, runContext, ["a", "b"], new Map([
			["a", output("success", 209)],
			["b", output("success", 175)],
		]));

		const record = JSON.parse(written.get("_vaultore/runs/wf/r1/run.json") as string);
		expect(record.status).toBe("completed");
		expect(record.finishedAt).toBeTruthy();
		expect(record.durationMs).toBeGreaterThanOrEqual(0);
		expect(record.cells).toEqual([
			{ cellId: "a", status: "success", durationMs: 209 },
			{ cellId: "b", status: "success", durationMs: 175 },
		]);
	});

	it("marks the run failed when any cell failed", async () => {
		const { platform, written } = capturingPlatform();
		await finalizeRunContext(platform, runContext, ["a", "b"], new Map([
			["a", output("success", 209)],
			["b", output("error", 927554)],
		]));

		expect(JSON.parse(written.get("_vaultore/runs/wf/r1/run.json") as string).status).toBe("failed");
	});

	it("summarises only the cells this run executed, not hydrated ones", async () => {
		const { platform, written } = capturingPlatform();
		await finalizeRunContext(platform, runContext, ["b"], new Map([
			["a", output("error", 1)],   // stale, from an earlier run
			["b", output("success", 5)],
		]));

		const record = JSON.parse(written.get("_vaultore/runs/wf/r1/run.json") as string);
		expect(record.status).toBe("completed");
		expect(record.cells).toHaveLength(1);
		expect(record.cells[0].cellId).toBe("b");
	});

	// A throw part-way through leaves `ran` holding only cells that were
	// persisted — all green — so inferring status from them alone would report a
	// failed run as "completed".
	it("records an escaping error rather than inferring success from the cells that did run", async () => {
		const { platform, written } = capturingPlatform();
		await finalizeRunContext(
			platform,
			runContext,
			["a"],
			new Map([["a", output("success", 209)]]),
			new Error('Container runtime "docker" is not available: daemon not running')
		);

		const record = JSON.parse(written.get("_vaultore/runs/wf/r1/run.json") as string);
		expect(record.status).toBe("aborted");
		expect(record.error).toMatch(/docker" is not available/);
	});

	it("omits the error field and stays completed on a clean run", async () => {
		const { platform, written } = capturingPlatform();
		await finalizeRunContext(platform, runContext, ["a"], new Map([["a", output("success", 1)]]));

		const record = JSON.parse(written.get("_vaultore/runs/wf/r1/run.json") as string);
		expect(record.status).toBe("completed");
		expect(record.error).toBeUndefined();
	});

	it("omits durationMs rather than emitting NaN for an unparseable start time", async () => {
		const { platform, written } = capturingPlatform();
		await finalizeRunContext(
			platform,
			{ ...runContext, startedAt: "not a date" },
			["a"],
			new Map([["a", output("success", 1)]])
		);

		const record = JSON.parse(written.get("_vaultore/runs/wf/r1/run.json") as string);
		expect(record).not.toHaveProperty("durationMs");
	});

	it("never masks the error already propagating out of the run", async () => {
		const platform = {
			writeFile: async () => {
				throw new Error("disk full");
			},
		} as never;

		await expect(
			finalizeRunContext(platform, runContext, ["a"], new Map([["a", output("success", 1)]]))
		).resolves.toBeUndefined();
	});
});
