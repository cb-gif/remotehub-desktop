import { handleIpc } from './security'
import type { SshPasswordOptions } from '../../shared/ssh'
import type { SshService } from '../services/ssh'
import type { StorageService } from '../services/storage'

export function registerSshIpc(storage: StorageService, ssh: SshService): void {
  handleIpc('ssh:connect', (_event, connectionId: string, options?: SshPasswordOptions, sessionId?: string) => {
    if (typeof connectionId !== 'string' || connectionId.length > 100) throw storageError('INVALID_CONNECTION_ID', 'Connection identifier is invalid')
    const connection = storage.getConnection(connectionId)
    if (!connection) throw storageError('CONNECTION_NOT_FOUND', 'Connection not found')
    if (options !== undefined && (!options || typeof options.password !== 'string' || !options.password || options.password.length > 16384 || typeof options.savePassword !== 'boolean')) throw storageError('INVALID_CREDENTIAL', 'Password input is invalid')
    return ssh.connect(connection, options, sessionId)
  })
  handleIpc('ssh:trustHostKey', (_event, connectionId: string, fingerprint: string) => {
    ssh.trustHostKey(connectionId, fingerprint)
    return { ok: true }
  })
  handleIpc('ssh:hasSessionCredential', (_event, connectionId: string) => {
    if (typeof connectionId !== 'string' || connectionId.length > 100) throw storageError('INVALID_CONNECTION_ID', 'Connection identifier is invalid')
    const connection = storage.getConnection(connectionId)
    if (!connection) throw storageError('CONNECTION_NOT_FOUND', 'Connection not found')
    return ssh.hasTemporaryPassword(connection)
  })
  handleIpc('ssh:write', (_event, sessionId: string, data: string) => {
    ssh.write(sessionId, data)
    return { ok: true }
  })
  handleIpc('ssh:acknowledgeOutput', (_event, sessionId: string, sequence: number) => ssh.acknowledgeOutput(sessionId, sequence))
  handleIpc('ssh:resize', (_event, sessionId: string, cols: number, rows: number) => {
    ssh.resize(sessionId, cols, rows)
    return { ok: true }
  })
  handleIpc('ssh:statusOverview', (_event, sessionId: string) => ssh.status(sessionId))
  handleIpc('ssh:codexStatus', (_event, sessionId: string) => ssh.codexStatus(sessionId))
  handleIpc('ssh:disconnect', (_event, sessionId: string) => {
    ssh.disconnect(sessionId)
    return { ok: true }
  })
}

function storageError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}
