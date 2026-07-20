# Sandbox Integration Specification

> **Version:** 0.1.0 (draft)
> **Status:** Design — targets v0.2 (Tier 2) and v0.3+ (Tier 3)
> **Last Updated:** 2026-07-20

## Motivation

The container requirement is VaultOre's biggest setup barrier (see PRD risk
matrix: "Docker not installed — High likelihood, High impact"). A tiered
sandbox strategy keeps the strong isolation of containers where available
while adding a zero-install execution tier so `ore:ts` workflows can run on
any machine Obsidian runs on.

Every tier must preserve the same security contract: **cells never get a
capability the workflow's permissions did not grant.** When a tier cannot
enforce a permission, execution fails closed with a clear error (see the
Apple container network rule below).

## Tier Model

### Tier 1 — OCI Containers (shipped, v0.1)

Full-machine isolation via lightweight VMs or namespaces. Required for
`ore:shell` (arbitrary binaries) and any cell needing a real Linux userland.

| Engine | Platform | Isolation | Network deny | Notes |
|--------|----------|-----------|--------------|-------|
| Docker | all | namespaces / VM | `--network=none` | Reference engine |
| Podman | all | namespaces / VM | `--network=none` | Rootless supported |
| Colima | macOS | VM | `--network=none` | Uses the docker CLI |
| Apple `container` | macOS 26+, Apple silicon | per-container micro-VM | **unsupported** | CLI 1.0 (June 2026); each container boots its own VM with its own IP. No `--network=none` equivalent yet, so VaultOre **fails closed**: workflows with `network: deny` refuse to run on this engine until upstream support lands. |

Windows guidance: Docker Desktop (WSL2 backend), Docker Engine installed
inside a WSL2 distro, or Podman. Microsoft's native WSL containers (`wslc`,
public preview June 2026) may become a first-class engine once it reaches GA
and exposes network isolation flags.

### Tier 2 — In-Process WASM Sandbox for `ore:ts` (planned, v0.2)

A JavaScript engine compiled to WebAssembly (QuickJS family:
`quickjs-emscripten` / QuickJS-NG builds) embedded in the plugin. WASM linear
memory is the isolation boundary — the guest has **no ambient access** to the
file system, network, or host objects. Every capability is a host function we
explicitly inject.

**Why QuickJS-in-WASM over the alternatives:**

| Option | Verdict | Reason |
|--------|---------|--------|
| QuickJS in WASM | **Adopt** | In-process, no native modules, works inside Electron; ~ms startup; memory + interrupt limits |
| Node `vm` module | Reject | Explicitly not a security boundary |
| `isolated-vm` | Reject | Native module; cannot ship in an Obsidian plugin bundle |
| ShadowRealm (TC39) | Reject | Isolates globals, not resources; no memory/CPU limits |
| WebContainers | Reject | Proprietary licensing, browser/service-worker oriented |
| Deno/Node subprocess | Defer | Reintroduces an external runtime dependency — the problem we're solving |

**Capability bridge design:**

```
┌────────────────────────── Obsidian plugin (host) ──────────────────────────┐
│  PermissionGate — resolves workflow permissions before any call crosses    │
│  ┌───────────────┐   host functions    ┌───────────────────────────────┐   │
│  │ vault.read    │◄────────────────────│  QuickJS-in-WASM guest        │   │
│  │ vault.write   │  (each call checked │  - user cell code             │   │
│  │ cell(id)      │   against grants)   │  - injected vault/cell API    │   │
│  │ fetch (gated) │                     │  - no other imports           │   │
│  └───────────────┘                     └───────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────┘
```

- `vaultRead` / `vaultWrite` — enforced **in the host** per call, not by guest
  code (the guest is untrusted; today's container tier injects the check into
  the guest script, which is acceptable only because the container also
  mounts the vault read-only).
- `network` — no socket API exists in the guest. If (and only if) the
  workflow grants `network: allow`, a `fetch` host function is injected that
  proxies through the host with the response streamed back into guest memory.
- **CPU limit** — QuickJS interrupt handler with a wall-clock deadline
  (maps from the existing `timeout` cell attribute).
- **Memory limit** — QuickJS runtime memory cap (maps from `memoryLimit`).

**Engine selection semantics:**

- New engine value: `runtime.engine: wasm` (explicit opt-in per workflow), plus
  an `auto` mode: prefer a detected container engine, fall back to `wasm`
  when the workflow contains only `ore:ts` / `ore:ai` cells.
- `ore:shell` cells are **incompatible** with the wasm tier — parsing a
  workflow that mixes `ore:shell` with `engine: wasm` is a validation error.
- Bun-specific APIs (`Bun.file`, `Bun.spawn`) are unavailable; the injected
  `vault` API is the supported surface. The spec'd cell API (`vault.*`,
  `cell()`) is identical across tiers so workflows stay portable.

### Tier 3 — WASI Components for Compiled Cells (exploratory, v0.3+)

WASI 0.2 and the component model are now stable, with Wasmtime as the
reference runtime and `jco` maturing for JavaScript hosts. This opens a lane
for:

- `ore:go` cells compiled via TinyGo to WASI, executed in-process with
  capability-scoped preopens instead of a Go builder container
- `ore:py` via Pyodide (Emscripten build runs in Node/Electron today) or
  CPython's tier-2 WASI target
- Cached compiled components keyed by source hash (mirrors the existing Go
  build-cache design in `go-cell-spec.md`)

This tier is research-stage: the component-model JS host story (`jco`) and
Pyodide-in-Electron packaging need prototyping before committing to a version.

## Permission Mapping Summary

| Permission | Tier 1 (containers) | Tier 2 (wasm) |
|------------|--------------------|----------------|
| `network: deny` | `--network=none` (error on Apple engine) | No fetch injected (default) |
| `network: allow` | No network flag | Gated `fetch` host function |
| `vaultRead` | RO mount + guest check | Host-side check per call |
| `vaultWrite` | RW mount gated | Host-side check per call |
| CPU / memory | `--cpus` / `--memory` | Interrupt deadline / heap cap |

## Open Questions

1. **Bundle size** — a QuickJS WASM build adds roughly 500 KB–1 MB to
   `main.js`. Ship lazily (download on first wasm-tier run) or bundle?
2. **TS transpilation** — cells are TypeScript; the container tier gets this
   free from Bun. The wasm tier needs esbuild-wasm or sucrase in-plugin, or
   pre-transpilation by the host before injection.
3. **Streaming output** — QuickJS host calls are synchronous by default;
   async host functions (asyncify builds) cost performance. Evaluate
   `quickjs-emscripten` asyncify variants for the `fetch` bridge.
4. **Apple network isolation** — track upstream `apple/container` for a
   vmnet isolation mode to lift the fail-closed restriction.

## Rollout Plan

| Step | Deliverable | Target |
|------|-------------|--------|
| 1 | `SandboxProvider` interface in `@vaultore/core` abstracting Tier 1 exec | v0.2 |
| 2 | QuickJS wasm provider for `ore:ts` with capability bridge | v0.2 |
| 3 | `engine: auto` fallback chain + settings UI | v0.2 |
| 4 | Pyodide spike for `ore:py` | v0.3 |
| 5 | TinyGo→WASI spike for `ore:go` | v0.3+ |
