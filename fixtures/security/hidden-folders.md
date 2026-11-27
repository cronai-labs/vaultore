---
ore: true
name: Hidden folders stay hidden
description: Checks that a cell can neither see nor change Obsidian's config folder or the CLI's settings, under any spelling of their names.
tags: [security, fixture]
permissions:
  network: deny
  vaultRead: allow
  vaultWrite: allow
---

# Hidden folders stay hidden

`.obsidian/` holds the plugins and their settings, `.vaultore/` the CLI's settings. A cell, even with `vaultWrite`, must not see them or change them (permissions-spec §4.1). On macOS and Windows the file system ignores letter case, so the probe also tries other spellings (`.Obsidian`, `.VAULTORE`). Reading another spelling still works there, which is a known gap (#338) and not checked here.

Run it in any vault. It is most telling in one that has `.obsidian/` and `.vaultore/`. It creates no file unless a boundary fails, and then only files named `vaultore-probe.txt`.

The cell fails and names each check that did not hold.

```ore:ts id=probe
const fs = require("node:fs");
const w = "/workspace";
const entries = (dir) => { try { return fs.readdirSync(w + "/" + dir).length; } catch { return 0; } };
const create = (path) => { try { fs.mkdirSync(w + "/" + path.split("/").slice(0, -1).join("/"), { recursive: true }); fs.writeFileSync(w + "/" + path, "probe"); return "created"; } catch { return "refused"; } };

const results = {
	configEntriesSeen: entries(".obsidian"),
	stateEntriesSeen: entries(".vaultore"),
	writeConfig: create(".obsidian/vaultore-probe.txt"),
	writeConfigOtherSpelling: create(".Obsidian/vaultore-probe.txt"),
	writeState: create(".vaultore/vaultore-probe.txt"),
	writeStateOtherSpelling: create(".VAULTORE/vaultore-probe.txt"),
};
const expected = {
	configEntriesSeen: 0,
	stateEntriesSeen: 0,
	writeConfig: "refused",
	writeConfigOtherSpelling: "refused",
	writeState: "refused",
	writeStateOtherSpelling: "refused",
};
const crossed = Object.keys(expected).filter((key) => results[key] !== expected[key]);
if (crossed.length > 0) throw new Error("Not held: " + crossed.map((key) => `${key} (${results[key]})`).join(", "));
`held: ${Object.keys(expected).join(", ")}`;
```
