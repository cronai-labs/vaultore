/**
 * @vaultore/core - Runtime
 *
 * BRICK-003: Container runtime detection
 * BRICK-004/005: Container execution helper
 */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import {
  RuntimeDetection,
  RuntimeEngine,
  ContainerExecOptions,
  ContainerExecResult,
} from "../types";

// =============================================================================
// RUNTIME DETECTION
// =============================================================================

export async function detectRuntimes(): Promise<RuntimeDetection> {
  const engines: RuntimeEngine[] = ["docker", "podman", "colima"];
  const available: RuntimeEngine[] = [];
  const errors = new Map<RuntimeEngine, string>();

  for (const engine of engines) {
    try {
      await detectEngine(engine);
      available.push(engine);
    } catch (err) {
      errors.set(engine, err instanceof Error ? err.message : String(err));
    }
  }

  return {
    available,
    preferred: available[0] ?? null,
    errors,
  };
}

async function detectEngine(engine: RuntimeEngine): Promise<void> {
  if (engine === "colima") {
    await runCommand("colima", ["status"]);
    return;
  }

  await runCommand(engine, ["version"]);
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

function buildRunCommand(
  engine: RuntimeEngine,
  options: ContainerExecOptions
): { command: string; args: string[] } {
  const runtime = engine === "colima" ? "docker" : engine;
  const args: string[] = ["run", "--rm"];

  if (!options.networkEnabled) {
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

// =============================================================================
// HELPERS
// =============================================================================

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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
      }, timeoutMs);
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function resolveCommandPath(command: string): string {
  if (command.includes("/") || command.includes("\\")) {
    return command;
  }

  const candidates: string[] = [];
  const pathEntries = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const entry of pathEntries) {
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

  return [];
}
