import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InstanceRegistry } from '../registry.js'

export function registerSessionTools(
  server: McpServer,
  registry: InstanceRegistry,
): void {
  server.tool(
    'list_sessions',
    'List all sessions on an opencode instance, showing ID, title, message count, and status',
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
          client.session.status().catch(() => ({ data: {} })),
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
          `Sessions on **${instance.name}** (${instance.hostname}:${instance.cwd}):`,
          '',
          '| ID | Title | Updated | Status |',
          '|----|-------|---------|--------|',
        ]

        for (const s of sessions) {
          const shortId = s.id.slice(0, 8)
          const title = s.title || '(untitled)'
          const updated = new Date(s.time.updated).toLocaleString()
          const status = statuses[s.id]?.type ?? 'idle'
          lines.push(`| ${shortId} | ${title} | ${updated} | ${status} |`)
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
    'get_session',
    'Get session details and recent messages from an opencode instance, formatted as a readable conversation',
    {
      instance: z
        .string()
        .describe('Instance name (exact or fuzzy substring match)'),
      session_id: z.string().describe('Session ID (full or prefix)'),
      message_limit: z
        .number()
        .optional()
        .default(20)
        .describe('Max number of messages to retrieve (default 20)'),
    },
    async ({ instance: query, session_id, message_limit }) => {
      try {
        const { client, instance } = registry.resolveInstance(query)

        // If session_id is a prefix, try to resolve it
        const resolvedId = await resolveSessionId(client, session_id)

        const [sessionResult, messagesResult] = await Promise.all([
          client.session.get({ path: { id: resolvedId } }),
          client.session.messages({
            path: { id: resolvedId },
            query: { limit: message_limit },
          }),
        ])

        const session = sessionResult.data
        const messages = messagesResult.data ?? []

        const lines = [
          `## Session: ${session?.title || '(untitled)'}`,
          `- **Instance:** ${instance.name}`,
          `- **ID:** ${resolvedId}`,
          `- **Created:** ${session ? new Date(session.time.created).toLocaleString() : 'unknown'}`,
          `- **Updated:** ${session ? new Date(session.time.updated).toLocaleString() : 'unknown'}`,
          '',
          `### Messages (last ${messages.length}):`,
          '',
        ]

        for (const msg of messages) {
          const role = msg.info.role === 'user' ? 'User' : 'Assistant'
          const time = new Date(msg.info.time.created).toLocaleTimeString()

          lines.push(`**${role}** (${time}):`)

          // Extract text parts
          const textParts = msg.parts
            .filter((p) => p.type === 'text')
            .map((p) => (p as { text: string }).text)
            .join('\n')

          // Extract tool usage summaries
          const toolParts = msg.parts
            .filter((p) => p.type === 'tool')
            .map((p) => {
              const tp = p as { tool: string; state: { status: string } }
              return `  [tool: ${tp.tool} → ${tp.state.status}]`
            })

          if (textParts) lines.push(textParts)
          if (toolParts.length > 0) lines.push(toolParts.join('\n'))
          lines.push('')
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
    'create_session',
    'Create a new chat session on an opencode instance',
    {
      instance: z
        .string()
        .describe('Instance name (exact or fuzzy substring match)'),
      title: z.string().optional().describe('Optional title for the session'),
    },
    async ({ instance: query, title }) => {
      try {
        const { client, instance } = registry.resolveInstance(query)

        const result = await client.session.create({
          body: { title },
        })

        const session = result.data
        return {
          content: [
            {
              type: 'text',
              text:
                `Created session on ${instance.name}:\n` +
                `- **ID:** ${session?.id}\n` +
                `- **Title:** ${session?.title || '(untitled)'}`,
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
 * Resolve a session ID prefix to a full session ID by listing sessions
 * and finding one that starts with the given prefix.
 */
import type { OpencodeClient } from '@opencode-ai/sdk'

async function resolveSessionId(
  client: OpencodeClient,
  idOrPrefix: string,
): Promise<string> {
  // If it looks like a full UUID, use it directly
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
