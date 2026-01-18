---
ore: true
name: System Snapshot
version: "0.1"
author: VaultOre Team
tags: [canonical, system, shell, monitoring]
description: >
  Collects system information using shell commands,
  normalizes to JSON with TypeScript, and writes artifacts.
  Tests shell execution and cross-cell data flow.

runtime:
  engine: docker
  image: oven/bun:1-alpine

permissions:
  network: deny
  buildNetwork: deny
  vaultWrite: allow
  vaultRead: allow
---

# System Snapshot (top-level)

Collects basic system information from the container environment.

## Test Criteria

- [ ] Shell cell executes and captures stdout
- [ ] TypeScript can parse shell output
- [ ] Structured JSON is produced
- [ ] Artifacts are written correctly

---

## Step 1: Collect system info via shell

```ore:shell id=sysinfo
set -eu

echo "--- uname ---"
uname -a || true

echo "--- uptime ---"
uptime || true

echo "--- cpuinfo ---"
grep -E 'model name|processor|cpu cores' /proc/cpuinfo 2>/dev/null | head -n 40 || true

echo "--- meminfo ---"
grep -E 'MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree' /proc/meminfo || true

echo "--- loadavg ---"
cat /proc/loadavg || true
```

---

## Step 2: Normalize to structured JSON

```ore:ts id=normalize depends=[sysinfo]
const raw = String(cell("sysinfo"));
const lines = raw.split("\n");

function pickSection(name) {
  const idx = lines.findIndex((l) => l.trim() === `--- ${name} ---`);
  if (idx < 0) return [];
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("--- ")) break;
    out.push(lines[i]);
  }
  return out.filter(Boolean);
}

const uname = pickSection("uname").join("\n");
const uptime = pickSection("uptime").join("\n");
const cpuinfo = pickSection("cpuinfo");
const meminfo = pickSection("meminfo");
const loadavg = pickSection("loadavg").join("\n");

// Parse memory info
const mem = {};
for (const l of meminfo) {
  const m = l.match(/^(\w+):\s+(\d+)\s+kB/);
  if (m) mem[m[1]] = Number(m[2]) * 1024;
}

({
  capturedAt: new Date().toISOString(),
  uname,
  uptime,
  cpuinfo,
  loadavg,
  memBytes: mem,
});
```

---

## Step 3: Compute derived metrics

```ore:ts id=derive depends=[normalize]
const data = cell("normalize");
const mem = data.memBytes || {};

const total = mem.MemTotal || 0;
const avail = mem.MemAvailable || 0;
const used = total - avail;
const usedPct = total > 0 ? used / total : 0;

({
  capturedAt: data.capturedAt,
  uname: data.uname,
  loadavg: data.loadavg,
  mem: {
    totalBytes: total,
    availableBytes: avail,
    usedBytes: used,
    usedPct: Math.round(usedPct * 10000) / 100, // percentage with 2 decimals
  },
});
```

---

## Step 4: Write artifact snapshot

```ore:ts id=write-snapshot depends=[derive, sysinfo]
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const baseDir = `${vaultore.outputRoot}/artifacts/sys-snapshot/${runId}`;

await vault.mkdirp(baseDir);

// Write derived metrics
await vault.write(
  `${baseDir}/snapshot.json`,
  JSON.stringify(cell("derive"), null, 2)
);

// Write raw shell output
await vault.write(`${baseDir}/raw.txt`, String(cell("sysinfo")));

({
  artifactDir: baseDir,
  files: [`${baseDir}/snapshot.json`, `${baseDir}/raw.txt`],
});
```

---

## Expected Results

1. **Shell output** captured with system info sections
2. **Normalized JSON** with structured memory data
3. **Derived metrics** including memory usage percentage
4. **Artifacts** in `_vaultore/artifacts/sys-snapshot/<timestamp>/` (default output folder)

## Validation

```bash
# Check artifacts exist
test -f "_vaultore/artifacts/sys-snapshot/*/snapshot.json"
test -f "_vaultore/artifacts/sys-snapshot/*/raw.txt"

# Validate JSON
jq '.mem.usedPct' "_vaultore/artifacts/sys-snapshot/*/snapshot.json"
```
