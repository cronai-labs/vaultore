/**
 * @vaultore/cli - `vaultore` command
 *
 * Standalone, Obsidian-free entry points for VaultOre workflows:
 *
 *   vaultore run <workflow.md>       run a workflow headless
 *   vaultore list                    list workflow notes in the vault
 *   vaultore agent                   headless scheduler daemon
 *   vaultore schedules export        emit the CronAI handover manifest
 */

import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { WorkflowExecutor, WorkflowScheduler, VERSION } from "@vaultore/core";
import { NodeAdapter } from "./adapter";
import { buildScheduleManifest, discoverWorkflows } from "./scan";
import { hasExplicitVault, parseArgs, toVaultRelative, vaultRootFrom } from "./args";
import type { ParsedArgs } from "./args";

function usage(): string {
	return `vaultore ${VERSION} — Markdown-native AI workflow engine (headless CLI)

Usage:
  vaultore run <workflow.md> [--vault <dir>] [--cell <id>] [--skip-deps] [--yes] [--quiet]
  vaultore list [--vault <dir>]
  vaultore agent [--vault <dir>] [--yes] [--rescan <seconds>] [--quiet]
  vaultore schedules export [--vault <dir>] [--out <file>]
  vaultore --version | --help

Options:
  --vault <dir>       Vault root (default: current directory). When given, a
                      relative <workflow.md> resolves against it.
  --cell <id>         Run a single cell (with its dependencies)
  --skip-deps         With --cell: skip dependency cells
  --yes               Auto-grant "ask" permissions (non-interactive default: deny)
  --rescan <seconds>  Agent rescan interval (default: 300)
  --out <file>        Write manifest to a file instead of stdout
  --quiet             Suppress info/debug output

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

async function cmdList(args: ParsedArgs): Promise<number> {
	const vaultRoot = vaultRootFrom(args.flags);
	const adapter = new NodeAdapter({ vaultRoot, quiet: true });
	const outputRoot = adapter.getSetting<string>("vaultore.outputRoot");
	const discovered = await discoverWorkflows(adapter, { outputRoot });

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
	const vaultRoot = vaultRootFrom(args.flags);
	const adapter = new NodeAdapter({
		vaultRoot,
		assumeYes: args.flags["yes"] === true,
		quiet: args.flags["quiet"] === true,
	});
	const executor = new WorkflowExecutor();
	const rescanSeconds = Number(args.flags["rescan"] ?? 300) || 300;

	const runByPath = async (path: string): Promise<void> => {
		try {
			const content = await adapter.readFile(path);
			process.stdout.write(`[vaultore:agent] running ${path}\n`);
			await executor.runWorkflow({ platform: adapter, workflowPath: path, content });
			process.stdout.write(`[vaultore:agent] completed ${path}\n`);
		} catch (err) {
			process.stderr.write(
				`[vaultore:agent] failed ${path}: ${err instanceof Error ? err.message : String(err)}\n`
			);
		}
	};

	const scheduler = new WorkflowScheduler({
		tickIntervalMs: 60 * 1000,
		onTick: (workflows) => {
			workflows.forEach((workflow) => {
				void runByPath(workflow.path);
			});
		},
	});

	const rescan = async (): Promise<void> => {
		for (const entry of scheduler.list()) {
			scheduler.unregister(entry.path);
		}
		const outputRoot = adapter.getSetting<string>("vaultore.outputRoot");
		const discovered = await discoverWorkflows(adapter, { outputRoot });
		let registered = 0;
		for (const item of discovered) {
			const schedule = item.workflow.frontmatter.schedule;
			if (!schedule) continue;
			try {
				scheduler.register(item.path, String(schedule));
				registered += 1;
			} catch {
				process.stderr.write(`[vaultore:agent] invalid cron in ${item.path}, skipping\n`);
			}
		}
		process.stdout.write(`[vaultore:agent] ${registered} scheduled workflow(s) registered\n`);
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

async function cmdSchedulesExport(args: ParsedArgs): Promise<number> {
	const vaultRoot = vaultRootFrom(args.flags);
	const adapter = new NodeAdapter({ vaultRoot, quiet: true });
	const outputRoot = adapter.getSetting<string>("vaultore.outputRoot");
	const discovered = await discoverWorkflows(adapter, { outputRoot });
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
		process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n\n` + usage());
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
		process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 1;
	});
