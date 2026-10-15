/**
 * @vaultore/core - Runtime
 *
 * BRICK-003: Container runtime detection
 * BRICK-004/005: Container execution helper
 */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  RuntimeDetection,
  RuntimeEngine,
  ContainerExecOptions,
  ContainerExecResult,
} from "../types";

// =============================================================================
// RUNTIME DETECTION
// =============================================================================

/**
 * How long one engine probe may take before detection reports that engine as
 * unavailable. Without a bound, a wedged daemon hangs the run forever (#26).
 * `colima status` is the slowest probe, since it asks the VM; it answers in
 * about a second when healthy. Override per call with `timeoutMs`.
 */
export const DETECTION_TIMEOUT_MS = 10_000;

export interface DetectRuntimesOptions {
  /** Per-probe timeout; defaults to `DETECTION_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export async function detectRuntimes(
  options: DetectRuntimesOptions = {}
): Promise<RuntimeDetection> {
  const engines: RuntimeEngine[] = ["docker", "podman", "colima", "apple"];
  const timeoutMs = options.timeoutMs ?? DETECTION_TIMEOUT_MS;
  const available: RuntimeEngine[] = [];
  const errors = new Map<RuntimeEngine, string>();

  // Probed in parallel so a slow engine does not delay the others; results are
  // collected in the fixed order above, which decides `preferred`.
  const results = await Promise.allSettled(
    engines.map((engine) => detectEngine(engine, timeoutMs))
  );
  results.forEach((result, index) => {
    const engine = engines[index] as RuntimeEngine;
    if (result.status === "fulfilled") {
      available.push(engine);
    } else {
      const err: unknown = result.reason;
      errors.set(engine, err instanceof Error ? err.message : String(err));
    }
  });

  return {
    available,
    preferred: available[0] ?? null,
    errors,
  };
}

async function detectEngine(engine: RuntimeEngine, timeoutMs: number): Promise<void> {
  if (engine === "colima") {
    await probe("colima", ["status"], timeoutMs);
    return;
  }

  if (engine === "apple") {
    // Windows ships a `container.exe` alias for WSL containers, so a binary of
    // that name is Apple's CLI only on macOS.
    if (process.platform !== "darwin") {
      throw new Error("Apple container is available only on macOS");
    }
    // Apple's `container` CLI requires its background service to be running
    await probe("container", ["system", "status"], timeoutMs);
    return;
  }

  await probe(engine, ["version"], timeoutMs);
}

/**
 * An engine is available only when its probe exits 0 in time. `docker version`
 * against a stopped daemon still prints the client version, so output alone
 * proves nothing.
 */
async function probe(command: string, args: string[], timeoutMs: number): Promise<void> {
  const invocation = [command, ...args].join(" ");
  const result = await runCommand(command, args, undefined, timeoutMs);
  if (result.timedOut) {
    throw new Error(`\`${invocation}\` did not answer within ${timeoutMs} ms`);
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `\`${invocation}\` exited with code ${result.exitCode}` + (detail ? `: ${detail}` : "")
    );
  }
}

// =============================================================================
// CONTAINER EXECUTION
// =============================================================================

export async function execContainer(
  engine: RuntimeEngine,
  options: ContainerExecOptions
): Promise<ContainerExecResult> {
  const start = Date.now();
  const { command, args } = buildRunCommand(engine, options);

  const result = await runCommand(command, args, options.stdin, options.timeout);

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    duration: Date.now() - start,
  };
}

export function buildRunCommand(
  engine: RuntimeEngine,
  options: ContainerExecOptions
): { command: string; args: string[] } {
  const runtime = engineBinary(engine);
  const args: string[] = ["run", "--rm"];

  if (!options.networkEnabled) {
    if (engine === "apple") {
      // Apple's container CLI has no --network=none equivalent yet; every
      // container gets its own network interface. Fail closed rather than
      // silently running a network-denied workflow with network access.
      throw new Error(
        "Apple container does not support disabling network access yet. " +
          "Use Docker or Podman for workflows with 'network: deny', or set " +
          "'permissions.network: allow' in the workflow frontmatter."
      );
    }
    args.push("--network=none");
  }

  if (options.stdin) {
    args.push("-i");
  }

  if (options.memoryLimit) {
    args.push("--memory", options.memoryLimit);
  }

  if (options.cpuLimit) {
    args.push("--cpus", String(options.cpuLimit));
  }

  if (options.workdir) {
    args.push("--workdir", options.workdir);
  }

  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  if (options.mounts) {
    for (const mount of options.mounts) {
      const mode = mount.readonly ? "ro" : "rw";
      args.push("-v", `${mount.source}:${mount.target}:${mode}`);
    }
  }

  args.push(options.image);
  args.push(...options.command);

  return { command: runtime, args };
}

function engineBinary(engine: RuntimeEngine): string {
  switch (engine) {
    case "colima":
      return "docker";
    case "apple":
      return "container";
    default:
      return engine;
  }
}

// =============================================================================
// HELPERS
// =============================================================================

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The command was killed after `timeoutMs`; `exitCode` is then 1. */
  timedOut: boolean;
}

function runCommand(
  command: string,
  args: string[],
  stdin?: string,
  timeoutMs = 0
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const resolvedCommand = resolveCommandPath(command);
    const child = spawn(resolvedCommand, args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let timeout: NodeJS.Timeout | undefined;
    let settled = false;

    const settle = (result: Omit<CommandResult, "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ ...result, stdout, stderr });
    };

    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        // Settle now rather than on "close": a killed CLI's helper processes
        // can hold its stdout open long after it is gone.
        child.stdout.destroy();
        child.stderr.destroy();
        settle({ exitCode: 1, timedOut: true });
      }, timeoutMs);
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      settle({ exitCode: code ?? 1, timedOut: false });
    });
  });
}

/**
 * The directories of a `PATH` value. The separator is the platform's (`;` on
 * Windows, where `:` also appears in drive letters), not a hardcoded `:`.
 */
export function searchPathEntries(
  pathValue: string | undefined,
  separator: string = delimiter
): string[] {
  return (pathValue ?? "").split(separator).filter(Boolean);
}

function resolveCommandPath(command: string): string {
  if (command.includes("/") || command.includes("\\")) {
    return command;
  }

  const candidates: string[] = [];
  for (const entry of searchPathEntries(process.env.PATH)) {
    candidates.push(join(entry, command));
  }

  for (const candidate of knownCommandPaths(command)) {
    candidates.push(candidate);
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return command;
}

function knownCommandPaths(command: string): string[] {
  const platform = process.platform;
  if (command === "docker") {
    if (platform === "darwin") {
      return [
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
        "/Applications/Docker.app/Contents/Resources/bin/docker",
      ];
    }
    if (platform === "win32") {
      return [
        "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
        "C:\\Program Files (x86)\\Docker\\Docker\\resources\\bin\\docker.exe",
      ];
    }
    return ["/usr/bin/docker"];
  }

  if (command === "podman") {
    if (platform === "darwin") {
      return ["/usr/local/bin/podman", "/opt/homebrew/bin/podman"];
    }
    if (platform === "win32") {
      return ["C:\\Program Files\\RedHat\\Podman\\podman.exe"];
    }
    return ["/usr/bin/podman"];
  }

  if (command === "colima") {
    if (platform === "darwin") {
      return ["/usr/local/bin/colima", "/opt/homebrew/bin/colima"];
    }
    return [];
  }

  if (command === "container") {
    // Apple's container CLI installs to /usr/local/bin (Apple silicon only)
    if (platform === "darwin") {
      return ["/usr/local/bin/container", "/opt/homebrew/bin/container"];
    }
    return [];
  }

  return [];
}
