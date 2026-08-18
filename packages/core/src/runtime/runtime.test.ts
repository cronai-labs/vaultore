import { describe, expect, it } from "vitest";
import { buildRunCommand } from "./index";
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
