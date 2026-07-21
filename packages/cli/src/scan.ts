/**
 * @vaultore/cli - Workflow discovery and schedule manifest export
 *
 * The schedule manifest is the handover contract between local execution
 * (Obsidian plugin or `vaultore agent`) and CronAI infrastructure — see
 * specs/cronai-handover-spec.md.
 */

import { createHash } from "node:crypto";
import { WorkflowParser } from "@vaultore/core";
import type { Workflow } from "@vaultore/core";
import type { NodeAdapter } from "./adapter";

export interface DiscoveredWorkflow {
	/** Vault-relative path of the workflow note */
	path: string;
	workflow: Workflow;
	/** SHA-256 of the note content, for drift detection on handover */
	contentSha256: string;
}

export interface ScheduleManifest {
	format: "vaultore.schedule-manifest";
	version: "0.1";
	generatedAt: string;
	vault: {
		root: string;
		name: string;
	};
	workflows: Array<{
		path: string;
		name: string;
		schedule: string;
		runtime?: Record<string, unknown>;
		permissions?: Record<string, unknown>;
		contentSha256: string;
	}>;
}

const parser = new WorkflowParser();

/**
 * Find every workflow note in the vault. Output folders (default
 * `_vaultore`) are skipped so generated notes are never picked up.
 */
export async function discoverWorkflows(
	adapter: NodeAdapter,
	options: { outputRoot?: string } = {}
): Promise<DiscoveredWorkflow[]> {
	const outputRoot = (options.outputRoot ?? "_vaultore").replace(/\/+$/, "");
	const files = await adapter.listFiles("");
	const results: DiscoveredWorkflow[] = [];

	for (const path of files) {
		if (!path.endsWith(".md")) continue;
		if (path === outputRoot || path.startsWith(`${outputRoot}/`)) continue;

		let content: string;
		try {
			content = await adapter.readFile(path);
		} catch {
			continue;
		}
		if (!parser.isWorkflow(content)) continue;

		try {
			const workflow = parser.parse(content, path);
			results.push({
				path,
				workflow,
				contentSha256: createHash("sha256").update(content).digest("hex"),
			});
		} catch {
			// Malformed workflow notes are skipped, mirroring plugin behavior
		}
	}

	return results;
}

/**
 * Build the CronAI handover manifest from discovered workflows. Only
 * scheduled workflows are included — unscheduled ones have nothing to
 * hand over.
 */
export function buildScheduleManifest(
	discovered: DiscoveredWorkflow[],
	vaultRoot: string
): ScheduleManifest {
	const name = vaultRoot.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "vault";

	return {
		format: "vaultore.schedule-manifest",
		version: "0.1",
		generatedAt: new Date().toISOString(),
		vault: { root: vaultRoot, name },
		workflows: discovered
			.filter((d) => Boolean(d.workflow.frontmatter.schedule))
			.map((d) => ({
				path: d.path,
				name: d.workflow.frontmatter.name,
				schedule: String(d.workflow.frontmatter.schedule),
				...(d.workflow.frontmatter.runtime
					? { runtime: d.workflow.frontmatter.runtime as Record<string, unknown> }
					: {}),
				...(d.workflow.frontmatter.permissions
					? { permissions: d.workflow.frontmatter.permissions as Record<string, unknown> }
					: {}),
				contentSha256: d.contentSha256,
			})),
	};
}
