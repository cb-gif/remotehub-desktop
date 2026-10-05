import { handleIpc } from './security'
import type { SftpService } from '../services/sftp'
import type { FtpService } from '../services/ftp'
import type { StorageService } from '../services/storage'
import { appError } from '../services/storage'
import type { SshPasswordOptions } from '../../shared/ssh'

export function registerSftpIpc(storage: StorageService, sftp: SftpService): void {
  registerFileTransferIpc('sftp', storage, sftp)
  handleIpc('sftp:trustHostKey', (_event, connectionId: string, fingerprint: string) => {
    sftp.trustHostKey(connectionId, fingerprint)
    return { ok: true }
  })
}

export function registerFtpIpc(storage: StorageService, ftp: FtpService): void {
  registerFileTransferIpc('ftp', storage, ftp)
}

function registerFileTransferIpc(prefix: 'sftp' | 'ftp', storage: StorageService, service: SftpService | FtpService): void {
  handleIpc(`${prefix}:connect`, (_event, connectionId: string, options?: SshPasswordOptions) => {
    if (typeof connectionId !== 'string' || connectionId.length > 100) throw appError('INVALID_CONNECTION_ID', 'Connection identifier is invalid')
    const connection = storage.getConnection(connectionId)
    if (!connection) throw appError('CONNECTION_NOT_FOUND', 'Connection not found')
    if (prefix === 'sftp') {
      if (options !== undefined && (!options || typeof options.password !== 'string' || !options.password || options.password.length > 16384 || typeof options.savePassword !== 'boolean')) throw appError('INVALID_CREDENTIAL', 'Password input is invalid')
      return (service as SftpService).connect(connection, options)
    }
    return (service as FtpService).connect(connection)
  })
  handleIpc(`${prefix}:list`, (_event, sessionId: string, path: string) => service.list(sessionId, path))
  handleIpc(`${prefix}:mkdir`, async (_event, sessionId: string, path: string) => { await service.mkdir(sessionId, path); return { ok: true } })
  handleIpc(`${prefix}:rename`, async (_event, sessionId: string, oldPath: string, newPath: string) => { await service.rename(sessionId, oldPath, newPath); return { ok: true } })
  handleIpc(`${prefix}:readText`, (_event, sessionId: string, path: string) => service.readText(sessionId, path))
  handleIpc(`${prefix}:writeText`, (_event, sessionId: string, path: string, content: string, expectedModifiedAt: number) => service.writeText(sessionId, path, content, expectedModifiedAt))
  handleIpc(`${prefix}:remove`, async (_event, sessionId: string, path: string, type: 'file' | 'directory' | 'link') => { await service.remove(sessionId, path, type); return { ok: true } })
  handleIpc(`${prefix}:enqueueUploads`, (_event, sessionId: string, localPaths: string[], remoteDirectory: string, overwrite: boolean) => service.enqueueUploads(sessionId, localPaths, remoteDirectory, Boolean(overwrite)))
  handleIpc(`${prefix}:enqueueDownload`, (_event, sessionId: string, remotePath: string, localDirectory: string, entryType: 'file' | 'directory' | 'link', overwrite: boolean) => service.enqueueDownload(sessionId, remotePath, localDirectory, entryType, Boolean(overwrite)))
  handleIpc(`${prefix}:listTransfers`, (_event, sessionId: string) => service.listTransfers(sessionId))
  handleIpc(`${prefix}:pauseTransfer`, (_event, sessionId: string, transferId: string) => service.pauseTransfer(sessionId, transferId))
  handleIpc(`${prefix}:resumeTransfer`, (_event, sessionId: string, transferId: string) => service.resumeTransfer(sessionId, transferId))
  handleIpc(`${prefix}:cancelTransfer`, (_event, sessionId: string, transferId: string) => service.cancelTransfer(sessionId, transferId))
  handleIpc(`${prefix}:retryTransfer`, (_event, sessionId: string, transferId: string) => service.retryTransfer(sessionId, transferId))
  handleIpc(`${prefix}:clearFinishedTransfers`, (_event, sessionId: string) => { service.clearFinishedTransfers(sessionId); return { ok: true } })
  handleIpc(`${prefix}:disconnect`, (_event, sessionId: string) => { service.disconnect(sessionId); return { ok: true } })
}
