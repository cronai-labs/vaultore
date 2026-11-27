---
ore: true
name: A note template cannot reach a hidden folder
description: Checks that an AI cell refuses a {{note:}} into Obsidian's config folder, in any spelling, before anything is sent.
tags: [security, fixture]
permissions:
  network: allow
  vaultRead: allow
  vaultWrite: deny
---

# A note template cannot reach a hidden folder

An AI cell sends its prompt to the provider, with each `{{note:…}}` filled in. A template into `.obsidian/`, which holds the plugins' settings, must fail the cell before anything is sent (permissions-spec §3.3), in any spelling of the folder's name.

**Both cells are expected to fail**, each with a message that the folder is hidden from cells. A cell that succeeds has sent the file to the provider. Running it by hand needs a provider set up in VaultOre's settings; no request is made when the boundary holds.

```ore:ai id=exact
Reply with OK. {{note:.obsidian/app.json}}
```

```ore:ai id=otherSpelling
Reply with OK. {{note:.Obsidian/app.json}}
```
