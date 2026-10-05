import { handleIpc } from './security'
import type { LocalShellService } from '../services/local-shell'
import type { StorageService } from '../services/storage'
import { appError } from '../services/storage'

export function registerLocalShellIpc(storage: StorageService, shell: LocalShellService): void {
  handleIpc('shell:connect', (_event, connectionId: string) => {
    if (typeof connectionId !== 'string' || connectionId.length > 100) throw appError('INVALID_CONNECTION_ID', 'Connection identifier is invalid')
    const connection = storage.getConnection(connectionId)
    if (!connection) throw appError('CONNECTION_NOT_FOUND', 'Connection not found')
    return shell.connect(connection)
  })
  handleIpc('shell:write', async (_event, sessionId: string, data: string) => { await shell.write(sessionId, data); return { ok: true } })
  handleIpc('shell:resize', (_event, sessionId: string, cols: number, rows: number) => { shell.resize(sessionId, cols, rows); return { ok: true } })
  handleIpc('shell:codexStatus', (_event, sessionId: string) => shell.codexStatus(sessionId))
  handleIpc('shell:disconnect', (_event, sessionId: string) => { shell.disconnect(sessionId); return { ok: true } })
}
