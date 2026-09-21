import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import type { CodexStatus } from '../../shared/codex'
import type { Connection } from '../../shared/types'
import type { SshPasswordOptions } from '../../shared/ssh'
import { parseServerStatus, sshErrorCode, type ServerStatus, type SshConnectResult, type SshDataEvent, type SshStatusEvent } from '../../shared/ssh'
import { CredentialService } from './credentials'
import { fingerprintHostKey, hostKeyState } from './host-key'
import { appError, StorageService } from './storage'
import { queryCodexUsage } from './codex'

type EventSink = (channel: 'ssh:data' | 'ssh:status', payload: SshDataEvent | SshStatusEvent) => void

type SshStreamLike = {
  on(event: string, listener: (...args: unknown[]) => void): SshStreamLike
  write(data: string): boolean
  setWindow(rows: number, cols: number, height: number, width: number): void
  close(): void
}

type SshClientLike = {
  on(event: string, listener: (...args: unknown[]) => void): SshClientLike
  connect(config: Record<string, unknown>): void
  shell(options: Record<string, unknown>, callback: (error: Error | undefined, stream: SshStreamLike) => void): void
  exec(command: string, callback: (error: Error | undefined, stream: SshExecStreamLike) => void): void
  end(): void
}

type SshExecStreamLike = {
  stderr: { on(event: string, listener: (...args: unknown[]) => void): void }
  on(event: string, listener: (...args: unknown[]) => void): SshExecStreamLike
  write(data: string): boolean
  end(): void
}

type SshClientConstructor = new () => SshClientLike

type SshSession = {
  id: string
  connectionId: string
  client: SshClientLike
  stream?: SshStreamLike
  temporaryPassword?: string
  target?: string
}

const SERVER_STATUS_COMMAND = String.raw`
export LC_ALL=C
printf 'user\t%s\n' "$(id -un 2>/dev/null)"
printf 'host\t%s\n' "$(hostname -f 2>/dev/null || hostname 2>/dev/null)"
if [ -r /etc/os-release ]; then . /etc/os-release; printf 'os\t%s\n' "$PRETTY_NAME"; else printf 'os\t%s\n' "$(uname -s 2>/dev/null)"; fi
printf 'kernel\t%s\n' "$(uname -sr 2>/dev/null)"
awk 'NR==1 {printf "uptime_seconds\t%.0f\n", $1}' /proc/uptime 2>/dev/null
printf 'cpu_cores\t%s\n' "$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf 0)"
printf 'load_average\t%s\n' "$(cut -d ' ' -f 1-3 /proc/loadavg 2>/dev/null)"
if [ -r /proc/stat ]; then
  read _ u1 n1 s1 i1 w1 q1 z1 t1 _ < /proc/stat
  total1=$((u1+n1+s1+i1+w1+q1+z1+t1)); idle1=$((i1+w1)); sleep 0.2
  read _ u2 n2 s2 i2 w2 q2 z2 t2 _ < /proc/stat
  total2=$((u2+n2+s2+i2+w2+q2+z2+t2)); idle2=$((i2+w2))
  awk -v ticks="$((total2-total1))" -v idle_ticks="$((idle2-idle1))" 'BEGIN {value=0; if (ticks>0) value=(ticks-idle_ticks)*100/ticks; printf "cpu_percent\t%.1f\n", value}'
fi
awk '/^MemTotal:/ {mt=$2} /^MemAvailable:/ {ma=$2} /^SwapTotal:/ {st=$2} /^SwapFree:/ {sf=$2} END {printf "memory_total_kb\t%.0f\nmemory_used_kb\t%.0f\nswap_total_kb\t%.0f\nswap_used_kb\t%.0f\n", mt, mt-ma, st, st-sf}' /proc/meminfo 2>/dev/null
df -Pk / 2>/dev/null | awk 'NR==2 {gsub(/%/, "", $5); printf "disk_total_kb\t%s\ndisk_used_kb\t%s\ndisk_percent\t%s\n", $2, $3, $5}'
awk -F: 'NR>2 {gsub(/ /, "", $1); if ($1 != "lo") {gsub(/^ +/, "", $2); split($2, v, / +/); rx+=v[1]; tx+=v[9]}} END {printf "network_rx_bytes\t%.0f\nnetwork_tx_bytes\t%.0f\n", rx, tx}' /proc/net/dev 2>/dev/null
printf 'process_count\t%s\n' "$(ps -e --no-headers 2>/dev/null | wc -l)"
ps -eo pid=,pcpu=,rss=,comm= --sort=-pcpu 2>/dev/null | head -n 6 | awk '{printf "process\t%s|%s|%s|%s\n", $1, $2, $3, $4}'
`.trim()

const loadNativeModule = createRequire(__filename)

export class SshService {
  private readonly sessions = new Map<string, SshSession>()
  private readonly pendingHostKeys = new Map<string, string>()

  constructor(private readonly storage: StorageService, private readonly credentials: CredentialService, private readonly send: EventSink) {}

  async connect(connection: Connection, options?: SshPasswordOptions): Promise<SshConnectResult> {
    if (connection.type !== 'ssh') throw appError('SSH_CONNECTION_INVALID', 'Only SSH connections can open a terminal')
    if (!connection.username?.trim()) throw appError('SSH_USERNAME_REQUIRED', 'SSH 用户名不能为空')
    const credential = options?.password ?? this.credentials.get(connection.credentialId)
    if (!credential) throw appError('CREDENTIAL_MISSING', 'Save a password or private key before connecting')

    const client = this.createClient()
    const sessionId = randomUUID()
    const session: SshSession = { id: sessionId, connectionId: connection.id, client }
    this.sessions.set(sessionId, session)
    this.emitStatus({ sessionId, status: 'connecting' })

    return new Promise((resolve, reject) => {
      let settled = false
      let receivedHostKey: string | undefined
      const fail = (error: unknown): void => {
        if (!this.sessions.has(sessionId)) return
        const wasPending = !settled
        if (wasPending) settled = true
        const keyState = receivedHostKey ? hostKeyState(connection.hostKeyFingerprint, receivedHostKey) : undefined
        if (keyState === 'new') {
          this.pendingHostKeys.set(connection.id, receivedHostKey!)
          this.closeSession(sessionId, false)
          if (wasPending) resolve({ trustRequired: true, fingerprint: receivedHostKey! })
          return
        }
        const appFailure = keyState === 'changed'
          ? appError('SSH_HOST_KEY_CHANGED', `Host key changed for ${connection.host}:${connection.port}. Expected ${connection.hostKeyFingerprint}, received ${receivedHostKey}. Connection blocked.`)
          : toSshError(error)
        this.emitStatus({ sessionId, status: 'error', code: appFailure.code, message: appFailure.message })
        this.closeSession(sessionId, false)
        if (wasPending) reject(appFailure)
      }

      client.on('ready', () => {
        client.shell({ term: 'xterm-256color', cols: 120, rows: 32 }, (error, stream) => {
          if (error) return fail(error)
          session.stream = stream
          stream.on('data', (chunk: unknown) => this.emitData({ sessionId, data: Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk) }))
          stream.on('error', fail)
          stream.on('close', () => this.closeSession(sessionId, true))
          stream.on('end', () => this.closeSession(sessionId, true))
          if (!settled) {
            if (options?.savePassword) {
              try {
                const latest = this.storage.getConnection(connection.id)
                if (latest) {
                  const credentialId = this.credentials.save(latest.name, credential, latest.credentialId)
                  this.storage.saveConnection({ ...latest, authType: 'password', credentialId })
                }
              } catch (saveError) { fail(saveError); return }
            }
            settled = true
            try { this.storage.markConnected(connection.id, Date.now()) } catch { /* connection metadata is best effort */ }
            if (options && !options.savePassword) {
              session.temporaryPassword = credential
              session.target = JSON.stringify([connection.host, connection.port, connection.username])
            }
            this.emitStatus({ sessionId, status: 'connected' })
            resolve({ sessionId })
          }
        })
      })
      client.on('error', fail)
      const closed = (): void => {
        if (!settled) fail(new Error('SSH connection closed before it was ready'))
        else this.closeSession(sessionId, true)
      }
      client.on('end', closed)
      client.on('close', closed)

      try {
        client.connect({
          host: connection.host,
          port: connection.port,
          username: connection.username,
          readyTimeout: 10000,
          keepaliveInterval: 10000,
          keepaliveCountMax: 3,
          hostVerifier: (key: Buffer) => {
            receivedHostKey = fingerprintHostKey(key)
            return hostKeyState(connection.hostKeyFingerprint, receivedHostKey) === 'trusted'
          },
          ...(!options && connection.authType === 'privateKey' ? { privateKey: credential } : { password: credential })
        })
      } catch (error) {
        fail(error)
      }
    })
  }

  temporaryPassword(connection: Connection): string | undefined {
    const target = JSON.stringify([connection.host, connection.port, connection.username])
    return [...this.sessions.values()].find((session) => session.connectionId === connection.id && session.target === target && session.stream)?.temporaryPassword
  }

  hasTemporaryPassword(connection: Connection): boolean {
    return Boolean(this.temporaryPassword(connection))
  }

  trustHostKey(connectionId: string, fingerprint: string): void {
    if (this.storage.getConnection(connectionId)?.hostKeyFingerprint === fingerprint) return
    if (typeof connectionId !== 'string' || connectionId.length > 100 || this.pendingHostKeys.get(connectionId) !== fingerprint) {
      throw appError('SSH_HOST_KEY_INVALID', 'Host key confirmation is invalid or expired')
    }
    this.storage.trustHostKey(connectionId, fingerprint)
    this.pendingHostKeys.delete(connectionId)
  }

  write(sessionId: string, data: string): void {
    if (typeof data !== 'string' || data.length > 1024 * 1024) throw appError('SSH_INPUT_INVALID', 'Terminal input is invalid')
    const session = this.sessions.get(sessionId)
    if (!session?.stream) throw appError('SSH_SESSION_NOT_FOUND', 'SSH session is not available')
    session.stream.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || cols > 300 || rows < 1 || rows > 200) {
      throw appError('SSH_RESIZE_INVALID', 'Terminal size is invalid')
    }
    const session = this.sessions.get(sessionId)
    if (!session?.stream) throw appError('SSH_SESSION_NOT_FOUND', 'SSH session is not available')
    session.stream.setWindow(rows, cols, 0, 0)
  }

  async status(sessionId: string): Promise<ServerStatus> {
    try {
      const result = await this.runCommand(sessionId, SERVER_STATUS_COMMAND)
      if (result.code && !result.output) throw new Error(result.errorOutput.trim() || 'Could not read server status')
      return parseServerStatus(result.output)
    } catch (error) {
      throw appError('SSH_STATUS_FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  async codexStatus(sessionId: string): Promise<CodexStatus> {
    if (typeof sessionId !== 'string' || sessionId.length > 100) throw appError('SSH_SESSION_INVALID', 'SSH session identifier is invalid')
    const session = this.sessions.get(sessionId)
    if (!session?.stream) throw appError('SSH_SESSION_NOT_FOUND', 'SSH session is not available')
    try {
      return await queryCodexUsage((ready, fail) => session.client.exec('codex app-server', (error, stream) => {
        if (error) return fail(error)
        ready({
          onData: (listener) => { stream.on('data', listener) },
          onError: (listener) => { stream.on('error', listener) },
          onClose: (listener) => { stream.on('close', listener) },
          write: (data) => { stream.write(data) },
          close: () => stream.end()
        })
      }))
    } catch (error) {
      throw appError('SSH_CODEX_STATUS_FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  disconnect(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId.length > 100) throw appError('SSH_SESSION_INVALID', 'SSH session identifier is invalid')
    this.closeSession(sessionId, true)
  }

  dispose(): void {
    for (const sessionId of this.sessions.keys()) this.closeSession(sessionId, false)
    this.pendingHostKeys.clear()
  }

  private createClient(): SshClientLike {
    try {
      const module = loadNativeModule('ssh2') as { Client?: SshClientConstructor }
      if (!module.Client) throw new Error('ssh2 Client export is unavailable')
      return new module.Client()
    } catch {
      throw appError('SSH_UNAVAILABLE', 'SSH module is unavailable; run npm install and restart')
    }
  }

  private runCommand(sessionId: string, command: string): Promise<{ output: string; errorOutput: string; code: number }> {
    if (typeof sessionId !== 'string' || sessionId.length > 100) throw appError('SSH_SESSION_INVALID', 'SSH session identifier is invalid')
    const session = this.sessions.get(sessionId)
    if (!session?.stream) throw appError('SSH_SESSION_NOT_FOUND', 'SSH session is not available')
    return new Promise((resolve, reject) => {
      let output = ''
      let errorOutput = ''
      let settled = false
      const finish = (error?: Error, code = 0): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve({ output, errorOutput, code })
      }
      const timeout = setTimeout(() => finish(new Error('Remote command timed out')), 6000)
      session.client.exec(command, (error, stream) => {
        if (error) return finish(error)
        stream.on('data', (chunk: unknown) => { if (output.length < 64 * 1024) output += bufferText(chunk) })
        stream.stderr.on('data', (chunk: unknown) => { if (errorOutput.length < 4096) errorOutput += bufferText(chunk) })
        stream.on('error', (streamError: unknown) => finish(streamError instanceof Error ? streamError : new Error(String(streamError))))
        stream.on('close', (code: unknown) => finish(undefined, typeof code === 'number' ? code : 0))
      })
    })
  }

  private closeSession(sessionId: string, notify: boolean): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    try { session.stream?.close() } catch { /* best effort */ }
    try { session.client.end() } catch { /* best effort */ }
    if (notify) this.emitStatus({ sessionId, status: 'closed' })
  }

  private emitData(event: SshDataEvent): void {
    try { this.send('ssh:data', event) } catch { /* the renderer may already be closed */ }
  }

  private emitStatus(event: SshStatusEvent): void {
    try { this.send('ssh:status', event) } catch { /* the renderer may already be closed */ }
  }
}

function toSshError(error: unknown): Error & { code: string } {
  const source = error as (NodeJS.ErrnoException & { level?: string }) | undefined
  const code = sshErrorCode(source?.code, source?.level)
  const message = code === 'SSH_AUTHENTICATION_FAILED'
    ? 'Authentication failed. Check the saved username and password or private key.'
    : error instanceof Error ? error.message : 'SSH connection failed'
  return appError(code, message)
}

function bufferText(value: unknown): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
}
