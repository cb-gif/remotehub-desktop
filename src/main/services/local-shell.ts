import { randomUUID } from 'node:crypto'
import { spawn as spawnProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { spawn, type IPty } from 'node-pty'
import type { CodexStatus } from '../../shared/codex'
import type { LocalShellDataEvent, LocalShellStatusEvent } from '../../shared/local-shell'
import { localShellCommand } from '../../shared/local-shell'
import { initialTerminalInput } from '../../shared/terminal-input'
import type { Connection } from '../../shared/types'
import { appError, type StorageService } from './storage'
import { queryCodexUsage } from './codex'
import { codexCommand } from './codex-command'

type LocalShellSession = { process: IPty; cwd: string }

export class LocalShellService {
  private readonly sessions = new Map<string, LocalShellSession>()

  constructor(private readonly storage: StorageService, private readonly send: (channel: string, payload: unknown) => void) {}

  connect(connection: Connection): Promise<{ sessionId: string }> {
    if (connection.type !== 'shell') throw appError('SHELL_CONNECTION_INVALID', 'Only local shell connections can open a local shell')
    try {
      if (!isAbsolute(connection.host) || connection.host.length > 4096 || !statSync(connection.host).isDirectory()) throw new Error()
    } catch {
      throw appError('SHELL_DIRECTORY_INVALID', 'Shell working directory is invalid')
    }
    const sessionId = randomUUID()
    this.emitStatus({ sessionId, status: 'connecting' })
    try {
      const { command, args } = localShellCommand(process.platform, process.env)
      const child = spawn(command, args, { cwd: connection.host, env: process.env, name: 'xterm-256color', cols: 120, rows: 32 })
      this.sessions.set(sessionId, { process: child, cwd: connection.host })
      child.onData((data) => this.emitData({ sessionId, data }))
      child.onExit(() => this.closeSession(sessionId, true))
      try { this.storage.markConnected(connection.id, Date.now()) } catch { /* metadata is best effort */ }
      this.emitStatus({ sessionId, status: 'connected' })
      const initialInput = initialTerminalInput(connection.initialCommand)
      if (initialInput) child.write(initialInput)
      return Promise.resolve({ sessionId })
    } catch (error) {
      this.closeSession(sessionId, false)
      const message = error instanceof Error ? error.message : 'Local shell could not start'
      this.emitStatus({ sessionId, status: 'error', message })
      return Promise.reject(appError('SHELL_START_FAILED', message))
    }
  }

  write(sessionId: string, data: string): Promise<void> {
    if (typeof data !== 'string' || data.length > 1024 * 1024) throw appError('SHELL_INPUT_INVALID', 'Shell input is invalid')
    const session = this.getSession(sessionId)
    session.process.write(data)
    return Promise.resolve()
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || cols > 300 || rows < 1 || rows > 200) throw appError('SHELL_RESIZE_INVALID', 'Terminal size is invalid')
    this.getSession(sessionId).process.resize(cols, rows)
  }

  async codexStatus(sessionId: string): Promise<CodexStatus> {
    const { cwd } = this.getSession(sessionId)
    try {
      return await queryCodexUsage((ready, fail) => {
        const command = codexCommand(cwd)
        const child = spawnProcess(command.file, command.args, { cwd: command.cwd, env: { ...command.env, NO_COLOR: '1' }, shell: false, windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments })
        child.once('error', fail)
        child.stdin.on('error', fail)
        child.stderr.resume()
        ready({
          onData: (listener) => child.stdout.on('data', listener),
          onError: (listener) => child.on('error', listener),
          onClose: (listener) => child.on('close', listener),
          write: (data) => child.stdin.write(data),
          close: () => { child.stdin.end(); child.kill() }
        })
      })
    } catch (error) {
      throw appError('SHELL_CODEX_STATUS_FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  disconnect(sessionId: string): void {
    this.closeSession(sessionId, true)
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.closeSession(id, false)
  }

  private getSession(sessionId: string): LocalShellSession {
    if (typeof sessionId !== 'string' || sessionId.length > 100) throw appError('SHELL_SESSION_INVALID', 'Shell session identifier is invalid')
    const session = this.sessions.get(sessionId)
    if (!session) throw appError('SHELL_SESSION_NOT_FOUND', 'Shell session is not available')
    return session
  }

  private closeSession(sessionId: string, notify: boolean): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    try { session.process.kill() } catch { /* the process may already have exited */ }
    if (notify) this.emitStatus({ sessionId, status: 'closed' })
  }

  private emitData(event: LocalShellDataEvent): void {
    try { this.send('shell:data', event) } catch { /* renderer may already be closed */ }
  }

  private emitStatus(event: LocalShellStatusEvent): void {
    try { this.send('shell:status', event) } catch { /* renderer may already be closed */ }
  }
}
