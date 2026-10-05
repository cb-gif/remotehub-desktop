import { handleIpc } from './security'
import type { SerialService } from '../services/serial'
import type { StorageService } from '../services/storage'
import { appError } from '../services/storage'

export function registerSerialIpc(storage: StorageService, serial: SerialService): void {
  handleIpc('serial:listPorts', () => serial.listPorts())
  handleIpc('serial:connect', (_event, connectionId: string) => {
    if (typeof connectionId !== 'string' || connectionId.length > 100) throw appError('INVALID_CONNECTION_ID', 'Connection identifier is invalid')
    const connection = storage.getConnection(connectionId)
    if (!connection) throw appError('CONNECTION_NOT_FOUND', 'Connection not found')
    return serial.connect(connection)
  })
  handleIpc('serial:write', async (_event, sessionId: string, data: string) => { await serial.write(sessionId, data); return { ok: true } })
  handleIpc('serial:disconnect', (_event, sessionId: string) => { serial.disconnect(sessionId); return { ok: true } })
}
