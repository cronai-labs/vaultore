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
 *   vaultore schedules log           what each scheduled run came to
 *   vaultore schedules catch-up      run a note's missed scheduled runs once now
 *   vaultore schedules dismiss       close a note's missed scheduled runs
 *   vaultore schedules late-after    how late a scheduled run may start, for this machine
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { clearInterval, setInterval } from "node:timers";
import {
	RunLockHeldError,
	SlotTakenError,
	catchUpMissedSlot,
	dismissMissedSlots,
	isLateSlot,
	lateAfterMs,
	readMachineSettings,
	machineSettingsPath,
	readSlotRecord,
	recordMissedSlots,
	WorkflowExecutor,
	WorkflowScheduler,
	VERSION,
	errorMessage,
} from "@vaultore/core";
import type { ScheduledSlot, SlotClaim } from "@vaultore/core";
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
	formatSlotLog,
	lateAfter,
	listSchedules,
	readScheduledNote,
	revokeSchedules,
	scheduledNotes,
} from "./schedules";
import {
	configDirFrom,
	hasExplicitVault,
	keepDaysFrom,
	parseArgs,
	slotFrom,
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
  vaultore agent [--vault <dir>] [--config-dir <name>] [--state-dir <dir>] [--yes] [--rescan <seconds>] [--keep-days <n>] [--quiet]
  vaultore schedules list [--vault <dir>] [--config-dir <name>] [--state-dir <dir>]
  vaultore schedules approve <workflow.md>... [--vault <dir>] [--state-dir <dir>]
  vaultore schedules revoke <workflow.md>... [--vault <dir>] [--state-dir <dir>]
  vaultore schedules export [--vault <dir>] [--config-dir <name>] [--out <file>]
  vaultore schedules log [<workflow.md>] [--vault <dir>]
  vaultore schedules catch-up <workflow.md> [<slot>] [--vault <dir>] [--config-dir <name>] [--yes] [--quiet]
  vaultore schedules dismiss <workflow.md> [<slot>] [--vault <dir>]
  vaultore schedules late-after [<minutes> | default]
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
  --keep-days <n>     Days of scheduled-run history to keep, 0 to 30
                      (default: 30). 0 keeps each run for a day only.
  --out <file>        Write manifest to a file instead of stdout
  --quiet             Suppress info/debug output

The agent runs a scheduled note only after 'vaultore schedules approve', and
only while the note's front matter and cells are what was approved. Each
occurrence of a schedule runs at most once, in the agent or in Obsidian;
'vaultore schedules log' shows what each one came to. Occurrences no runner
fired (the machine slept, nothing was running) are recorded as missed runs;
'schedules catch-up' runs the note once for them, 'schedules dismiss' closes
them. A missed run is named by its first slot, as the log shows it.

An occurrence is missed once it is more than 2 minutes late. 'schedules
late-after' shows or sets that for this machine, 2 to 60 minutes, in the file
both runners read (Obsidian's "Late after" is the same setting).

Secrets are read from the environment:
  VAULTORE_OPENAI_APIKEY (or OPENAI_API_KEY)
  VAULTORE_ANTHROPIC_APIKEY (or ANTHROPIC_API_KEY)
`;
}

/** Runs a note: `vaultore run`, or with `catchUp` the catch-up of its missed runs (#269). */
async function cmdRun(args: ParsedArgs, catchUp?: { slot: Date | undefined }): Promise<number> {
	const workflowArg = args.positional[0];
	if (!workflowArg) {
		process.stderr.write("error: missing workflow file\n\n" + usage());
		return 2;
	}
	if (catchUp && args.flags["cell"] !== undefined) {
		process.stderr.write("error: a catch-up runs the whole note; --cell is not for it\n\n" + usage());
		return 2;
	}

	const vaultRoot = vaultRootFrom(args.flags);
	const adapter = new NodeAdapter({
		vaultRoot,
		configDir: configDirFrom(args.flags),
		assumeYes: args.flags["yes"] === true,
		quiet: args.flags["quiet"] === true,
		runner: catchUp ? "vaultore schedules catch-up" : "vaultore run",
	});

	const workflowPath = toVaultRelative(vaultRoot, workflowArg, {
		vaultExplicit: hasExplicitVault(args.flags),
	});
	const content = await adapter.readFile(workflowPath);

	// Taken once the note was read: a note that cannot be read leaves its
	// missed runs open.
	let slotClaim: SlotClaim | undefined;
	if (catchUp) {
		const claim = await catchUpMissedSlot({ vaultRoot, notePath: workflowPath, slot: catchUp.slot, by: "vaultore" });
		const { gap } = claim;
		process.stdout.write(
			`[vaultore] catching up ${gap.count ?? 1} missed run(s) of ${workflowPath}, ` +
				`from ${gap.slot.toISOString()} to ${(gap.until ?? gap.slot).toISOString()}, with one run\n`
		);
		slotClaim = claim;
	}

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
		...(slotClaim ? { slotClaim } : {}),
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

/** Why an occurrence was not run when a later one came due in the same tick. */
const SUPERSEDED = "a later occurrence came due at the same time and ran instead";

async function cmdAgent(args: ParsedArgs): Promise<number> {
	let rescanSeconds: number;
	let keepDays: number;
	try {
		rescanSeconds = rescanSecondsFrom(args.flags);
		keepDays = keepDaysFrom(args.flags);
	} catch (err) {
		process.stderr.write(`error: ${errorMessage(err)}\n\n` + usage());
		return 2;
	}
	// The late threshold is this machine's, shared with Obsidian: a file that
	// cannot be used stops the agent here (the error names it) rather than
	// running with a threshold Obsidian may not share.
	let late: number;
	try {
		late = lateAfterMs((await readMachineSettings()).lateAfterMinutes);
	} catch (err) {
		process.stderr.write(`error: ${errorMessage(err)}\n`);
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
		runner: "vaultore agent",
		keepDays,
	});
	const executor = new WorkflowExecutor();
	const warn = (line: string): void => {
		process.stderr.write(`[vaultore:agent] ${line}\n`);
	};

	// A due note runs only if it is approved as it is now: the note and the
	// approvals are read again, and the content that was checked is what runs.
	// The slot is claimed only here, once the note passed the approval check:
	// a note this agent may not run leaves the slot to the plugin (#255).
	const runApproved = createApprovedRunner<ScheduledSlot>({
		readNote: (path) => readScheduledNote((notePath) => adapter.readFile(notePath), path),
		approvals: () => store.forVault(vaultKey),
		run: async (path, content, scheduled) => {
			try {
				process.stdout.write(`[vaultore:agent] running ${path}\n`);
				await executor.runWorkflow({ platform: adapter, workflowPath: path, content, scheduled });
				process.stdout.write(`[vaultore:agent] completed ${path}\n`);
			} catch (err) {
				// Run elsewhere, by the plugin or another CLI: not a failure of this one.
				if (err instanceof RunLockHeldError || err instanceof SlotTakenError) {
					warn(`skipped ${path}: ${err.message}`);
					return;
				}
				process.stderr.write(
					`[vaultore:agent] failed ${path}: ${errorMessage(err)}\n`
				);
			}
		},
		onRefuse: (path, reason) => warn(`not running ${path}: ${reason}`),
	});

	// A slot not run is still decided: claimed and recorded as skipped, so it
	// is neither run later nor lost between the record's slots (#269).
	const recordSkipped = async (path: string, scheduled: ScheduledSlot, reason: string): Promise<void> => {
		try {
			const claim = await adapter.claimSlot(path, scheduled);
			await claim.finish({ result: "skipped", reason });
			process.stderr.write(`[vaultore:agent] skipped ${path} at ${scheduled.slot.toISOString()}: ${reason}\n`);
		} catch (err) {
			if (!(err instanceof SlotTakenError)) warn(`could not record the skipped run of ${path}: ${errorMessage(err)}`);
		}
	};

	const runByPath = createSingleFlightRunner(runApproved, (path, scheduled) =>
		recordSkipped(path, scheduled, "the previous run is still in progress")
	);

	// Occurrences no runner fired are recorded as missed runs, said once
	// here, and left to the user to catch up or dismiss (#269).
	const lookForMissed = async (path: string, schedule: string, armedAt?: Date): Promise<void> => {
		try {
			const gaps = await recordMissedSlots({
				vaultRoot,
				notePath: path,
				schedule,
				by: "vaultore agent",
				keepDays,
				lateAfterMs: late,
				...(armedAt ? { armedAt } : {}),
			});
			for (const gap of gaps) {
				warn(
					`missed ${gap.count} scheduled run(s) of ${path}, from ${gap.slot.toISOString()} to ${gap.until.toISOString()}; ` +
						`run them once with: vaultore schedules catch-up ${path}, or close them with: vaultore schedules dismiss ${path}`
				);
			}
		} catch (err) {
			warn(`could not look for missed runs of ${path}: ${errorMessage(err)}`);
		}
	};

	const scheduler = new WorkflowScheduler({
		timers: adapter.timers,
		tickIntervalMs: 60 * 1000,
		lateAfterMs: late,
		onTick: (workflows) => {
			workflows.forEach((workflow) => {
				// A tick that comes late (the machine slept) does not run the
				// slot it held: that slot, and any after it, are missed runs.
				if (isLateSlot(workflow.slot, new Date(), late)) {
					void lookForMissed(workflow.path, workflow.cronExpression, workflow.armedAt);
					return;
				}
				// A later occurrence came due in the same tick and runs instead.
				if (workflow.superseded) {
					void recordSkipped(workflow.path, { schedule: workflow.cronExpression, slot: workflow.slot }, SUPERSEDED);
					return;
				}
				void runByPath(workflow.path, { schedule: workflow.cronExpression, slot: workflow.slot });
			});
		},
	});

	const reportSkips = createSkipReporter(warn);
	let storeError: string | undefined;

	const rescan = async (): Promise<void> => {
		const outputRoot = adapter.getSetting<string>("vaultore.outputRoot");
		const discovered = await discoverWorkflows(adapter, {
			outputRoot,
			onSkip: reportSkipped("[vaultore:agent]"),
		});
		// An approvals file that cannot be used leaves nothing armed. Said once,
		// and again when the reason changes.
		let approvals;
		try {
			approvals = await store.forVault(vaultKey);
			storeError = undefined;
		} catch (err) {
			scheduler.replace([]);
			const message = errorMessage(err);
			if (message !== storeError) warn(`${message}. Nothing runs until then`);
			storeError = message;
			return;
		}

		const plan = planRegistrations(await scheduledNotes(discovered), approvals);
		// Notes armed already keep their next run, so a slot that came due since
		// the last tick still fires (#255).
		const { invalid, armed } = scheduler.replace(
			plan.register.map((note) => ({ path: note.path, cronExpression: note.schedule }))
		);
		for (const note of invalid) {
			process.stderr.write(`[vaultore:agent] invalid cron in ${note.path}, skipping\n`);
		}
		for (const note of armed) {
			const entry = scheduler.list().find((e) => e.path === note.path);
			void lookForMissed(note.path, note.cronExpression, entry?.armedAt);
		}
		// An occurrence of the last two minutes fires now, in time, rather
		// than at the next tick, when it would be late.
		if (armed.length > 0) scheduler.tick();
		const registered = plan.register.length - invalid.length;
		process.stdout.write(`[vaultore:agent] ${registered} scheduled workflow(s) registered\n`);
		reportSkips({ registered, skipped: plan.skipped });
	};

	await rescan();
	scheduler.start();
	const rescanTimer = setInterval(() => {
		void rescan();
	}, rescanSeconds * 1000);
	// Obsidian's "Late after" writes the same file: follow it within a minute.
	// A file that turned unusable is reported, and the last good value kept.
	let lateFileError = "";
	const lateTimer = setInterval(() => {
		void readMachineSettings().then(
			(settings) => {
				lateFileError = "";
				late = lateAfterMs(settings.lateAfterMinutes);
				scheduler.lateAfterMs = late;
			},
			(err: unknown) => {
				const message = errorMessage(err);
				if (message !== lateFileError) warn(`${message}; keeping late after ${late / 60_000} minutes`);
				lateFileError = message;
			}
		);
	}, 60 * 1000);

	process.stdout.write(
		`[vaultore:agent] watching ${vaultRoot} (rescan every ${rescanSeconds}s, Ctrl-C to stop)\n`
	);

	await new Promise<void>((resolveExit) => {
		const stop = (): void => {
			clearInterval(rescanTimer);
			clearInterval(lateTimer);
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

async function cmdSchedulesLog(args: ParsedArgs): Promise<number> {
	const vaultRoot = vaultRootFrom(args.flags);
	const noteArg = args.positional[0];
	if (args.positional.length > 1) {
		process.stderr.write("error: schedules log takes at most one note\n\n" + usage());
		return 2;
	}
	const notePath =
		noteArg === undefined
			? undefined
			: toVaultRelative(vaultRoot, noteArg, { vaultExplicit: hasExplicitVault(args.flags) });
	const entries = await readSlotRecord({ vaultRoot, ...(notePath !== undefined ? { notePath } : {}) });
	for (const line of formatSlotLog(entries)) {
		process.stdout.write(`${line}\n`);
	}
	return 0;
}

/** `slotFrom`, with a usage error printed and null for a bad one. */
function slotArg(args: ParsedArgs): Date | undefined | null {
	try {
		return slotFrom(args.positional);
	} catch (err) {
		process.stderr.write(`error: ${errorMessage(err)}\n\n` + usage());
		return null;
	}
}

async function cmdSchedulesDismiss(args: ParsedArgs): Promise<number> {
	const noteArg = args.positional[0];
	if (!noteArg) {
		process.stderr.write("error: missing workflow file\n\n" + usage());
		return 2;
	}
	const slot = slotArg(args);
	if (slot === null) return 2;
	const vaultRoot = vaultRootFrom(args.flags);
	const notePath = toVaultRelative(vaultRoot, noteArg, { vaultExplicit: hasExplicitVault(args.flags) });
	const dismissed = await dismissMissedSlots({ vaultRoot, notePath, slot, by: "vaultore" });
	for (const gap of dismissed) {
		process.stdout.write(
			`dismissed ${gap.count ?? 1} missed run(s) of ${notePath}, from ${gap.slot.toISOString()} to ${(gap.until ?? gap.slot).toISOString()}\n`
		);
	}
	return 0;
}

/**
 * Shows or sets how many minutes late a scheduled run may start, for this
 * machine: the file both runners read (Obsidian's "Late after"). A running
 * agent follows a change within a minute.
 */
async function cmdSchedulesLateAfter(args: ParsedArgs): Promise<number> {
	let line: string;
	try {
		line = await lateAfter(args.positional[0], machineSettingsPath());
	} catch (err) {
		process.stderr.write(`error: ${errorMessage(err)}\n\n` + usage());
		return 2;
	}
	process.stdout.write(line + "\n");
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
			if (sub === "log") return cmdSchedulesLog(args);
			if (sub === "catch-up") {
				const slot = slotArg(args);
				return slot === null ? 2 : cmdRun(args, { slot });
			}
			if (sub === "dismiss") return cmdSchedulesDismiss(args);
			if (sub === "late-after") return cmdSchedulesLateAfter(args);
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
