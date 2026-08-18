/**
 * @vaultore/cli - library surface
 *
 * Exposes the Node platform adapter and vault scanning helpers so other
 * tooling (CronAI runners, CI scripts, Quarto engine extensions) can embed
 * headless VaultOre execution without shelling out to the `vaultore` binary.
 */

export { NodeAdapter } from "./adapter";
export type { NodeAdapterOptions } from "./adapter";
export { discoverWorkflows, buildScheduleManifest } from "./scan";
export type { DiscoveredWorkflow, ScheduleManifest } from "./scan";
