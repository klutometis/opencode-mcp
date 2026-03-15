# opencode-mcp

An MCP server that discovers, monitors, and drives multiple OpenCode instances
running across personal machines. Uses SSH reverse tunnels through a central
relay for discovery and transport. Pluggable transport layer supports future
backends (Tailscale, Cloudflare Tunnels, mDNS).

## Quick Start (local testing)

```bash
# 1. Install
npm install && npm run build

# 2. Create a registration file pointing at a running opencode instance
mkdir -p /tmp/opencode-relay-test
cat > /tmp/opencode-relay-test/local-test.json << 'EOF'
{
  "name": "local-test",
  "hostname": "localhost",
  "port": 4096,
  "localPort": 4096,
  "cwd": "/home/you/your-project",
  "connectedAt": "2026-01-01T00:00:00Z"
}
EOF

# 3. Run with MCP inspector
RELAY_REGISTRY_DIR=/tmp/opencode-relay-test \
  npx @modelcontextprotocol/inspector tsx src/index.ts

# Or run directly (stdio MCP server)
RELAY_REGISTRY_DIR=/tmp/opencode-relay-test node dist/index.js
```

## Architecture

```
┌──────────────────────────────────────────────┐
│        Relay machine (e.g. GCE instance)     │
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

The MCP server runs on the same machine that accepts SSH reverse tunnels.
It reads registration JSON files from a directory, health-checks each
registered port on localhost, and creates OpenCode SDK clients for healthy
instances. All OpenCode API calls go through `localhost:{tunnel_port}`.

## MCP Tools

| Tool | Input | Description |
|------|-------|-------------|
| `list_instances` | — | List all discovered opencode instances |
| `refresh_instances` | — | Re-scan registry, health-check, return updated list |
| `list_sessions` | `instance` | List sessions with ID, title, status |
| `get_session` | `instance`, `session_id`, `message_limit?` | Session details + last N messages |
| `create_session` | `instance`, `title?` | Create a new chat session |
| `send_message` | `instance`, `session_id`, `message`, `async?` | Send a prompt (sync or async) |
| `get_status` | `instance` | Status of all sessions (idle/busy/retry) |
| `abort_session` | `instance`, `session_id` | Abort a running session |

Instance names support fuzzy substring matching (e.g. `"laptop"` matches
`"laptop-myproject"`). Session IDs accept prefixes (e.g. `"ses_3149"`).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_REGISTRY_DIR` | `~/.local/share/opencode-relay` | Directory containing registration JSON files |
| `OPENCODE_SERVER_PASSWORD` | — | HTTP Basic auth password for opencode instances |
| `OPENCODE_SERVER_USERNAME` | `opencode` | HTTP Basic auth username |
| `DISCOVERY_INTERVAL_MS` | `30000` | How often to refresh instance list (ms) |
| `HEALTH_CHECK_TIMEOUT_MS` | `3000` | Timeout for health-checking each instance (ms) |
| `TRANSPORT` | `local-relay` | Transport backend (`local-relay`, future: `tailscale`) |

## Registration File Format

Each file in `RELAY_REGISTRY_DIR` is a JSON file named `{instance-name}.json`:

```json
{
  "name": "laptop-myproject",
  "hostname": "laptop",
  "port": 10042,
  "localPort": 4096,
  "cwd": "/home/user/projects/myproject",
  "pid": 12345,
  "connectedAt": "2026-03-14T10:30:00Z"
}
```

Files are written by `opencode-connected` on the client machine via SSH.
The MCP server prunes files whose ports fail health checks.

## Connecting an OpenCode Instance

Use `opencode-connected` instead of bare `opencode` to start the TUI with
an HTTP side-car and an SSH tunnel to the relay:

```bash
# Install (symlink)
ln -s ~/prg/opencode-mcp/scripts/opencode-connected ~/bin/opencode-connected

# Start opencode with tunnel to relay
RELAY_HOST=my-relay.example.com opencode-connected

# Start without tunnel (local HTTP server only)
opencode-connected

# Pass extra args to opencode (after --)
RELAY_HOST=my-relay.example.com opencode-connected -- -d
```

The script:
1. Picks a random available local port (4096-5095)
2. Starts opencode TUI with `--port` and `--hostname 0.0.0.0` (enables HTTP side-car)
3. Establishes an SSH reverse tunnel to the relay in the background (with auto-retry)
4. Registers the instance on the relay (lazily creates the registry directory)
5. Cleans up the registration file on exit

Note: `opencode` without `--port` does **not** start an HTTP server.
The `--port` flag is what enables the HTTP side-car alongside the TUI.

### Environment variables for `opencode-connected`

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_HOST` | — | Relay hostname (skip tunnel if unset) |
| `RELAY_USER` | `$(whoami)` | SSH user on relay |
| `INSTANCE_NAME` | `$(hostname)-$(basename $PWD)` | Instance name for registration |
| `RELAY_REGISTRY_DIR` | `/var/lib/opencode-relay` | Registry dir on relay |
| `OPENCODE_SERVER_PASSWORD` | — | Password for opencode HTTP auth |

For work machines with different MCP configs, set `OPENCODE_CONFIG` in your
shell profile — the script does not handle config selection.

## Relay Machine Setup

No dedicated setup step needed. The `opencode-connected` script lazily
creates the registry directory on the relay when registering. The relay
machine just needs `sshd` running (default on most Linux boxes) and
Node.js 20+ for the MCP server.

## Integration with mcp-gateway (Docker)

To add opencode-mcp to an existing mcp-gateway Docker deployment:

### 1. Host-side setup

Run `scripts/setup-relay.sh` on the **Docker host** (not inside the container).
SSH tunnels connect to the host's sshd and bind ports on the host's localhost.

### 2. Docker Compose additions

```yaml
services:
  mcp-gateway:
    # ... existing config ...

    # Required: access SSH tunnel ports bound on host's localhost
    network_mode: host

    # Mount the registration directory (read-only is fine for the MCP server)
    volumes:
      - /var/lib/opencode-relay:/var/lib/opencode-relay:ro

    environment:
      # ... existing env vars ...
      RELAY_REGISTRY_DIR: /var/lib/opencode-relay
      OPENCODE_SERVER_PASSWORD: ${OPENCODE_SERVER_PASSWORD}
      # OPENCODE_SERVER_USERNAME: opencode  # only if overridden
```

`network_mode: host` is required because SSH reverse tunnels bind on the
**host's** `localhost`, not the container's. Without it, the MCP server
can't reach `localhost:10001` etc.

If `network_mode: host` is too broad, forward the tunnel port range instead:
```yaml
    ports:
      - "10000-10099:10000-10099"
```

### 3. MCP server config in mcp-gateway

Add to the mcp-gateway's MCP server configuration:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "node",
      "args": ["/path/to/opencode-mcp/dist/index.js"],
      "env": {
        "RELAY_REGISTRY_DIR": "/var/lib/opencode-relay",
        "OPENCODE_SERVER_PASSWORD": "your-shared-secret"
      }
    }
  }
}
```

Or if using tsx for development:
```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["tsx", "/path/to/opencode-mcp/src/index.ts"],
      "env": {
        "RELAY_REGISTRY_DIR": "/var/lib/opencode-relay",
        "OPENCODE_SERVER_PASSWORD": "your-shared-secret"
      }
    }
  }
}
```

### 4. Verify

```bash
# On a client machine, connect an opencode instance:
RELAY_HOST=my-relay.example.com opencode-connected

# From the chat interface, the LLM can now call:
# list_instances → sees the connected instance
# list_sessions → sees its sessions
# send_message → interacts with it
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
│       ├── instances.ts         # list_instances, refresh_instances
│       ├── sessions.ts          # list_sessions, get_session, create_session
│       └── messages.ts          # send_message, get_status, abort_session
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

- **SSH tunnels**: standard SSH key auth to the relay machine
- **Tunnel ports**: bound to localhost only, not externally accessible
- **OpenCode auth**: HTTP Basic auth via `OPENCODE_SERVER_PASSWORD`
- **MCP transport**: stdio (no network exposure); OAuth via mcp-gateway
- **Registration files**: contain only name, hostname, port, cwd — no credentials
