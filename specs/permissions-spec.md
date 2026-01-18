# Permissions and Security Specification

> **Status:** Canonical  
> **Version:** 0.1.0  
> **Last Updated:** 2026-01-09

## Overview

VaultOre executes user code in sandboxed containers. This specification defines the permission model that controls what workflows can do.

## 1. Design Principles

1. **Secure by Default:** All permissions default to most restrictive
2. **Explicit Consent:** Dangerous operations require user approval
3. **Per-Workflow:** Permissions are scoped to individual workflows
4. **Transparent:** Users can see exactly what a workflow will do
5. **No Host Fallback:** If containers unavailable, fail safely (not unsafely)

---

## 2. Permission Types

### 2.1 Overview

| Permission | Default | Description |
|------------|---------|-------------|
| `network` | `deny` | Runtime network access |
| `buildNetwork` | `ask` | Network during builds (Go, Python) |
| `vaultRead` | `allow` | Read notes from vault |
| `vaultWrite` | `deny` | Write/create notes |

### 2.2 Permission Values

| Value | Behavior |
|-------|----------|
| `allow` | Always permit without prompting |
| `deny` | Always block without prompting |
| `ask` | Prompt user on first use, remember choice |

---

## 3. Permission Details

### 3.1 `network`

Controls runtime network access for cells.

**When `deny` (default):**
- Container runs with `--network=none`
- `fetch()` calls fail
- External API calls fail
- Only local operations work

**When `allow`:**
- Container has network access
- Can call external APIs
- Can fetch URLs
- Can send data externally

**When `ask`:**
- Prompt user on first run
- Store decision per-workflow
- Use stored decision on subsequent runs

**Security considerations:**
- Network access enables data exfiltration
- Workflows from untrusted sources should not have network
- AI cells require network (to call provider APIs)

### 3.2 `buildNetwork`

Controls network access during build phase (Go modules, pip install).

**When `deny`:**
- Builds must be offline
- Go: vendored deps or stdlib only
- Python: pre-installed packages only

**When `allow`:**
- Can download dependencies during build
- Go: `go mod download` works
- Python: `pip install` works

**When `ask` (default):**
- Prompt on first build needing network
- Store decision per-workflow

**Note:** Build network is separate from runtime network. A workflow can have `buildNetwork: allow` but `network: deny`.

### 3.3 `vaultRead`

Controls reading notes from the vault.

**When `deny`:**
- `vault.read()` throws error
- `{{note:path}}` templates fail
- Cell can only access its own context

**When `allow` (default):**
- Can read any note in vault
- Templates resolve successfully
- Full vault access for reading

**When `ask`:**
- Prompt before reading notes
- Useful for sensitive vaults

**Security considerations:**
- Reading is generally safe (can't exfiltrate without network)
- May expose sensitive note content to AI providers
- Combined with network, could leak vault contents

### 3.4 `vaultWrite`

Controls writing/creating notes in the vault.

**When `deny` (default):**
- `vault.write()` throws error
- `vault.mkdirp()` throws error
- Output stubs and run output files are written (always allowed)

**When `allow`:**
- Can create new notes
- Can modify existing notes
- Can create directories

**When `ask`:**
- Prompt before write operations
- Store decision per-workflow

**Security considerations:**
- Write access can modify/corrupt vault
- Can overwrite important notes
- Can create misleading content

---

## 4. Container Sandbox

### 4.1 Default Container Flags

All cells run with these Docker/Podman flags:

```bash
docker run \
  --rm \
  --network=none \           # Unless network: allow
  --read-only \              # Except /tmp and /workspace
  --memory=512m \
  --cpus=1 \
  --pids-limit=256 \
  --user=1000:1000 \         # Non-root
  --security-opt=no-new-privileges \
  --cap-drop=ALL \
  -v /vault:/workspace:ro \  # Vault mounted read-only
  -v /tmp:/tmp:rw \          # Temp directory writable
  $IMAGE $COMMAND
```

### 4.2 Configurable Limits

| Limit | Default | Configurable |
|-------|---------|--------------|
| Memory | 512MB | Yes, in settings |
| CPU | 1 core | Yes, in settings |
| Timeout | 60s | Yes, per-cell or settings |
| PIDs | 256 | Yes, in settings |

### 4.3 No Unsafe Fallback

If no container runtime is available:
- Show error message with setup instructions
- **Do not** offer to run code directly on host
- **Do not** provide any bypass mechanism

---

## 5. Permission Prompts

### 5.1 Prompt Triggers

A permission prompt is shown when:
- Permission is set to `ask`
- This is the first run of this workflow
- (Or user has cleared stored permissions)

### 5.2 Prompt UI

```
┌─────────────────────────────────────────────────────┐
│  VaultOre: Permission Request                       │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Workflow: Link Digest                              │
│  Path: Workflows/link-digest.md                     │
│                                                     │
│  This workflow requests:                            │
│                                                     │
│  ⚠️  Network Access                                 │
│      Allows fetching external URLs and calling      │
│      AI APIs.                                       │
│                                                     │
│  ⚠️  Vault Write Access                             │
│      Allows creating and modifying notes in         │
│      your vault.                                    │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ [ ] Remember my choice for this workflow    │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│        [ Deny ]                    [ Allow ]        │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 5.3 Permission Storage

Stored permissions are saved per-workflow:

```json
{
  "Workflows/link-digest.md": {
    "network": "allow",
    "vaultWrite": "allow",
    "grantedAt": "2026-01-09T08:00:00Z",
    "workflowHash": "<sha256>"
  }
}
```

**Re-prompt conditions:**
- User clears permissions in settings
- Workflow content significantly changes (hash differs)
- New permission type is requested

---

## 6. AI Provider Considerations

### 6.1 API Key Security

- API keys stored using Obsidian's secure storage
- Never logged or exposed in outputs
- Never sent to containers (injected at runtime)

### 6.2 Data Sent to Providers

AI cells send:
- Prompt content (including interpolated variables)
- System prompt (if configured)
- Model parameters

**Data that could be sent:**
- Note content (via `{{note:path}}`)
- Cell outputs (via `{{cellId}}`)
- Block content (via `{{block:...}}`)

**User awareness:**
- AI cells require `network: allow`
- Users should review prompts before running
- Sensitive data should not be in AI prompts

---

## 7. Shared Workflow Security

### 7.1 Workflow Trust Model

When importing a workflow from external source:

1. **Display warning** before first run
2. **Show requested permissions** clearly
3. **Require explicit approval** for each permission
4. **Hash workflow content** for re-prompt on changes

### 7.2 Warning UI

```
┌─────────────────────────────────────────────────────┐
│  ⚠️  External Workflow                              │
├─────────────────────────────────────────────────────┤
│                                                     │
│  This workflow was not created by you.              │
│                                                     │
│  Source: Community Gallery                          │
│  Author: unknown-user                               │
│                                                     │
│  Please review the code before running.             │
│  Malicious workflows could:                         │
│  - Access your vault contents                       │
│  - Send data to external servers                    │
│  - Modify or delete your notes                      │
│                                                     │
│        [ Cancel ]         [ Review & Continue ]     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 7.3 Best Practices for Shared Workflows

- Default to `network: deny` unless necessary
- Default to `vaultWrite: deny` unless necessary
- Document why permissions are needed
- Provide minimal example with reduced permissions

---

## 8. Audit Logging

### 8.1 Audit Log Format

All executions logged to `.vaultore/audit.jsonl`:

```json
{
  "timestamp": "2026-01-09T08:00:00Z",
  "event": "workflow:run",
  "workflow": "Workflows/link-digest.md",
  "cells": ["fetch", "summarize", "output"],
  "permissions": {
    "network": "allow",
    "vaultWrite": "allow"
  },
  "status": "success",
  "duration": 5200
}
```

### 8.2 Logged Events

| Event | Description |
|-------|-------------|
| `workflow:run` | Workflow execution started |
| `workflow:complete` | Workflow completed |
| `workflow:error` | Workflow failed |
| `permission:grant` | User granted permission |
| `permission:deny` | User denied permission |
| `cell:run` | Cell execution started |
| `cell:complete` | Cell completed |
| `cell:error` | Cell failed |

### 8.3 Log Retention

- Default: Keep last 1000 entries
- Configurable in settings
- User can clear logs

---

## 9. Threat Model

### 9.1 Threats Mitigated

| Threat | Mitigation |
|--------|------------|
| Code execution on host | Container isolation |
| Network data exfiltration | `network: deny` default |
| Vault corruption | `vaultWrite: deny` default |
| Resource exhaustion | Memory/CPU/PID limits |
| Privilege escalation | Non-root user, dropped caps |
| Malicious shared workflows | Trust warnings, permission prompts |

### 9.2 Threats Not Mitigated

| Threat | Notes |
|--------|-------|
| Side-channel attacks | Containers share kernel |
| Container escape (0-day) | Rely on Docker security |
| Malicious AI responses | AI can return anything |
| Social engineering | User can approve anything |

### 9.3 Risk Acceptance

Users accept remaining risk by:
1. Installing the plugin
2. Granting permissions to workflows
3. Running workflows with network access

---

## 10. Configuration

### 10.1 Global Settings

```yaml
# In plugin settings
security:
  defaultNetwork: deny         # Default for new workflows
  defaultVaultWrite: deny      # Default for new workflows
  allowUntrustedWorkflows: true # Show warning but allow
  requireReviewForExternal: true # Force code review
  auditLogEnabled: true
  auditLogMaxEntries: 1000
```

### 10.2 Per-Workflow Override

Settings can make permissions stricter but not looser:
- If global is `deny`, workflow cannot override to `allow`
- If global is `ask`, workflow can be `deny` but not `allow`
- If global is `allow`, workflow can override freely

---

## Appendix A: Permission Matrix

| Operation | `network` | `vaultRead` | `vaultWrite` | `buildNetwork` |
|-----------|-----------|-------------|--------------|----------------|
| `fetch()` in TS | ✓ | | | |
| `vault.read()` | | ✓ | | |
| `vault.write()` | | | ✓ | |
| `{{note:path}}` | | ✓ | | |
| AI completion | ✓ | | | |
| `go mod download` | | | | ✓ |
| `pip install` | | | | ✓ |
| Output comment | | | (always) | |

---

## Appendix B: Decision Flowchart

```
User runs workflow
        │
        ▼
┌───────────────────┐
│ Parse permissions │
│ from frontmatter  │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐     ┌─────────────────┐
│ Any permission    │ Yes │ Check stored    │
│ set to 'ask'?     │────►│ permissions     │
└─────────┬─────────┘     └────────┬────────┘
          │ No                     │
          │            ┌───────────┴───────────┐
          │            │                       │
          │       Has stored?              No stored
          │            │                       │
          │            ▼                       ▼
          │     Use stored              Show prompt
          │            │                       │
          │            │           ┌───────────┴───────────┐
          │            │           │                       │
          │            │        Allowed?               Denied?
          │            │           │                       │
          │            │           ▼                       ▼
          │            │      Store choice           Abort run
          │            │           │
          ▼            ▼           ▼
    ┌─────────────────────────────────┐
    │      Apply permissions          │
    │      Configure container        │
    │      Execute workflow           │
    └─────────────────────────────────┘
```
