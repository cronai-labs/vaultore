import { b as RuntimeDetection, R as RuntimeEngine, C as ContainerExecOptions, c as ContainerExecResult } from '../index-DIxOf9vK.mjs';
import 'zod';

/**
 * @vaultore/core - Runtime
 *
 * BRICK-003: Container runtime detection
 * BRICK-004/005: Container execution helper
 */

declare function detectRuntimes(): Promise<RuntimeDetection>;
declare function execContainer(engine: RuntimeEngine, options: ContainerExecOptions): Promise<ContainerExecResult>;

export { detectRuntimes, execContainer };
