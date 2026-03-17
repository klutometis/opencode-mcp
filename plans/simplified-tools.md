# Simplified Tools Plan

## Context

The original 8 MCP tools (list_instances, refresh_instances, list_sessions,
get_session, create_session, send_message, get_status, abort_session) are
"power tools" — session-based, explicit, useful for targeted operations.

For the primary use case ("I'm out and about, want to talk to my opencode"),
they're too much ceremony. The user doesn't care about sessions — they just
want to talk to whatever's on screen.

## Design: Two tools

### `instances` — what's connected?

- **Args**: none
- **Behavior**: refresh + list all connected instances + check `/session/status`
  per instance to report busy/idle state
- **Returns**: instance names, hostnames, CWDs, versions, online status,
  and current activity state (busy/idle). If busy, includes which session
  is actively processing.
- **Use case**: "I just opened the chat app, what's going on?" — one call
  gives you the full picture without needing to drill into sessions.

### `send` — talk to opencode

- **Args**: `message` (required), `instance` (required), `abort` (optional bool)
- **Normal behavior** (`abort` unset or false):
  1. Check `/session/status` — if a session is already busy, return a
     message saying the instance is busy (let the user/LLM decide whether
     to wait or abort)
  2. `POST /tui/append-prompt {text: message}` — stages the message
  3. `POST /tui/submit-prompt` — fires it to the TUI's focused session
  4. `GET /event` (SSE stream) — subscribe to opencode events
  5. For each SSE event:
     - If `message.part.delta` with `field === "text"`:
       → send `notifications/progress` to MCP client with the delta text
       → accumulate delta into fullResponse
     - If `session.idle`:
       → close SSE connection
       → return complete accumulated response as tool result
  6. On timeout (configurable, default 300s):
     → close SSE connection
     → return what we have + "(still processing)"
- **Abort behavior** (`abort: true`):
  1. Check `/session/status` — find the busy session
  2. `POST /session/:id/abort` on the busy session
  3. Return confirmation that the session was aborted
- **Streaming**: deltas stream back to the MCP client in real-time via
  `notifications/progress`. The MCP SDK supports this over stdio — tool
  handlers can call `extra.sendNotification()` while still executing.
- **TUI targeting**: uses `/tui/append-prompt` + `/tui/submit-prompt`,
  which always targets whatever session is focused in the TUI. This is
  correct by definition — no session ID needed, no heuristic.
- **TUI sync**: when messages arrive via the API, the TUI updates in
  real-time (the TUI is just another client of the server). So the laptop
  shows the conversation as it happens, even though the message was sent
  from the phone.
- **Session ID discovery**: we don't need to know the session ID in advance.
  After submitting via TUI, the first `message.part.delta` SSE event tells
  us which session it went to (events include `sessionID`).

## Why TUI endpoints instead of session API

The most-recently-updated session heuristic was wrong in our only test case:
the user was looking at "Image paste over SSH+tmux troubleshooting" but the
most recently updated session was "Removing exposed API keys from git history"
(because the user had selected a session without mutating it yet).

The TUI submit path is correct by definition — it targets whatever the user
is looking at in the terminal. The only downside is we can't read which
session it is before submitting, but we don't need to — the SSE events tell
us after submission.

## Why this works over stdio

MCP over stdio is newline-delimited JSON-RPC messages on stdin/stdout. It's
a continuous bidirectional stream, not request/response. The server can send
`notifications/progress` messages on stdout at any time while a tool is still
executing. The client reads them as they arrive.

The MCP SDK's tool handler receives an `extra` parameter with
`sendNotification()` method. The progress example in the SDK demonstrates
exactly this pattern.

The opencode web UI at localhost:4290 already streams responses in real-time
via SSE (`message.part.delta` events). Our MCP tool subscribes to that SSE
stream and forwards each delta as an MCP progress notification. It's a bridge
between two streaming protocols.

## Architecture

```
Phone (chat UI)
  ↕ SSE (streaming LLM response)
llm-multiplex (Next.js)
  ↕ MCP over stdio (progress notifications stream back)
mcp-gateway (fastmcp)
  ↕ MCP over stdio (progress notifications stream back)
opencode-mcp (our server)
  ↕ SSE (message.part.delta events)
opencode instance (on your laptop)
```

Every link in this chain streams. The MCP progress notifications carry the
opencode deltas from the bottom of the chain to the top.

## Open question: llm-multiplex rendering

For the user to see streaming opencode responses in the chat UI, llm-multiplex
needs to render MCP progress notifications. This may require changes to the
chat frontend. Since we control llm-multiplex, we can implement this.

If llm-multiplex doesn't render progress notifications yet, the user still
gets the complete response when the tool finishes — they just don't see it
building up in real-time. The streaming still happens (prevents timeouts),
it's just not visible until we add the rendering.

## Gateway integration

The gateway (`gateway.py`) exposes only the simplified tools. The 8 power
tools remain in the MCP server but are hidden by the gateway's tool transform.

```python
"opencode": {
    "command": "npx",
    "args": ["-y", "@klutometis/opencode-mcp"],
    "transport": "stdio",
    "env_keys": ["RELAY_REGISTRY_DIR"],
    "tools": {
        "instances": ToolTransformConfig(...),
        "send": ToolTransformConfig(...),
    },
},
```

Anyone using `@klutometis/opencode-mcp` directly (not through the gateway)
gets all 10 tools (8 power + 2 simplified).

## Implementation order

1. `src/tools/simplified.ts` — `instances` + `send`
2. Wire into `src/index.ts`
3. Test via MCP inspector — verify `send` streams deltas back
4. Update `gateway.py` — expose only simplified tools
5. Bump version, commit, push, release → npm publish
6. Test end-to-end: gateway → opencode-mcp → opencode instance
7. (Separate session) llm-multiplex: render MCP progress notifications

## Files to change

| Repo | File | Change |
|------|------|--------|
| `opencode-mcp` | `src/tools/simplified.ts` (new) | `instances` + `send` |
| `opencode-mcp` | `src/index.ts` | Register simplified tools |
| `opencode-mcp` | `package.json` | Bump version |
| `mcp-gateway` | `gateway.py` | Expose only simplified tools |
| `llm-multiplex` | TBD | Render MCP progress notifications |
