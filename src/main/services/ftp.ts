import { randomUUID } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { Client, type FileInfo } from 'basic-ftp'
import type { Connection } from '../../shared/types'
import type { SessionConnectionStatusEvent } from '../../shared/connection-status'
import { MAX_TRANSFER_FILES } from '../../shared/transfer-limits'
import { joinRemotePath, normalizeRemotePath, type SftpConnectResult, type SftpEntry, type SftpEntryType, type SftpQueueResult, type SftpTransferConflict, type SftpTransferEvent, type SftpTransferItem } from '../../shared/sftp'
import { CredentialService } from './credentials'
import { appError, StorageService } from './storage'
import { assertUniqueLocalTargets, buildUploadPlan, safeLocalFileName, validateLocalDirectory, validateRemotePath, type FilePlan } from './sftp'
import { TransferManager, type TransferControl, type TransferHooks } from './transfer-manager'

type FtpSession = {
  id: string
  connection: Connection
  password?: string
  client: Client
  operation: Promise<void>
}
type EventSink = (channel: 'ftp:transfer' | 'ftp:status', payload: SftpTransferEvent | SessionConnectionStatusEvent) => void

const MAX_EDIT_BYTES = 2 * 1024 * 1024

export class FtpService {
  private readonly sessions = new Map<string, FtpSession>()
  private readonly transfers: TransferManager

  constructor(private readonly storage: StorageService, private readonly credentials: CredentialService, private readonly send: EventSink) {
    this.transfers = new TransferManager((item) => this.emit(item), 2)
  }

  async connect(connection: Connection): Promise<SftpConnectResult> {
    if (connection.type !== 'ftp') throw appError('FTP_CONNECTION_INVALID', 'FTP requires an FTP connection')
    const password = this.credentials.get(connection.credentialId)
    const client = await this.openClient(connection, password)
    try {
      const homePath = normalizeRemotePath(await client.pwd())
      const sessionId = randomUUID()
      this.sessions.set(sessionId, { id: sessionId, connection, password, client, operation: Promise.resolve() })
      this.observeSessionClosure(sessionId, client)
      try { this.storage.markConnected(connection.id, Date.now()) } catch { /* metadata is best effort */ }
      this.emitStatus({ sessionId, status: 'connected' })
      return { sessionId, homePath }
    } catch (error) {
      client.close()
      throw toFtpError(error)
    }
  }

  list(sessionId: string, path: string): Promise<SftpEntry[]> {
    const remotePath = ftpPath(path)
    return this.run(sessionId, async (session) => this.readDirectory(session.client, remotePath))
  }

  mkdir(sessionId: string, path: string): Promise<void> {
    const remotePath = ftpPath(path)
    return this.run(sessionId, async (session) => { await session.client.ensureDir(remotePath) })
  }

  rename(sessionId: string, oldPath: string, newPath: string): Promise<void> {
    const source = ftpPath(oldPath)
    const target = ftpPath(newPath)
    if (source === target || posix.dirname(source) !== posix.dirname(target)) throw appError('FTP_RENAME_INVALID', 'Enter a new file or folder name without slashes')
    return this.run(sessionId, async (session) => { await session.client.rename(source, target) })
  }

  readText(sessionId: string, path: string): Promise<{ content: string; modifiedAt: number }> {
    const remotePath = ftpPath(path)
    return this.run(sessionId, async (session) => {
      const entry = await this.remoteEntry(session.client, remotePath)
      if (!entry) throw appError('FTP_PATH_NOT_FOUND', 'Remote file no longer exists')
      if (entry.size > MAX_EDIT_BYTES) throw appError('FTP_EDIT_TOO_LARGE', 'Online editing supports text files up to 2 MB')
      const chunks: Buffer[] = []
      let size = 0
      const target = new Writable({ write(chunk: Buffer, _encoding, done) {
        size += chunk.length
        if (size > MAX_EDIT_BYTES) return done(appError('FTP_EDIT_TOO_LARGE', 'Online editing supports text files up to 2 MB'))
        chunks.push(Buffer.from(chunk)); done()
      } })
      await session.client.downloadTo(target, remotePath)
      const data = Buffer.concat(chunks)
      if (!isUtf8(data) || data.includes(0)) throw appError('FTP_EDIT_BINARY', 'Online editing supports UTF-8 text files only')
      return { content: data.toString('utf8'), modifiedAt: entry.modifiedAt?.getTime() || 0 }
    })
  }

  writeText(sessionId: string, path: string, content: string, expectedModifiedAt: number): Promise<{ modifiedAt: number }> {
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_EDIT_BYTES) throw appError('FTP_EDIT_TOO_LARGE', 'Online editing supports text files up to 2 MB')
    const remotePath = ftpPath(path)
    return this.run(sessionId, async (session) => {
      const entry = await this.remoteEntry(session.client, remotePath)
      if (!entry) throw appError('FTP_PATH_NOT_FOUND', 'Remote file no longer exists')
      if ((entry.modifiedAt?.getTime() || 0) !== expectedModifiedAt) throw appError('FTP_EDIT_CONFLICT', 'Remote file changed after it was opened; reopen it before saving')
      await session.client.uploadFrom(Readable.from(Buffer.from(content)), remotePath)
      const updated = await this.remoteEntry(session.client, remotePath)
      return { modifiedAt: updated?.modifiedAt?.getTime() || 0 }
    })
  }

  remove(sessionId: string, path: string, type: SftpEntryType): Promise<void> {
    if (type !== 'file' && type !== 'directory' && type !== 'link') throw appError('FTP_ENTRY_TYPE_INVALID', 'Remote entry type is invalid')
    const remotePath = ftpPath(path)
    return this.run(sessionId, async (session) => {
      if (type === 'directory') await session.client.removeEmptyDir(remotePath)
      else await session.client.remove(remotePath)
    })
  }

  enqueueUploads(sessionId: string, localPaths: string[], remoteDirectory: string, overwrite: boolean): Promise<SftpQueueResult> {
    if (!Array.isArray(localPaths) || !localPaths.length || localPaths.length > MAX_TRANSFER_FILES || localPaths.some((path) => typeof path !== 'string')) throw appError('TRANSFER_INPUT_INVALID', `Choose between 1 and ${MAX_TRANSFER_FILES} files or folders`)
    const directory = ftpPath(remoteDirectory)
    return this.run(sessionId, async (session) => {
      const { files, directories } = buildUploadPlan(localPaths, directory)
      const conflicts = await this.uploadConflicts(session.client, files)
      if (conflicts.length && !overwrite) return { transferIds: [], conflicts }
      for (const item of directories.sort((a, b) => pathDepth(a.path) - pathDepth(b.path))) await session.client.ensureDir(ftpPath(item.path))
      const directoryTimes = new Map(directories.map((item) => [item.path, item.modifiedAt]))
      const transferIds = files.map((file) => this.transfers.enqueue({
        sessionId,
        direction: 'upload',
        name: basename(file.localPath),
        relativePath: file.relativePath,
        total: file.size,
        start: (offset, hooks) => this.startTransfer(session, file, offset, hooks, 'upload', directoryTimes.get(posix.dirname(file.remotePath)))
      }).transferId)
      return { transferIds, conflicts: [] }
    })
  }

  enqueueDownload(sessionId: string, remotePathInput: string, localDirectoryInput: string, entryType: SftpEntryType, overwrite: boolean): Promise<SftpQueueResult> {
    const remotePath = ftpPath(remotePathInput)
    const localDirectory = validateLocalDirectory(localDirectoryInput)
    if (entryType !== 'file' && entryType !== 'directory' && entryType !== 'link') throw appError('FTP_ENTRY_TYPE_INVALID', 'Remote entry type is invalid')
    return this.run(sessionId, async (session) => {
      const rootName = safeLocalFileName(posix.basename(remotePath))
      const files: FilePlan[] = []
      const directories = new Set<string>()
      if (entryType === 'directory') await this.collectDownloadPlan(session.client, remotePath, join(localDirectory, rootName), rootName, files, directories, 0)
      else {
        const entry = await this.remoteEntry(session.client, remotePath)
        if (!entry) throw appError('FTP_PATH_NOT_FOUND', 'Remote file no longer exists')
        files.push({ localPath: join(localDirectory, rootName), remotePath, relativePath: rootName, size: entry.size, modifiedAt: Math.floor((entry.modifiedAt?.getTime() || 0) / 1000) })
      }
      assertUniqueLocalTargets(files)
      const conflicts = files.filter((file) => existsSync(file.localPath)).map((file) => ({ direction: 'download' as const, path: file.localPath, name: file.relativePath }))
      if (conflicts.length && !overwrite) return { transferIds: [], conflicts }
      for (const localPath of directories) {
        if (existsSync(localPath) && !lstatSync(localPath).isDirectory()) throw appError('TRANSFER_DIRECTORY_CONFLICT', `A file blocks the destination folder: ${localPath}`)
        mkdirSync(localPath, { recursive: true })
      }
      const transferIds = files.map((file) => this.transfers.enqueue({
        sessionId,
        direction: 'download',
        name: posix.basename(file.remotePath),
        relativePath: file.relativePath,
        total: file.size,
        start: (offset, hooks) => this.startTransfer(session, file, offset, hooks, 'download')
      }).transferId)
      return { transferIds, conflicts: [] }
    })
  }

  listTransfers(sessionId: string): SftpTransferItem[] { this.getSession(sessionId); return this.transfers.list(sessionId) }
  pauseTransfer(sessionId: string, transferId: string): SftpTransferItem { this.assertTransferSession(sessionId, transferId); return this.transfers.pause(transferId) }
  resumeTransfer(sessionId: string, transferId: string): SftpTransferItem { this.assertTransferSession(sessionId, transferId); return this.transfers.resume(transferId) }
  cancelTransfer(sessionId: string, transferId: string): SftpTransferItem { this.assertTransferSession(sessionId, transferId); return this.transfers.cancel(transferId) }
  retryTransfer(sessionId: string, transferId: string): SftpTransferItem { this.assertTransferSession(sessionId, transferId); return this.transfers.retry(transferId) }
  clearFinishedTransfers(sessionId: string): void { this.getSession(sessionId); this.transfers.clearFinished(sessionId) }

  disconnect(sessionId: string): void {
    this.closeSession(sessionId, 'closed')
  }

  private closeSession(sessionId: string, status: 'closed' | 'error', message?: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    this.transfers.closeSession(sessionId)
    this.emitStatus({ sessionId, status, message })
    session.client.close()
  }

  private observeSessionClosure(sessionId: string, client: Client): void {
    // basic-ftp removes socket listeners while closing, so observe its public
    // close entry point too (including failures originating on a data socket).
    let status: 'closed' | 'error' = 'error'
    client.ftp.socket.prependOnceListener('end', () => { status = 'closed' })
    client.ftp.socket.prependOnceListener('close', (hadError: boolean) => { status = hadError ? 'error' : 'closed' })
    const closeWithError = client.ftp.closeWithError.bind(client.ftp)
    client.ftp.closeWithError = (error: Error): void => {
      closeWithError(error)
      this.closeSession(sessionId, status, status === 'error' ? error.message : undefined)
    }
  }

  dispose(): void { for (const id of [...this.sessions.keys()]) this.disconnect(id) }

  private async openClient(connection: Connection, password?: string): Promise<Client> {
    const client = new Client(15_000)
    try {
      await client.access({ host: connection.host, port: connection.port, user: connection.username || 'anonymous', password: password ?? 'guest' })
      return client
    } catch (error) {
      client.close()
      throw toFtpError(error)
    }
  }

  private getSession(sessionId: string): FtpSession {
    if (typeof sessionId !== 'string' || sessionId.length > 100) throw appError('FTP_SESSION_INVALID', 'FTP session identifier is invalid')
    const session = this.sessions.get(sessionId)
    if (!session) throw appError('FTP_SESSION_NOT_FOUND', 'FTP session is not available')
    return session
  }

  private run<T>(sessionId: string, task: (session: FtpSession) => Promise<T>): Promise<T> {
    const session = this.getSession(sessionId)
    const result = session.operation.then(() => task(session))
    session.operation = result.then(() => undefined, () => undefined)
    return result.catch((error) => { throw toFtpError(error) })
  }

  private readDirectory(client: Client, path: string): Promise<SftpEntry[]> {
    const remotePath = ftpPath(path)
    return client.list(remotePath).then((list) => list.filter((item) => item.name !== '.' && item.name !== '..').map((item) => ({
      name: item.name,
      path: joinRemotePath(remotePath, item.name),
      type: ftpEntryType(item),
      size: Number(item.size || 0),
      modifiedAt: item.modifiedAt?.getTime() || 0,
      mode: 0
    })).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
  }

  private async remoteEntry(client: Client, path: string): Promise<FileInfo | undefined> {
    const remotePath = ftpPath(path)
    const name = posix.basename(remotePath)
    return (await client.list(posix.dirname(remotePath))).find((item) => item.name === name)
  }

  private async uploadConflicts(client: Client, files: FilePlan[]): Promise<SftpTransferConflict[]> {
    const conflicts: SftpTransferConflict[] = []
    const directoryEntries = new Map<string, Set<string>>()
    for (const file of files) {
      const parent = posix.dirname(ftpPath(file.remotePath))
      let names = directoryEntries.get(parent)
      if (!names) {
        names = new Set((await client.list(parent)).map((entry) => entry.name))
        directoryEntries.set(parent, names)
      }
      if (names.has(posix.basename(file.remotePath))) conflicts.push({ direction: 'upload', path: file.remotePath, name: file.relativePath })
    }
    return conflicts
  }

  private async collectDownloadPlan(client: Client, remoteDirectory: string, localDirectory: string, relativeDirectory: string, files: FilePlan[], directories: Set<string>, depth: number): Promise<void> {
    if (depth > 100) throw appError('TRANSFER_TOO_DEEP', 'Remote folder nesting exceeds 100 levels')
    directories.add(localDirectory)
    for (const entry of await this.readDirectory(client, remoteDirectory)) {
      const localPath = join(localDirectory, safeLocalFileName(entry.name))
      const relativePath = `${relativeDirectory}/${entry.name}`.replaceAll('\\', '/')
      if (entry.type === 'directory') await this.collectDownloadPlan(client, entry.path, localPath, relativePath, files, directories, depth + 1)
      else files.push({ localPath, remotePath: entry.path, relativePath, size: entry.size, modifiedAt: Math.floor(entry.modifiedAt / 1000) })
      if (files.length > MAX_TRANSFER_FILES) throw appError('TRANSFER_TOO_LARGE', `Folder contains more than ${MAX_TRANSFER_FILES} files`)
    }
  }

  private startTransfer(session: FtpSession, file: FilePlan, offset: number, hooks: TransferHooks, direction: 'upload' | 'download', parentModifiedAt?: number): TransferControl {
    let client: Client | undefined
    let transferred = offset
    let running = false
    let paused = false
    let cancelled = false
    let settled = false
    const start = async (): Promise<void> => {
      if (running || paused || cancelled || settled) return
      running = true
      let startAt = transferred
      try {
        client = await this.openClient(session.connection, session.password)
        if (paused || cancelled) return
        if (direction === 'upload' && startAt > 0) {
          startAt = Math.min(file.size, await client.size(ftpPath(file.remotePath)).catch(() => startAt))
          transferred = startAt
          hooks.progress(startAt)
          if (startAt >= file.size) {
            await setRemoteMtime(client, file.remotePath, file.modifiedAt)
            settled = true
            hooks.done()
            return
          }
        }
        client.trackProgress((info) => { transferred = startAt + info.bytesOverall; hooks.progress(transferred) })
        if (direction === 'upload') {
          if (startAt) await client.appendFrom(file.localPath, ftpPath(file.remotePath), { localStart: startAt })
          else await client.uploadFrom(file.localPath, ftpPath(file.remotePath))
          await setRemoteMtime(client, file.remotePath, file.modifiedAt)
          if (parentModifiedAt !== undefined) await setRemoteMtime(client, posix.dirname(file.remotePath), parentModifiedAt)
        } else {
          await client.downloadTo(file.localPath, ftpPath(file.remotePath), startAt)
          if (file.modifiedAt > 0) await utimes(file.localPath, file.modifiedAt, file.modifiedAt)
        }
        settled = true
        hooks.done()
      } catch (error) {
        if (!paused && !cancelled) { settled = true; hooks.done(toFtpError(error)) }
      } finally {
        client?.close()
        client = undefined
        running = false
        if (!paused && !cancelled && !settled) void start()
      }
    }
    void start()
    return {
      pause: () => { paused = true; client?.close() },
      resume: () => { paused = false; void start() },
      cancel: () => { cancelled = true; client?.close() }
    }
  }

  private assertTransferSession(sessionId: string, transferId: string): void {
    this.getSession(sessionId)
    if (this.transfers.getItem(transferId).sessionId !== sessionId) throw appError('TRANSFER_NOT_FOUND', 'Transfer not found in this session')
  }

  private emit(event: SftpTransferEvent): void { try { this.send('ftp:transfer', event) } catch { /* renderer may already be closed */ } }
  private emitStatus(event: SessionConnectionStatusEvent): void { try { this.send('ftp:status', event) } catch { /* renderer may already be closed */ } }
}

export function ftpPath(path: string): string {
  const normalized = validateRemotePath(path)
  if (/[\r\n]/.test(normalized)) throw appError('FTP_PATH_INVALID', 'Remote FTP path cannot contain line breaks')
  return normalized
}

function ftpEntryType(entry: FileInfo): SftpEntryType {
  return entry.isDirectory ? 'directory' : entry.isSymbolicLink ? 'link' : 'file'
}

function pathDepth(path: string): number { return path.split('/').filter(Boolean).length }

async function setRemoteMtime(client: Client, path: string, modifiedAt: number): Promise<void> {
  const value = new Date(modifiedAt * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14)
  await client.sendIgnoringError(`MFMT ${value} ${ftpPath(path)}`).catch(() => undefined)
}

function toFtpError(error: unknown): Error & { code: string } {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return error as Error & { code: string }
  return appError('FTP_FAILED', error instanceof Error ? error.message : 'FTP operation failed')
}
