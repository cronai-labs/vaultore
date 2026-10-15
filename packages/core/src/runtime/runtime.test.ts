import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunCommand, detectRuntimes, DETECTION_TIMEOUT_MS } from "./index";
import type { ContainerExecOptions } from "../types";

const baseOptions: ContainerExecOptions = {
  image: "oven/bun:1-alpine",
  command: ["sh", "-lc", "echo hi"],
  workdir: "/workspace",
  networkEnabled: false,
  memoryLimit: "512m",
  cpuLimit: 1,
  mounts: [{ source: "/vault", target: "/workspace", readonly: true }],
};

describe("buildRunCommand", () => {
  it("builds a docker command with network disabled", () => {
    const { command, args } = buildRunCommand("docker", baseOptions);

    expect(command).toBe("docker");
    expect(args).toContain("--network=none");
    expect(args).toContain("--rm");
    expect(args).toContain("oven/bun:1-alpine");
    expect(args.join(" ")).toContain("/vault:/workspace:ro");
  });

  it("maps colima to the docker binary", () => {
    const { command } = buildRunCommand("colima", {
      ...baseOptions,
      networkEnabled: true,
    });
    expect(command).toBe("docker");
  });

  it("maps apple to the container binary when network is allowed", () => {
    const { command, args } = buildRunCommand("apple", {
      ...baseOptions,
      networkEnabled: true,
    });

    expect(command).toBe("container");
    expect(args).not.toContain("--network=none");
    expect(args).toContain("--rm");
  });

  it("fails closed for apple engine when network must be denied", () => {
    expect(() => buildRunCommand("apple", baseOptions)).toThrow(
      /does not support disabling network/
    );
  });

  it("omits --network=none when network is enabled", () => {
    const { args } = buildRunCommand("docker", {
      ...baseOptions,
      networkEnabled: true,
    });
    expect(args).not.toContain("--network=none");
  });

  it("passes env vars and writable mounts through", () => {
    const { args } = buildRunCommand("podman", {
      ...baseOptions,
      networkEnabled: true,
      env: { FOO: "bar" },
      mounts: [{ source: "/vault", target: "/workspace", readonly: false }],
    });

    expect(args.join(" ")).toContain("-e FOO=bar");
    expect(args.join(" ")).toContain("/vault:/workspace:rw");
  });
});

describe("detectRuntimes", () => {
  const engines = ["docker", "podman", "colima", "container"] as const;
  let bin: string;
  let savedPath: string | undefined;

  /** Every engine binary on PATH is a script with the given body. */
  function fakeEngines(body: string) {
    for (const name of engines) {
      const file = join(bin, name);
      writeFileSync(file, `#!/bin/sh\n${body}\n`);
      chmodSync(file, 0o755);
    }
  }

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "vaultore-detect-"));
    savedPath = process.env.PATH;
    process.env.PATH = bin;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(bin, { recursive: true, force: true });
  });

  it("reports an engine whose probe exits non-zero as unavailable", async () => {
    fakeEngines('echo "Cannot connect to the Docker daemon" >&2\nexit 1');

    const detection = await detectRuntimes();

    expect(detection.available).toEqual([]);
    expect(detection.preferred).toBeNull();
    expect(detection.errors.get("docker")).toMatch(/exited with code 1/);
    expect(detection.errors.get("docker")).toMatch(/Cannot connect to the Docker daemon/);
  });

  it("reports an engine whose probe exits zero as available", async () => {
    fakeEngines("exit 0");

    const detection = await detectRuntimes();

    expect(detection.available).toContain("docker");
    expect(detection.preferred).toBe("docker");
  });

  it("gives up on a probe that does not answer in time", async () => {
    // No `exec`: the shell is killed but its `sleep` child keeps the pipes
    // open, as a wedged CLI's helper processes would.
    fakeEngines("/bin/sleep 30");

    const started = Date.now();
    const detection = await detectRuntimes({ timeoutMs: 200 });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(detection.available).toEqual([]);
    expect(detection.errors.get("docker")).toMatch(/did not answer within 200 ms/);
  });

  it("has a default probe timeout", () => {
    expect(DETECTION_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
