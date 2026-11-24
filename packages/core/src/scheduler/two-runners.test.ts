import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nodeTimers } from "../testing/timers";
import { WorkflowScheduler } from "./index";
import type { DueWorkflow } from "./index";
import { SlotTakenError, claimSlot, readSlotRecord } from "./slot-record";

/**
 * #255 end to end, without containers: two runners arm the same note at
 * different moments, both tick past one occurrence, and both try to claim it
 * in one record. They must name the same slot, and only one may run it.
 */

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vaultore-two-runners-"));
	mkdirSync(join(dir, "Vault", "Workflows"), { recursive: true });
	writeFileSync(join(dir, "Vault", "Workflows", "fast.md"), "---\nore: true\nschedule: \"* * * * *\"\n---\n");
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

it("two runners that armed a note at different moments claim one slot, and only one gets it", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	const due: Record<string, DueWorkflow[]> = { obsidian: [], agent: [] };
	const plugin = new WorkflowScheduler({ timers: nodeTimers });
	const agent = new WorkflowScheduler({ timers: nodeTimers });

	vi.setSystemTime(new Date("2026-11-24T10:14:03.123Z"));
	plugin.register("Workflows/fast.md", "* * * * *");
	vi.setSystemTime(new Date("2026-11-24T10:14:47.987Z"));
	agent.register("Workflows/fast.md", "* * * * *");

	// Their ticks fall at different moments past the occurrence.
	vi.setSystemTime(new Date("2026-11-24T10:15:00.412Z"));
	due.obsidian = plugin.tick();
	vi.setSystemTime(new Date("2026-11-24T10:15:38.020Z"));
	due.agent = agent.tick();

	// Each fires the 10:15 occurrence (with what came due since it armed).
	const a = due.obsidian.find((w) => w.slot.toISOString() === "2026-11-24T10:15:00.000Z");
	const b = due.agent.find((w) => w.slot.toISOString() === "2026-11-24T10:15:00.000Z");
	expect(a).toBeDefined();
	expect(b?.slot.getTime()).toBe(a?.slot.getTime());

	vi.useRealTimers();
	const claim = (by: string, w: DueWorkflow) =>
		claimSlot({
			vaultRoot: join(dir, "Vault"),
			notePath: w.path,
			schedule: w.cronExpression,
			slot: w.slot,
			by,
			directory: join(dir, "slots"),
		});
	const results = await Promise.allSettled([claim("Obsidian", a as DueWorkflow), claim("vaultore agent", b as DueWorkflow)]);

	expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
	expect(refused.reason).toBeInstanceOf(SlotTakenError);
	expect(await readSlotRecord({ directory: join(dir, "slots") })).toHaveLength(1);
});
