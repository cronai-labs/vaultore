# The schedule record

A note scheduled in both runners, the Obsidian plugin and `vaultore agent`, is fired by both when its time comes. The run lock (#215) keeps the two runs from overlapping, not from following each other: a fast note can finish before the second runner looks, and then runs twice (#255). The schedule record makes each scheduled occurrence of a note, a **slot**, run at most once, whichever runner fires it, and keeps a history of what each slot came to.

Decided by the owner on 2026-11-23 and 2026-11-24 (#255):

- **At most once** per slot. A slot is spent once a runner claims it, even if that run then finds the note locked, finds it changed, or fails, a declined permission included; the record says why. Exactly once (a slot that failed is retried until it ran) may follow.
- **History** is kept for 30 days at most. Each runner has a setting to shorten it or switch it off.
- **Missed slots**, the ones no runner fired (the machine slept, Obsidian was closed), are recorded and shown, and the user can catch one up or dismiss it. Built after the record itself.
- **Surface:** `vaultore schedules log` first; a view in the plugin, or a small terminal or app view, later, without duplicating what cronai.app is for.

## Things and actors

- **A slot:** one note and one occurrence of its schedule, an instant in UTC: the time the cron expression gives, not the time a runner noticed it. Two runners that fire the same occurrence name the same slot.
- **A slot's record:** files in one directory per note, outside the vault (below). It lives longer than the run it describes, and can be removed while the note lives on.
- **Actors:** a runner's scheduler, which fires a slot; the run it starts; the user, through `vaultore schedules` (later also the plugin); the pruning, which any runner does when it claims.

## Where it lives

`~/.config/vaultore/slots/<note>/` (on Windows `%APPDATA%\vaultore\slots\<note>\`), beside the run locks and found the same way: from the account's home directory, never `$HOME`, so both runners meet there and nothing in the vault can reach it. `<note>` is the run lock's key, the SHA-256 of the note's real path. A slot is named by its instant, `20261124T101500000Z`, a form every file system accepts.

| File | Written by | How |
|---|---|---|
| `<slot>.claim.json` | the runner that claims the slot | exclusively: prepared under a name of its own, then hard-linked to this name, which fails when it exists; it appears whole or not at all |
| `<slot>.outcome.json` | the claimer, when its run ends | written under a temporary name and renamed into place |
| `<slot>.missed.json`, `<slot>.resolved.json` | missed slots, later (below) | exclusively, as the claim |

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
| Pruned | none, after retention | (looks Open, but its time is long past and no runner fires it) | never |

Missed slots, built after this, add three states: **Missed** (`missed`: no runner fired it), **Dismissed** (`missed` and `resolved` by a dismissal) and **Caught up** (`missed` and `resolved` by a catch-up, then running and Done as a claim).

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

Pruning removes a slot's files once the slot is older than the shorter of 30 days and the runner's setting, and never before a day has passed: that day keeps the claim for a runner that fires the same slot late, after its machine slept. With the history switched off, the setting is that one day.

## Invariants

1. A slot has at most one claim, and a claim never changes.
2. Only a claim starts a scheduled run, so a slot runs at most once.
3. A runner claims only a slot it would run; one that may not run the note leaves it to the other.
4. Only the claimer writes the outcome, once.
5. Pruning never removes a slot less than a day old.
6. The record is outside the vault: sync does not carry it, and a cell cannot read or write it.

## Surfaces

- `vaultore schedules log [<note.md>] [--vault <dir>]`: one line per slot of the vault, oldest first, with its state, the runner that claimed it, the run's id and the reason.
- `vaultore agent --keep-days <0-30>` and the plugin's "Scheduled-run history" setting: how long each runner's pruning keeps history. Each prunes with its own setting when it claims, so the shorter one wins over time.
- A runner that finds its slot claimed reports it as skipped: the agent on stderr, the plugin in its log, not as a notice every minute.

## Limits

- Two machines that share a synced vault each have their own record, as each has its own run locks. Schedule a note on one machine.
- The schedule's time zone is the runner's: two runners in different time zones name different slots.
- A run started by hand claims nothing; it is still refused while a scheduled run holds the note's run lock.
