/**
 * @vaultore/cli - `vaultore` command
 *
 * Standalone, Obsidian-free entry points for VaultOre workflows:
 *
 *   vaultore run <workflow.md>       run a workflow headless
 *   vaultore list                    list workflow notes in the vault
 *   vaultore agent                   headless scheduler daemon
 *   vaultore schedules list          scheduled notes and whether the agent may run them
 *   vaultore schedules approve       let the agent run a scheduled note
 *   vaultore schedules revoke        withdraw that
 *   vaultore schedules export        emit the CronAI handover manifest
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { WorkflowExecutor, WorkflowScheduler, VERSION, errorMessage } from "@vaultore/core";
import { NodeAdapter } from "./adapter";
import {
	createApprovedRunner,
	createSingleFlightRunner,
	createSkipReporter,
	planRegistrations,
} from "./agent";
import { ApprovalStore, resolveStateDir, vaultKeyFor } from "./approvals";
import { buildScheduleManifest, discoverWorkflows } from "./scan";
import {
	approveSchedules,
	formatScheduleList,
	listSchedules,
	readScheduledNote,
	revokeSchedules,
	scheduledNotes,
} from "./schedules";
import {
	configDirFrom,
	hasExplicitVault,
	parseArgs,
	rescanSecondsFrom,
	toVaultRelative,
	vaultRootFrom,
} from "./args";
import type { ParsedArgs } from "./args";

function usage(): string {
	return `vaultore ${VERSION} — Markdown-native AI workflow engine (headless CLI)

Usage:
  vaultore run <workflow.md> [--vault <dir>] [--config-dir <name>] [--cell <id>] [--skip-deps] [--yes] [--quiet]
  vaultore list [--vault <dir>] [--config-dir <name>]
  vaultore agent [--vault <dir>] [--config-dir <name>] [--state-dir <dir>] [--yes] [--rescan <seconds>] [--quiet]
  vaultore schedules list [--vault <dir>] [--config-dir <name>] [--state-dir <dir>]
  vaultore schedules approve <workflow.md>... [--vault <dir>] [--state-dir <dir>]
  vaultore schedules revoke <workflow.md>... [--vault <dir>] [--state-dir <dir>]
  vaultore schedules export [--vault <dir>] [--config-dir <name>] [--out <file>]
  vaultore --version | --help

Options:
  --vault <dir>       Vault root (default: current directory). When given, a
                      relative <workflow.md> resolves against it.
  --config-dir <name> The vault's Obsidian config folder, if overridden
                      (default: .obsidian). Hidden from cells.
  --state-dir <dir>   Where this machine keeps the agent's schedule approvals
                      (default: $XDG_CONFIG_HOME/vaultore, else ~/.config/vaultore;
                      on Windows %APPDATA%\\vaultore). Outside the vault, so
                      that sync cannot deliver an approval.
  --cell <id>         Run a single cell (with its dependencies)
  --skip-deps         With --cell: skip dependency cells
  --yes               Auto-grant "ask" permissions (non-interactive default: deny).
                      Does not approve a schedule.
  --rescan <seconds>  Agent rescan interval (default: 300)
  --out <file>        Write manifest to a file instead of stdout
  --quiet             Suppress info/debug output

The agent runs a scheduled note only after 'vaultore schedules approve', and
only while the note's front matter and cells are what was approved.

Secrets are read from the environment:
  VAULTORE_OPENAI_APIKEY (or OPENAI_API_KEY)
  VAULTORE_ANTHROPIC_APIKEY (or ANTHROPIC_API_KEY)
`;
}

async function cmdRun(args: ParsedArgs): Promise<number> {
	const workflowArg = args.positional[0];
	if (!workflowArg) {
		process.stderr.write("error: missing workflow file\n\n" + usage());
		return 2;
	}

	const vaultRoot = vaultRootFrom(args.flags);
	const adapter = new NodeAdapter({
		vaultRoot,
		configDir: configDirFrom(args.flags),
		assumeYes: args.flags["yes"] === true,
		quiet: args.flags["quiet"] === true,
	});

	const workflowPath = toVaultRelative(vaultRoot, workflowArg, {
		vaultExplicit: hasExplicitVault(args.flags),
	});
	const content = await adapter.readFile(workflowPath);

	const executor = new WorkflowExecutor();
	const targetCellId = typeof args.flags["cell"] === "string" ? args.flags["cell"] : undefined;

	// Cells this invocation actually ran. result.outputs also carries outputs
	// hydrated from earlier runs, which must not colour this run's summary or
	// its exit code.
	const ran: string[] = [];

	const result = await executor.runWorkflow({
		platform: adapter,
		workflowPath,
		content,
		targetCellId,
		skipDependencies: args.flags["skip-deps"] === true,
		emitEvent: (event, data) => {
			const cellId = (data as { cellId?: string })?.cellId;
			if (event === "cell:started" && cellId !== undefined) ran.push(cellId);
			if (args.flags["quiet"] === true) return;
			if (event === "cell:started" || event === "cell:completed") {
				process.stdout.write(
					`[vaultore] ${event.replace("cell:", "cell ")}: ${cellId ?? "?"}\n`
				);
			}
		},
	});

	let failed = 0;
	for (const cellId of ran) {
		const output = result.outputs.get(cellId);
		if (output === undefined) continue;
		const mark = output.meta.status === "success" ? "ok" : output.meta.status;
		process.stdout.write(`  ${cellId}: ${mark} (${output.meta.duration}ms)\n`);
		if (output.meta.status !== "success") {
			failed += 1;
			if (output.meta.error) {
				process.stderr.write(`error: ${cellId}: ${output.meta.error}\n`);
			}
		}
	}

	return failed > 0 ? 1 : 0;
}

/** Reports a note meant as a workflow that the scan could not read. */
function reportSkipped(prefix: string): (path: string, reason: string) => void {
	return (path, reason) => {
		process.stderr.write(`${prefix} skipped ${path}: ${reason}\n`);
	};
}

async function cmdList(args: ParsedArgs): Promise<number> {
	const vaultRoot = vaultRootFrom(args.flags);
	const adapter = new NodeAdapter({ vaultRoot, configDir: configDirFrom(args.flags), quiet: true });
	const outputRoot = adapter.getSetting<string>("vaultore.outputRoot");
	const discovered = await discoverWorkflows(adapter, {
		outputRoot,
		onSkip: reportSkipped("[vaultore]"),
	});

	if (discovered.length === 0) {
		process.stdout.write("No workflow notes found.\n");
		return 0;
	}

	for (const item of discovered) {
		const schedule = item.workflow.frontmatter.schedule
			? `  [schedule: ${item.workflow.frontmatter.schedule}]`
			: "";
		process.stdout.write(
			`${item.path} — ${item.workflow.frontmatter.name} (${item.workflow.cells.length} cells)${schedule}\n`
		);
	}
	return 0;
}

async function cmdAgent(args: ParsedArgs): Promise<number> {
	let rescanSeconds: number;
	try {
		rescanSeconds = rescanSecondsFrom(args.flags);
	} catch (err) {
		process.stderr.write(`error: ${errorMessage(err)}\n\n` + usage());
		return 2;
	}

	const vaultRoot = vaultRootFrom(args.flags);
	// Before anything is armed: an approvals file that cannot be used stops the
	// agent here (the error names the file) rather than running as if nothing
	// were approved.
	const { store, vaultKey } = await openApprovals(args.flags, vaultRoot);
	await store.forVault(vaultKey);

	const adapter = new NodeAdapter({
		vaultRoot,
		configDir: configDirFrom(args.flags),
		assumeYes: args.flags["yes"] === true,
		quiet: args.flags["quiet"] === true,
	});
	const executor = new WorkflowExecutor();
	const warn = (line: string): void => {
		process.stderr.write(`[vaultore:agent] ${line}\n`);
	};

	// A due note runs only if it is approved as it is now: the note and the
	// approvals are read again, and the content that was checked is what runs.
	const runApproved = createApprovedRunner({
		readNote: (path) => readScheduledNote((notePath) => adapter.readFile(notePath), path),
		approvals: () => store.forVault(vaultKey),
		run: async (path, content) => {
			try {
				process.stdout.write(`[vaultore:agent] running ${path}\n`);
				await executor.runWorkflow({ platform: adapter, workflowPath: path, content });
				process.stdout.write(`[vaultore:agent] completed ${path}\n`);
			} catch (err) {
				process.stderr.write(
					`[vaultore:agent] failed ${path}: ${errorMessage(err)}\n`
				);
			}
		},
		onRefuse: (path, reason) => warn(`not running ${path}: ${reason}`),
	});

	const runByPath = createSingleFlightRunner(
		runApproved,
		(path) => {
			process.stderr.write(
				`[vaultore:agent] skipped ${path}: the previous run is still in progress\n`
			);
		}
	);

	const scheduler = new WorkflowScheduler({
		timers: adapter.timers,
		tickIntervalMs: 60 * 1000,
		onTick: (workflows) => {
			workflows.forEach((workflow) => {
				void runByPath(workflow.path);
			});
		},
	});

	const reportSkips = createSkipReporter(warn);
	let storeError: string | undefined;

	const rescan = async (): Promise<void> => {
		for (const entry of scheduler.list()) {
			scheduler.unregister(entry.path);
		}
		const outputRoot = adapter.getSetting<string>("vaultore.outputRoot");
		const discovered = await discoverWorkflows(adapter, {
			outputRoot,
			onSkip: reportSkipped("[vaultore:agent]"),
		});
		// Everything was unregistered above, so an approvals file that cannot be
		// used leaves nothing armed. Said once, and again when the reason changes.
		let approvals;
		try {
			approvals = await store.forVault(vaultKey);
			storeError = undefined;
		} catch (err) {
			const message = errorMessage(err);
			if (message !== storeError) warn(`${message}. Nothing runs until then`);
			storeError = message;
			return;
		}

		const plan = planRegistrations(await scheduledNotes(discovered), approvals);
		let registered = 0;
		for (const note of plan.register) {
			try {
				scheduler.register(note.path, note.schedule);
				registered += 1;
			} catch {
				process.stderr.write(`[vaultore:agent] invalid cron in ${note.path}, skipping\n`);
			}
		}
		process.stdout.write(`[vaultore:agent] ${registered} scheduled workflow(s) registered\n`);
		reportSkips({ registered, skipped: plan.skipped });
	};

	await rescan();
	scheduler.start();
	const rescanTimer = setInterval(() => {
		void rescan();
	}, rescanSeconds * 1000);

	process.stdout.write(
		`[vaultore:agent] watching ${vaultRoot} (rescan every ${rescanSeconds}s, Ctrl-C to stop)\n`
	);

	await new Promise<void>((resolveExit) => {
		const stop = (): void => {
			clearInterval(rescanTimer);
			scheduler.stop();
			process.stdout.write("\n[vaultore:agent] stopped\n");
			resolveExit();
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});

	return 0;
}

/** The approvals file for this invocation, and the key of this vault in it. */
async function openApprovals(
	flags: ParsedArgs["flags"],
	vaultRoot: string
): Promise<{ store: ApprovalStore; vaultKey: string }> {
	const stateDir = resolveStateDir({
		flag: flags["state-dir"],
		env: process.env,
		platform: process.platform,
		homedir: homedir(),
	});
	return { store: new ApprovalStore(stateDir), vaultKey: await vaultKeyFor(vaultRoot) };
}

function printResult(result: { ok: boolean; lines: string[] }): number {
	for (const line of result.lines) {
		if (result.ok) process.stdout.write(`${line}\n`);
		else process.stderr.write(`error: ${line}\n`);
	}
	return result.ok ? 0 : 1;
}

/** The note arguments of approve and revoke as vault-relative paths, or undefined when none was given. */
function notePathsFrom(args: ParsedArgs, vaultRoot: string): string[] | undefined {
	if (args.positional.length === 0) {
		process.stderr.write("error: missing workflow file\n\n" + usage());
		return undefined;
	}
	return args.positional.map((arg) =>
		toVaultRelative(vaultRoot, arg, { vaultExplicit: hasExplicitVault(args.flags) })
	);
}

async function cmdSchedulesList(args: ParsedArgs): Promise<number> {
	const vaultRoot = vaultRootFrom(args.flags);
	const { store, vaultKey } = await openApprovals(args.flags, vaultRoot);
	const approvals = await store.forVault(vaultKey);

	const adapter = new NodeAdapter({ vaultRoot, configDir: configDirFrom(args.flags), quiet: true });
	const outputRoot = adapter.getSetting<string>("vaultore.outputRoot");
	const discovered = await discoverWorkflows(adapter, {
		outputRoot,
		onSkip: reportSkipped("[vaultore]"),
	});

	const entries = listSchedules(await scheduledNotes(discovered), approvals);
	for (const line of formatScheduleList(entries)) {
		process.stdout.write(`${line}\n`);
	}
	return 0;
}

async function cmdSchedulesApprove(args: ParsedArgs): Promise<number> {
	const vaultRoot = vaultRootFrom(args.flags);
	const paths = notePathsFrom(args, vaultRoot);
	if (paths === undefined) return 2;

	const { store, vaultKey } = await openApprovals(args.flags, vaultRoot);
	const adapter = new NodeAdapter({ vaultRoot, configDir: configDirFrom(args.flags), quiet: true });
	return printResult(
		await approveSchedules({
			paths,
			readNote: (path) => adapter.readFile(path),
			store,
			vaultKey,
		})
	);
}

async function cmdSchedulesRevoke(args: ParsedArgs): Promise<number> {
	const vaultRoot = vaultRootFrom(args.flags);
	const paths = notePathsFrom(args, vaultRoot);
	if (paths === undefined) return 2;

	const { store, vaultKey } = await openApprovals(args.flags, vaultRoot);
	return printResult(await revokeSchedules({ paths, store, vaultKey }));
}

async function cmdSchedulesExport(args: ParsedArgs): Promise<number> {
	const vaultRoot = vaultRootFrom(args.flags);
	const adapter = new NodeAdapter({ vaultRoot, configDir: configDirFrom(args.flags), quiet: true });
	const outputRoot = adapter.getSetting<string>("vaultore.outputRoot");
	const discovered = await discoverWorkflows(adapter, {
		outputRoot,
		onSkip: reportSkipped("[vaultore]"),
	});
	const manifest = buildScheduleManifest(discovered, vaultRoot);
	const json = JSON.stringify(manifest, null, 2) + "\n";

	const out = args.flags["out"];
	if (typeof out === "string") {
		await fs.writeFile(resolve(out), json, "utf8");
		process.stdout.write(
			`Wrote ${manifest.workflows.length} scheduled workflow(s) to ${out}\n`
		);
	} else {
		process.stdout.write(json);
	}
	return 0;
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);

	let args: ParsedArgs;
	try {
		args = parseArgs(argv);
	} catch (err) {
		process.stderr.write(`error: ${errorMessage(err)}\n\n` + usage());
		return 2;
	}

	const command = args.positional.shift();

	if (args.flags["version"] === true) {
		process.stdout.write(`${VERSION}\n`);
		return 0;
	}
	if (command === undefined || args.flags["help"] === true) {
		process.stdout.write(usage());
		return command === undefined && args.flags["help"] !== true ? 2 : 0;
	}

	switch (command) {
		case "run":
			return cmdRun(args);
		case "list":
			return cmdList(args);
		case "agent":
			return cmdAgent(args);
		case "schedules": {
			const sub = args.positional.shift();
			if (sub === "list") return cmdSchedulesList(args);
			if (sub === "approve") return cmdSchedulesApprove(args);
			if (sub === "revoke") return cmdSchedulesRevoke(args);
			if (sub === "export") return cmdSchedulesExport(args);
			process.stderr.write(`error: unknown schedules subcommand '${sub ?? ""}'\n\n` + usage());
			return 2;
		}
		default:
			process.stderr.write(`error: unknown command '${command}'\n\n` + usage());
			return 2;
	}
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((err) => {
		process.stderr.write(`error: ${errorMessage(err)}\n`);
		process.exitCode = 1;
	});
