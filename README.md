# opencode-mcp

An MCP server that discovers, monitors, and drives multiple OpenCode instances
running across personal machines. Uses SSH reverse tunnels through a central
relay for discovery and transport. Pluggable transport layer supports future
backends (Tailscale, Cloudflare Tunnels, mDNS).

## Quick Start (local testing)

```bash
# 1. Install
npm install && npm run build

# 2. Start opencode with HTTP side-car (in a separate terminal)
#    opencode-connected picks a random port and writes a registration file
ln -s ~/prg/opencode-mcp/scripts/opencode-connected ~/bin/opencode-connected
opencode-connected

# 3. Run with MCP inspector (in another terminal)
npx @modelcontextprotocol/inspector tsx src/index.ts

# Or run directly (stdio MCP server)
node dist/index.js
```

Both `opencode-connected` and the MCP server default to `/tmp/opencode-relay`
for the registry directory — no configuration needed for local testing.

## Architecture

```
┌──────────────────────────────────────────────┐
│        Relay machine (GCE / VPS / etc.)      │
│                                              │
│  mcp-gateway ──── opencode-mcp (stdio)       │
│       │              │                       │
│       │         reads /tmp/opencode-relay/    │
│       │         or RELAY_REGISTRY_DIR         │
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
    (oc:4823)  (oc:4567)   (oc:4901)
```

The MCP server runs on the same machine that accepts SSH reverse tunnels.
It reads registration JSON files from a directory, health-checks each
registered port on localhost, and creates OpenCode SDK clients for healthy
instances. All OpenCode API calls go through `localhost:{tunnel_port}`.

OpenCode binds to `127.0.0.1` (default) — the SSH tunnel is the auth
boundary. No passwords needed.

## MCP Tools

| Tool | Input | Description |
|------|-------|-------------|
| `instances` | — | List all discovered instances with status (idle/busy) and recent session |
| `send` | `instance`, `message`, `abort?` | Send a message to the most recent session; set `abort=true` to stop a running task |
| `read` | `instance`, `message_limit?` | Read the last N messages from the most recent session |

Instance names support fuzzy substring matching (e.g. `"laptop"` matches
`"laptop-myproject"`).

## Environment Variables

### MCP server

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_REGISTRY_DIR` | `/tmp/opencode-relay` | Directory containing registration JSON files |
| `DISCOVERY_INTERVAL_MS` | `30000` | How often to refresh instance list (ms) |
| `HEALTH_CHECK_TIMEOUT_MS` | `3000` | Timeout for health-checking each instance (ms) |
| `TRANSPORT` | `local-relay` | Transport backend (`local-relay`, future: `tailscale`) |
| `SEND_TIMEOUT_MS` | `300000` | Timeout for streaming send responses (ms) |

### `opencode-connected` script

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_SSH_CMD` | — | SSH command to reach relay. If unset, local only. |
| `RELAY_REGISTRY_DIR` | `/tmp/opencode-relay` | Registry directory (local or on relay) |
| `INSTANCE_NAME` | `$(hostname)-$(basename $PWD)` | Instance name for registration |

## Registration File Format

Each file in `RELAY_REGISTRY_DIR` is a JSON file named `{instance-name}.json`:

```json
{
  "name": "laptop-myproject",
  "hostname": "laptop",
  "port": 10042,
  "localPort": 4823,
  "cwd": "/home/user/projects/myproject",
  "connectedAt": "2026-03-14T10:30:00Z"
}
```

Files are written by `opencode-connected` (locally or on the relay via SSH).
The MCP server prunes files whose ports fail health checks.

## Connecting an OpenCode Instance

Use `opencode-connected` instead of bare `opencode` to start the TUI with
an HTTP side-car:

```bash
# Install (symlink)
ln -s ~/prg/opencode-mcp/scripts/opencode-connected ~/bin/opencode-connected

# Local only (no tunnel, writes registration to /tmp/opencode-relay/)
opencode-connected

# With relay (set RELAY_SSH_CMD in your shell profile)
export RELAY_SSH_CMD="gcloud compute ssh mcp-gateway --zone=us-central1-a --project=my-project --"
opencode-connected

# Or with direct SSH
export RELAY_SSH_CMD="ssh user@relay.example.com"
opencode-connected

# Pass extra args to opencode (after --)
opencode-connected -- -d
```

The script:
1. Picks a random available local port (4096-5095)
2. Starts opencode TUI with `--port` (enables HTTP side-car on `127.0.0.1`)
3. If `RELAY_SSH_CMD` is set: establishes SSH reverse tunnel with auto-retry
4. Registers the instance (lazily creates the registry directory)
5. Cleans up the registration file on exit

Note: `opencode` without `--port` does **not** start an HTTP server.
The `--port` flag is what enables the HTTP side-car alongside the TUI.

**Multiple instances in the same directory:** The instance name defaults to
`$(hostname)-$(basename $PWD)`. If you run multiple opencode instances in
the same directory, they'll compete for the same registration file — the
last one wins and the others become invisible to the MCP server. To avoid
this, set `INSTANCE_NAME` explicitly:

```bash
INSTANCE_NAME=my-tests opencode-connected
INSTANCE_NAME=my-refactor opencode-connected
```

For work machines with different MCP configs, set `OPENCODE_CONFIG` in your
shell profile — the script does not handle config selection.

## Integration with mcp-gateway (Docker)

To add opencode-mcp to an existing mcp-gateway Docker deployment:

### 1. Install from npm

```bash
npx -y opencode-mcp  # or add to gateway's SERVERS dict
```

### 2. Docker configuration

```yaml
# docker run additions:
--network=host                    # reach SSH tunnel ports on host's localhost
-v /tmp/opencode-relay:/tmp/opencode-relay:ro  # read registration files
-e RELAY_REGISTRY_DIR=/tmp/opencode-relay
```

`--network=host` is required because SSH reverse tunnels bind on the
**host's** `localhost`. The container needs to reach those ports directly.

### 3. MCP server config in mcp-gateway

Add to the gateway's server configuration:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "opencode-mcp"],
      "transport": "stdio",
      "env": {
        "RELAY_REGISTRY_DIR": "/tmp/opencode-relay"
      }
    }
  }
}
```

### 4. Verify

```bash
# On a client machine:
export RELAY_SSH_CMD="gcloud compute ssh mcp-gateway --zone=us-central1-a --project=my-project --"
opencode-connected

# From the chat interface, the LLM can now call:
# instances → sees the connected instance
# send → interacts with it
# read → sees what's been happening
```

## Project Structure

```
opencode-mcp/
├── src/
│   ├── index.ts                 # MCP server entry + transport factory
│   ├── types.ts                 # RegistrationFile, OpenCodeInstance
│   ├── registry.ts              # Instance cache + OpenCode SDK client mgmt
│   ├── transport/
│   │   ├── interface.ts         # Abstract Transport interface
│   │   └── local-relay.ts       # File-based registry + localhost health checks
│   └── tools/
│       └── simplified.ts       # instances, send, read
├── scripts/
│   └── opencode-connected       # Client: random port + tunnel + exec opencode TUI
├── plans/
│   └── architecture.md          # Design doc + future work
├── package.json
├── tsconfig.json
└── .env.example
```

## Development

```bash
npm install
npm run dev          # run with tsx (no build step)
npm run build        # compile TypeScript
npm start            # run compiled output
```

## Security

- **SSH tunnels**: the auth boundary — standard SSH key or gcloud auth
- **Tunnel ports**: bound to host's localhost only, not externally accessible
- **OpenCode binding**: `127.0.0.1` by default — not network-accessible
- **MCP transport**: stdio (no network exposure); OAuth via mcp-gateway
- **Registration files**: contain only name, hostname, port, cwd — no credentials
