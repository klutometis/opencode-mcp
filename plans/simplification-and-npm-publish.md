# Simplification & npm Publish Plan

## Context

After initial implementation and local testing, several simplifications
emerged from real-world usage discussion:

1. `OPENCODE_SERVER_PASSWORD` is YAGNI — binding to `127.0.0.1` + SSH tunnel = sufficient auth
2. `RELAY_HOST` / `RELAY_USER` should be replaced by a single `RELAY_SSH_CMD` (supports gcloud)
3. Default registry dir should be `/tmp/opencode-relay` (ephemeral, no permissions issues)
4. `--hostname 0.0.0.0` is unnecessary when tunneling (localhost binding is fine for SSH)
5. Package needs npm publish support (`bin`, `files` fields)

## Changes

### 1. `scripts/opencode-connected`

**Remove:**
- `RELAY_HOST`, `RELAY_USER` env vars
- `OPENCODE_SERVER_PASSWORD` env var and export
- `--hostname 0.0.0.0` from the exec line (bind to `127.0.0.1` default)
- All `ssh ${RELAY_USER}@${RELAY_HOST}` calls

**Add:**
- `RELAY_SSH_CMD` env var — if set, enables tunneling; if empty, local only

**Change:**
- Default `REGISTRY_DIR` to `/tmp/opencode-relay`
- All remote operations use `${RELAY_SSH_CMD}` directly

**Resulting env vars:**

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_SSH_CMD` | — | SSH command to reach relay. If unset, local only. |
| `RELAY_REGISTRY_DIR` | `/tmp/opencode-relay` | Registry directory |
| `INSTANCE_NAME` | `$(hostname)-$(basename $PWD)` | Instance name |

### 2. `src/transport/local-relay.ts`

- Remove `password` field, constructor option, `OPENCODE_SERVER_PASSWORD` reading
- Remove auth headers from `healthCheck()`
- Change `DEFAULT_REGISTRY_DIR` to `/tmp/opencode-relay`
- Remove `homedir` import (no longer needed for default)

### 3. `src/registry.ts`

- Remove `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` reading
- Remove `customFetch` auth wrapper in `makeClient()`
- `makeClient()` becomes just `createOpencodeClient({ baseUrl })`

### 4. `.env.example`

Document both local and relay setups:

```bash
# ── Local development (no relay, no tunnel) ──────────────────
# Default: /tmp/opencode-relay
# RELAY_REGISTRY_DIR=/tmp/opencode-relay

# ── Relay deployment (SSH tunnel to remote machine) ──────────
# RELAY_SSH_CMD=gcloud compute ssh mcp-gateway --zone=us-central1-a --project=your-project --
# RELAY_SSH_CMD=ssh user@relay.example.com
# RELAY_REGISTRY_DIR=/var/lib/opencode-relay

# ── MCP server settings ─────────────────────────────────────
# DISCOVERY_INTERVAL_MS=30000
# HEALTH_CHECK_TIMEOUT_MS=3000
# TRANSPORT=local-relay

# ── Optional: HTTP auth (only if opencode binds to 0.0.0.0) ─
# OPENCODE_SERVER_PASSWORD=your-secret
# OPENCODE_SERVER_USERNAME=opencode
```

### 5. `package.json`

Add for npm publish:
```json
{
  "bin": { "opencode-mcp": "dist/index.js" },
  "files": ["dist", "README.md", "LICENSE"]
}
```

### 6. `src/index.ts`

Add `#!/usr/bin/env node` shebang (required for `bin` to work).

### 7. `src/types.ts`

Remove `pid` from `RegistrationFile` (never actually set by the script).

### 8. `README.md` + `plans/architecture.md`

Update env var tables, examples, and references to match.

## Execution order

1. Types cleanup (`types.ts`)
2. Transport cleanup (`local-relay.ts`)
3. Registry cleanup (`registry.ts`)
4. Script rewrite (`opencode-connected`)
5. `.env.example`
6. `package.json` + `src/index.ts` shebang
7. `README.md`
8. `plans/architecture.md`
9. Build + syntax check
10. Commit + push
11. `npm publish`
