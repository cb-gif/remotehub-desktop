import { dialog } from 'electron'
import { handleIpc } from './security'
import { createConnection } from 'node:net'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { canRetainImportedCredential, connectionErrorCode, createConnectionExport, parseConnectionExport } from '../../shared/connection'
import type { Connection, ConnectionOrderItem, ConnectionSaveRequest, ConnectionTestRequest, ConnectionTestResult } from '../../shared/types'
import { CredentialService } from '../services/credentials'
import { appError, StorageService } from '../services/storage'

export function registerConnectionIpc(storage: StorageService, credentials: CredentialService, testSerial?: (connection: Connection) => Promise<ConnectionTestResult>, testDatabase?: (connection: Connection, credential?: string) => Promise<ConnectionTestResult>): void {
  handleIpc('connections:list', () => ({ connections: storage.listConnections(), groups: storage.listGroups() }))
  handleIpc('connections:save', (_event, request: ConnectionSaveRequest) => {
    if (!request || typeof request !== 'object' || !request.connection || typeof request.connection !== 'object') throw appError('INVALID_CONNECTION', 'Connection input is invalid')
    if (request.credential !== undefined && typeof request.credential !== 'string') throw appError('INVALID_CREDENTIAL', 'Credential is invalid')
    if (request.privateKeyPath !== undefined && typeof request.privateKeyPath !== 'string') throw appError('PRIVATE_KEY_FILE_INVALID', 'Private key file path is invalid')
    storage.validateConnection(request.connection)
    if (request.connection.type === 'ssh' && !request.connection.username?.trim()) throw appError('SSH_USERNAME_REQUIRED', 'SSH 用户名不能为空')
    if (request.connection.type === 'ssh' && request.connection.authType === 'none') {
      request = { ...request, credential: undefined, privateKeyPath: undefined, clearCredential: true }
    }
    const previousCredentialId = request.connection.credentialId
    const credentialId = request.connection.type === 'serial' || request.connection.type === 'shell'
      ? undefined
      : request.privateKeyPath
        ? credentials.savePrivateKeyFile(request.connection.name, request.privateKeyPath, previousCredentialId)
        : request.credential
      ? credentials.save(request.connection.name, request.credential, previousCredentialId)
      : request.clearCredential ? undefined : previousCredentialId
    const connection = storage.saveConnection({ ...request.connection, credentialId })
    if ((request.clearCredential || request.connection.type === 'serial' || request.connection.type === 'shell') && previousCredentialId && !storage.hasCredentialReference(previousCredentialId)) credentials.delete(previousCredentialId)
    return connection
  })
  handleIpc('connections:delete', (_event, id: string) => {
    const credentialId = storage.getConnection(id)?.credentialId
    storage.deleteConnection(id)
    if (credentialId && !storage.hasCredentialReference(credentialId)) credentials.delete(credentialId)
    return { ok: true }
  })
  handleIpc('connections:duplicate', (_event, id: string) => storage.duplicateConnection(id))
  handleIpc('connections:reorder', (_event, items: ConnectionOrderItem[]) => storage.reorderConnections(items))
  handleIpc('connections:export', async () => {
    const result = await dialog.showSaveDialog({ title: 'Export connections', defaultPath: 'remotehub-connections.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (result.canceled || !result.filePath) return { canceled: true, count: 0 }
    const data = createConnectionExport(storage.listConnections(), storage.listGroups())
    await writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf8')
    return { canceled: false, count: data.connections.length }
  })
  handleIpc('connections:import', async () => {
    const result = await dialog.showOpenDialog({ title: 'Import connections', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) return { canceled: true, count: 0 }
    if ((await stat(filePath)).size > 5 * 1024 * 1024) throw appError('CONNECTION_IMPORT_TOO_LARGE', 'Connection JSON must be 5 MB or smaller')
    const data = parseConnectionExport(await readFile(filePath, 'utf8'))
    const groupIds = new Set([...storage.listGroups().map((group) => group.id), ...data.groups.map((group) => group.id)])
    data.connections.forEach((connection) => {
      if (connection.groupId && !groupIds.has(connection.groupId)) throw appError('GROUP_NOT_FOUND', `Imported group not found: ${connection.groupId}`)
      storage.validateConnection({ ...connection, groupId: undefined })
    })
    data.groups.sort((a, b) => a.sortOrder - b.sortOrder).forEach((group) => storage.saveGroup(group.name, group.id))
    data.connections.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)).forEach((connection) => {
      const previous = storage.getConnection(connection.id!)
      const previousCredentialId = previous?.credentialId
      const normalized = storage.validateConnection(connection)
      const credentialId = canRetainImportedCredential(previous, normalized) ? previousCredentialId : undefined
      storage.saveConnection({ ...connection, credentialId })
      if (previousCredentialId && !storage.hasCredentialReference(previousCredentialId)) credentials.delete(previousCredentialId)
    })
    return { canceled: false, count: data.connections.length }
  })
  handleIpc('connections:test', async (_event, target: string | ConnectionTestRequest) => {
    const request = typeof target === 'string' ? undefined : target
    if (request && (typeof request !== 'object' || !request.connection || typeof request.connection !== 'object')) throw appError('INVALID_CONNECTION', 'Connection input is invalid')
    if (request?.credential !== undefined && typeof request.credential !== 'string') throw appError('INVALID_CREDENTIAL', 'Credential is invalid')
    const input = request?.connection
    const normalized = input ? storage.validateConnection(input) : undefined
    const connection = typeof target === 'string' ? storage.getConnection(target) : normalized ? { ...normalized, id: input?.id || 'test', createdAt: 0, updatedAt: 0 } : undefined
    if (!connection) return { ok: false, code: 'CONNECTION_FAILED', message: 'Connection not found', latencyMs: 0, testedAt: Date.now() } satisfies ConnectionTestResult
    const result = connection.type === 'shell'
      ? await testLocalDirectory(connection.host)
      : connection.type === 'serial' && testSerial
      ? await testSerial(connection)
      : connection.type === 'database' && testDatabase
        ? await testDatabase(connection, request?.credential)
        : await testTcpConnection(connection.host, connection.port)
    if (result.ok && typeof target === 'string') storage.markConnected(target, result.testedAt)
    return result
  })
  handleIpc('groups:save', (_event, name: string, id?: string) => storage.saveGroup(name, id))
  handleIpc('groups:reorder', (_event, ids: string[]) => storage.reorderGroups(ids))
  handleIpc('groups:delete', (_event, id: string) => {
    storage.deleteGroup(id)
    return { ok: true }
  })
}

async function testLocalDirectory(path: string): Promise<ConnectionTestResult> {
  const startedAt = Date.now()
  try {
    const ok = (await stat(path)).isDirectory()
    return { ok, code: ok ? 'OK' : 'CONNECTION_FAILED', message: ok ? 'Directory is available' : 'Path is not a directory', latencyMs: Date.now() - startedAt, testedAt: Date.now() }
  } catch (error) {
    return { ok: false, code: 'CONNECTION_FAILED', message: error instanceof Error ? error.message : 'Directory is unavailable', latencyMs: Date.now() - startedAt, testedAt: Date.now() }
  }
}

function testTcpConnection(host: string, port: number): Promise<ConnectionTestResult> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    let done = false
    const finish = (ok: boolean, code: ConnectionTestResult['code'], message: string): void => {
      if (done) return
      done = true
      socket.destroy()
      resolve({ ok, code, message, latencyMs: Date.now() - startedAt, testedAt: Date.now() })
    }
    socket.setTimeout(5000)
    socket.once('connect', () => finish(true, 'OK', 'Connection succeeded'))
    socket.once('timeout', () => finish(false, 'CONNECTION_TIMEOUT', 'Connection timed out'))
    socket.once('error', (error: NodeJS.ErrnoException) => finish(false, connectionErrorCode(error.code), error.message))
  })
}
