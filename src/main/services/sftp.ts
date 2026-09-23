import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, statSync, utimes } from 'node:fs'
import { isUtf8 } from 'node:buffer'
import { basename, isAbsolute, join, posix } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { Connection } from '../../shared/types'
import type { SessionConnectionStatusEvent, TabConnectionStatus } from '../../shared/connection-status'
import { joinRemotePath, normalizeRemotePath, type SftpConnectResult, type SftpEntry, type SftpEntryType, type SftpQueueResult, type SftpTransferConflict, type SftpTransferEvent, type SftpTransferItem } from '../../shared/sftp'
import { sshErrorCode, type SshPasswordOptions } from '../../shared/ssh'
import { MAX_TRANSFER_FILES } from '../../shared/transfer-limits'
import { CredentialService } from './credentials'
import { fingerprintHostKey, hostKeyState } from './host-key'
import { appError, StorageService } from './storage'
import { TransferManager, type TransferControl, type TransferHooks } from './transfer-manager'

type SftpAttrs = { size?: number; mtime?: number; mode?: number }
type SftpListItem = { filename: string; attrs: SftpAttrs }
type SftpLike = {
  on?(event: string, listener: (...args: unknown[]) => void): SftpLike
  readdir(path: string, callback: (error: Error | undefined, list: SftpListItem[]) => void): void
  realpath(path: string, callback: (error: Error | undefined, resolved: string) => void): void
  stat(path: string, callback: (error: Error | undefined, attrs: SftpAttrs) => void): void
  mkdir(path: string, callback: (error?: Error) => void): void
  rename(oldPath: string, newPath: string, callback: (error?: Error) => void): void
  readFile(path: string, callback: (error: Error | undefined, data: Buffer) => void): void
  writeFile(path: string, data: Buffer, callback: (error?: Error) => void): void
  setstat(path: string, attrs: { atime: number; mtime: number }, callback: (error?: Error) => void): void
  unlink(path: string, callback: (error?: Error) => void): void
  rmdir(path: string, callback: (error?: Error) => void): void
  createReadStream(path: string, options: { start?: number }): Readable
  createWriteStream(path: string, options: { flags: string; start?: number }): Writable
  end(): void
}
type SshClientLike = {
  on(event: string, listener: (...args: unknown[]) => void): SshClientLike
  connect(config: Record<string, unknown>): void
  sftp(callback: (error: Error | undefined, sftp: SftpLike) => void): void
  end(): void
}
type SshClientConstructor = new () => SshClientLike
type SftpSession = { id: string; connectionId: string; client: SshClientLike; sftp: SftpLike }
type EventSink = (channel: 'sftp:transfer' | 'sftp:status', payload: SftpTransferEvent | SessionConnectionStatusEvent) => void
export type FilePlan = { localPath: string; remotePath: string; relativePath: string; size: number; modifiedAt: number }
export type DirectoryPlan = { path: string; modifiedAt: number }

const loadNativeModule = createRequire(__filename)
const MAX_EDIT_BYTES = 2 * 1024 * 1024

export class SftpService {
  private readonly sessions = new Map<string, SftpSession>()
  private readonly pendingHostKeys = new Map<string, string>()
  private readonly transfers: TransferManager

  constructor(private readonly storage: StorageService, private readonly credentials: CredentialService, private readonly send: EventSink, private readonly sessionPassword?: (connection: Connection) => string | undefined) {
    this.transfers = new TransferManager((item) => this.emit(item), 2)
  }

  async connect(connection: Connection, options?: SshPasswordOptions): Promise<SftpConnectResult> {
    if (connection.type !== 'ssh') throw appError('SFTP_CONNECTION_INVALID', 'SFTP requires an SSH connection')
    const credential = options?.password ?? (connection.authType === 'none' ? this.sessionPassword?.(connection) : this.credentials.get(connection.credentialId))
    if (!credential) throw appError('CREDENTIAL_MISSING', 'Save a password or private key before connecting')
    const client = this.createClient()
    let receivedHostKey: string | undefined
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        try { client.end() } catch { /* best effort */ }
        const state = receivedHostKey ? hostKeyState(connection.hostKeyFingerprint, receivedHostKey) : undefined
        if (state === 'new') {
          this.pendingHostKeys.set(connection.id, receivedHostKey!)
          resolve({ trustRequired: true, fingerprint: receivedHostKey! })
          return
        }
        if (state === 'changed') {
          reject(appError('SSH_HOST_KEY_CHANGED', `Host key changed for ${connection.host}:${connection.port}. Connection blocked.`))
          return
        }
        reject(toSftpError(error))
      }
      client.on('ready', () => {
        client.sftp((error, sftp) => {
          if (error) return fail(error)
          sftp.realpath('.', (pathError, homePath) => {
            if (pathError) return fail(pathError)
            if (settled) return
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
            const sessionId = randomUUID()
            this.sessions.set(sessionId, { id: sessionId, connectionId: connection.id, client, sftp })
            sftp.on?.('error', (error) => this.closeSession(sessionId, 'error', error instanceof Error ? error.message : 'SFTP channel failed'))
            sftp.on?.('end', () => this.closeSession(sessionId, 'closed'))
            sftp.on?.('close', () => this.closeSession(sessionId, 'closed'))
            try { this.storage.markConnected(connection.id, Date.now()) } catch { /* metadata is best effort */ }
            this.emitStatus({ sessionId, status: 'connected' })
            resolve({ sessionId, homePath: normalizeRemotePath(homePath || '/') })
          })
        })
      })
      client.on('error', (error) => {
        if (!settled) fail(error)
        else this.removeClient(client, 'error', error instanceof Error ? error.message : 'SFTP connection failed')
      })
      const closed = (): void => {
        if (!settled) fail(new Error('SFTP connection closed before it was ready'))
        else this.removeClient(client, 'closed')
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
      } catch (error) { fail(error) }
    })
  }

  trustHostKey(connectionId: string, fingerprint: string): void {
    if (this.storage.getConnection(connectionId)?.hostKeyFingerprint === fingerprint) return
    if (typeof connectionId !== 'string' || connectionId.length > 100 || this.pendingHostKeys.get(connectionId) !== fingerprint) throw appError('SSH_HOST_KEY_INVALID', 'Host key confirmation is invalid or expired')
    this.storage.trustHostKey(connectionId, fingerprint)
    this.pendingHostKeys.delete(connectionId)
  }

  list(sessionId: string, path: string): Promise<SftpEntry[]> {
    return this.readDirectory(this.getSession(sessionId).sftp, validateRemotePath(path))
  }

  mkdir(sessionId: string, path: string): Promise<void> {
    return this.call(sessionId, 'mkdir', validateRemotePath(path))
  }

  rename(sessionId: string, oldPath: string, newPath: string): Promise<void> {
    const session = this.getSession(sessionId)
    const source = validateRemotePath(oldPath)
    const target = validateRemotePath(newPath)
    if (source === target || posix.dirname(source) !== posix.dirname(target)) throw appError('SFTP_RENAME_INVALID', 'Enter a new file or folder name without slashes')
    return new Promise((resolve, reject) => session.sftp.rename(source, target, (error) => error ? reject(toSftpError(error)) : resolve()))
  }

  async readText(sessionId: string, pathInput: string): Promise<{ content: string; modifiedAt: number }> {
    const session = this.getSession(sessionId)
    const path = validateRemotePath(pathInput)
    const attrs = await this.remoteStat(session.sftp, path)
    if (!attrs) throw appError('SFTP_PATH_NOT_FOUND', 'Remote file no longer exists')
    if (Number(attrs.size || 0) > MAX_EDIT_BYTES) throw appError('SFTP_EDIT_TOO_LARGE', 'Online editing supports text files up to 2 MB')
    const data = await new Promise<Buffer>((resolve, reject) => session.sftp.readFile(path, (error, value) => error ? reject(toSftpError(error)) : resolve(value)))
    // ponytail: the built-in editor is UTF-8 text-only; use download/upload when binary or larger-file editing is needed.
    if (data.length > MAX_EDIT_BYTES) throw appError('SFTP_EDIT_TOO_LARGE', 'Online editing supports text files up to 2 MB')
    if (!isUtf8(data) || data.includes(0)) throw appError('SFTP_EDIT_BINARY', 'Online editing supports UTF-8 text files only')
    return { content: data.toString('utf8'), modifiedAt: Number(attrs.mtime || 0) * 1000 }
  }

  async writeText(sessionId: string, pathInput: string, content: string, expectedModifiedAt: number): Promise<{ modifiedAt: number }> {
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_EDIT_BYTES) throw appError('SFTP_EDIT_TOO_LARGE', 'Online editing supports text files up to 2 MB')
    const session = this.getSession(sessionId)
    const path = validateRemotePath(pathInput)
    const attrs = await this.remoteStat(session.sftp, path)
    if (!attrs) throw appError('SFTP_PATH_NOT_FOUND', 'Remote file no longer exists')
    if (Number(attrs.mtime || 0) * 1000 !== expectedModifiedAt) throw appError('SFTP_EDIT_CONFLICT', 'Remote file changed after it was opened; reopen it before saving')
    await new Promise<void>((resolve, reject) => session.sftp.writeFile(path, Buffer.from(content), (error) => error ? reject(toSftpError(error)) : resolve()))
    const updated = await this.remoteStat(session.sftp, path)
    return { modifiedAt: Number(updated?.mtime || 0) * 1000 }
  }

  remove(sessionId: string, path: string, type: SftpEntryType): Promise<void> {
    if (type !== 'file' && type !== 'directory' && type !== 'link') throw appError('SFTP_ENTRY_TYPE_INVALID', 'Remote entry type is invalid')
    return this.call(sessionId, type === 'directory' ? 'rmdir' : 'unlink', validateRemotePath(path))
  }

  async enqueueUploads(sessionId: string, localPaths: string[], remoteDirectory: string, overwrite: boolean): Promise<SftpQueueResult> {
    const session = this.getSession(sessionId)
    if (!Array.isArray(localPaths) || !localPaths.length || localPaths.length > MAX_TRANSFER_FILES || localPaths.some((path) => typeof path !== 'string')) throw appError('TRANSFER_INPUT_INVALID', `Choose between 1 and ${MAX_TRANSFER_FILES} files or folders`)
    const directory = validateRemotePath(remoteDirectory)
    const { files, directories } = buildUploadPlan(localPaths, directory)
    const conflicts = await findConflicts(files, async (file) => Boolean(await this.remoteStat(session.sftp, file.remotePath)), 'upload')
    if (conflicts.length && !overwrite) return { transferIds: [], conflicts }
    for (const directory of directories.sort((a, b) => pathDepth(a.path) - pathDepth(b.path))) await this.ensureRemoteDirectory(session.sftp, directory.path)
    for (const directory of directories) await this.setRemoteMtime(session.sftp, directory.path, directory.modifiedAt)
    const directoryTimes = new Map(directories.map((directory) => [directory.path, directory.modifiedAt]))
    const transferIds = files.map((file) => this.transfers.enqueue({
      sessionId,
      direction: 'upload',
      name: basename(file.localPath),
      relativePath: file.relativePath,
      total: file.size,
      start: (offset, hooks) => this.startUpload(session.sftp, file, offset, hooks, directoryTimes.get(posix.dirname(file.remotePath)))
    }).transferId)
    return { transferIds, conflicts: [] }
  }

  async enqueueDownload(sessionId: string, remotePathInput: string, localDirectoryInput: string, entryType: SftpEntryType, overwrite: boolean): Promise<SftpQueueResult> {
    const session = this.getSession(sessionId)
    const remotePath = validateRemotePath(remotePathInput)
    const localDirectory = validateLocalDirectory(localDirectoryInput)
    if (entryType !== 'file' && entryType !== 'directory' && entryType !== 'link') throw appError('SFTP_ENTRY_TYPE_INVALID', 'Remote entry type is invalid')
    const rootName = posix.basename(remotePath)
    safeLocalFileName(rootName)
    const files: FilePlan[] = []
    const directories = new Set<string>()
    if (entryType === 'directory') await this.collectDownloadPlan(session.sftp, remotePath, join(localDirectory, rootName), rootName, files, directories, 0)
    else {
      const attrs = await this.remoteStat(session.sftp, remotePath)
      if (!attrs) throw appError('SFTP_PATH_NOT_FOUND', 'Remote file no longer exists')
      files.push({ localPath: join(localDirectory, rootName), remotePath, relativePath: rootName, size: Number(attrs.size || 0), modifiedAt: Number(attrs.mtime || 0) })
    }
    assertUniqueLocalTargets(files)
    const conflicts = await findConflicts(files, async (file) => existsSync(file.localPath), 'download')
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
      start: (offset, hooks) => this.startDownload(session.sftp, file, offset, hooks)
    }).transferId)
    return { transferIds, conflicts: [] }
  }

  listTransfers(sessionId: string): SftpTransferItem[] {
    this.getSession(sessionId)
    return this.transfers.list(sessionId)
  }

  pauseTransfer(sessionId: string, transferId: string): SftpTransferItem {
    this.assertTransferSession(sessionId, transferId)
    return this.transfers.pause(transferId)
  }

  resumeTransfer(sessionId: string, transferId: string): SftpTransferItem {
    this.assertTransferSession(sessionId, transferId)
    return this.transfers.resume(transferId)
  }

  cancelTransfer(sessionId: string, transferId: string): SftpTransferItem {
    this.assertTransferSession(sessionId, transferId)
    return this.transfers.cancel(transferId)
  }

  retryTransfer(sessionId: string, transferId: string): SftpTransferItem {
    this.assertTransferSession(sessionId, transferId)
    return this.transfers.retry(transferId)
  }

  clearFinishedTransfers(sessionId: string): void {
    this.getSession(sessionId)
    this.transfers.clearFinished(sessionId)
  }

  disconnect(sessionId: string): void {
    this.closeSession(sessionId, 'closed')
  }

  private closeSession(sessionId: string, status: TabConnectionStatus, message?: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    this.transfers.closeSession(sessionId)
    this.emitStatus({ sessionId, status, message })
    try { session.sftp.end() } catch { /* best effort */ }
    try { session.client.end() } catch { /* best effort */ }
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.disconnect(id)
    this.pendingHostKeys.clear()
  }

  private createClient(): SshClientLike {
    try {
      const module = loadNativeModule('ssh2') as { Client?: SshClientConstructor }
      if (!module.Client) throw new Error('ssh2 Client export is unavailable')
      return new module.Client()
    } catch { throw appError('SFTP_UNAVAILABLE', 'SFTP module is unavailable; run npm install and restart') }
  }

  private getSession(sessionId: string): SftpSession {
    if (typeof sessionId !== 'string' || sessionId.length > 100) throw appError('SFTP_SESSION_INVALID', 'SFTP session identifier is invalid')
    const session = this.sessions.get(sessionId)
    if (!session) throw appError('SFTP_SESSION_NOT_FOUND', 'SFTP session is not available')
    return session
  }

  private assertTransferSession(sessionId: string, transferId: string): void {
    this.getSession(sessionId)
    if (this.transfers.getItem(transferId).sessionId !== sessionId) throw appError('TRANSFER_NOT_FOUND', 'Transfer not found in this session')
  }

  private readDirectory(sftp: SftpLike, path: string): Promise<SftpEntry[]> {
    return new Promise((resolve, reject) => sftp.readdir(path, (error, list) => {
      if (error) return reject(toSftpError(error))
      resolve(list.filter((item) => item.filename !== '.' && item.filename !== '..').map((item) => ({
        name: item.filename,
        path: joinRemotePath(path, item.filename),
        type: modeType(item.attrs.mode),
        size: Number(item.attrs.size || 0),
        modifiedAt: Number(item.attrs.mtime || 0) * 1000,
        mode: Number(item.attrs.mode || 0)
      })).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
    }))
  }

  private remoteStat(sftp: SftpLike, path: string): Promise<SftpAttrs | undefined> {
    return new Promise((resolve) => sftp.stat(path, (error, attrs) => resolve(error ? undefined : attrs)))
  }

  private async ensureRemoteDirectory(sftp: SftpLike, path: string): Promise<void> {
    const existing = await this.remoteStat(sftp, path)
    if (existing) {
      if (modeType(existing.mode) !== 'directory') throw appError('TRANSFER_DIRECTORY_CONFLICT', `A file blocks the remote folder: ${path}`)
      return
    }
    await new Promise<void>((resolve, reject) => sftp.mkdir(path, (error) => error ? reject(toSftpError(error)) : resolve()))
  }

  private async collectDownloadPlan(sftp: SftpLike, remoteDirectory: string, localDirectory: string, relativeDirectory: string, files: FilePlan[], directories: Set<string>, depth: number): Promise<void> {
    if (depth > 100) throw appError('TRANSFER_TOO_DEEP', 'Remote folder nesting exceeds 100 levels')
    directories.add(localDirectory)
    const entries = await this.readDirectory(sftp, remoteDirectory)
    for (const entry of entries) {
      const localPath = join(localDirectory, safeLocalFileName(entry.name))
      const relativePath = `${relativeDirectory}/${entry.name}`.replaceAll('\\', '/')
      if (entry.type === 'directory') await this.collectDownloadPlan(sftp, entry.path, localPath, relativePath, files, directories, depth + 1)
      else files.push({ localPath, remotePath: entry.path, relativePath, size: entry.size, modifiedAt: Math.floor(entry.modifiedAt / 1000) })
      if (files.length > MAX_TRANSFER_FILES) throw appError('TRANSFER_TOO_LARGE', `Folder contains more than ${MAX_TRANSFER_FILES} files`)
    }
  }

  private startUpload(sftp: SftpLike, file: FilePlan, offset: number, hooks: TransferHooks, parentModifiedAt?: number): TransferControl {
    return pipeTransfer(createReadStream(file.localPath, { start: offset }), sftp.createWriteStream(file.remotePath, { flags: offset > 0 ? 'r+' : 'w', start: offset }), offset, {
      ...hooks,
      done: (error) => {
        if (error) return hooks.done(error)
        void this.setRemoteMtime(sftp, file.remotePath, file.modifiedAt)
          .then(() => parentModifiedAt === undefined ? undefined : this.setRemoteMtime(sftp, posix.dirname(file.remotePath), parentModifiedAt))
          .then(() => hooks.done(), hooks.done)
      }
    })
  }

  private startDownload(sftp: SftpLike, file: FilePlan, offset: number, hooks: TransferHooks): TransferControl {
    return pipeTransfer(sftp.createReadStream(file.remotePath, { start: offset }), createWriteStream(file.localPath, { flags: offset > 0 ? 'r+' : 'w', start: offset }), offset, {
      ...hooks,
      done: (error) => error ? hooks.done(error) : utimes(file.localPath, file.modifiedAt, file.modifiedAt, (timeError) => timeError ? hooks.done(timeError) : hooks.done())
    })
  }

  private call(sessionId: string, method: 'mkdir' | 'unlink' | 'rmdir', path: string): Promise<void> {
    const session = this.getSession(sessionId)
    return new Promise((resolve, reject) => session.sftp[method](path, (error) => error ? reject(toSftpError(error)) : resolve()))
  }

  private setRemoteMtime(sftp: SftpLike, path: string, modifiedAt: number): Promise<void> {
    return new Promise((resolve, reject) => sftp.setstat(path, { atime: modifiedAt, mtime: modifiedAt }, (error) => error ? reject(toSftpError(error)) : resolve()))
  }

  private emit(event: SftpTransferEvent): void {
    try { this.send('sftp:transfer', event) } catch { /* renderer may already be closed */ }
  }

  private emitStatus(event: SessionConnectionStatusEvent): void {
    try { this.send('sftp:status', event) } catch { /* renderer may already be closed */ }
  }

  private removeClient(client: SshClientLike, status: 'closed' | 'error', message?: string): void {
    for (const [id, session] of this.sessions) if (session.client === client) {
      this.closeSession(id, status, message)
    }
  }
}

export function buildUploadPlan(localPaths: string[], remoteDirectory: string): { files: FilePlan[]; directories: DirectoryPlan[] } {
  const files: FilePlan[] = []
  const directories = new Map<string, number>()
  const targets = new Set<string>()
  const addFile = (localPath: string, remotePath: string, relativePath: string): void => {
    if (files.length >= MAX_TRANSFER_FILES) throw appError('TRANSFER_TOO_LARGE', `Selection contains more than ${MAX_TRANSFER_FILES} files`)
    if (targets.has(remotePath)) throw appError('TRANSFER_DUPLICATE_TARGET', `Multiple local files map to ${remotePath}`)
    targets.add(remotePath)
    const stat = statSync(localPath)
    files.push({ localPath, remotePath, relativePath, size: stat.size, modifiedAt: Math.floor(stat.mtimeMs / 1000) })
  }
  const walk = (localDirectory: string, remotePath: string, relativePath: string, depth: number): void => {
    if (depth > 100) throw appError('TRANSFER_TOO_DEEP', 'Local folder nesting exceeds 100 levels')
    directories.set(remotePath, Math.floor(statSync(localDirectory).mtimeMs / 1000))
    for (const entry of readdirSync(localDirectory, { withFileTypes: true })) {
      const localChild = join(localDirectory, entry.name)
      const remoteChild = joinRemotePath(remotePath, entry.name)
      const relativeChild = `${relativePath}/${entry.name}`.replaceAll('\\', '/')
      if (entry.isDirectory()) walk(localChild, remoteChild, relativeChild, depth + 1)
      else if (entry.isFile()) addFile(localChild, remoteChild, relativeChild)
    }
  }
  for (const path of localPaths) {
    const localPath = validateLocalPath(path)
    const stat = lstatSync(localPath)
    const name = basename(localPath)
    const remotePath = joinRemotePath(remoteDirectory, name)
    if (stat.isDirectory()) walk(localPath, remotePath, name, 0)
    else if (stat.isFile()) addFile(localPath, remotePath, name)
    else throw appError('TRANSFER_INPUT_INVALID', `Unsupported local item: ${name}`)
  }
  return { files, directories: [...directories].map(([path, modifiedAt]) => ({ path, modifiedAt })) }
}

async function findConflicts(files: FilePlan[], exists: (file: FilePlan) => Promise<boolean>, direction: 'upload' | 'download'): Promise<SftpTransferConflict[]> {
  const conflicts: SftpTransferConflict[] = []
  let next = 0
  const workers = Array.from({ length: Math.min(8, files.length) }, async () => {
    while (next < files.length) {
      const file = files[next++]
      if (await exists(file)) conflicts.push({ direction, path: direction === 'upload' ? file.remotePath : file.localPath, name: file.relativePath })
    }
  })
  await Promise.all(workers)
  return conflicts.sort((a, b) => a.name.localeCompare(b.name))
}

export function pipeTransfer(source: Readable, target: Writable, offset: number, hooks: TransferHooks): TransferControl {
  let transferred = offset
  let settled = false
  const done = (error?: Error): void => {
    if (settled) return
    settled = true
    hooks.done(error)
  }
  source.on('data', (chunk: Buffer | string) => {
    transferred += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
    hooks.progress(transferred)
  })
  source.once('error', done)
  target.once('error', done)
  target.once('close', () => done())
  source.pipe(target)
  return {
    pause: () => source.pause(),
    resume: () => source.resume(),
    cancel: () => { source.unpipe(target); source.destroy(); target.destroy() }
  }
}

export function validateRemotePath(path: string): string {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) throw appError('SFTP_PATH_INVALID', 'Remote path is invalid')
  return normalizeRemotePath(path)
}

function validateLocalPath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 32767 || !existsSync(path)) throw appError('SFTP_LOCAL_PATH_INVALID', 'Local path is invalid or no longer exists')
  return path
}

export function validateLocalDirectory(path: string): string {
  const localPath = validateLocalPath(path)
  if (!lstatSync(localPath).isDirectory()) throw appError('SFTP_LOCAL_PATH_INVALID', 'Choose a local folder')
  return localPath
}

function modeType(mode = 0): SftpEntryType {
  const kind = mode & 0o170000
  return kind === 0o040000 ? 'directory' : kind === 0o120000 ? 'link' : 'file'
}

function pathDepth(path: string): number {
  return path.split('/').filter(Boolean).length
}

export function safeLocalFileName(name: string): string {
  const windowsStem = name.split('.')[0].toUpperCase()
  const windowsReserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(windowsStem)
  const invalid = !name || name === '.' || name === '..' || name.includes('/') || name.includes('\0') || (process.platform === 'win32' && (/[\\:*?"<>|]/.test(name) || /[. ]$/.test(name) || windowsReserved))
  if (invalid) throw appError('TRANSFER_FILENAME_UNSUPPORTED', `Remote filename is not supported on this computer: ${name}`)
  return name
}

export function assertUniqueLocalTargets(files: FilePlan[]): void {
  const targets = new Set<string>()
  for (const file of files) {
    const key = process.platform === 'win32' ? file.localPath.toLocaleLowerCase() : file.localPath
    if (targets.has(key)) throw appError('TRANSFER_DUPLICATE_TARGET', `Remote names collide on this computer: ${file.relativePath}`)
    targets.add(key)
  }
}

function toSftpError(error: unknown): Error & { code: string } {
  const source = error as (NodeJS.ErrnoException & { level?: string }) | undefined
  return appError(sshErrorCode(source?.code, source?.level).replace(/^SSH_/, 'SFTP_'), error instanceof Error ? error.message : 'SFTP operation failed')
}
