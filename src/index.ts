#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { LocalRelayTransport } from './transport/local-relay.js'
import { InstanceRegistry } from './registry.js'
import { registerInstanceTools } from './tools/instances.js'
import { registerSessionTools } from './tools/sessions.js'
import { registerMessageTools } from './tools/messages.js'
import type { Transport } from './transport/interface.js'

function createTransport(): Transport {
  const backend = process.env.TRANSPORT ?? 'local-relay'

  switch (backend) {
    case 'local-relay':
      return new LocalRelayTransport()
    // Future:
    // case 'tailscale':
    //   return new TailscaleTransport()
    default:
      throw new Error(
        `Unknown transport "${backend}". Supported: local-relay`,
      )
  }
}

async function main() {
  const transport = createTransport()
  const registry = new InstanceRegistry(transport)

  // Initialize discovery (first scan + periodic refresh)
  await registry.initialize()

  const server = new McpServer({
    name: 'opencode-mcp',
    version: '1.0.0',
  })

  // Register all tool groups
  registerInstanceTools(server, registry)
  registerSessionTools(server, registry)
  registerMessageTools(server, registry)

  // Connect via stdio (for mcp-gateway or direct use)
  const stdioTransport = new StdioServerTransport()
  await server.connect(stdioTransport)

  // Graceful shutdown
  const shutdown = () => {
    registry.shutdown()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('opencode-mcp failed to start:', err)
  process.exit(1)
})
