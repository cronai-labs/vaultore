---
ore: true
name: Hello World
version: "0.1"
author: VaultOre Team
tags: [canonical, smoke-test, minimal]
description: >
  Minimal smoke test workflow. If this runs, VaultOre is working.

runtime:
  engine: docker
  image: oven/bun:1-alpine

permissions:
  network: deny
  vaultWrite: deny
  vaultRead: allow
---

# Hello World

The simplest possible VaultOre workflow.

## Test Criteria

- [ ] Parser extracts frontmatter correctly
- [ ] Parser identifies both cells
- [ ] TypeScript cell executes
- [ ] Output stub appears as an ore-output callout
- [ ] Second cell receives first cell's output

---

## Step 1: Compute a value

```ore:ts id=hello
const message = "Hello from VaultOre!";
message;
```

## Step 2: Transform the value

```ore:ts id=transform depends=[hello]
const msg = cell("hello");
msg.toUpperCase();
```

---

## Expected Outputs

After running, you should see:

1. `hello` output: `"Hello from VaultOre!"`
2. `transform` output: `"HELLO FROM VAULTORE!"`

Both appear as ore-output callouts below their respective cells.
