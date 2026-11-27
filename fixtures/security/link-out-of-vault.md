---
ore: true
name: A link out of the vault leads nowhere
description: Checks that a symbolic link in the vault that points outside it shows a cell nothing of what it points to.
tags: [security, fixture]
permissions:
  network: deny
  vaultRead: allow
  vaultWrite: allow
---

# A link out of the vault leads nowhere

The container sees the vault, not the computer. A symbolic link in the vault that points outside it (`vaultore-link-out -> ~/Documents`) must not show a cell the folder it points to (permissions-spec §3.4).

To make it telling by hand, create such a link at the vault's top level, named `vaultore-link-out`; without one the probe passes trivially.

```ore:ts id=probe
const fs = require("node:fs");
const w = "/workspace";
const entries = (dir) => { try { return fs.readdirSync(w + "/" + dir).length; } catch { return 0; } };
const create = (path) => { try { fs.writeFileSync(w + "/" + path, "probe"); return "created"; } catch { return "refused"; } };

const results = {
	entriesSeen: entries("vaultore-link-out"),
	createThroughLink: create("vaultore-link-out/vaultore-probe.txt"),
};
const expected = { entriesSeen: 0, createThroughLink: "refused" };
const crossed = Object.keys(expected).filter((key) => results[key] !== expected[key]);
if (crossed.length > 0) throw new Error("Not held: " + crossed.map((key) => `${key} (${results[key]})`).join(", "));
`held: ${Object.keys(expected).join(", ")}`;
```
