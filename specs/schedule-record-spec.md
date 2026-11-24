# The schedule record

A note scheduled in both runners, the Obsidian plugin and `vaultore agent`, is fired by both when its time comes. The run lock (#215) keeps the two runs from overlapping, not from following each other: a fast note can finish before the second runner looks, and then runs twice (#255). The schedule record makes each scheduled occurrence of a note, a **slot**, run at most once, whichever runner fires it, and keeps a history of what each slot came to.

Decided by the owner on 2026-11-23 and 2026-11-24 (#255):

- **At most once** per slot. A slot is spent once a runner claims it, even if that run then finds the note locked, finds it changed, or fails, a declined permission included; the record says why. Exactly once (a slot that failed is retried until it ran) may follow.
- **History** is kept for 30 days at most. Each runner has a setting to shorten it or switch it off.
- **Missed slots**, the ones no runner fired (the machine slept, Obsidian was closed), are recorded and shown, and the user can catch one up or dismiss it (#269).
- **Surface:** `vaultore schedules log` first; a view in the plugin, or a small terminal or app view, later, without duplicating what cronai.app is for.

## Things and actors

- **A slot:** one note and one occurrence of its schedule, an instant in UTC: the time the cron expression gives, not the time a runner noticed it. Two runners that fire the same occurrence name the same slot.
- **A slot's record:** files in one directory per note, outside the vault (below). It lives longer than the run it describes, and can be removed while the note lives on.
- **A gap:** a run of consecutive slots of one note that no runner fired, recorded as one decision, named after its first slot. A minute schedule left alone for a day is one gap of 1440 slots, not 1440 files, and is caught up with one run.
- **Actors:** a runner's scheduler, which fires a slot or finds a gap; the run it starts; the user, through `vaultore schedules` and the plugin's settings; the pruning, which any runner does when it claims.

## Where it lives

`~/.config/vaultore/slots/<note>/` (on Windows `%APPDATA%\vaultore\slots\<note>\`), beside the run locks and found the same way: from the account's home directory, never `$HOME`, so both runners meet there and nothing in the vault can reach it. `<note>` is the run lock's key, the SHA-256 of the note's real path. A slot is named by its instant, `20261124T101500000Z`, a form every file system accepts.

| File | Written by | How |
|---|---|---|
| `<slot>.claim.json` | the runner that claims the slot: the slot's one decision | exclusively: prepared under a name of its own, then hard-linked to this name, which fails when it exists; it appears whole or not at all |
| `<slot>.outcome.json` | the claimer, when its run ends | written under a temporary name and renamed into place |
| `<slot>.resolved.json` | the user, for a gap: a catch-up or a dismissal | exclusively, as the claim |

Beside the record, `~/.config/vaultore/settings.json` (`%APPDATA%\vaultore\settings.json`) holds what both runners must agree on for the record to hold: today `lateAfterMinutes`. Absent is the default. A runner that cannot read it, or finds a value out of range, says so with the file's path rather than guessing; keys it does not know are kept when it writes.

The decision file holds `version` (1) and `kind`: `claimed`, or `missed` for a gap, which also holds `until` (its last slot) and `count`. A slot is decided once, either way, and never both: a gap and a claim of its first slot are the same file name. A reader that meets a version or kind it does not know shows the slot as `unknown`, keeps it decided, and prunes it by age alone; plugin and CLI update separately, so this is the contract between their versions.

The claim holds the vault's real path, the note's vault path, the schedule, the slot, the claimer as a run lock names its holder (`by`, `pid`, `host`, `since`), and a token of its own by which the claiming process knows that its run goes on. The outcome holds the result, the run's id when one started, the reason when it did not complete, and when it ended.

The result is the run record's status, `completed`, `failed` (a cell failed) or `aborted` (the run could not go on: no container engine, a declined permission), or `skipped` when nothing ran because the note was locked by another run or had changed since it was read.

## States of a slot

Derived from the files that exist; nothing stores a state that the files could contradict.

| State | Files | Allowed here | Leaves when |
|---|---|---|---|
| Open | none | a runner claims it | claimed → Claimed |
| Claimed | claim | its claimer runs the note | the run ends → Done; the claimer is gone → Abandoned |
| Abandoned | claim, whose claimer is gone (as a run lock's holder is: process gone, or claimed before the machine started) | nothing: it is not run again | pruned |
| Done | claim, outcome (`completed`, `failed`, `aborted` or `skipped`) | nothing (final) | pruned |
| Pruned | none, after retention | nothing: no runner fires a slot that old (a late tick makes it part of a gap, invariant 7), and gaps are not looked for beyond the history kept | never |

A gap has its own states, on the same files:

| State | Files | Allowed here | Leaves when |
|---|---|---|---|
| Missed | decision `missed` | the user catches it up or dismisses it | dismissed → Dismissed; caught up → Catching up |
| Dismissed | decision, resolution `dismissed` | nothing (final) | pruned |
| Catching up | decision, resolution `caught-up` | its resolver runs the note, once for the whole gap | the run ends → Done; the resolver is gone → Abandoned |
| Done, Abandoned, Pruned | as for a claim | as for a claim | as for a claim |

### Every occurrence is decided

Each occurrence of an armed note's schedule ends up either claimed (in time) or in a gap (missed); none falls between the two. Three rules make that so:

- **In time is two minutes, by default.** It is one setting per machine, from 2 to 60 minutes (owner, 2026-11-24), in `settings.json` beside the record (below), which both runners read: the plugin's "Late after" and `vaultore schedules late-after` change it, and each runner follows a change within a minute. Less than two would let a tick on time find its slot late. It is not a setting of each runner, as the history's length is: two runners that disagreed would find a slot in time for one and missed for the other. The scheduler never lets an occurrence younger than the setting pass unfired: a note armed at 09:01 fires its 09:00 occurrence at once (the host ticks right after arming), and a tick fires every occurrence that is due, not only the next one. A tick that fires a slot more than two minutes old does not run it: the slot is missed. A machine that wakes from sleep therefore runs no slot it held while asleep, but does run one of the last two minutes.
- **A gap covers what is older.** A runner looks for a gap when it arms a note (Obsidian or the agent starts, a note is approved) and when a tick comes late. It covers the slots after the note's last decided slot (a claim's slot, or a gap's `until`) that are more than two minutes old, never further back than the history kept. Between the two rules nothing is left; a slot exactly at the boundary is the tick's.
- **Of occurrences due at once,** after an arming or a late tick, only the latest runs; the others are claimed and recorded as `skipped` ("a later occurrence came due at the same time and ran instead"). Found in the app: arming a minute schedule fired two at once, and the older one ran while the newer was skipped as "still running".
- **A slot fired while its note still runs** is claimed and recorded as `skipped` (the agent: "the previous run is still in progress"; the plugin: "the note was still running"), not dropped before its claim.

What a gap looks back to:

- **The note's last decided slot of the same schedule.** A record of another schedule says nothing: after a change from daily to every minute, the minutes before were never scheduled.
- **Otherwise, when the runner armed the note** (less the two minutes it still fires): a note scheduled for the first time has nothing backfilled, but a runner that armed it and then slept records what it slept through.

And:

- **Exclusive:** the gap's decision file is named after its first slot. Two runners that find the same gap write the same name, and one gets it; a runner that claims the first slot in time takes the name first, and the gap is looked for again after it.
- **A claim inside a gap is refused,** so runners that disagree on the threshold (one read the file before a change, the other after; an older version) still run no slot twice: the slot is reported as skipped, "one of N missed runs …". A gap starts right after the note's last decided slot, so only the latest decision before a slot can hold it: one listing and one read per claim. Left open: a claim and a gap written in the same instant, each before seeing the other; the slot then runs, and is also counted in the gap.
- **A look for gaps ignores decisions after its own bound:** a late tick claims its in-time slot while it looks, in either order, and a claim that lands first must not hide the slots before it.
- **Told once:** each open gap is told once per runner session, whoever recorded it: the plugin as a notice naming the note and the number of runs (also for a gap the agent recorded), the agent on stderr for the gaps it recorded.
- **Arming again counts:** a note whose scheduling was switched off and on again, in the plugin or by revoking and re-approving it for the agent, reports the occurrences in between as missed, since nothing tells them from occurrences missed while the runner was closed. Dismiss them.

## Events

| Event | Open | Claimed | Abandoned | Done |
|---|---|---|---|---|
| A runner fires the slot, and its own check passes (the plugin's setting and approval; the agent's approval of the note as it is) | claims it and runs the note | skipped: "the <slot> run was claimed by <runner>, process <pid>" | skipped, as Claimed | skipped, as Claimed |
| A runner fires the slot, and its own check fails | nothing: the slot stays Open for a runner that may run it | (no change) | (no change) | (no change) |
| The run ends, however: completed, failed, aborted, or skipped because the note was locked or changed | – | its claimer writes the outcome → Done | – | – |
| The outcome cannot be written (disk full) | – | stays Claimed; logged; Abandoned once the claimer is gone, and not run again | – | – |
| Its claimer writes the outcome again | – | – | – | no change: the first outcome stands |
| The claimer is killed or the machine stops | – | → Abandoned, seen by the next reader | – | – |
| Retention ends (pruning on a later claim) | – | kept | removed | removed |

For a gap:

| Event | Missed | Dismissed | Catching up | Done |
|---|---|---|---|---|
| The user dismisses it | → Dismissed | refused: "already dismissed" | refused: "being caught up" | refused: "already caught up" |
| The user catches it up | → Catching up; the note runs once, as a run by hand (no schedule approval needed, the run's own permissions apply) | refused: "dismissed" | refused, as Dismissed | refused, as Dismissed |
| A runner looks for gaps | none: the gap is decided | none | none | none |
| Retention ends | removed | removed | kept while its resolver runs | removed |

Pruning removes a slot's files once the slot is older than the shorter of 30 days and the runner's setting, and never before a day has passed: that day keeps the claim for a runner that fires the same slot late, after its machine slept. With the history switched off, the setting is that one day.

## Invariants

1. A slot has at most one claim, and a claim never changes.
2. Only a claim starts a scheduled run, so a slot runs at most once while its record is kept.
3. A runner claims only a slot it would run; one that may not run the note leaves it to the other.
4. Only the claimer writes the outcome, once.
5. Pruning never removes a slot less than a day old.
6. A gap is resolved once, and a catch-up runs the note once for the whole gap.
7. Every occurrence of an armed note is claimed or part of a gap: the scheduler fires each one younger than two minutes, and a gap covers what is older.
8. The record is outside the vault: sync does not carry it, and a cell cannot read or write it.

## Surfaces

- `vaultore schedules log [<note.md>] [--vault <dir>]`: one line per slot or gap of the vault, oldest first, with its state, the runner that claimed it, the run's id and the reason.
- `vaultore schedules catch-up <note.md> [<slot>]` and `vaultore schedules dismiss <note.md> [<slot>]`: act on the note's open gap, named by its first slot when it has more than one; `dismiss` without a slot dismisses all of the note's open gaps.
- The plugin's settings list the open gaps under "Missed runs", each with "Catch up" and "Dismiss". While the list holds a gap, the plugin re-reads the record each minute, so a gap the agent resolved leaves it.
- `vaultore schedules late-after [<2-60> | default]` and the plugin's "Late after" setting: how many minutes late a slot may still run, one value for the machine. A file that cannot be read stops the agent at start; later, either runner tells of it and keeps its last good value.
- `vaultore agent --keep-days <0-30>` and the plugin's "Scheduled-run history" setting: how long each runner's pruning keeps history. Each prunes with its own setting when it claims, so the shorter one wins over time.
- A runner that finds its slot claimed reports it as skipped: the agent on stderr, the plugin in its log, not as a notice every minute.

## Limits

- Two machines that share a synced vault each have their own record, as each has its own run locks. Schedule a note on one machine; approving it in a runner on each machine is what makes it run on both. Sync cannot carry a lease between machines (each would win locally and learn otherwise only later), so preventing this needs one authority all machines ask, which is a service's job, not this record's.
- The schedule's time zone is the runner's: two runners in different time zones name different slots.
- A run started by hand claims nothing; it is still refused while a scheduled run holds the note's run lock.
