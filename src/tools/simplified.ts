import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InstanceRegistry } from '../registry.js'
import type { OpenCodeInstance } from '../types.js'

/**
 * Subscribe to an opencode instance's SSE event stream.
 * Returns an async iterator of parsed events.
 */
async function* sseEvents(
  baseUrl: string,
  signal: AbortSignal,
): AsyncGenerator<{ type: string; properties: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/event`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  })

  if (!res.ok || !res.body) return

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()
          if (data) {
            try {
              yield JSON.parse(data)
            } catch {
              // Skip malformed events
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Check the busy/idle status of sessions on an instance.
 * Returns a map of sessionID → status type, and the busy session ID if any.
 */
async function getInstanceStatus(
  baseUrl: string,
): Promise<{ statuses: Record<string, string>; busySessionId?: string }> {
  try {
    const res = await fetch(`${baseUrl}/session/status`)
    if (!res.ok) return { statuses: {} }
    const data = (await res.json()) as Record<
      string,
      { type: string }
    >
    const statuses: Record<string, string> = {}
    let busySessionId: string | undefined
    for (const [id, info] of Object.entries(data)) {
      statuses[id] = info.type
      if (info.type !== 'idle' && info.type !== 'completed') {
        busySessionId = id
      }
    }
    return { statuses, busySessionId }
  } catch {
    return { statuses: {} }
  }
}

interface SessionInfo {
  id: string
  title?: string
  time: { created: number; updated: number }
}

/**
 * Find the most recently updated session on an instance.
 * Returns the session ID and title.
 */
async function findMostRecentSession(
  baseUrl: string,
): Promise<SessionInfo | undefined> {
  try {
    const res = await fetch(`${baseUrl}/session`)
    if (!res.ok) return undefined
    const sessions = (await res.json()) as SessionInfo[]
    if (sessions.length === 0) return undefined
    sessions.sort((a, b) => b.time.updated - a.time.updated)
    return sessions[0]
  } catch {
    return undefined
  }
}

function formatInstanceList(
  instances: Array<{
    instance: OpenCodeInstance
    status: string
    recentSession?: string
  }>,
): string {
  if (instances.length === 0) {
    return 'No opencode instances are currently connected.\n\nRun `opencode-connected` on a machine to register one.'
  }

  const lines: string[] = []
  for (const { instance, status, recentSession } of instances) {
    const session = recentSession ? ` — "${recentSession}"` : ''
    lines.push(
      `**${instance.name}** (${instance.hostname}:${instance.cwd})`,
    )
    lines.push(
      `  ${instance.online ? 'online' : 'offline'} | ${status}${session} | v${instance.version ?? 'unknown'}`,
    )
  }
  return lines.join('\n')
}

export function registerSimplifiedTools(
  server: McpServer,
  registry: InstanceRegistry,
): void {
  server.tool(
    'instances',
    'List all connected opencode instances with their current status (busy/idle). Call this to see what machines are available.',
    {},
    async () => {
      try {
        const instances = await registry.refresh()

        const enriched = await Promise.all(
          instances
            .filter((inst) => inst.online)
            .map(async (inst) => {
              const { busySessionId } = await getInstanceStatus(inst.url)
              const session = await findMostRecentSession(inst.url)
              const status = busySessionId ? 'busy' : 'idle'
              return {
                instance: inst,
                status,
                recentSession: session?.title,
              }
            }),
        )

        return {
          content: [
            { type: 'text', text: formatInstanceList(enriched) },
          ],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error: ${(err as Error).message}` },
          ],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'send',
    'Send a message to the most recent opencode session on an instance. Streams the response back in real-time. The TUI on the remote machine updates live. Set abort=true to stop a running task instead of sending a message.',
    {
      message: z
        .string()
        .optional()
        .describe('The message to send (not required when aborting)'),
      instance: z
        .string()
        .describe('Instance name (exact or fuzzy substring match)'),
      abort: z
        .boolean()
        .optional()
        .default(false)
        .describe('Set to true to abort the currently running task'),
    },
    async ({ message, instance: query, abort }, extra) => {
      try {
        const { instance } = registry.resolveInstance(query)
        const baseUrl = instance.url

        // Abort mode
        if (abort) {
          const { busySessionId } = await getInstanceStatus(baseUrl)
          if (!busySessionId) {
            return {
              content: [
                {
                  type: 'text',
                  text: `No active task on ${instance.name} — nothing to abort.`,
                },
              ],
            }
          }
          await fetch(`${baseUrl}/session/${busySessionId}/abort`, {
            method: 'POST',
          })
          return {
            content: [
              {
                type: 'text',
                text: `Aborted active task on ${instance.name}.`,
              },
            ],
          }
        }

        // Send mode — message is required
        if (!message) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: message is required when not aborting.',
              },
            ],
            isError: true,
          }
        }

        // Check if instance is busy
        const { busySessionId } = await getInstanceStatus(baseUrl)
        if (busySessionId) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `${instance.name} is currently busy processing a task. ` +
                  `You can wait for it to finish, or call send with abort=true to stop it.`,
              },
            ],
          }
        }

        // Find the most recently updated session
        const session = await findMostRecentSession(baseUrl)
        if (!session) {
          return {
            content: [
              {
                type: 'text',
                text: `No sessions found on ${instance.name}. Open opencode and start a session first.`,
              },
            ],
            isError: true,
          }
        }

        // TODO: If multiple send calls race past the busy check simultaneously,
        // they'll all subscribe to the same SSE stream filtered by sessionID.
        // Each would see all deltas, not just "their" response. Fix by filtering
        // SSE events by messageID instead of sessionID — after prompt_async,
        // fetch the latest message to get our messageID. Low priority since the
        // typical use case is one user, one model, one send at a time.

        // Submit via session API (TUI updates in real-time)
        await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parts: [{ type: 'text', text: message }],
          }),
        })

        // Subscribe to SSE and stream deltas back
        const timeout = Number(process.env.SEND_TIMEOUT_MS) || 300_000
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)

        let fullResponse = ''

        try {
          for await (const event of sseEvents(
            baseUrl,
            controller.signal,
          )) {
            if (
              event.type === 'message.part.delta' &&
              event.properties.field === 'text' &&
              event.properties.sessionID === session.id
            ) {
              const delta = event.properties.delta as string
              fullResponse += delta

              // Stream delta back to MCP client via progress notification
              if (extra._meta?.progressToken !== undefined) {
                await extra.sendNotification({
                  method: 'notifications/progress',
                  params: {
                    progressToken: extra._meta.progressToken,
                    progress: fullResponse.length,
                    total: 0,
                    message: delta,
                  },
                })
              }
            }

            if (
              event.type === 'session.idle' &&
              event.properties.sessionID === session.id
            ) {
              break
            }
          }
        } catch (err) {
          if ((err as Error).name === 'AbortError') {
            fullResponse +=
              '\n\n(still processing — timed out waiting for response)'
          } else {
            throw err
          }
        } finally {
          clearTimeout(timer)
          controller.abort()
        }

        if (!fullResponse) {
          return {
            content: [
              {
                type: 'text',
                text: `Message sent to ${instance.name}, but no response received. Check the instance directly.`,
              },
            ],
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: fullResponse,
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error: ${(err as Error).message}` },
          ],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'read',
    'Read the last few messages from the most recent opencode session on an instance. Use this to see what has been happening without sending a new message.',
    {
      instance: z
        .string()
        .describe('Instance name (exact or fuzzy substring match)'),
      message_limit: z
        .number()
        .optional()
        .default(10)
        .describe(
          'Max number of messages to retrieve (default 10)',
        ),
    },
    async ({ instance: query, message_limit }) => {
      try {
        const { instance } = registry.resolveInstance(query)
        const baseUrl = instance.url

        // Find the most recently updated session
        const session = await findMostRecentSession(baseUrl)
        if (!session) {
          return {
            content: [
              {
                type: 'text',
                text: `No sessions found on ${instance.name}.`,
              },
            ],
          }
        }

        // Fetch recent messages
        const msgRes = await fetch(
          `${baseUrl}/session/${session.id}/message?limit=${message_limit}`,
        )
        if (!msgRes.ok) {
          return {
            content: [
              {
                type: 'text',
                text: `Failed to fetch messages from ${instance.name}.`,
              },
            ],
            isError: true,
          }
        }

        const messages = (await msgRes.json()) as Array<{
          info: {
            role: string
            time: { created: number }
          }
          parts: Array<{
            type: string
            text?: string
            tool?: string
            state?: { status: string }
          }>
        }>

        if (messages.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Session "${session.title ?? '(untitled)'}" on ${instance.name} has no messages.`,
              },
            ],
          }
        }

        // Check status
        const { busySessionId } = await getInstanceStatus(baseUrl)
        const status =
          busySessionId === session.id ? 'busy' : 'idle'

        const lines = [
          `**${instance.name}** — "${session.title ?? '(untitled)'}" (${status})`,
          '',
        ]

        for (const msg of messages) {
          const role =
            msg.info.role === 'user' ? 'User' : 'Assistant'
          const time = new Date(
            msg.info.time.created,
          ).toLocaleTimeString()

          const textParts = msg.parts
            .filter((p) => p.type === 'text' && p.text)
            .map((p) => p.text!)
            .join('\n')

          const toolParts = msg.parts
            .filter((p) => p.type === 'tool')
            .map(
              (p) =>
                `  [tool: ${p.tool} → ${p.state?.status ?? '?'}]`,
            )

          lines.push(`**${role}** (${time}):`)
          if (textParts) lines.push(textParts)
          if (toolParts.length > 0) lines.push(toolParts.join('\n'))
          lines.push('')
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error: ${(err as Error).message}` },
          ],
          isError: true,
        }
      }
    },
  )
}
