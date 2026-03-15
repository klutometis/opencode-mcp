import { readdir, readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Transport } from './interface.js'
import type { OpenCodeInstance, RegistrationFile } from '../types.js'

const DEFAULT_REGISTRY_DIR = join(
  homedir(),
  '.local',
  'share',
  'opencode-relay',
)
const DEFAULT_HEALTH_TIMEOUT_MS = 3000

/**
 * Local relay transport: reads registration JSON files written by
 * opencode-connect.sh via SSH reverse tunnels, health-checks each
 * registered port on localhost, prunes stale entries.
 */
export class LocalRelayTransport implements Transport {
  readonly name = 'local-relay'
  private registryDir: string
  private healthTimeoutMs: number
  private password: string | undefined

  constructor(options?: {
    registryDir?: string
    healthTimeoutMs?: number
    password?: string
  }) {
    this.registryDir =
      options?.registryDir ??
      process.env.RELAY_REGISTRY_DIR ??
      DEFAULT_REGISTRY_DIR
    this.healthTimeoutMs =
      options?.healthTimeoutMs ??
      (Number(process.env.HEALTH_CHECK_TIMEOUT_MS) ||
        DEFAULT_HEALTH_TIMEOUT_MS)
    this.password =
      options?.password ?? process.env.OPENCODE_SERVER_PASSWORD
  }

  async discover(): Promise<OpenCodeInstance[]> {
    let files: string[]
    try {
      const entries = await readdir(this.registryDir)
      files = entries.filter((f) => f.endsWith('.json'))
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [] // registry dir doesn't exist yet
      }
      throw err
    }

    const results = await Promise.allSettled(
      files.map((file) => this.probeRegistration(file)),
    )

    return results
      .filter(
        (r): r is PromiseFulfilledResult<OpenCodeInstance | null> =>
          r.status === 'fulfilled',
      )
      .map((r) => r.value)
      .filter((v): v is OpenCodeInstance => v !== null)
  }

  getBaseUrl(instance: OpenCodeInstance): string {
    return instance.url
  }

  private async probeRegistration(
    filename: string,
  ): Promise<OpenCodeInstance | null> {
    const filepath = join(this.registryDir, filename)
    let reg: RegistrationFile

    try {
      const content = await readFile(filepath, 'utf-8')
      reg = JSON.parse(content) as RegistrationFile
    } catch {
      // Corrupted file — prune it
      await this.pruneFile(filepath)
      return null
    }

    const url = `http://localhost:${reg.port}`
    const health = await this.healthCheck(url)

    if (!health.healthy) {
      // Tunnel is dead — prune the registration
      await this.pruneFile(filepath)
      return null
    }

    return {
      name: reg.name,
      hostname: reg.hostname,
      url,
      cwd: reg.cwd,
      online: true,
      version: health.version,
      transport: this.name,
      meta: {
        tunnelPort: reg.port,
        localPort: reg.localPort,
        connectedAt: reg.connectedAt,
        pid: reg.pid,
      },
    }
  }

  private async healthCheck(
    baseUrl: string,
  ): Promise<{ healthy: boolean; version?: string }> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(),
        this.healthTimeoutMs,
      )

      const headers: Record<string, string> = {}
      if (this.password) {
        const username =
          process.env.OPENCODE_SERVER_USERNAME ?? 'opencode'
        const encoded = Buffer.from(
          `${username}:${this.password}`,
        ).toString('base64')
        headers['Authorization'] = `Basic ${encoded}`
      }

      const res = await fetch(`${baseUrl}/global/health`, {
        signal: controller.signal,
        headers,
      })
      clearTimeout(timeout)

      if (!res.ok) return { healthy: false }

      const data = (await res.json()) as {
        healthy: boolean
        version: string
      }
      return { healthy: data.healthy, version: data.version }
    } catch {
      return { healthy: false }
    }
  }

  private async pruneFile(filepath: string): Promise<void> {
    try {
      await unlink(filepath)
    } catch {
      // File already gone or permission issue — ignore
    }
  }
}
