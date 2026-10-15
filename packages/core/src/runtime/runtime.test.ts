import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  buildRunCommand,
  containerUser,
  DEFAULT_PIDS_LIMIT,
  detectRuntimes,
  DETECTION_TIMEOUT_MS,
  execContainer,
  FALLBACK_CONTAINER_USER,
  searchPathEntries,
} from "./index";
import type { RuntimeEngine } from "../types";
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
    expect(args).not.toContain("--network");
    expect(args).toContain("--rm");
  });

  it("detaches apple containers from every network when network is denied", () => {
    const { command, args } = buildRunCommand("apple", baseOptions);

    expect(command).toBe("container");
    // `--network none` (apple/container #739): no network attachment at all.
    // Never an `--internal` network: those still allow outbound TCP
    // (apple/container #2062).
    const at = args.indexOf("--network");
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe("none");
    expect(args.filter((arg) => arg.startsWith("--network"))).toHaveLength(1);
    expect(args.join(" ")).not.toContain("internal");
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

  it("does not probe Apple container off macOS", async () => {
    // Windows ships a `container.exe` alias for WSL containers, so a binary
    // of that name proves nothing outside macOS.
    fakeEngines("exit 0");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const detection = await detectRuntimes();
      expect(detection.available).not.toContain("apple");
      expect(detection.errors.get("apple")).toMatch(/only on macOS/);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
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

describe("searchPathEntries", () => {
  it("splits a Windows PATH on ';' and keeps drive letters intact", () => {
    expect(
      searchPathEntries("C:\\Program Files\\Docker\\bin;C:\\Windows;", win32.delimiter)
    ).toEqual(["C:\\Program Files\\Docker\\bin", "C:\\Windows"]);
  });

  it("splits a POSIX PATH on ':'", () => {
    expect(searchPathEntries("/usr/local/bin::/usr/bin", posix.delimiter)).toEqual([
      "/usr/local/bin",
      "/usr/bin",
    ]);
  });

  it("treats an unset PATH as empty", () => {
    expect(searchPathEntries(undefined)).toEqual([]);
  });
});

describe("container hardening (#28)", () => {
  const dockerFamily: RuntimeEngine[] = ["docker", "podman", "colima"];
  const hardened = { ...baseOptions, user: "501:20" };

  /** The value following `flag`, or undefined. */
  function valueOf(args: string[], flag: string): string | undefined {
    const at = args.indexOf(flag);
    return at === -1 ? undefined : args[at + 1];
  }

  for (const engine of dockerFamily) {
    for (const networkEnabled of [false, true]) {
      it(`${engine}, network ${networkEnabled ? "allow" : "deny"}: emits every hardening flag`, () => {
        const { args } = buildRunCommand(engine, { ...hardened, networkEnabled });

        expect(args).toContain("--read-only");
        expect(valueOf(args, "--tmpfs")).toBe("/tmp:rw,noexec,nosuid,nodev,mode=1777");
        expect(args).toContain("--cap-drop=ALL");
        expect(args).toContain("--security-opt=no-new-privileges");
        expect(args).toContain(`--pids-limit=${DEFAULT_PIDS_LIMIT}`);
        expect(args).toContain("--user=501:20");
        expect(args.join(" ")).toContain("-e HOME=/tmp");
        expect(args.includes("--network=none")).toBe(!networkEnabled);
      });
    }
  }

  for (const networkEnabled of [false, true]) {
    it(`apple, network ${networkEnabled ? "allow" : "deny"}: emits only the flags its CLI supports`, () => {
      const { args } = buildRunCommand("apple", { ...hardened, networkEnabled });

      expect(args).toContain("--read-only");
      expect(valueOf(args, "--tmpfs")).toBe("/tmp:rw,noexec,nosuid,nodev,mode=1777");
      expect(valueOf(args, "--cap-drop")).toBe("ALL");
      expect(valueOf(args, "--user")).toBe("501:20");
      expect(args.join(" ")).toContain("-e HOME=/tmp");
      // No equivalent in apple/container's command reference.
      expect(args.some((arg) => arg.startsWith("--pids-limit"))).toBe(false);
      expect(args.some((arg) => arg.startsWith("--security-opt"))).toBe(false);
      expect(valueOf(args, "--network") === "none").toBe(!networkEnabled);
    });
  }

  it("puts the hardening flags before the image", () => {
    const { args } = buildRunCommand("docker", hardened);
    const image = args.indexOf("oven/bun:1-alpine");
    for (const flag of ["--read-only", "--cap-drop=ALL", "--user=501:20"]) {
      expect(args.indexOf(flag)).toBeGreaterThan(-1);
      expect(args.indexOf(flag)).toBeLessThan(image);
    }
  });

  it("takes a pids limit override", () => {
    const { args } = buildRunCommand("podman", { ...hardened, pidsLimit: 64 });
    expect(args).toContain("--pids-limit=64");
    expect(args).not.toContain(`--pids-limit=${DEFAULT_PIDS_LIMIT}`);
  });

  it("runs as containerUser() when no user is given", () => {
    const { args } = buildRunCommand("docker", baseOptions);
    expect(args).toContain(`--user=${containerUser()}`);
  });

  for (const engine of [...dockerFamily, "apple"] as RuntimeEngine[]) {
    it(`${engine}: hides masked paths behind an empty read-only tmpfs`, () => {
      const { args } = buildRunCommand(engine, {
        ...hardened,
        maskedPaths: ["/workspace/.obsidian"],
      });
      const tmpfs = args.filter((_, i) => args[i - 1] === "--tmpfs");
      expect(tmpfs).toEqual([
        "/tmp:rw,noexec,nosuid,nodev,mode=1777",
        "/workspace/.obsidian:ro,noexec,nosuid,nodev",
      ]);
      // After the vault mount it covers, so engines that mount in argument
      // order also get it right.
      const vault = args.indexOf("/vault:/workspace:ro");
      expect(args.indexOf("/workspace/.obsidian:ro,noexec,nosuid,nodev")).toBeGreaterThan(vault);
    });
  }
});

describe("containerUser", () => {
  it("uses the host's uid:gid", () => {
    expect(containerUser({ uid: 1000, gid: 1000 })).toBe("1000:1000");
    expect(containerUser({ uid: 501, gid: 20 })).toBe("501:20");
  });

  it("falls back to an unprivileged user on hosts without POSIX ids", () => {
    expect(containerUser({ uid: undefined, gid: undefined })).toBe(FALLBACK_CONTAINER_USER);
  });

  it("never maps a root host user to root in the container", () => {
    expect(containerUser({ uid: 0, gid: 0 })).toBe(FALLBACK_CONTAINER_USER);
    expect(FALLBACK_CONTAINER_USER.startsWith("0:")).toBe(false);
  });
});

describe("execContainer output", () => {
  let bin: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "vaultore-exec-"));
    savedPath = process.env.PATH;
    process.env.PATH = bin;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(bin, { recursive: true, force: true });
  });

  it("keeps a UTF-8 character that arrives split across two reads", async () => {
    // "ä" is C3 A4. The pause makes the pipe deliver the two bytes in separate
    // chunks, as a large note's text does at a 64 KiB boundary. Decoded per
    // chunk, each half becomes U+FFFD and the note text is corrupted.
    const file = join(bin, "docker");
    writeFileSync(
      file,
      "#!/bin/sh\nprintf '\\303'\n/bin/sleep 0.2\nprintf '\\244'\nprintf '\\303' >&2\n/bin/sleep 0.2\nprintf '\\244' >&2\n"
    );
    chmodSync(file, 0o755);

    const result = await execContainer("docker", baseOptions);

    expect(result.stdout).toBe("ä");
    expect(result.stderr).toBe("ä");
  });
});
