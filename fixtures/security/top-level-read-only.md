---
ore: true
name: The vault's top level stays read-only
description: Checks that a cell with vaultWrite writes in the vault's folders, and creates nothing at its top level through the mount.
tags: [security, fixture]
permissions:
  network: deny
  vaultRead: allow
  vaultWrite: allow
---

# The vault's top level stays read-only

Under `vaultWrite` each top-level folder of the vault is writable, and the top level itself is not: a cell cannot create a new top-level file or folder, such as a `.git` or `.envrc` of its own (permissions-spec §4.1). `vault.write` still writes top-level notes, since VaultOre applies it after the cell.

The probe creates a file in this run's own folder, which it may, and tries to create `vaultore-probe.md` at the top level, which it may not.

```ore:ts id=probe
const fs = require("node:fs");
const w = "/workspace";
const create = (path) => { try { fs.writeFileSync(w + "/" + path, "probe"); return "created"; } catch { return "refused"; } };
const mkdir = (path) => { try { fs.mkdirSync(w + "/" + path); return "created"; } catch { return "refused"; } };

const results = {
	createInRunFolder: create(process.env.VAULTORE_RUN_DIR + "/vaultore-probe.txt"),
	createAtTopLevel: create("vaultore-probe.md"),
	createFolderAtTopLevel: mkdir("vaultore-probe"),
	createGitAtTopLevel: mkdir(".git-vaultore-probe"),
};
const expected = {
	createInRunFolder: "created",
	createAtTopLevel: "refused",
	createFolderAtTopLevel: "refused",
	createGitAtTopLevel: "refused",
};
const crossed = Object.keys(expected).filter((key) => results[key] !== expected[key]);
if (crossed.length > 0) throw new Error("Not held: " + crossed.map((key) => `${key} (${results[key]})`).join(", "));
`held: ${Object.keys(expected).join(", ")}`;
```
