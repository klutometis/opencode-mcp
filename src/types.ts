/**
 * A registration file written by opencode-connect.sh when it establishes
 * an SSH reverse tunnel to the relay machine.
 */
export interface RegistrationFile {
  /** Human-readable instance name, e.g. "laptop-myproject" */
  name: string
  /** Short hostname of the connecting machine */
  hostname: string
  /** Tunnel port on the relay (localhost:{port} reaches the opencode instance) */
  port: number
  /** The local port opencode is serving on at the remote machine */
  localPort: number
  /** Working directory of the opencode instance */
  cwd: string
  /** ISO timestamp of when the tunnel was established */
  connectedAt: string
}

/**
 * A discovered opencode instance, enriched with health check data.
 */
export interface OpenCodeInstance {
  /** Instance name (from registration or discovery) */
  name: string
  /** Hostname of the machine running opencode */
  hostname: string
  /** Base URL to reach this instance's API */
  url: string
  /** Working directory of the opencode project */
  cwd: string
  /** Whether the instance responded to a health probe */
  online: boolean
  /** OpenCode version (from health check, if available) */
  version?: string
  /** Source transport that discovered this instance */
  transport: string
  /** Additional metadata from the transport layer */
  meta?: Record<string, unknown>
}
