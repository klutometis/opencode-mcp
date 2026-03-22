# Postgres-based Instance Registry

**Status:** Proposed (not yet started)
**Date:** 2026-03-21
**Priority:** Medium — pursue if /tmp-based registry proves fragile even with direct SSH

## Motivation

The current file-based registry (`/tmp/opencode-relay/*.json`) has several
fragility concerns:

- **`/tmp` cleanup**: `systemd-tmpfiles` or reboots can delete registration
  files while instances are still alive.
- **Coupled failure modes**: Registration, health-checking, and tunneling all
  depend on SSH. When SSH breaks, everything breaks simultaneously — no
  visibility into what's happening.
- **No TTL**: Stale files persist until the MCP server health-checks and prunes
  them. If the MCP server isn't running, stale files accumulate indefinitely.
- **No observability**: No way to query registration history, uptime, or
  failure patterns.

## Current State (2026-03-21)

The primary reliability issue was diagnosed as **gcert/SSO expiry** breaking
the `gcloud compute ssh` wrapper. Switching `RELAY_SSH_CMD` to direct SSH
(using the underlying key at `~/.ssh/google_compute_engine`) eliminates this
failure mode entirely.

With direct SSH, the existing file-based registry may be reliable enough.
**Monitor for a week before investing in Postgres migration.**

## Proposed Architecture

```
┌─────────────────────────────────────────────────────┐
│  Neon Postgres (serverless)                         │
│                                                     │
│  instances table:                                   │
│    name           TEXT PRIMARY KEY                   │
│    hostname       TEXT NOT NULL                      │
│    relay_host     TEXT NOT NULL DEFAULT 'localhost'  │
│    port           INT NOT NULL                      │
│    local_port     INT NOT NULL                      │
│    cwd            TEXT                               │
│    last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT now()│
│    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()│
│                                                     │
└─────────────────────────────────────────────────────┘
         ▲                    ▲
         │ UPSERT+heartbeat   │ SELECT (discover)
         │ every 30s          │ every 30s
         │                    │
    opencode-connected     opencode-mcp
    (on laptop/desktop)    (on relay)
```

### Key design decisions

**TTL via WHERE clause, not pg_cron.** Neon scales to zero when idle, and
pg_cron only runs when the compute is active. Instead, the MCP server's
`discover()` query filters stale rows:

```sql
SELECT * FROM instances
WHERE last_heartbeat > now() - interval '120 seconds'
```

A lazy cleanup runs at discover time to prevent unbounded table growth:

```sql
DELETE FROM instances WHERE last_heartbeat < now() - interval '1 hour'
```

**Heartbeat decoupled from tunnel.** The client (`opencode-connected`) sends
heartbeats directly to Neon via `DATABASE_URL`. This works even when the SSH
tunnel is temporarily down, giving the MCP server visibility into instances
that exist but aren't currently reachable.

**autossh for tunnel management.** Replace the custom `tunnel_loop` bash
function with `autossh -M 0`, which handles reconnection, half-open
connections, and edge cases better than our hand-rolled retry logic.

### Connection approach

Neon exposes a standard Postgres connection string over TLS:

```
postgresql://user:pass@ep-xyz.us-west-2.aws.neon.tech/dbname?sslmode=require
```

Both client and server use this directly. No SSH dependency for registry
operations. Credential stored in `DATABASE_URL` env var.

**Latency:** Neon REST adds ~100-200ms per query. Acceptable for:
- Heartbeat (fire-and-forget, every 30s)
- Discovery (background, every 30s)
- On-demand `instances` tool call (~200ms one-time)

Could use `@neondatabase/serverless` driver or standard `pg` npm package
for lower latency via the wire protocol.

## Implementation Plan

### New transport: `src/transport/postgres.ts`

```typescript
class PostgresTransport implements Transport {
  async discover(): Promise<OpenCodeInstance[]> {
    // SELECT * FROM instances WHERE last_heartbeat > now() - '120s'
    // Also: DELETE FROM instances WHERE last_heartbeat < now() - '1 hour'
  }
}
```

### Transport selection in `src/index.ts`

```
DATABASE_URL set? → PostgresTransport
Otherwise         → LocalRelayTransport (current behavior, for local testing)
```

### Client changes: `scripts/opencode-connected`

- Replace custom `tunnel_loop` with `autossh -M 0 -R ...`
- Replace file-based registration with Postgres UPSERT heartbeat loop
- On exit: `DELETE FROM instances WHERE name = $NAME`

### New env vars

| Variable | Where | Description |
|----------|-------|-------------|
| `DATABASE_URL` | Both | Neon connection string |
| `RELAY_HOST` | Client | Relay identifier (default: `localhost`) |

### Migration SQL

```sql
CREATE TABLE IF NOT EXISTS instances (
  name           TEXT PRIMARY KEY,
  hostname       TEXT NOT NULL,
  relay_host     TEXT NOT NULL DEFAULT 'localhost',
  port           INT NOT NULL,
  local_port     INT NOT NULL,
  cwd            TEXT,
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Cost / Benefit

### Benefits
- **Independent failure modes**: Registration works when tunnel is down
- **No /tmp fragility**: Survives reboots, tmpfiles cleanup
- **Observability**: Query history, uptime patterns, stale instance debugging
- **Cleaner pruning**: TTL via WHERE clause, no health-check-and-delete dance
- **Foundation for multiple relays**: `relay_host` column supports it if needed

### Costs
- **Additional infrastructure**: Neon database (cheap, but another dependency)
- **Credentials management**: `DATABASE_URL` must be on every client machine
- **Neon cold start**: First query after idle wakes the compute (~500ms-1s)
- **Complexity**: More moving parts than reading JSON files from /tmp

## Decision Criteria

Proceed with Postgres migration if any of the following occur after
switching to direct SSH:

1. /tmp files are cleaned up by systemd-tmpfiles and cause outages
2. Registration files get out of sync with actual tunnel state
3. Need for multi-relay support arises
4. Want historical observability into instance uptime/connectivity
