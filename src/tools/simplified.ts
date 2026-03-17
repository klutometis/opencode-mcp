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

/**
 * Get the most recently updated session title for an instance.
 */
async function getRecentSessionTitle(
  baseUrl: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(`${baseUrl}/session`)
    if (!res.ok) return undefined
    const sessions = (await res.json()) as Array<{
      id: string
      title?: string
      time: { updated: number }
    }>
    if (sessions.length === 0) return undefined
    sessions.sort((a, b) => b.time.updated - a.time.updated)
    return sessions[0].title
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
              const recentSession = await getRecentSessionTitle(inst.url)
              const status = busySessionId ? 'busy' : 'idle'
              return { instance: inst, status, recentSession }
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
    'Send a message to the currently focused opencode session on an instance. Streams the response back in real-time. Set abort=true to stop a running task instead of sending a message.',
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

        // Submit via TUI endpoints (targets the focused session)
        await fetch(`${baseUrl}/tui/append-prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message }),
        })

        await fetch(`${baseUrl}/tui/submit-prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })

        // Subscribe to SSE and stream deltas back
        const timeout = Number(process.env.SEND_TIMEOUT_MS) || 300_000
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)

        let fullResponse = ''
        let targetSessionId: string | undefined

        try {
          for await (const event of sseEvents(
            baseUrl,
            controller.signal,
          )) {
            if (
              event.type === 'message.part.delta' &&
              event.properties.field === 'text'
            ) {
              const delta = event.properties.delta as string
              const sessionId = event.properties.sessionID as string

              // Track which session we're listening to
              if (!targetSessionId) {
                targetSessionId = sessionId
              }
              // Only accumulate events from our target session
              if (sessionId !== targetSessionId) continue

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

            if (event.type === 'session.idle') {
              const idleSessionId = event.properties.sessionID as string
              if (
                targetSessionId &&
                idleSessionId === targetSessionId
              ) {
                break
              }
            }
          }
        } catch (err) {
          if ((err as Error).name === 'AbortError') {
            fullResponse += '\n\n(still processing — timed out waiting for response)'
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
}
