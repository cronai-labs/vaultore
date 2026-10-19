import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { WorkflowExecutor } from "../executor";
import type { PlatformRequest, PlatformResponse, Workflow } from "../types";
import {
	filesystemPlatform,
	makeIntegrationVaultRoot,
	waitForContainerView,
} from "../testing/integration-vault";

/**
 * fixtures/canonical/smart-inbox.md end to end (#79): the TS cells run in a
 * real container, the AI cell's provider request is answered by the
 * platform's `request` in this process. Needs a running engine (VAULTORE_IT_ENGINE, default
 * colima).
 *
 *   bun run --cwd packages/core test:integration
 */

const FIXTURE = readFileSync(
	resolve(__dirname, "../../../../fixtures/canonical/smart-inbox.md"),
	"utf8"
);

const INBOX_LINES = [
	"# Inbox",
	"",
	"Things I jot down during the day. Not a task, - [ ] not even this.",
	"",
	"- [ ] Prepare the Q3 board deck",
	"- [x] Renew the domain",
	"- [ ] Book a dentist appointment",
	"  - [ ] Read the Bun runtime docs",
	"* [ ] Water the plants",
	"- [ ] Call mum",
	"- [ ] Call mum",
	"- [ ]",
	"",
];
const INBOX = INBOX_LINES.join("\n");

/** The categorisation of INBOX's six open items, by item number. */
const ANSWER = JSON.stringify({ work: [1], personal: [2, 4, 5, 6], reference: [3] });

/** INBOX with the given 0-based lines ticked. */
function ticked(lines: readonly string[], indexes: readonly number[]): string {
	return lines
		.map((line, i) => (indexes.includes(i) ? line.replace("[ ]", "[x]") : line))
		.join("\n");
}

let root: string;
let prompts: string[];
let provider: (request: PlatformRequest) => Promise<PlatformResponse>;

beforeEach(() => {
	root = makeIntegrationVaultRoot();
	prompts = [];
	provider = async () => {
		throw new Error("unexpected provider request");
	};
	writeFileSync(join(root, "smart-inbox.md"), FIXTURE);
	writeFileSync(join(root, "Inbox.md"), INBOX);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const read = (path: string) => readFileSync(join(root, path), "utf8");

/**
 * Answer each provider request with the next of `answers`, in the OpenAI
 * chat-completions shape. `during` runs inside the request, i.e. after the
 * inbox was read and before anything is written.
 */
function stubProvider(answers: string[], during?: () => Promise<void>) {
	provider = async (request) => {
		const body = JSON.parse(String(request.body)) as {
			messages: Array<{ content: string }>;
		};
		prompts.push(body.messages[0]?.content ?? "");
		await during?.();
		const content = answers.shift();
		if (content === undefined) throw new Error("unexpected provider request");
		return { status: 200, text: JSON.stringify({ choices: [{ message: { content } }] }) };
	};
}

async function run(): Promise<Workflow> {
	return new WorkflowExecutor().runWorkflow({
		platform: filesystemPlatform(root, {
			settings: { "vaultore.defaultProvider": "openai" },
			secrets: { "openai.apiKey": "test-key" },
			request: (request) => provider(request),
		}),
		workflowPath: "smart-inbox.md",
		content: read("smart-inbox.md"),
	});
}

function statuses(workflow: Workflow): Record<string, string | undefined> {
	return Object.fromEntries(
		workflow.cells.map((cell) => [
			cell.attributes.id,
			workflow.outputs.get(cell.attributes.id)?.meta.status,
		])
	);
}

function frontmatter(note: string): Record<string, unknown> {
	const match = note.match(/^---\n([\s\S]*?)\n---\n/);
	expect(match, "note starts with frontmatter").not.toBeNull();
	return parseYaml(match?.[1] ?? "") as Record<string, unknown>;
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

describe("smart-inbox", { timeout: 180_000 }, () => {
	it("files each open item into its category note and ticks exactly those lines", async () => {
		stubProvider([ANSWER]);
		const workflow = await run();

		expect(Object.values(statuses(workflow)).every((s) => s === "success"), JSON.stringify(statuses(workflow))).toBe(true);

		// One AI call, carrying the six open items and nothing already done.
		expect(prompts).toHaveLength(1);
		for (const item of [
			"1. Prepare the Q3 board deck",
			"2. Book a dentist appointment",
			"3. Read the Bun runtime docs",
			"4. Water the plants",
			"5. Call mum",
			"6. Call mum",
		]) {
			expect(prompts[0]).toContain(item);
		}
		expect(prompts[0]).not.toContain("Renew the domain");

		const work = read("Processed/Work.md");
		const personal = read("Processed/Personal.md");
		const reference = read("Processed/Reference.md");
		expect(work).toContain("- [ ] Prepare the Q3 board deck\n");
		expect(reference).toContain("- [ ] Read the Bun runtime docs\n");
		for (const item of ["Book a dentist appointment", "Water the plants"]) {
			expect(personal).toContain(`- [ ] ${item}\n`);
		}
		expect(personal.match(/- \[ \] Call mum\n/g)).toHaveLength(2);
		expect(work).not.toContain("dentist");

		for (const [note, title] of [
			[work, "Work"],
			[personal, "Personal"],
			[reference, "Reference"],
		] as const) {
			const meta = frontmatter(note);
			expect(meta.type).toBeTruthy();
			expect(meta.title).toBe(title);
			expect(String(meta.description)).not.toBe("");
			const generated = meta.generated as { by: string; at: string };
			expect(generated.by).toBe("process:smart-inbox");
			expect(generated.at).toMatch(ISO_WITH_OFFSET);
		}

		// Lines 4, 6-10 were the open items; everything else is byte-identical.
		expect(read("Inbox.md")).toBe(ticked(INBOX_LINES, [4, 6, 7, 8, 9, 10]));
	});

	it("does not process an item twice: a second run sees only what is new", async () => {
		stubProvider([ANSWER, JSON.stringify({ work: [1], personal: [], reference: [] })]);
		await run();
		const personalAfterFirst = read("Processed/Personal.md");

		writeFileSync(join(root, "Inbox.md"), `${read("Inbox.md")}- [ ] Draft the offer\n`);
		const inboxBeforeSecond = read("Inbox.md");
		// Only so the second run sees the new item: on colima with sshfs,
		// readInbox can be served the inbox cut off at its old length (#83). The
		// compare-and-swap on vault.write keeps such a run from damaging the inbox
		// (next test), but a cell that only reads still sees the stale copy.
		await waitForContainerView(root, "Inbox.md", inboxBeforeSecond);
		const second = await run();

		expect(Object.values(statuses(second)).every((s) => s === "success"), JSON.stringify(statuses(second))).toBe(true);
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("1. Draft the offer");
		expect(prompts[1]).not.toContain("Prepare the Q3 board deck");
		expect(prompts[1]).not.toContain("Call mum");

		const work = read("Processed/Work.md");
		expect(work.match(/Prepare the Q3 board deck/g)).toHaveLength(1);
		expect(work.match(/- \[ \] Draft the offer\n/g)).toHaveLength(1);
		expect(work.match(/^---$/gm)).toHaveLength(2);
		expect(read("Processed/Personal.md")).toBe(personalAfterFirst);

		expect(read("Inbox.md")).toBe(
			inboxBeforeSecond.replace("- [ ] Draft the offer\n", "- [x] Draft the offer\n")
		);
	});

	it("files an item added right before the run, or leaves it for the next run, and never loses a line", async () => {
		stubProvider([ANSWER, JSON.stringify({ work: [1], personal: [], reference: [] })]);
		await run();
		const inboxBefore = `${read("Inbox.md")}- [ ] Draft the offer\n`;
		writeFileSync(join(root, "Inbox.md"), inboxBefore);
		// No wait: the container may see the inbox from before this edit (#83).
		const second = await run();

		expect(Object.values(statuses(second)).every((s) => s === "success"), JSON.stringify(statuses(second))).toBe(true);
		const filed = prompts[1]?.includes("1. Draft the offer") ?? false;
		expect(read("Inbox.md")).toBe(
			filed ? inboxBefore.replace("- [ ] Draft the offer\n", "- [x] Draft the offer\n") : inboxBefore
		);
	});

	it("fails on an answer that is not JSON, and leaves the inbox and notes alone", async () => {
		stubProvider(["Sure! Work: 1. Personal: 2, 4, 5, 6. Reference: 3."]);
		const workflow = await run();

		const answer = workflow.outputs.get("parseAnswer");
		expect(answer?.meta.status).toBe("error");
		expect(String(answer?.value)).toContain("categorize did not answer with JSON");
		expect(statuses(workflow).writeNotes).toBe("error");
		expect(statuses(workflow).tickInbox).toBe("error");
		expect(read("Inbox.md")).toBe(INBOX);
		expect(existsSync(join(root, "Processed"))).toBe(false);
	});

	it("fails on an answer that leaves an item out", async () => {
		stubProvider([JSON.stringify({ work: [1], personal: [4, 5, 6], reference: [3] })]);
		const workflow = await run();

		const answer = workflow.outputs.get("parseAnswer");
		expect(answer?.meta.status).toBe("error");
		expect(String(answer?.value)).toContain("item 2 (Book a dentist appointment) was not categorised");
		expect(read("Inbox.md")).toBe(INBOX);
		expect(existsSync(join(root, "Processed"))).toBe(false);
	});

	it("leaves a line edited during the run unticked and reports it", async () => {
		const edited = ["- [ ] Added while the run was going", ...INBOX_LINES];
		edited[7] = "- [ ] Book a dentist appointment for Tuesday";
		stubProvider([ANSWER], async () => {
			writeFileSync(join(root, "Inbox.md"), edited.join("\n"));
		});

		const workflow = await run();

		// No wait after the edit: tickInbox may be served the inbox cut off at its
		// old length (#83). Its write is then refused and the inbox stays exactly
		// as the user left it; before the host checked writes, the cut-off text
		// was saved.
		if (statuses(workflow).tickInbox === "error") {
			expect(String(workflow.outputs.get("tickInbox")?.value)).toContain(
				"Inbox.md changed since this cell read it"
			);
			expect(read("Inbox.md")).toBe(edited.join("\n"));
			return;
		}
		expect(statuses(workflow).tickInbox).toBe("success");
		const result = workflow.outputs.get("tickInbox")?.value as {
			ticked: number;
			notTicked: string[];
		};
		expect(result.ticked).toBe(5);
		expect(result.notTicked).toEqual(["Book a dentist appointment"]);
		// Shifted by one line, the other five are still found; the edited line
		// and the line added at the top are untouched.
		expect(read("Inbox.md")).toBe(ticked(edited, [5, 8, 9, 10, 11]));
	});
});
