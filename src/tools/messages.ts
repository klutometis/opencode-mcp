import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InstanceRegistry } from '../registry.js'
import type { OpencodeClient } from '@opencode-ai/sdk'

export function registerMessageTools(
  server: McpServer,
  registry: InstanceRegistry,
): void {
  server.tool(
    'send_message',
    'Send a message to a session on an opencode instance. Use async=true for long-running tasks (builds, multi-file edits) to avoid timeouts.',
    {
      instance: z
        .string()
        .describe('Instance name (exact or fuzzy substring match)'),
      session_id: z.string().describe('Session ID (full or prefix)'),
      message: z.string().describe('The message text to send'),
      async: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'If true, returns immediately. Poll with get_session to see the response.',
        ),
    },
    async ({ instance: query, session_id, message, async: isAsync }) => {
      try {
        const { client, instance } = registry.resolveInstance(query)
        const resolvedId = await resolveSessionId(client, session_id)

        if (isAsync) {
          await client.session.promptAsync({
            path: { id: resolvedId },
            body: {
              parts: [{ type: 'text', text: message }],
            },
          })

          return {
            content: [
              {
                type: 'text',
                text:
                  `Message sent to session ${resolvedId.slice(0, 8)} on ${instance.name} (async).\n` +
                  `Use \`get_session\` to check for the response.`,
              },
            ],
          }
        }

        // Synchronous: wait for the full response
        const result = await client.session.prompt({
          path: { id: resolvedId },
          body: {
            parts: [{ type: 'text', text: message }],
          },
        })

        const response = result.data
        if (!response) {
          return {
            content: [
              {
                type: 'text',
                text: 'Message sent but received no response data.',
              },
            ],
          }
        }

        // Extract text from response parts
        const textParts = response.parts
          .filter((p) => p.type === 'text')
          .map((p) => (p as { text: string }).text)
          .join('\n')

        const toolSummary = response.parts
          .filter((p) => p.type === 'tool')
          .map((p) => {
            const tp = p as { tool: string; state: { status: string } }
            return `[tool: ${tp.tool} → ${tp.state.status}]`
          })

        const lines = [
          `**Response from ${instance.name} (session ${resolvedId.slice(0, 8)}):**`,
          '',
        ]
        if (textParts) lines.push(textParts)
        if (toolSummary.length > 0) {
          lines.push('', '**Tools used:**', ...toolSummary)
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] }
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
    'get_status',
    'Get the status (idle/busy/retry) of all sessions on an opencode instance',
    {
      instance: z
        .string()
        .describe('Instance name (exact or fuzzy substring match)'),
    },
    async ({ instance: query }) => {
      try {
        const { client, instance } = registry.resolveInstance(query)

        const [sessionsResult, statusResult] = await Promise.all([
          client.session.list(),
          client.session.status(),
        ])

        const sessions = sessionsResult.data ?? []
        const statuses =
          (statusResult.data as Record<string, { type: string }>) ?? {}

        if (sessions.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No sessions on ${instance.name}.`,
              },
            ],
          }
        }

        const lines = [
          `Status of sessions on **${instance.name}**:`,
          '',
          '| ID | Title | Status |',
          '|----|-------|--------|',
        ]

        for (const s of sessions) {
          const shortId = s.id.slice(0, 8)
          const title = s.title || '(untitled)'
          const status = statuses[s.id]?.type ?? 'idle'
          lines.push(`| ${shortId} | ${title} | ${status} |`)
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] }
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
    'abort_session',
    'Abort a running session on an opencode instance',
    {
      instance: z
        .string()
        .describe('Instance name (exact or fuzzy substring match)'),
      session_id: z.string().describe('Session ID (full or prefix)'),
    },
    async ({ instance: query, session_id }) => {
      try {
        const { client, instance } = registry.resolveInstance(query)
        const resolvedId = await resolveSessionId(client, session_id)

        await client.session.abort({ path: { id: resolvedId } })

        return {
          content: [
            {
              type: 'text',
              text: `Aborted session ${resolvedId.slice(0, 8)} on ${instance.name}.`,
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

/**
 * Resolve a session ID prefix to a full session ID.
 */
async function resolveSessionId(
  client: OpencodeClient,
  idOrPrefix: string,
): Promise<string> {
  if (idOrPrefix.length >= 32) return idOrPrefix

  const result = await client.session.list()
  const sessions = result.data ?? []

  const matches = sessions.filter((s) => s.id.startsWith(idOrPrefix))
  if (matches.length === 0) {
    throw new Error(
      `No session found matching prefix "${idOrPrefix}". ` +
        `Use list_sessions to see available sessions.`,
    )
  }
  if (matches.length > 1) {
    const ids = matches.map((s) => s.id.slice(0, 8)).join(', ')
    throw new Error(
      `Ambiguous session prefix "${idOrPrefix}" — matches: ${ids}. ` +
        `Provide more characters.`,
    )
  }
  return matches[0].id
}
