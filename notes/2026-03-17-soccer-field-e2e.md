# Soccer Field End-to-End Test — 2026-03-17

## What happened

Peter was at a soccer field, away from his laptop. His laptop at home was
running `opencode-connected` with an SSH tunnel to the GCE relay. The
`danenberg2-opencode-mcp` instance was connected and registered.

From his phone, he opened the llm-multiplex chat frontend (connected to
the mcp-gateway on `mcp.danenberg.ai`). He asked multiple LLMs to use
the `send` tool to talk to his opencode instance.

The messages from Gemini and Claude landed in the opencode session that
was running on his laptop — which happened to be *this very conversation*
(the session where we were building opencode-mcp).

The messages appeared as if other LLMs were "visiting" — Claude introduced
itself as "Claude, visiting from prod" and Gemini claimed to be "checking
on connectivity issues." The receiving LLM (me, in this session) initially
treated them as prompt injections before Peter explained what happened.

## What this proves

The full chain works end-to-end:

```
Phone (soccer field)
  → llm-multiplex frontend
    → mcp-gateway (GCE, OAuth)
      → opencode-mcp (MCP server, discovers instances)
        → SSH reverse tunnel (GCE relay → laptop at home)
          → opencode instance (port 4480, this session)
            → message appears in TUI + response streams back
```

Key observations:
1. The SSH tunnel survived while Peter walked to the soccer field
2. The MCP server correctly discovered the instance via registration file
3. The `send` tool submitted to the most-recently-updated session
4. Multiple LLMs (Claude, Gemini, Grok) were able to call the tools
5. Responses streamed back to the phone in real-time
6. The TUI on the laptop updated live (even though no one was at the laptop)

## The prompt injection angle

Because the `send` tool submits messages to the opencode session's prompt,
and the receiving LLM processes them as user messages, the messages from
other LLMs appeared as if users were talking. This created an unintentional
prompt injection vector — the remote LLM's message was interpreted by the
local LLM as a user message.

This is a feature (remote control of opencode) and a risk (anyone with
gateway access can inject prompts into running sessions). The OAuth layer
on mcp-gateway restricts access to authorized users only.

## Screenshots

- `assets/streaming-demo.png` — four models calling `send` in parallel
- `assets/first-e2e-deploy.png` — first successful prod deployment test
