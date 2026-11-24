# Parallel execution (not built)

Cells run one at a time. Running independent cells at the same time is under consideration
([roadmap](../roadmap.md#under-consideration)); these are the constraints a design has to
meet:

- **CPU and memory budget:** total container CPU and memory must not saturate the machine.
- **Runtime mix:** TS, shell and AI cells load the machine differently; concurrency limits per
  kind and globally.
- **Vault writes:** two cells writing the same path must not race.
- **Provider limits:** concurrent AI calls bounded per provider.
- **Write-back:** the note is re-read before every callout write (step 9 of [a run](../internals/run-flow.md#the-steps-of-a-run)); parallel cells
  would make those writes concurrent.

A warm container pool (starting containers ahead and `exec`-ing cells into them) is part of
the same consideration. It would change the isolation model: cells of one run would share a
container's filesystem and processes unless it is reset between them.
