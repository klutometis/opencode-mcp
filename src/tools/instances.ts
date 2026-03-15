import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { InstanceRegistry } from '../registry.js'
import type { OpenCodeInstance } from '../types.js'

function formatInstanceTable(instances: OpenCodeInstance[]): string {
  if (instances.length === 0) {
    return 'No opencode instances are currently connected.\n\nRun `opencode-connect.sh` on a machine to register one.'
  }

  const lines = [
    '| Instance | Hostname | CWD | Status | Version | Transport |',
    '|----------|----------|-----|--------|---------|-----------|',
  ]

  for (const inst of instances) {
    const status = inst.online ? 'online' : 'offline'
    const version = inst.version ?? 'unknown'
    lines.push(
      `| ${inst.name} | ${inst.hostname} | ${inst.cwd} | ${status} | ${version} | ${inst.transport} |`,
    )
  }

  return lines.join('\n')
}

export function registerInstanceTools(
  server: McpServer,
  registry: InstanceRegistry,
): void {
  server.tool(
    'list_instances',
    'List all discovered opencode instances across connected machines',
    {},
    async () => {
      const instances = registry.listInstances()
      return {
        content: [{ type: 'text', text: formatInstanceTable(instances) }],
      }
    },
  )

  server.tool(
    'refresh_instances',
    'Re-scan for opencode instances, health-check each one, and return the updated list',
    {},
    async () => {
      const instances = await registry.refresh()
      return {
        content: [
          {
            type: 'text',
            text:
              `Refreshed. Found ${instances.length} instance(s).\n\n` +
              formatInstanceTable(instances),
          },
        ],
      }
    },
  )
}
