# opencode-mcp: Architecture & Implementation Plan

## What This Is

An MCP server that lets a chat interface discover, monitor, and drive multiple
OpenCode instances running across personal machines. Uses SSH reverse tunnels
through a central relay (a GCE instance) for discovery and transport.

The MCP server itself runs on the relay machine, co-located with the SSH
tunnel endpoints. It plugs into the existing `mcp-gateway` on
the relay host, getting OAuth for free.

## Architecture

```
┌──────────────────────────────────────────────┐
│        Relay machine (GCE / VPS / etc.)      │
│                                              │
│  mcp-gateway ──── opencode-mcp (stdio)       │
│       │              │                       │
│       │         reads /var/lib/              │
│       │         opencode-relay/*.json         │
│       │              │                       │
│    OAuth         localhost:10001 ──┐         │
│    front         localhost:10002 ──┤ opencode│
│                  localhost:10003 ──┘ APIs    │
│                                              │
│  sshd: accepts reverse tunnels               │
└──────▲──────────▲───────────▲────────────────┘
       │          │           │
    ssh -R     ssh -R      ssh -R
       │          │           │
    laptop     desktop     laptop
    (oc:4096)  (oc:4096)   (oc:4097)
```

### How It Works

1. **Each opencode machine** runs `opencode-connect.sh`, which:
   - Starts `opencode serve` in a named tmux session
   - Opens an SSH reverse tunnel to the relay: `ssh -R {PORT}:localhost:4096 relay`
   - Writes a registration JSON file on the relay via the same SSH session
   - Port is hash-based from instance name (deterministic), with retry on conflict
   - `trap` + `sleep infinity` keeps the tunnel alive; cleanup on disconnect

2. **The relay machine** (GCE) provides:
   - `sshd` accepting reverse tunnels (already running)
   - A directory `/var/lib/opencode-relay/` with JSON registration files
   - The MCP server process (via mcp-gateway)

3. **The MCP server** (this project):
   - Reads registration files from `/var/lib/opencode-relay/`
   - Health-checks each registered port; prunes stale entries
   - Creates OpenCode SDK clients pointed at `localhost:{tunnel_port}`
   - Exposes MCP tools for instance/session/message management

4. **The chat client** (Claude, custom frontend) connects to the MCP server
   through mcp-gateway's OAuth layer. No direct access to tunnel ports needed.

## Design Decisions

### Pluggable Transport

The discovery/transport layer is abstracted behind an interface:

```typescript
interface Transport {
  discover(): Promise<OpenCodeInstance[]>
  getBaseUrl(instance: OpenCodeInstance): string
}
```

**Implementations:**
- `LocalRelayTransport` (Phase 1) — reads JSON files, returns `http://localhost:{port}`
- `TailscaleTransport` (future) — queries Tailscale API, returns `http://{tailscale_ip}:{port}`
- `CloudflareTransport` (future) — queries CF tunnel API, returns tunnel URLs

### SSH Tunnel Port Assignment

Hash-based from instance name, deterministic with collision retry:

```bash
BASE=10000; RANGE=1000
START=$(( BASE + $(echo "$NAME" | cksum | cut -d' ' -f1) % RANGE ))
# Try START, then START+1, START+2, ... wrapping around
# SSH exits with error if port is taken; script retries next port
```

### Registration File Format

`/var/lib/opencode-relay/{instance-name}.json`:

```json
{
  "name": "laptop-myproject",
  "hostname": "laptop",
  "port": 10042,
  "localPort": 4096,
  "cwd": "/home/user/projects/myproject",
  "connectedAt": "2026-03-14T10:30:00Z"
}
```

### Authentication

- **MCP layer**: OAuth via mcp-gateway (already handled)
- **OpenCode binding**: `127.0.0.1` (default) — not network-accessible.
  No HTTP password needed; the SSH tunnel is the auth boundary.
- **SSH tunnels**: standard SSH key auth or gcloud auth to the relay machine
- **Tunnel ports**: bound to host's localhost only, not externally accessible
- **Optional**: `OPENCODE_SERVER_PASSWORD` can be added back if opencode
  binds to `0.0.0.0` (e.g. for LAN/phone access without tunnels)

### Stale Instance Pruning

On each `discover()` call, the transport:
1. Reads all JSON files from the registry directory
2. For each, probes `GET http://localhost:{port}/global/health`
3. If unreachable, deletes the registration file
4. Returns only healthy instances (with version from health endpoint)

## Repository Structure

```
opencode-mcp/
├── package.json
├── tsconfig.json
├── plans/
│   └── architecture.md          # this file
├── src/
│   ├── index.ts                 # MCP server entry + tool registration
│   ├── types.ts                 # OpenCodeInstance, RegistrationFile, etc.
│   ├── registry.ts              # Instance cache + OpenCode SDK client mgmt
│   ├── transport/
│   │   ├── interface.ts         # Abstract transport interface
│   │   └── local-relay.ts       # Reads JSON files, health-checks, localhost URLs
│   └── tools/
│       ├── instances.ts         # list_instances, refresh_instances
│       ├── sessions.ts          # list_sessions, get_session, create_session
│       └── messages.ts          # send_message, get_status, abort_session
├── scripts/
│   └── opencode-connected       # Client: random port + tunnel + exec opencode TUI
└── PROPOSAL.md                  # Original proposal (includes Tailscale plan)
```

## MCP Tools

### Instance Management

| Tool | Input | Description |
|------|-------|-------------|
| `list_instances` | none | List all discovered opencode instances (cached) |
| `refresh_instances` | none | Re-scan registry, health-check, return updated list |

### Session Management

| Tool | Input | Description |
|------|-------|-------------|
| `list_sessions` | `{instance}` | List sessions on an instance with ID, title, message count, status |
| `get_session` | `{instance, session_id, message_limit?}` | Get session details + last N messages as readable conversation |
| `create_session` | `{instance, title?}` | Create a new session |

### Message Operations

| Tool | Input | Description |
|------|-------|-------------|
| `send_message` | `{instance, session_id, message, async?}` | Send a message; sync waits for response, async returns immediately |
| `get_status` | `{instance}` | Get status of all sessions (running/idle/error) |
| `abort_session` | `{instance, session_id}` | Abort a running session |

## Implementation Phases

### Phase 1: Foundation
- `package.json`, `tsconfig.json`
- `src/types.ts` — shared type definitions
- `src/transport/interface.ts` — abstract transport interface

### Phase 2: Local Relay Transport
- `src/transport/local-relay.ts`
- Reads `/var/lib/opencode-relay/*.json`
- Health-checks each port, prunes stale entries
- Returns `http://localhost:{port}` base URLs

### Phase 3: Registry
- `src/registry.ts`
- Caches instances from transport layer
- Creates/manages OpenCode SDK clients per instance
- Fuzzy instance name resolution
- Periodic refresh on configurable interval

### Phase 4: Instance Tools
- `src/tools/instances.ts`
- `list_instances`: returns markdown table from cache
- `refresh_instances`: triggers re-discovery, returns updated table

### Phase 5: Session Tools
- `src/tools/sessions.ts`
- `list_sessions`, `get_session`, `create_session`
- Uses OpenCode SDK client from registry

### Phase 6: Message Tools
- `src/tools/messages.ts`
- `send_message` (sync + async modes), `get_status`, `abort_session`

### Phase 7: MCP Entry Point
- `src/index.ts`
- Instantiate transport, registry, register all tools
- StdioServerTransport for mcp-gateway compatibility
- Graceful shutdown handling

### Phase 8: Client Script — `scripts/opencode-connected`

Self-contained script (symlink to `~/bin/opencode-connected`) that:

1. **Derives INSTANCE_NAME** from `$(hostname)-$(basename $PWD)` (override via env)
2. **Picks a random LOCAL_PORT** in range 4096-5095, checks `ss -tln` for conflicts
3. **Computes REMOTE_PORT** by hashing INSTANCE_NAME → range 10000-10999 (stable per instance)
4. **Starts tunnel_loop in background**:
   - `mkdir -p` + writes registration JSON on relay (lazy dir creation, no setup step)
   - `ssh -N -R ${REMOTE_PORT}:localhost:${LOCAL_PORT} ${RELAY_HOST}`
   - On tunnel drop: sleep, re-register, retry
   - On port conflict: try next port, re-register
   - On parent (opencode) death: break, cleanup registration file
5. **`exec npx -y opencode-ai@latest --port ${LOCAL_PORT} --hostname 0.0.0.0 "$@"`**
   - TUI runs in foreground (appears in eat / terminal)
   - `exec` replaces shell; EXIT trap fires when opencode exits
6. **EXIT trap** kills tunnel_loop, which cleans up registration on relay

Env vars:
- `RELAY_SSH_CMD` — SSH command to reach relay (e.g. `gcloud compute ssh ...`).
  If unset, local only — no tunnel, just local registration.
- `INSTANCE_NAME` — defaults to `$(hostname)-$(basename $PWD)`
- `RELAY_REGISTRY_DIR` — defaults to `/tmp/opencode-relay`

Config selection (e.g. work machine MCPs) is handled extrinsically via
`OPENCODE_CONFIG` env var in the user's shell profile — not by this script.

Note: `opencode` without `--port` does NOT start an HTTP server.
The `--port` flag is what enables the HTTP side-car alongside the TUI.
OpenCode binds to `127.0.0.1` by default — no password needed when
using SSH tunnels as the auth boundary.

### Phase 9: Relay Setup
No dedicated setup script needed. The `opencode-connected` script lazily
creates the registry directory on the relay via `mkdir -p` when registering.
The MCP server's `local-relay.ts` handles ENOENT gracefully (returns empty
list if the dir doesn't exist yet). Optional hardening (dedicated user,
sshd restrictions) can be done manually.

### Phase 10: Testing
- Local end-to-end: start two opencode instances, write fake registration files,
  run MCP server, exercise all tools

## Future Work

### Session UX: reducing repetitive parameters (evaluate after real usage)

Three options for how the chat frontend interacts with session IDs:

- **Option A: `focus_instance` / `focus_session` tools** — set-and-forget.
  Subsequent tool calls that omit `instance` or `session_id` use the focused
  one. Like `cd` for sessions. Pro: cleaner conversation flow. Con: hidden
  state can confuse the LLM if it loses track.

- **Option B: Status quo (LLM carries context)** — every tool call requires
  explicit `instance` and `session_id`. The LLM's context window is the
  memory. Pro: stateless, predictable. Con: slightly verbose but the LLM
  handles it naturally.

- **Option C: Title-based session resolution** — allow `session_id` to accept
  a title substring (e.g. "Tailscale session") in addition to ID prefixes.
  The `resolveSessionId` helper would check ID prefix first, then fall back
  to title substring match. Pro: more natural in conversation. Con: ambiguous
  titles could collide.

Current recommendation: B + C (stateless, but accept titles as well as IDs).

### Connection resilience (implement after first real-world test)

- **Reconnect loop in opencode-connect.sh**: wrap the `ssh -N` call in a
  `while true` loop with a backoff delay. On reconnect, re-register (new port)
  by overwriting the JSON file. The trap only fires on intentional disconnect
  (Ctrl+C / SIGTERM), not on SSH dying. Alternative: recommend `autossh` for
  users who want it battle-hardened.

- **Retry-with-refresh in tool handlers**: when an SDK call fails with a
  connection error, the tool handler calls `registry.refresh()` and retries
  once with the fresh client. This makes port changes from reconnection
  transparent to the conversation — no need to manually refresh. Pattern:
  ```
  try sdk call → catch connection error → refresh registry → resolve again → retry
  ```
  Instances are keyed by name (not port), so the conversation's reference to
  "laptop-myproject" survives a port change seamlessly.

### Additional MCP tools (from OpenCode server API docs)

These tools leverage endpoints we haven't exposed yet. Implement as needed:

| Tool | Endpoint | Use case |
|------|----------|----------|
| `run_shell` | `POST /session/:id/shell` | Run a shell command on a remote instance |
| `read_file` | `GET /file/content?path=...` | Read file contents on a remote instance |
| `list_files` | `GET /file?path=...` | Directory listing on a remote instance |
| `run_command` | `POST /session/:id/command` | Execute opencode slash commands remotely |
| `get_diff` | `GET /session/:id/diff` | See what files changed in a session |
| `delete_session` | `DELETE /session/:id` | Delete a session and all its data |
| `fork_session` | `POST /session/:id/fork` | Fork a session at a specific message |
| `share_session` | `POST /session/:id/share` | Share a session (get public URL) |

### TUI tools (only for TUI instances, not headless `opencode serve`)

| Tool | Endpoint | Use case |
|------|----------|----------|
| `inject_prompt` | `POST /tui/append-prompt` + `POST /tui/submit-prompt` | Stage or submit a prompt in the TUI |
| `show_toast` | `POST /tui/show-toast` | Alert the user at a specific machine |
| `focus_tui` | `POST /tui/open-sessions` | Open the session picker in the TUI |

### SSE event subscription (stretch goal)

`GET /event` provides a real-time Server-Sent Events stream. Instead of
polling with `get_status`, we could subscribe and get push notifications
when sessions change state (idle → busy → idle). Useful for "watch a
long-running task" without repeated polling. Would require the MCP server
to maintain persistent SSE connections per instance.

### Transport backends

- **mDNS transport**: OpenCode has built-in mDNS discovery
  (`opencode serve --mdns --mdns-domain opencode.local`). This broadcasts
  on the local network — zero configuration for LAN machines. Could be a
  transport backend that listens for mDNS announcements instead of reading
  JSON files. No SSH tunnels needed for same-network machines.
- **Tailscale transport**: drop-in backend using posture attributes for discovery,
  direct WireGuard for transport (no relay needed)
- **Cloudflare Tunnel transport**: `cloudflared` on each machine, automatic
  HTTPS/subdomains, no self-hosted relay

### SSH tunnel resilience: autossh upgrade path

The current `tunnel_loop` in `opencode-connected` is a simple `while true`
+ `sleep 5` reconnect loop with `ServerAliveInterval=30` /
`ServerAliveCountMax=3` for dead-connection detection (~90s detection).

If we hit edge cases (TCP half-open connections, zombie SSH processes,
tunnels that appear alive but aren't forwarding), consider replacing the
loop with `autossh` (https://github.com/Autossh/autossh), which adds:
- Dedicated monitoring port for proactive dead-tunnel detection
- Better backoff strategies
- Battle-tested handling of partial connection states

Our loop also lacks exponential backoff (fixed 5s retry) — could add if
rapid retries become a problem.

### Other future work

- **spawn_instance tool**: start a new opencode session on a remote machine
  via SSH + tmux
- **systemd/launchd service**: make opencode-connected a system service that
  auto-restarts on boot and on failure — for machines that should always be
  reachable

## Environment Variables

### MCP server

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_REGISTRY_DIR` | `/tmp/opencode-relay` | Registry directory |
| `DISCOVERY_INTERVAL_MS` | `30000` | Refresh interval (ms) |
| `HEALTH_CHECK_TIMEOUT_MS` | `3000` | Health check timeout (ms) |
| `TRANSPORT` | `local-relay` | Transport backend |

### `opencode-connected` script

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_SSH_CMD` | — | SSH command to reach relay. If unset, local only. |
| `RELAY_REGISTRY_DIR` | `/tmp/opencode-relay` | Registry directory |
| `INSTANCE_NAME` | `$(hostname)-$(basename $PWD)` | Instance name |

### Optional (only if binding to 0.0.0.0)

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_SERVER_PASSWORD` | — | HTTP Basic auth password |
| `OPENCODE_SERVER_USERNAME` | `opencode` | HTTP Basic auth username |
