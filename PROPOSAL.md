# AGENTS.md — opencode-mcp

## What This Is

A complete build spec for two tightly integrated systems:

1. **`opencode-mcp`** — A TypeScript MCP server that lets a chat interface (Claude, custom front end) discover, monitor, and drive multiple OpenCode instances running across personal machines. Discovery and routing use Tailscale exclusively — no external registry, no dynamic DNS, no additional infrastructure.

2. **Corp remote execution layer** — SSH ControlMaster configuration and wrapper scripts that allow OpenCode on a personal laptop to transparently run corp build commands (`blaze`, etc.) on a corp machine, while editing source files via a local SrcFS mount. Corp machines are **not** on Tailscale and never will be.

These two systems are independent but live together in the same workflow. The MCP server handles personal machine orchestration. The SSH layer handles corp execution. Both run from the personal laptop.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Chat Interface                            │
│              (Claude / custom front end)                     │
└───────────────────────────┬─────────────────────────────────┘
                            │ MCP protocol (stdio)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  opencode-mcp server                         │
│              (runs on personal laptop)                       │
│                                                              │
│   Tailscale API client ──▶ device discovery + metadata       │
│   OpenCode SDK clients  ──▶ one per discovered instance      │
└──────┬──────────────────────────────────────────────────────┘
       │ Tailscale WireGuard (100.x.x.x)
       ├──▶ personal-laptop:4096   (this machine)
       ├──▶ personal-laptop:4097   (second instance)
       └──▶ home-desktop:4096      (another personal machine)

┌─────────────────────────────────────────────────────────────┐
│                   Personal Laptop                            │
│                                                              │
│  OpenCode ──▶ edits files via SrcFS mount                   │
│           ──▶ runs ~/bin/blaze                               │
│                         │                                    │
│               SSH ControlMaster socket                       │
│               ~/.ssh/cm-corp  (alive 8h)                     │
└─────────────────────────┬───────────────────────────────────┘
                          │ SSH (authenticated once,
                          │     security key touch)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│               Corp Machine (NOT on Tailscale)                │
│                                                              │
│   blaze, build tools, corp-only binaries                     │
│   SrcFS source tree (same files, remote side)                │
└─────────────────────────────────────────────────────────────┘
```

---

## Part 1: SSH ControlMaster + Corp Execution Layer

This part requires no code — only configuration and shell scripts on the personal laptop.

### 1.1 SSH Config

```
# ~/.ssh/config

Host corp
  HostName           your-corp-machine.internal
  User               your-corp-username
  ControlMaster      auto
  ControlPath        ~/.ssh/cm-corp
  ControlPersist     8h
  ServerAliveInterval 60
  ServerAliveCountMax 5
```

**What each directive does:**

- `ControlMaster auto` — On first connect: create a master connection and write the socket. On subsequent connects: attach to the existing socket if present, create new master if not.
- `ControlPath ~/.ssh/cm-corp` — Where the socket file lives on disk. Its existence = master is running.
- `ControlPersist 8h` — When you close the terminal that started the master, SSH daemonizes it. The socket stays alive for 8 hours of inactivity.
- `ServerAliveInterval 60` / `ServerAliveCountMax 5` — Send a keepalive packet every 60 seconds. After 5 missed responses (~5 minutes), give up and close. This prevents the corp SSH server from dropping idle connections.

**Daily use:**
```bash
# Once in the morning — tap security key here
ssh corp

# Verify master is alive (no key prompt)
ssh -O check corp     # → "Master running"

# Close the terminal. Socket persists.
# All subsequent commands through the day: no key prompt.

# Explicit teardown if needed
ssh -O exit corp
```

### 1.2 Environment Variables for Path Translation

SrcFS mounts the source tree locally. The wrapper scripts need to translate the current working directory to its equivalent on the corp machine before `cd`-ing there. Set these in `~/.zshrc` or `~/.bashrc`:

```bash
# Local SrcFS mount root (where the corp source tree appears on your laptop)
export SRCFS_LOCAL_ROOT="/path/to/local/srcfs/mount"

# Equivalent path on the corp machine
export SRCFS_REMOTE_ROOT="/path/to/source/on/corp"

# SSH Host alias (matches ~/.ssh/config)
export CORP_SSH_HOST="corp"
```

If your SrcFS setup mounts at the same absolute path on both sides (common with CitC), set both to the same value.

### 1.3 Pre-flight Check Function

Add this to `~/.zshrc` or `~/.bashrc`. The wrapper scripts call it:

```bash
check_corp_ssh() {
  if ! ssh -O check "${CORP_SSH_HOST:-corp}" 2>/dev/null; then
    echo "╔══════════════════════════════════════════════════╗" >&2
    echo "║  SSH master connection to corp is not active.   ║" >&2
    echo "║  Run:  ssh corp                                  ║" >&2
    echo "║  Then tap your security key once.                ║" >&2
    echo "╚══════════════════════════════════════════════════╝" >&2
    return 1
  fi
}
```

### 1.4 Wrapper Scripts

Create `~/bin/` if it doesn't exist. Make sure `~/bin` is first in `$PATH` in your shell config:

```bash
export PATH="$HOME/bin:$PATH"
```

**`~/bin/blaze`:**
```bash
#!/usr/bin/env bash
set -euo pipefail

# Ensure SSH master is up
source ~/.zshrc 2>/dev/null || true
if ! ssh -O check "${CORP_SSH_HOST:-corp}" 2>/dev/null; then
  echo "ERROR: SSH master to corp not active. Run: ssh corp" >&2
  exit 1
fi

# Translate current directory to remote equivalent
LOCAL_ROOT="${SRCFS_LOCAL_ROOT:?SRCFS_LOCAL_ROOT not set}"
REMOTE_ROOT="${SRCFS_REMOTE_ROOT:?SRCFS_REMOTE_ROOT not set}"
REMOTE_CWD="${PWD/#$LOCAL_ROOT/$REMOTE_ROOT}"

if [[ "$REMOTE_CWD" == "$PWD" && "$PWD" != "$REMOTE_ROOT"* ]]; then
  echo "ERROR: Current directory is not under SRCFS_LOCAL_ROOT" >&2
  echo "  PWD:        $PWD" >&2
  echo "  LOCAL_ROOT: $LOCAL_ROOT" >&2
  exit 1
fi

exec ssh "${CORP_SSH_HOST:-corp}" "cd '${REMOTE_CWD}' && blaze $*"
```

```bash
chmod +x ~/bin/blaze
```

Add the same pattern for any other corp-only commands (`~/bin/bazel`, `~/bin/g4`, etc.) — the body is identical, just change the final `blaze` to the appropriate command name.

### 1.5 Long-Running Builds via tmux

For builds that outlast a single command invocation:

```bash
# Create a persistent build session (once)
ssh corp "tmux new-session -d -s build"

# Fire a build and return immediately
ssh corp "tmux send-keys -t build 'blaze build //my/target/...' Enter"

# Poll for output
ssh corp "tmux capture-pane -t build -p"

# Attach interactively if needed
ssh corp -t "tmux attach -t build"
```

Create `~/bin/blaze-bg` for background builds:
```bash
#!/usr/bin/env bash
set -euo pipefail

if ! ssh -O check "${CORP_SSH_HOST:-corp}" 2>/dev/null; then
  echo "ERROR: SSH master to corp not active. Run: ssh corp" >&2
  exit 1
fi

LOCAL_ROOT="${SRCFS_LOCAL_ROOT:?SRCFS_LOCAL_ROOT not set}"
REMOTE_ROOT="${SRCFS_REMOTE_ROOT:?SRCFS_REMOTE_ROOT not set}"
REMOTE_CWD="${PWD/#$LOCAL_ROOT/$REMOTE_ROOT}"

WINDOW="${BLAZE_TMUX_WINDOW:-build}"
CMD="cd '${REMOTE_CWD}' && blaze $*"

ssh "${CORP_SSH_HOST:-corp}" "tmux send-keys -t '${WINDOW}' '${CMD}' Enter"
echo "Build started in tmux window '${WINDOW}' on corp."
echo "Poll output: ssh corp tmux capture-pane -t ${WINDOW} -p"
```

### 1.6 Workspace AGENTS.md (Corp Build Rules)

Put this in the root of your source tree. OpenCode reads it automatically:

```markdown
## Build Commands

All build and test commands run on the corp machine via SSH ControlMaster.
The `blaze` command in ~/bin is a transparent wrapper — use it exactly as you
would use the real blaze.

### BEFORE running any build or test command:

Check that the SSH master connection is active:

```
ssh -O check corp
```

If the output is "Master running" → proceed.

If not → STOP. Do not attempt to establish the connection.
Tell the user: "SSH master to corp is not active. Please run `ssh corp`
in a terminal and tap your security key, then try again."

### Build commands (use exactly like local):
- `blaze build //path/to/target/...`
- `blaze test //path/to/target/...`
- `blaze run //path/to/target`

### For long-running builds:
Use `blaze-bg` instead of `blaze` to fire-and-forget into a tmux session:
- `blaze-bg build //path/to/target/...`
Then check progress: `ssh corp tmux capture-pane -t build -p`

### File editing:
Edit files directly in the local SrcFS mount. Changes are visible on the
corp machine immediately — no sync step needed.

### Do not:
- Attempt to SSH to corp directly
- Try to install anything on corp
- Use `sudo` on corp
- Run any command that would require a password or key on corp
  (the ControlMaster handles auth transparently)
```

---

## Part 2: opencode-mcp Server

### 2.1 Repository Structure

```
opencode-mcp/
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts              # MCP server entry point + tool registration
│   ├── tailscale.ts          # Tailscale API client + instance discovery
│   ├── registry.ts           # Live instance cache + SDK client management
│   ├── tools/
│   │   ├── instances.ts      # list_instances, refresh_instances
│   │   ├── sessions.ts       # list_sessions, get_session, create_session, delete_session
│   │   ├── messages.ts       # send_message, read_messages, abort_session, get_status
│   │   └── tui.ts            # focus_tui, inject_prompt, show_toast
│   └── types.ts              # shared types
├── scripts/
│   └── opencode-serve.sh     # startup wrapper — use instead of bare opencode serve
└── README.md
```

### 2.2 Tech Stack

- **Runtime:** Node.js 20+ with TypeScript
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **OpenCode SDK:** `@opencode-ai/sdk`
- **HTTP:** native `fetch` (Node 20+ built-in)
- **Dev:** `tsx` for fast iteration without build step

### 2.3 package.json

```json
{
  "name": "opencode-mcp",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@opencode-ai/sdk": "latest",
    "zod": "^3.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0"
  }
}
```

### 2.4 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

### 2.5 Environment Variables

```bash
# .env.example

# Tailscale API key — create at https://login.tailscale.com/admin/settings/keys
# Required scopes: devices:core:read, devices:posture_attributes
TS_API_KEY=tskey-api-xxxxxxxxxxxx

# Use "-" to auto-detect tailnet from the API key (recommended)
TS_TAILNET=-

# Shared password for all opencode instances
# Every opencode serve must be started with OPENCODE_SERVER_PASSWORD set to this value
OPENCODE_SERVER_PASSWORD=your-shared-secret-here

# How often to refresh instance list from Tailscale API (ms)
DISCOVERY_INTERVAL_MS=30000

# Tailscale custom attribute keys (must match what opencode-serve.sh writes)
TS_ATTR_PORT=custom:opencode_port
TS_ATTR_CWD=custom:opencode_cwd
TS_ATTR_NAME=custom:opencode_name

# Optional: only probe devices with this tag for opencode
# If unset, all online devices are probed
# TS_OPENCODE_TAG=tag:opencode
```

### 2.6 src/types.ts

```typescript
export interface TailscaleDevice {
  id: string
  nodeId: string
  hostname: string
  name: string           // FQDN: "hostname.tail12345.ts.net"
  addresses: string[]    // [0] = 100.x.x.x Tailscale IPv4
  connectedToControl: boolean
  lastSeen: string
  tags?: string[]
}

export interface OpenCodeInstance {
  deviceId: string
  nodeId: string
  hostname: string       // short name, e.g. "personal-laptop"
  tailscaleIP: string    // 100.x.x.x
  fqdn: string           // full MagicDNS name
  port: number           // from TS_ATTR_PORT attribute
  cwd: string            // from TS_ATTR_CWD attribute
  instanceName: string   // from TS_ATTR_NAME attribute
  url: string            // http://{tailscaleIP}:{port}
  online: boolean        // connectedToControl AND health check passed
  version?: string       // from /global/health
}
```

### 2.7 src/tailscale.ts

```typescript
import type { TailscaleDevice, OpenCodeInstance } from './types.js'

const TS_BASE = 'https://api.tailscale.com/api/v2'

export class TailscaleClient {
  private headers: Record<string, string>

  constructor(
    private apiKey: string,
    private tailnet: string = '-',
  ) {
    // Tailscale accepts API key as Basic auth username with blank password
    const encoded = Buffer.from(`${apiKey}:`).toString('base64')
    this.headers = { Authorization: `Basic ${encoded}` }
  }

  async listDevices(): Promise<TailscaleDevice[]> {
    const res = await fetch(
      `${TS_BASE}/tailnet/${this.tailnet}/devices?fields=all`,
      { headers: this.headers }
    )
    if (!res.ok) throw new Error(`Tailscale API error: ${res.status} ${await res.text()}`)
    const data = await res.json() as { devices: TailscaleDevice[] }
    return data.devices
  }

  async getDeviceAttributes(nodeId: string): Promise<Record<string, { value: unknown }>> {
    const res = await fetch(
      `${TS_BASE}/device/${nodeId}/attributes`,
      { headers: this.headers }
    )
    if (!res.ok) return {}
    const data = await res.json() as { attributes: Record<string, { value: unknown }> }
    return data.attributes ?? {}
  }

  async setDeviceAttribute(
    nodeId: string,
    key: string,
    value: string,
    ttlSeconds: number = 86400
  ): Promise<void> {
    const expiry = new Date(Date.now() + ttlSeconds * 1000).toISOString()
    const res = await fetch(
      `${TS_BASE}/device/${nodeId}/attributes/${key}`,
      {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, expiry }),
      }
    )
    if (!res.ok) throw new Error(`Failed to set attribute ${key}: ${res.status}`)
  }

  async discoverOpenCodeInstances(): Promise<OpenCodeInstance[]> {
    const attrPort = process.env.TS_ATTR_PORT ?? 'custom:opencode_port'
    const attrCwd  = process.env.TS_ATTR_CWD  ?? 'custom:opencode_cwd'
    const attrName = process.env.TS_ATTR_NAME  ?? 'custom:opencode_name'
    const filterTag = process.env.TS_OPENCODE_TAG

    const devices = await this.listDevices()

    // Only probe online devices; optionally filter by tag
    const candidates = devices.filter(d => {
      if (!d.connectedToControl) return false
      if (filterTag && !d.tags?.includes(filterTag)) return false
      return true
    })

    // Fetch attributes + probe health in parallel
    const results = await Promise.allSettled(
      candidates.map(async (device): Promise<OpenCodeInstance | null> => {
        const attrs = await this.getDeviceAttributes(device.nodeId)
        const portAttr = attrs[attrPort]
        if (!portAttr) return null  // not an opencode machine

        const port = Number(portAttr.value)
        const cwd  = String(attrs[attrCwd]?.value  ?? '')
        const instanceName = String(attrs[attrName]?.value ?? device.hostname)
        const tailscaleIP  = device.addresses[0]
        const url = `http://${tailscaleIP}:${port}`

        // Probe health with timeout + one retry
        let version: string | undefined
        let online = false
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 3000)
            const headers: Record<string, string> = {}
            const password = process.env.OPENCODE_SERVER_PASSWORD
            if (password) {
              const encoded = Buffer.from(`opencode:${password}`).toString('base64')
              headers['Authorization'] = `Basic ${encoded}`
            }
            const res = await fetch(`${url}/global/health`, {
              signal: controller.signal,
              headers,
            })
            clearTimeout(timeout)
            if (res.ok) {
              const health = await res.json() as { healthy: boolean; version: string }
              if (health.healthy) {
                version = health.version
                online = true
                break
              }
            }
          } catch {
            if (attempt === 0) await new Promise(r => setTimeout(r, 2000))
          }
        }

        return {
          deviceId: device.id,
          nodeId: device.nodeId,
          hostname: device.hostname,
          tailscaleIP,
          fqdn: device.name,
          port,
          cwd,
          instanceName,
          url,
          online,
          version,
        }
      })
    )

    return results
      .filter((r): r is PromiseFulfilledResult<OpenCodeInstance | null> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter((v): v is OpenCodeInstance => v !== null)
  }
}
```

### 2.8 src/registry.ts

```typescript
import { createOpencodeClient } from '@opencode-ai/sdk'
import type { TailscaleClient } from './tailscale.js'
import type { OpenCodeInstance } from './types.js'

type OcClient = ReturnType<typeof createOpencodeClient>

export class InstanceRegistry {
  private instances: Map<string, OpenCodeInstance> = new Map()
  private clients:   Map<string, OcClient>         = new Map()
  private timer?: NodeJS.Timeout

  constructor(private ts: TailscaleClient) {}

  async initialize(): Promise<void> {
    await this.refresh()
    const interval = Number(process.env.DISCOVERY_INTERVAL_MS ?? 30000)
    this.timer = setInterval(() => this.refresh().catch(console.error), interval)
  }

  async refresh(): Promise<void> {
    const discovered = await this.ts.discoverOpenCodeInstances()

    // Add or update
    for (const inst of discovered) {
      this.instances.set(inst.instanceName, inst)
      if (inst.online && !this.clients.has(inst.instanceName)) {
        this.clients.set(inst.instanceName, this.makeClient(inst))
      }
      if (!inst.online) {
        this.clients.delete(inst.instanceName)
      }
    }

    // Remove disappeared instances
    const discoveredNames = new Set(discovered.map(i => i.instanceName))
    for (const name of this.instances.keys()) {
      if (!discoveredNames.has(name)) {
        this.instances.delete(name)
        this.clients.delete(name)
      }
    }
  }

  private makeClient(inst: OpenCodeInstance): OcClient {
    const password = process.env.OPENCODE_SERVER_PASSWORD
    const customFetch = password
      ? (url: RequestInfo | URL, init?: RequestInit) => {
          const encoded = Buffer.from(`opencode:${password}`).toString('base64')
          return fetch(url, {
            ...init,
            headers: {
              ...init?.headers,
              Authorization: `Basic ${encoded}`,
            },
          })
        }
      : undefined

    return createOpencodeClient({
      baseUrl: inst.url,
      ...(customFetch ? { fetch: customFetch } : {}),
    })
  }

  listInstances(): OpenCodeInstance[] {
    return Array.from(this.instances.values())
  }

  // Fuzzy resolve: "work" matches "work-mbp", "personal" matches "personal-laptop"
  resolveInstance(query: string): { instance: OpenCodeInstance; client: OcClient } {
    // Exact match first
    if (this.instances.has(query)) {
      const inst = this.instances.get(query)!
      const client = this.clients.get(query)
      if (!client) throw new Error(`Instance "${query}" is offline`)
      return { instance: inst, client }
    }

    // Fuzzy match
    const matches = Array.from(this.instances.entries()).filter(
      ([name]) => name.toLowerCase().includes(query.toLowerCase())
    )

    if (matches.length === 0) {
      const available = Array.from(this.instances.keys()).join(', ')
      throw new Error(`No instance matching "${query}". Available: ${available}`)
    }
    if (matches.length > 1) {
      const names = matches.map(([n]) => n).join(', ')
      throw new Error(`Ambiguous instance "${query}" — matches: ${names}`)
    }

    const [name, inst] = matches[0]
    const client = this.clients.get(name)
    if (!client) throw new Error(`Instance "${name}" is offline`)
    return { instance: inst, client }
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
```

### 2.9 MCP Tools — Full Specification

#### `src/tools/instances.ts`

**`list_instances`**
- Input: none
- Implementation: `registry.listInstances()`
- Returns: Markdown table — instance name, hostname, cwd, port, online status, OpenCode version
- Note: uses cached state, does not re-probe on every call

**`refresh_instances`**
- Input: none
- Implementation: `registry.refresh()` then `registry.listInstances()`
- Returns: Updated table same as above

---

#### `src/tools/sessions.ts`

**`list_sessions`**
- Input: `{ instance: string }`
- Implementation: `client.session.list()` combined with `GET /session/status`
- Returns: Table — session ID (truncated), title, message count, status (running/idle), created timestamp

**`get_session`**
- Input: `{ instance: string, session_id: string, message_limit?: number }` — default 20
- Implementation: `client.session.get()` + `client.session.messages()` with limit
- Returns: Session metadata block + last N messages formatted as a readable conversation (not raw JSON)

**`create_session`**
- Input: `{ instance: string, title?: string }`
- Implementation: `client.session.create({ body: { title } })`
- Returns: New session ID and title

**`delete_session`**
- Input: `{ instance: string, session_id: string }`
- Implementation: `client.session.delete({ path: { id: session_id } })`
- Returns: Confirmation with session title

---

#### `src/tools/messages.ts`

**`send_message`**
- Input: `{ instance: string, session_id: string, message: string, async?: boolean }` — default `async: false`
- Implementation:
  - `async: false` → `client.session.prompt(...)` — waits for full response, returns assistant text
  - `async: true` → `POST /session/:id/prompt_async` — returns `204` immediately, returns session ID and a note to poll with `get_session`
- Note: sync mode can take minutes for complex tasks. Suggest `async: true` for anything involving builds or multi-file edits.

**`get_session_status`**
- Input: `{ instance: string }`
- Implementation: `GET /session/status`
- Returns: For each session: ID, title, status (running/idle/error)

**`abort_session`**
- Input: `{ instance: string, session_id: string }`
- Implementation: `client.session.abort({ path: { id: session_id } })`
- Returns: Confirmation

---

#### `src/tools/tui.ts`

**`focus_tui`**
- Input: `{ instance: string }`
- Implementation: `POST /tui/open-sessions`
- Returns: Confirmation, or graceful error if no TUI is running on that instance
- Error handling: catch 404/timeout and return "No active TUI session on this instance. Use `opencode` (not `opencode serve`) to start with TUI."

**`inject_prompt`**
- Input: `{ instance: string, text: string, submit?: boolean }` — default `submit: false`
- Implementation: `POST /tui/append-prompt` then optionally `POST /tui/submit-prompt`
- Use case: Stage a prompt for the user to review before they submit it
- Returns: Confirmation

**`show_toast`**
- Input: `{ instance: string, message: string, title?: string, variant?: "success" | "error" | "warning" }`
- Implementation: `POST /tui/show-toast`
- Use case: Alert the user at a specific machine that something needs attention
- Returns: Confirmation

---

### 2.10 src/index.ts

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { TailscaleClient } from './tailscale.js'
import { InstanceRegistry } from './registry.js'
import { registerInstanceTools } from './tools/instances.js'
import { registerSessionTools }  from './tools/sessions.js'
import { registerMessageTools }  from './tools/messages.js'
import { registerTuiTools }      from './tools/tui.js'

async function main() {
  const ts = new TailscaleClient(
    process.env.TS_API_KEY ?? '',
    process.env.TS_TAILNET ?? '-'
  )

  const registry = new InstanceRegistry(ts)
  await registry.initialize()

  const server = new McpServer({
    name: 'opencode-mcp',
    version: '1.0.0',
  })

  // Register all tools, passing registry as dependency
  registerInstanceTools(server, registry)
  registerSessionTools(server, registry)
  registerMessageTools(server, registry)
  registerTuiTools(server, registry)

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Graceful shutdown
  process.on('SIGINT',  () => { registry.shutdown(); process.exit(0) })
  process.on('SIGTERM', () => { registry.shutdown(); process.exit(0) })
}

main().catch(console.error)
```

Each `register*Tools` function takes `(server: McpServer, registry: InstanceRegistry)` and calls `server.tool(name, description, schema, handler)` for each tool in that group.

### 2.11 scripts/opencode-serve.sh

Run this instead of bare `opencode serve`. It starts the OpenCode server and registers the instance in Tailscale posture attributes so the MCP server can discover it.

```bash
#!/usr/bin/env bash
set -euo pipefail

# ── Config ─────────────────────────────────────────────────────
PORT="${OPENCODE_PORT:-4096}"
INSTANCE_NAME="${OPENCODE_INSTANCE_NAME:-$(hostname)}"
TS_API_KEY="${TS_API_KEY:?TS_API_KEY must be set}"
OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:?OPENCODE_SERVER_PASSWORD must be set}"

# ── Get this device's Tailscale node ID ────────────────────────
DEVICE_NODE_ID=$(tailscale status --json | python3 -c "import sys,json; print(json.load(sys.stdin)['Self']['ID'])")

# ── Write posture attributes ───────────────────────────────────
# Expiry 24h. Re-running this script refreshes it automatically.
write_attr() {
  local key="$1"
  local value="$2"
  local expiry
  expiry=$(date -u -v+24H '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
    || date -u -d '+24 hours' '+%Y-%m-%dT%H:%M:%SZ')

  curl -sf -X POST \
    "https://api.tailscale.com/api/v2/device/${DEVICE_NODE_ID}/attributes/${key}" \
    -u "${TS_API_KEY}:" \
    -H "Content-Type: application/json" \
    -d "{\"value\": \"${value}\", \"expiry\": \"${expiry}\"}" \
    > /dev/null

  echo "  ✓ ${key} = ${value}"
}

echo "Registering in Tailscale..."
write_attr "custom:opencode_port" "$PORT"
write_attr "custom:opencode_cwd"  "$PWD"
write_attr "custom:opencode_name" "$INSTANCE_NAME"

echo "Starting opencode serve on 0.0.0.0:${PORT}..."
echo "Instance: ${INSTANCE_NAME}"
echo "CWD:      ${PWD}"
echo ""

# ── Start opencode ─────────────────────────────────────────────
# IMPORTANT: --hostname 0.0.0.0 is required.
# The default 127.0.0.1 only accepts localhost connections.
# Tailscale traffic arrives on the 100.x.x.x interface.
# Binding to 0.0.0.0 makes OpenCode reachable from any interface.
export OPENCODE_SERVER_PASSWORD
exec opencode serve \
  --port "$PORT" \
  --hostname "0.0.0.0"
```

```bash
chmod +x scripts/opencode-serve.sh
```

### 2.12 MCP Client Configuration

Add to Claude Desktop `claude_desktop_config.json`, or equivalent config in your custom front end:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "node",
      "args": ["/path/to/opencode-mcp/dist/index.js"],
      "env": {
        "TS_API_KEY": "tskey-api-xxxx",
        "TS_TAILNET": "-",
        "OPENCODE_SERVER_PASSWORD": "your-shared-secret"
      }
    }
  }
}
```

---

## Security Model

| Concern | How it's handled |
|---|---|
| Corp machine exposure | Never on Tailscale. Accessed only via SSH, behind hardware key. |
| OpenCode port exposure | Bound to `0.0.0.0` but only reachable via Tailscale WireGuard tunnel. Not port-forwarded, not publicly routable. |
| OpenCode auth | `OPENCODE_SERVER_PASSWORD` required on all instances. MCP server injects as HTTP Basic on every request. |
| Tailscale API key | Read-only scopes (`devices:core:read`, `devices:posture_attributes`). No ACL write access. Stored in `.env`, never committed. |
| Posture attributes | Only store: port number, working directory path, instance name. No credentials, no session content. |
| SSH ControlMaster socket | Lives at `~/.ssh/cm-corp`. Readable only by your user. Touch the security key once; socket persists 8h. |

---

## Implementation Order

Build in this sequence — each step is independently testable before moving on:

1. **SSH setup** — Configure `~/.ssh/config`, create `~/bin/blaze`, verify `ssh -O check corp` works. This is the quickest win and unblocks the rest of your day immediately.

2. **`scripts/opencode-serve.sh`** — Run it locally, verify attributes appear in the Tailscale admin console under the device (`Admin → Machines → your machine → Posture attributes`).

3. **`src/tailscale.ts`** — Implement `TailscaleClient`. Test: can you list devices and read the attributes you just wrote?

4. **`src/registry.ts`** — Implement `InstanceRegistry`. Test: start OpenCode on two ports locally, confirm both are discovered and clients created.

5. **`src/tools/instances.ts`** + minimal `src/index.ts` — Wire up `list_instances` and `refresh_instances`. Test with: `npx @modelcontextprotocol/inspector tsx src/index.ts`

6. **`src/tools/sessions.ts`** — Add session tools. Test against a live local OpenCode instance.

7. **`src/tools/messages.ts`** — Add message tools. Test `send_message` with `async: true` first to avoid timeout issues during development.

8. **`src/tools/tui.ts`** — Add TUI tools. Test `show_toast` first (zero side effects, instant feedback).

9. **Multi-machine test** — Start `opencode-serve.sh` on two different machines. Confirm the MCP server discovers and can interact with both.

10. **Wire into chat interface** — Add to Claude Desktop or custom front end config. Test the full loop: chat → MCP → OpenCode → response.

---

## Known Edge Cases

**Multiple instances on one machine:**
`custom:opencode_port` stores one value. For multiple instances on the same machine, store a JSON array string: `"[4096,4097,4098]"`. The `discoverOpenCodeInstances()` implementation should detect this, parse it, and create one `OpenCodeInstance` per port entry with `instanceName` set to `hostname-4096`, `hostname-4097`, etc.

**SSH master goes down mid-session:**
The blaze wrappers detect this and give a clear error. OpenCode will not attempt to reconnect — it tells the user to tap the key and retry. This is intentional. Never silently retry or mask the error.

**ControlMaster after network change:**
When WiFi switches or VPN reconnects, the underlying TCP connection dies and the socket becomes stale. `ssh -O check corp` will return an error. The pre-flight check in AGENTS.md catches this. User taps key once to re-establish.

**OpenCode not running but Tailscale is:**
The health probe in `discoverOpenCodeInstances()` will time out and mark the instance offline. The registry won't create a client for it. `list_instances` will show it as offline. This is the correct behavior — don't assume OpenCode is running just because the machine is on the tailnet.

**TUI tools on headless instances:**
`POST /tui/*` endpoints return errors on `opencode serve` (headless) instances. Catch these in the tool handlers and return a human-readable message, not a stack trace.
