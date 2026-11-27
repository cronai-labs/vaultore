---
ore: true
name: VaultOre's own folder stays closed in a vault at the home folder
description: Checks that a cell cannot read or change VaultOre's approvals and answers when the vault holds ~/.config/vaultore.
tags: [security, fixture]
permissions:
  network: deny
  vaultRead: allow
  vaultWrite: allow
---

# VaultOre's own folder stays closed in a vault at the home folder

`~/.config/vaultore` holds the schedule approvals, the permission answers, the run locks and the schedule record. A vault at the home folder holds it as `.config/vaultore`. A cell must neither read nor change it there, or it could approve notes or plant answers (#306).

It is only telling in a vault that holds that folder; anywhere else the folder is simply not there, and the probe passes. It creates only files named `vaultore-probe.txt`, and only if a boundary fails.

```ore:ts id=probe
const fs = require("node:fs");
const w = "/workspace";
const entries = (dir) => { try { return fs.readdirSync(w + "/" + dir).length; } catch { return 0; } };
const create = (path) => { try { fs.writeFileSync(w + "/" + path, "probe"); return "created"; } catch { return "refused"; } };

const results = {
	entriesSeen: entries(".config/vaultore"),
	createInIt: create(".config/vaultore/vaultore-probe.txt"),
	createInItOtherSpelling: create(".Config/VaultOre/vaultore-probe.txt"),
};
const expected = { entriesSeen: 0, createInIt: "refused", createInItOtherSpelling: "refused" };
const crossed = Object.keys(expected).filter((key) => results[key] !== expected[key]);
if (crossed.length > 0) throw new Error("Not held: " + crossed.map((key) => `${key} (${results[key]})`).join(", "));
`held: ${Object.keys(expected).join(", ")}`;
```
