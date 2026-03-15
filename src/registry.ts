import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'
import type { Transport } from './transport/interface.js'
import type { OpenCodeInstance } from './types.js'

export class InstanceRegistry {
  private instances: Map<string, OpenCodeInstance> = new Map()
  private clients: Map<string, OpencodeClient> = new Map()
  private timer?: ReturnType<typeof setInterval>

  constructor(private transport: Transport) {}

  async initialize(): Promise<void> {
    await this.refresh()
    const interval = Number(process.env.DISCOVERY_INTERVAL_MS) || 30000
    this.timer = setInterval(
      () => this.refresh().catch(console.error),
      interval,
    )
  }

  async refresh(): Promise<OpenCodeInstance[]> {
    const discovered = await this.transport.discover()

    // Build new maps from scratch each refresh
    const newInstances = new Map<string, OpenCodeInstance>()
    const newClients = new Map<string, OpencodeClient>()

    for (const inst of discovered) {
      newInstances.set(inst.name, inst)
      if (inst.online) {
        // Reuse existing client if the URL hasn't changed
        const existing = this.instances.get(inst.name)
        const existingClient = this.clients.get(inst.name)
        if (existingClient && existing?.url === inst.url) {
          newClients.set(inst.name, existingClient)
        } else {
          newClients.set(inst.name, this.makeClient(inst))
        }
      }
    }

    this.instances = newInstances
    this.clients = newClients
    return discovered
  }

  private makeClient(inst: OpenCodeInstance): OpencodeClient {
    const password = process.env.OPENCODE_SERVER_PASSWORD
    const baseUrl = this.transport.getBaseUrl(inst)

    const customFetch = password
      ? (request: Request) => {
          const username =
            process.env.OPENCODE_SERVER_USERNAME ?? 'opencode'
          const encoded = Buffer.from(
            `${username}:${password}`,
          ).toString('base64')
          const headers = new Headers(request.headers)
          headers.set('Authorization', `Basic ${encoded}`)
          return fetch(new Request(request, { headers }))
        }
      : undefined

    return createOpencodeClient({
      baseUrl,
      ...(customFetch ? { fetch: customFetch } : {}),
    })
  }

  listInstances(): OpenCodeInstance[] {
    return Array.from(this.instances.values())
  }

  /**
   * Resolve an instance by name. Supports exact match and fuzzy substring match.
   * Throws descriptive errors for no-match and ambiguous-match cases.
   */
  resolveInstance(query: string): {
    instance: OpenCodeInstance
    client: OpencodeClient
  } {
    // Exact match
    if (this.instances.has(query)) {
      const inst = this.instances.get(query)!
      const client = this.clients.get(query)
      if (!client) throw new Error(`Instance "${query}" is offline`)
      return { instance: inst, client }
    }

    // Fuzzy substring match
    const matches = Array.from(this.instances.entries()).filter(([name]) =>
      name.toLowerCase().includes(query.toLowerCase()),
    )

    if (matches.length === 0) {
      const available = Array.from(this.instances.keys())
      if (available.length === 0) {
        throw new Error(
          'No opencode instances are currently connected. ' +
            'Run opencode-connect.sh on a machine to register one.',
        )
      }
      throw new Error(
        `No instance matching "${query}". Available: ${available.join(', ')}`,
      )
    }

    if (matches.length > 1) {
      const names = matches.map(([n]) => n).join(', ')
      throw new Error(
        `Ambiguous instance "${query}" — matches: ${names}. Be more specific.`,
      )
    }

    const [name, inst] = matches[0]
    const client = this.clients.get(name)
    if (!client) throw new Error(`Instance "${name}" is offline`)
    return { instance: inst, client }
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
