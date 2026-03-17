# Streaming Test Results — 2026-03-17

## Setup

- OpenCode instance running on `localhost:4290` (started via `opencode-connected`)
- Registration file at `/tmp/opencode-relay/danenberg2-bin.json`
- MCP server running locally via `node dist/index.js`
- Testing via JSON-RPC over stdio

## Test 1: `instances` tool

```
→ {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"instances","arguments":{}}}

← {"result":{"content":[{"type":"text","text":"**danenberg2-bin** (danenberg2:/home/danenberg/bin)\n  online | idle — \"Removing exposed API keys from git history\" | v1.2.26"}]}}
```

Shows instance with busy/idle status and most recent session title.

## Test 2: `send` tool — short response

```
→ send(instance="danenberg2", message="What is 2+2? Reply with just the number.")

← progress: {"message": "4"}           ← streaming delta (arrives BEFORE tool result)
← result:   {"text": "4"}              ← complete response
```

Single delta, single progress notification, then final result.

## Test 3: `send` tool — longer streaming response

```
→ send(instance="danenberg2", message="Write a short poem about SSH tunnels (4 lines). Just the poem, nothing else.")

← progress: "Through"
← progress: " encrypted"
← progress: " pipes"
← progress: " the"
← progress: " packets"
← progress: " flow,\nA"
← progress: " secret"
← progress: " path"
← progress: " that"
← progress: " only we two"
← progress: " know,"
← progress: "\nPort"
← progress: " to"
← progress: " port, a bridge"
← progress: " across"
← progress: " the wire"
← progress: ",\nSSH"
← progress: " tunnels carry"
← progress: " data"
← progress: " through"
← progress: " the fire"
← progress: "."
← result: "Through encrypted pipes the packets flow,\nA secret path that only we two know,\nPort to port, a bridge across the wire,\nSSH tunnels carry data through the fire."
```

22 progress notifications streaming token-by-token, then the complete
accumulated response as the final tool result.

## How it works

```
JSON-RPC stdin → MCP server receives tools/call
  → POST /tui/append-prompt (stages message in TUI)
  → POST /tui/submit-prompt (fires to focused session)
  → GET /event (SSE stream subscription)
  → For each message.part.delta event:
      → notifications/progress on stdout (streaming delta to MCP client)
      → accumulate into fullResponse
  → On session.idle event:
      → return fullResponse as tool result on stdout
```

The progress notifications use the MCP protocol's `notifications/progress`
method with the client-provided `progressToken`. The `message` field carries
the text delta. The `progress` field is the accumulated byte count (not
particularly meaningful but required by the protocol).

## Key observations

1. **Streaming works over stdio.** Progress notifications are newline-delimited
   JSON-RPC messages on stdout, interleaved with the tool's execution. The MCP
   client receives them as they arrive.

2. **TUI endpoints work.** `POST /tui/append-prompt` + `POST /tui/submit-prompt`
   successfully stages and fires a prompt to the focused TUI session. The TUI
   updates in real-time on the laptop.

3. **SSE event stream is reliable.** `GET /event` on the opencode instance
   provides `message.part.delta` events with `field`, `delta`, `sessionID`,
   `messageID`, and `partID`. The `session.idle` event signals completion.

4. **Session ID discovery works.** The first `message.part.delta` event after
   submission tells us which session the TUI submitted to (via `sessionID` in
   the event properties). No need to know the session ID in advance.

5. **The TUI submit body format is plain JSON.** `{"text": "..."}` for
   append-prompt, `{}` for submit-prompt. NOT the event-wrapper format
   (`{"type": "tui.prompt.append", "properties": {...}}`).

## TUI endpoint body formats (discovered during testing)

```bash
# Append prompt text (stages in TUI input)
curl -X POST http://localhost:4290/tui/append-prompt \
  -H "Content-Type: application/json" \
  -d '{"text": "your message here"}'
# Returns: true

# Submit the staged prompt
curl -X POST http://localhost:4290/tui/submit-prompt \
  -H "Content-Type: application/json" \
  -d '{}'
# Returns: true
```

## SSE event lifecycle (observed)

Full event sequence for a simple "Say hello" prompt:

1. `tui.prompt.append` — text staged
2. `tui.command.execute` — prompt.submit fired
3. `message.updated` — user message created (role: user)
4. `message.part.updated` — user message text part
5. `session.updated` — session timestamp updated
6. `session.status` — busy
7. `message.updated` — assistant message created (role: assistant)
8. `message.part.updated` — step-start
9. `message.part.updated` — text part created (empty)
10. `message.part.delta` — "Hello" (this is what we stream)
11. `message.part.delta` — "!" (this is what we stream)
12. `message.part.updated` — text part complete ("Hello!")
13. `message.part.updated` — step-finish (with cost/token info)
14. `message.updated` — assistant message complete
15. `session.status` — idle
16. `session.idle` — we stop listening here
