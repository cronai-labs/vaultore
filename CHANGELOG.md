# Changelog

All notable changes to VaultOre will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-11-27

### Breaking changes

- **obsidian:** The Obsidian plugin's "Run scheduled workflows" switch and its schedule approvals now belong to your account on each computer and no longer travel with the vault. After upgrading, scheduling is off on every computer, and the plugin says so once on each computer where it was on. Turn it on and approve your notes again under Settings, VaultOre, Scheduled workflows, on the computer that should run them.
- An answer to a note's ask permission now applies only for the account and computer that gave it, and answers stored before are asked again once per note on each computer. In Obsidian the next run asks. With the CLI, run vaultore run with --yes once per note on each computer that runs it; until then a run without --yes denies the permission for that run.
- vaultore agent and vaultore schedules no longer take --state-dir; the schedule approvals are in ~/.config/vaultore/schedules.json, which Obsidian reads too, and are copied there once from approvals.json of earlier versions. Approvals kept with --state-dir in another folder are not carried over: approve those notes again with vaultore schedules approve. A second vaultore agent on the same vault is refused.
- Scheduled runs and catch-ups no longer ask for or reuse permission answers; they run with the permissions held by the note's schedule approval. vaultore agent --yes and vaultore schedules catch-up --yes are refused; answer a note's ask permissions with vaultore schedules approve <note> --allow <names> or --deny <names>, or in Obsidian's approval dialog. A note approved for Obsidian now stops running when its content changes, unless What an approval covers is set to Narrow. Answers for runs started by hand are kept in ~/.config/vaultore/answers.json for the account on each computer, shared by Obsidian and the CLI; answers kept in data.json or .vaultore/config.json are no longer read, so each note asks once on each computer.
- **core:** Cells now write only in the vault's folders. The vault's top level is read-only to them, and so are `.git`, `.claude`, `.vscode` and `.envrc`, also with `vaultWrite`. A shell cell that writes, deletes or renames a top-level note now fails: write it with `vault.write`, or keep it in a folder. Renaming a file from one top-level folder to another fails in a TS cell; copy and delete it instead.

### Upgrading

- **scheduler:** A note scheduled in both Obsidian and `vaultore agent` now runs once per occurrence of its schedule, in whichever runner claims it first; the other reports it as skipped. To do this, VaultOre keeps a small record of each scheduled run outside the vault, in `~/.config/vaultore/slots` (`%APPDATA%\vaultore\slots` on Windows), for 30 days at most. Shorten it with `vaultore agent --keep-days <n>` or the plugin's "Scheduled-run history" setting, and read it with `vaultore schedules log`.
- **scheduler:** A machine that wakes from sleep no longer runs the one scheduled occurrence it held, late. Occurrences that no runner fired are now recorded as missed runs and announced once, in Obsidian as a notice and by `vaultore agent` on stderr. Run a note once for them with `vaultore schedules catch-up <note.md>`, or with "Catch up" under "Missed runs" in VaultOre's settings, or close them with `vaultore schedules dismiss <note.md>` or "Dismiss". An occurrence is missed once it is more than two minutes late; `vaultore schedules late-after <minutes>` or "Late after" in VaultOre's settings changes that for the computer, for both runners.
- Notes approved for vaultore agent before this version that have an ask permission do not run until approved again with an answer: vaultore schedules approve <note> --allow <permission> (or --deny), or Review under Settings, VaultOre, Scheduled workflows. Obsidian names them once after the upgrade, and the agent on stderr.

### Features

- **scheduler:** Each scheduled occurrence runs once, in the plugin or the agent ([#272](https://github.com/cronai-labs/vaultore/issues/272))
- **scheduler:** Record missed scheduled runs, and catch them up or dismiss them ([#273](https://github.com/cronai-labs/vaultore/issues/273))
- One schedule approval per note on a computer, owned by the plugin or the agent ([#302](https://github.com/cronai-labs/vaultore/issues/302))
- Unattended runs use the permissions given at approval, which asks only what changed ([#300](https://github.com/cronai-labs/vaultore/issues/300))
- Forget a kept permission answer, in the CLI and in Obsidian ([#330](https://github.com/cronai-labs/vaultore/issues/330))
- Choose whether Obsidian and the CLI share permission answers ([#332](https://github.com/cronai-labs/vaultore/issues/332))

### Bug Fixes

- **core:** A cell VaultOre does not run says what runs instead and what to do ([#283](https://github.com/cronai-labs/vaultore/issues/283))
- **obsidian:** Scheduling consent stays on this computer, outside the vault, so sync arms nothing ([#285](https://github.com/cronai-labs/vaultore/issues/285))
- **release:** A breaking change's text is one line in the release notes ([#289](https://github.com/cronai-labs/vaultore/issues/289))
- A run says which cells failed, and which did not run because of them ([#294](https://github.com/cronai-labs/vaultore/issues/294))
- **cli:** The agent's approvals live beside the rest of VaultOre's state ([#296](https://github.com/cronai-labs/vaultore/issues/296))
- A permission answer applies only on the device that gave it ([#297](https://github.com/cronai-labs/vaultore/issues/297))
- Shared files keep every writer's change, and wait a moment for each other ([#303](https://github.com/cronai-labs/vaultore/issues/303))
- **core:** The user state folder is hidden from cells in a vault that holds it ([#314](https://github.com/cronai-labs/vaultore/issues/314))
- Nothing runs unattended for Obsidian while its scheduling is off or unreadable ([#315](https://github.com/cronai-labs/vaultore/issues/315))
- **scheduler:** Missed runs are kept while open, and none are lost or counted while off ([#317](https://github.com/cronai-labs/vaultore/issues/317))
- Removing schedules.json does not bring back the agent's approvals of 0.4.x ([#318](https://github.com/cronai-labs/vaultore/issues/318))
- **cli:** A failing rescan keeps vaultore agent running ([#319](https://github.com/cronai-labs/vaultore/issues/319))
- The upgrade's messages say what happens to each note ([#321](https://github.com/cronai-labs/vaultore/issues/321))
- An upgrade reports no false missed runs, and a broken old approvals file is not marked ([#329](https://github.com/cronai-labs/vaultore/issues/329))
- **release:** A command name keeps its lowercase in the release notes ([#335](https://github.com/cronai-labs/vaultore/issues/335))
- **core:** Cells write only in the vault's folders, never VaultOre's or the host tools' ones ([#337](https://github.com/cronai-labs/vaultore/issues/337))

### Dependencies

- **deps-dev:** Bump the dev-dependencies group across 1 directory with 5 updates ([#250](https://github.com/cronai-labs/vaultore/issues/250))

## [0.4.0] - 2026-11-23

### Upgrading

- **core:** VaultOre now keeps one lock file per running note outside the vault, in `~/.config/vaultore/locks` (`%APPDATA%\vaultore\locks` on Windows), shared by the Obsidian plugin and the CLI: a note that is running in one is refused in the other, with a message naming who runs it. A run is also refused when its note changed between being read and the run starting; run it again. A runner must be able to create that directory: under a user with no home directory, as a container may run, every run is refused with a message saying so.

### Features

- **core:** The process lock moves to core and knows its runner, reloads and reboots ([#252](https://github.com/cronai-labs/vaultore/issues/252))
- **core:** One run per note across the plugin and the CLI, with a shared run lock ([#253](https://github.com/cronai-labs/vaultore/issues/253))

### Bug Fixes

- **release:** The release scripts refuse a private address before creating anything ([#242](https://github.com/cronai-labs/vaultore/issues/242))
- **core:** A run cut off by a killed process is marked aborted when its lock is taken over ([#257](https://github.com/cronai-labs/vaultore/issues/257))

### Dependencies

- **deps:** Lift minimatch out of the advisory range in the lint tooling ([#247](https://github.com/cronai-labs/vaultore/issues/247))
- **deps:** Bump the production-dependencies group across 1 directory with 2 updates ([#235](https://github.com/cronai-labs/vaultore/issues/235))

## [0.3.0] - 2026-11-10

### Upgrading

- **parser:** A note is refused before anything runs when a cell's `timeout` is not a number above zero, or when cells depend on each other in a circle. Correct the `timeout`, or the `depends` list the error names.
- **cli:** An option the command line does not know is a usage error (`unknown option --name`, exit code 2); before, it was ignored. Correct the option where a script calls `vaultore`.
- **cli:** `vaultore agent` runs a scheduled note only after `vaultore schedules approve <note.md>`, and nothing until one is approved. An approval holds for the note's front matter and cells as they are: after changing either, approve again. `vaultore schedules list` shows what the agent may run.
- **parser:** A note is refused when a limit has a value that cannot be enforced: `runtime.timeout` and a cell's `timeout` must be above 0 and at most 86400 seconds, `cpuLimit` above 0, and `memoryLimit` an amount above zero such as `512m`. Correct the value the error names.
- **executor:** `vaultore run <note.md> --cell <id>` fails for an id the note does not have; before, it ran nothing and reported a completed run. In a TypeScript cell, `cell(id)` throws for a name that is no cell's output, such as `constructor`.
- **parser:** A cell id is 1 to 64 characters from the letters A-Z and a-z, digits, `_` and `-`, and starts with a letter or digit. `run` and the Windows device names (`con`, `prn`, `aux`, `nul`, `com0` to `com9`, `lpt0` to `lpt9`) are reserved, and two ids that differ only in letter case are refused. Rename the cell the error names, also where `depends`, `cell()` and `{{id}}` use its id.

### Features

- **cli:** The agent runs only scheduled notes that were approved ([#220](https://github.com/cronai-labs/vaultore/issues/220))

### Bug Fixes

- **parser:** Refuse invalid timeouts, cycles and colliding ids; match output ids exactly ([#214](https://github.com/cronai-labs/vaultore/issues/214))
- **cli:** Read --config-dir <name> and refuse unknown flags ([#217](https://github.com/cronai-labs/vaultore/issues/217))
- **parser:** A note cannot switch off its time, memory or CPU limit ([#225](https://github.com/cronai-labs/vaultore/issues/225))
- **executor:** Cell() answers only for real outputs, and an unknown target cell is an error ([#226](https://github.com/cronai-labs/vaultore/issues/226))
- **parser:** Cell ids follow Ore 0.2: form, reserved names and letter case ([#230](https://github.com/cronai-labs/vaultore/issues/230))

### Dependencies

- **deps:** Bump @babel/parser from 7.29.9 to 7.29.11 in the production-dependencies group across 1 directory ([#188](https://github.com/cronai-labs/vaultore/issues/188))
- **deps-dev:** Bump @vitest/coverage-v8 from 4.1.10 to 5.0.5 ([#176](https://github.com/cronai-labs/vaultore/issues/176))
- **deps-dev:** Bump the dev-dependencies group across 1 directory with 2 updates ([#183](https://github.com/cronai-labs/vaultore/issues/183))
- **deps:** Move fast-uri to 3.1.9 ([#198](https://github.com/cronai-labs/vaultore/issues/198))
- **deps:** Build core and cli with tsup 9 ([#199](https://github.com/cronai-labs/vaultore/issues/199))
- **deps:** Move to TypeScript 6.0 with bundler module resolution ([#200](https://github.com/cronai-labs/vaultore/issues/200))
- **deps-dev:** Bump the dev-dependencies group with 2 updates ([#203](https://github.com/cronai-labs/vaultore/issues/203))
- **deps-dev:** Bump the dev-dependencies group with 4 updates ([#236](https://github.com/cronai-labs/vaultore/issues/236))

## [0.2.0] - 2026-10-28

### Breaking changes

- **obsidian:** Requires Obsidian 1.13.0 or later. VaultOre 0.1.3 remains the release for Obsidian 1.11.4 to 1.12.

### Features

- **obsidian:** Settings appear in Obsidian's settings search ([#190](https://github.com/cronai-labs/vaultore/issues/190))

### Bug Fixes

- **fixtures:** Run on the configured engine and model ([#185](https://github.com/cronai-labs/vaultore/issues/185))
- **core:** Report thrown values, skipped workflows and bad meta blocks ([#187](https://github.com/cronai-labs/vaultore/issues/187))
- **runtime:** A cell timeout kills the container and says so ([#189](https://github.com/cronai-labs/vaultore/issues/189))
- **obsidian:** Switching the provider switches its default model ([#191](https://github.com/cronai-labs/vaultore/issues/191))

### Dependencies

- **deps-dev:** Bump vitest from 4.1.12 to 5.0.5 ([#178](https://github.com/cronai-labs/vaultore/issues/178))

## [0.1.3] - 2026-10-19

### Bug Fixes

- **executor:** A TS cell that is only a string literal outputs the string ([#159](https://github.com/cronai-labs/vaultore/issues/159))

## [0.1.2] - 2026-10-18

### Bug Fixes

- **core:** Hide the config folder the platform reports (Vault#configDir), not only .obsidian ([#147](https://github.com/cronai-labs/vaultore/issues/147))

## [0.1.1] - 2026-10-18

### Bug Fixes

- **obsidian:** Drop the `main` key, which is not an Obsidian manifest key ([#134](https://github.com/cronai-labs/vaultore/issues/134))

### Dependencies

- **deps:** Bump the production-dependencies group across 1 directory with 3 updates ([#92](https://github.com/cronai-labs/vaultore/issues/92))
- **deps:** Bump zod from 3.25.76 to 4.6.7 ([#93](https://github.com/cronai-labs/vaultore/issues/93))
- **deps-dev:** Bump the dev-dependencies group across 1 directory with 10 updates ([#65](https://github.com/cronai-labs/vaultore/issues/65))
- **deps:** Refresh the lockfile within ranges, clearing the dev-tool advisories ([#141](https://github.com/cronai-labs/vaultore/issues/141))

## [0.1.0] - 2026-10-15

### Features

- **obsidian:** Prepare plugin for community marketplace launch
- **runtime:** Add Apple container engine support
- **obsidian:** Adopt current plugin template conventions
- **core:** Emit OKF-conformant frontmatter on outputs and artifacts
- **cli:** Add standalone CLI with headless agent and schedule export
- **release:** Derive semver and changelog from conventional commits

### Bug Fixes

- **obsidian:** Improve plugin quality for marketplace launch
- **obsidian:** Comply with plugin review guidelines and speed up startup
- **cli:** Resolve workflow paths against --vault and surface cell errors
- **cli:** Remove polynomial-backtracking regexes from vault scanning
- **core:** Explain engine selection, bound AI requests, finalise run records
- **core:** Close the gaps a review found in this PR's own changes
- **core:** Preserve edits made while a workflow runs ([#51](https://github.com/cronai-labs/vaultore/issues/51))
- **core:** Remove polynomial backtracking from the parser and scope CI permissions ([#50](https://github.com/cronai-labs/vaultore/issues/50))
- **executor:** Gate {{note:}} on vaultRead and stop rescanning output text ([#72](https://github.com/cronai-labs/vaultore/issues/72))
- **executor:** Enforce vaultRead at the container mount ([#74](https://github.com/cronai-labs/vaultore/issues/74))
- **executor:** Bind permission grants to the note's content ([#75](https://github.com/cronai-labs/vaultore/issues/75))
- **runtime:** Reliable engine detection and hardened cell containers ([#86](https://github.com/cronai-labs/vaultore/issues/86))
- **executor:** Write output notes as OKF v0.2 concepts ([#87](https://github.com/cronai-labs/vaultore/issues/87))
- **providers:** Send requests through the platform and reject a model the provider cannot serve ([#88](https://github.com/cronai-labs/vaultore/issues/88))
- **fixtures:** Make smart-inbox a working canonical example ([#89](https://github.com/cronai-labs/vaultore/issues/89))
- **obsidian:** Scheduled workflows need consent, and API keys come from the selected secret ([#90](https://github.com/cronai-labs/vaultore/issues/90))
- **executor:** Hide the CLI's .vaultore from cells ([#97](https://github.com/cronai-labs/vaultore/issues/97))
- **core:** Default buildNetwork to deny until a cell type uses it ([#98](https://github.com/cronai-labs/vaultore/issues/98))
- **executor:** Apply vault writes on the host, confined to the vault and checked against what the cell read ([#127](https://github.com/cronai-labs/vaultore/issues/127))
- **runtime:** Put the engine's own directory on its PATH ([#129](https://github.com/cronai-labs/vaultore/issues/129))

### Dependencies

- **deps:** Sync lockfile with esbuild 0.27 bump
- **deps-dev:** Bump vitest from 1.6.1 to 4.1.10
- **deps:** Bump actions/checkout
- **deps-dev:** Bump @types/node from 20.19.30 to 26.2.0
- **deps:** Bump the production-dependencies group across 2 directories with 1 update
- **deps-dev:** Bump the dev-dependencies group across 1 directory with 6 updates
- **deps-dev:** Bump @vitest/coverage-v8 from 1.6.1 to 4.1.10
- **deps-dev:** Bump @commitlint/cli from 20.4.2 to 21.2.2
- **deps-dev:** Bump @commitlint/config-conventional to 21.2.2
- **deps:** Bump cron-parser from 4.9.0 to 5.10.0 ([#39](https://github.com/cronai-labs/vaultore/issues/39))

