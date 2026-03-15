import type { OpenCodeInstance } from '../types.js'

/**
 * Abstract transport interface for discovering opencode instances.
 *
 * Different backends (SSH relay, Tailscale, Cloudflare Tunnels) implement
 * this interface. The registry and tools don't care how instances are found
 * or reached — only that they conform to OpenCodeInstance.
 */
export interface Transport {
  /** Human-readable name for this transport backend */
  readonly name: string

  /**
   * Discover all reachable opencode instances.
   * Implementations should health-check each candidate and only return
   * instances that are actually responsive.
   */
  discover(): Promise<OpenCodeInstance[]>

  /**
   * Get the base URL for an instance's API.
   * For local-relay: http://localhost:{tunnelPort}
   * For tailscale:   http://{tailscaleIP}:{port}
   */
  getBaseUrl(instance: OpenCodeInstance): string
}
