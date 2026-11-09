import { describe, expect, it } from "vitest";
import { grantHash } from "../executor";
import { WorkflowParser } from "../parser";
import { classifyScheduleApproval } from "./approvals";
import type { ScheduleApproval } from "./approvals";

/**
 * A schedule approval is consent to run a note unattended. It is bound to
 * what the note runs (the hash permission decisions use), so an edit to the
 * cells or the front matter withdraws it, and writing an output does not.
 */

const parser = new WorkflowParser();

const NOTE = `---
ore: true
name: Digest
schedule: "0 9 * * 1-5"
permissions:
  network: deny
---

# Digest

Some prose.

\`\`\`ore:ts id=hello
1 + 1;
\`\`\`
`;

const hashOf = (content: string): Promise<string> =>
  grantHash(parser.parse(content, "Workflows/digest.md"));

async function approvalsFor(content: string): Promise<Record<string, ScheduleApproval>> {
  return {
    "Workflows/digest.md": {
      hash: await hashOf(content),
      schedule: "0 9 * * 1-5",
      approvedAt: "2026-11-09T00:00:00.000Z",
    },
  };
}

describe("classifyScheduleApproval", () => {
  it("is approved while the note's hash is the approved one", async () => {
    const approvals = await approvalsFor(NOTE);
    expect(
      classifyScheduleApproval(approvals, "Workflows/digest.md", await hashOf(NOTE))
    ).toBe("approved");
  });

  it("is not approved without an entry for the path", async () => {
    const approvals = await approvalsFor(NOTE);
    expect(
      classifyScheduleApproval(approvals, "Workflows/other.md", await hashOf(NOTE))
    ).toBe("not-approved");
    expect(classifyScheduleApproval({}, "Workflows/digest.md", await hashOf(NOTE))).toBe(
      "not-approved"
    );
  });

  it("does not take an inherited property for an approval", async () => {
    expect(classifyScheduleApproval({}, "constructor", await hashOf(NOTE))).toBe("not-approved");
    expect(classifyScheduleApproval({}, "__proto__", await hashOf(NOTE))).toBe("not-approved");
  });

  it("is changed when a cell was edited", async () => {
    const approvals = await approvalsFor(NOTE);
    const edited = NOTE.replace("1 + 1;", "1 + 2;");
    expect(
      classifyScheduleApproval(approvals, "Workflows/digest.md", await hashOf(edited))
    ).toBe("changed");
  });

  it("is changed when the schedule was edited, which is part of the front matter", async () => {
    const approvals = await approvalsFor(NOTE);
    const edited = NOTE.replace("0 9 * * 1-5", "* * * * *");
    expect(
      classifyScheduleApproval(approvals, "Workflows/digest.md", await hashOf(edited))
    ).toBe("changed");
  });

  it("is changed when a permission was edited", async () => {
    const approvals = await approvalsFor(NOTE);
    const edited = NOTE.replace("network: deny", "network: allow");
    expect(
      classifyScheduleApproval(approvals, "Workflows/digest.md", await hashOf(edited))
    ).toBe("changed");
  });

  it("stays approved when a run writes an output callout under a cell", async () => {
    const approvals = await approvalsFor(NOTE);
    const withOutput = NOTE.replace(
      "1 + 1;\n```\n",
      "1 + 1;\n```\n\n> [!ore-output] hello\n> run: 2026-11-09T09-00-00-000Z-abc123\n> status: success | duration: 0.12s | at: 2026-11-09T09:00:00.000Z\n"
    );
    expect(withOutput).not.toBe(NOTE);
    expect(
      classifyScheduleApproval(approvals, "Workflows/digest.md", await hashOf(withOutput))
    ).toBe("approved");
  });

  it("stays approved when only the prose around the cells was edited", async () => {
    const approvals = await approvalsFor(NOTE);
    const edited = NOTE.replace("Some prose.", "Some other prose, and more of it.");
    expect(
      classifyScheduleApproval(approvals, "Workflows/digest.md", await hashOf(edited))
    ).toBe("approved");
  });
});
