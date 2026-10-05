export type SshSessionStatus = 'connecting' | 'connected' | 'error' | 'closed'

export interface SshPasswordOptions {
  password: string
  savePassword: boolean
}

export type SshConnectResult = { sessionId: string; trustRequired?: false } | { trustRequired: true; fingerprint: string }

export interface SshDataEvent {
  sessionId: string
  data: string
  sequence?: number
}

export interface SshStatusEvent {
  sessionId: string
  status: SshSessionStatus
  message?: string
  code?: string
}

export interface ServerProcess {
  pid: number
  cpuPercent: number
  memoryKb: number
  command: string
}

export interface ServerStatus {
  user: string
  host: string
  os: string
  kernel: string
  uptimeSeconds: number
  cpuPercent: number
  cpuCores: number
  loadAverage: string
  memoryUsedKb: number
  memoryTotalKb: number
  swapUsedKb: number
  swapTotalKb: number
  diskUsedKb: number
  diskTotalKb: number
  diskPercent: number
  networkRxBytes: number
  networkTxBytes: number
  processCount: number
  processes: ServerProcess[]
}

export function parseServerStatus(output: string): ServerStatus {
  const values = new Map<string, string>()
  const processes: ServerProcess[] = []
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('\t')
    if (separator < 1) continue
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1).trim()
    if (key === 'process') {
      const [pid, cpuPercent, memoryKb, command] = value.split('|')
      if (command) processes.push({ pid: number(pid), cpuPercent: number(cpuPercent), memoryKb: number(memoryKb), command })
    } else values.set(key, value)
  }
  const get = (key: string): string => values.get(key) || ''
  return {
    user: get('user'), host: get('host'), os: get('os'), kernel: get('kernel'),
    uptimeSeconds: number(get('uptime_seconds')), cpuPercent: Math.min(100, number(get('cpu_percent'))),
    cpuCores: number(get('cpu_cores')), loadAverage: get('load_average'),
    memoryUsedKb: number(get('memory_used_kb')), memoryTotalKb: number(get('memory_total_kb')),
    swapUsedKb: number(get('swap_used_kb')), swapTotalKb: number(get('swap_total_kb')),
    diskUsedKb: number(get('disk_used_kb')), diskTotalKb: number(get('disk_total_kb')),
    diskPercent: Math.min(100, number(get('disk_percent'))), networkRxBytes: number(get('network_rx_bytes')),
    networkTxBytes: number(get('network_tx_bytes')), processCount: number(get('process_count')), processes
  }
}

function number(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function sshErrorCode(code?: string, level?: string): string {
  if (level === 'client-authentication') return 'SSH_AUTHENTICATION_FAILED'
  if (level === 'client-timeout' || code === 'ETIMEDOUT') return 'SSH_TIMEOUT'
  if (code === 'ECONNREFUSED') return 'SSH_CONNECTION_REFUSED'
  if (code === 'ENOTFOUND') return 'SSH_HOST_NOT_FOUND'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'SSH_NETWORK_UNREACHABLE'
  if (code === 'ECONNRESET') return 'SSH_CONNECTION_RESET'
  if (level === 'handshake' || level === 'protocol') return 'SSH_HANDSHAKE_FAILED'
  return 'SSH_CONNECTION_FAILED'
}
