---
ore: true
name: Host tools' folders stay read-only
description: Checks that a cell with vaultWrite cannot change what tools on the computer act on - git, coding agents, editors, direnv - at the vault's top level.
tags: [security, fixture]
permissions:
  network: deny
  vaultRead: allow
  vaultWrite: allow
---

# Host tools' folders stay read-only

Git runs hooks and `core.fsmonitor` from `.git/`, coding agents run hooks from `.claude/`, editors run tasks from `.vscode/`, and direnv loads `.envrc`. All of them run on the computer, outside the container, so a cell must not change them, even with `vaultWrite` (permissions-spec §4.1). The probe reads them (allowed) and checks they are read-only. It changes no existing file: it asks the file system whether a path is writable, and creates only files named `vaultore-probe`.

Run it in any vault; it is most telling in one that is a git repository. A git repository in a subfolder of the vault stays writable, a known gap (#339) not checked here.

```ore:ts id=probe
const fs = require("node:fs");
const w = "/workspace";
const writable = (path) => { try { fs.accessSync(w + "/" + path, fs.constants.W_OK); return "writable"; } catch { return "read-only"; } };
const create = (path) => { try { fs.writeFileSync(w + "/" + path, "probe"); return "created"; } catch { return "refused"; } };

const results = {
	gitFolder: writable(".git"),
	gitConfig: writable(".git/config"),
	gitHooks: writable(".git/hooks"),
	createInGitHooks: create(".git/hooks/vaultore-probe"),
	createInGitHooksOtherSpelling: create(".GIT/hooks/vaultore-probe"),
	claudeFolder: writable(".claude"),
	vscodeFolder: writable(".vscode"),
	envrc: writable(".envrc"),
};
const expected = {
	gitFolder: "read-only",
	gitConfig: "read-only",
	gitHooks: "read-only",
	createInGitHooks: "refused",
	createInGitHooksOtherSpelling: "refused",
	claudeFolder: "read-only",
	vscodeFolder: "read-only",
	envrc: "read-only",
};
const crossed = Object.keys(expected).filter((key) => results[key] !== expected[key]);
if (crossed.length > 0) throw new Error("Not held: " + crossed.map((key) => `${key} (${results[key]})`).join(", "));
`held: ${Object.keys(expected).join(", ")}`;
```
