# Session-Based Simplified Tools (replaces TUI-based approach)

## Context

After testing, we discovered that the session API (`POST /session/:id/prompt_async`)
updates the TUI in real-time — the TUI is just another client of the server. This
means we don't need the TUI endpoints (`/tui/append-prompt` + `/tui/submit-prompt`)
for `send`. The session API is cleaner and gives us the session ID upfront, which
enables a `read` tool.

## Design: Three tools (no session IDs exposed to the LLM)

### `instances` — what's connected? (unchanged)

- **Args**: none
- **Behavior**: refresh + list + busy/idle status per instance
- **Returns**: instance names, status, recent session title

### `send` — talk to opencode (changed: session-based, not TUI-based)

- **Args**: `message` (required), `instance` (required), `abort` (optional bool)
- **Normal behavior**:
  1. `GET /session` → sort by `time.updated` desc → take first → get session ID
  2. Check `/session/status` — if session is busy, report it
  3. `POST /session/:id/prompt_async {parts: [{type: "text", text: message}]}`
  4. `GET /event` (SSE stream) — filter `message.part.delta` by known session ID
  5. Forward deltas as `notifications/progress` to MCP client
  6. On `session.idle` for our session → return complete response
- **Abort behavior**: same as before — find busy session, `POST /session/:id/abort`
- **Session ID is hidden** — the LLM never sees it. The tool resolves it internally
  using the most-recently-updated heuristic.
- **Self-correcting**: after one `send`, the target session becomes the most recently
  updated, so subsequent `send` and `read` calls target the same session.

### `read` — what's been happening? (new)

- **Args**: `instance` (required), `message_limit` (optional, default 10)
- **Behavior**:
  1. `GET /session` → sort by `time.updated` desc → take first → get session ID
  2. `GET /session/:id/message?limit=N` → last N messages
  3. Format as readable conversation (role, timestamp, text content)
  4. Return formatted conversation
- **No mutation**: doesn't send anything to opencode, doesn't cost an API call,
  doesn't add a turn to the conversation.
- **Session ID is hidden** — same resolution as `send`.

## Why session-based instead of TUI-based

| | TUI-based (old) | Session-based (new) |
|---|---|---|
| Submit mechanism | `/tui/append-prompt` + `/tui/submit-prompt` | `/session/:id/prompt_async` |
| Session targeting | Whatever's focused in TUI | Most-recently-updated |
| Session ID known upfront | No (discovered from SSE) | Yes |
| `read` tool possible | No (can't identify the session) | Yes |
| TUI updates in real-time | Yes (it's the TUI) | Yes (confirmed: TUI updates even via session API) |
| Streaming | SSE → progress notifications | Same, but filtered by known session ID |
| Failure mode | None (always correct) | Wrong session if you selected one without typing |
| Self-correcting | N/A | Yes (after first `send`, heuristic is correct) |

## What the LLM sees

```
instances()                              → "danenberg2-bin: online, idle"
send(instance="danenberg2", message="..")→ streams response back
read(instance="danenberg2")              → last few conversation turns
```

No session IDs. No session management. Three tools, two args max.

## Gateway integration

```python
"opencode": {
    "command": "npx",
    "args": ["-y", "@klutometis/opencode-mcp"],
    "transport": "stdio",
    "env_keys": ["RELAY_REGISTRY_DIR"],
    "tools": {
        "instances": ToolTransformConfig(...),
        "send": ToolTransformConfig(...),
        "read": ToolTransformConfig(...),
    },
},
```

## Changes to implement

1. **`src/tools/simplified.ts`**:
   - Add helper: `findMostRecentSession(baseUrl)` → returns session ID + title
   - Change `send`: replace TUI endpoints with `POST /session/:id/prompt_async`,
     filter SSE by known session ID
   - Add `read`: `GET /session/:id/message?limit=N`, format as conversation

2. **`src/mcp_gateway/gateway.py`**: add `read` to the exposed tools

3. **Bump version, publish**
