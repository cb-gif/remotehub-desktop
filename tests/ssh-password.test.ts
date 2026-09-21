import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { SshService } from '../src/main/services/ssh'
import type { Connection } from '../src/shared/types'

vi.mock('electron', () => ({ app: {}, safeStorage: {} }))

const connection: Connection = { id: 'ssh', name: 'Server', host: 'server.test', port: 22, username: 'user', type: 'ssh', authType: 'none', favorite: false, sortOrder: 0, createdAt: 0, updatedAt: 0 }
function setup() {
  const stream = Object.assign(new EventEmitter(), { close: vi.fn() })
  const client = Object.assign(new EventEmitter(), {
    connect: vi.fn(), end: vi.fn(),
    shell: (_options: unknown, done: (error: undefined, stream: unknown) => void) => done(undefined, stream)
  })
  const storage = { getConnection: vi.fn(() => connection), saveConnection: vi.fn(), markConnected: vi.fn() }
  const credentials = { get: vi.fn(), save: vi.fn(() => 'saved-secret') }
  const service = new SshService(storage as never, credentials as never, vi.fn())
  service['createClient'] = () => client as never
  return { service, client, storage, credentials }
}

describe('SSH connection-time password', () => {
  it('keeps an unsaved password only for the active session and matching SFTP target', async () => {
    const { service, client, credentials } = setup()
    const pending = service.connect(connection, { password: 'temporary', savePassword: false })
    expect(service.temporaryPassword(connection)).toBeUndefined()
    expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({ username: 'user', password: 'temporary' }))
    client.emit('ready')
    const result = await pending
    expect(credentials.save).not.toHaveBeenCalled()
    expect(service.temporaryPassword(connection)).toBe('temporary')
    expect(service.temporaryPassword({ ...connection, host: 'other.test' })).toBeUndefined()
    if ('sessionId' in result) service.disconnect(result.sessionId)
    expect(service.temporaryPassword(connection)).toBeUndefined()
  })
  it('saves the password only after successful authentication', async () => {
    const { service, client, credentials, storage } = setup()
    const pending = service.connect(connection, { password: 'correct', savePassword: true })
    expect(credentials.save).not.toHaveBeenCalled()
    client.emit('ready')
    await pending
    expect(credentials.save).toHaveBeenCalledWith('Server', 'correct', undefined)
    expect(storage.saveConnection).toHaveBeenCalledWith(expect.objectContaining({ authType: 'password', credentialId: 'saved-secret' }))
  })
  it('does not save rejected passwords', async () => {
    const { service, client, credentials } = setup()
    const pending = service.connect(connection, { password: 'wrong', savePassword: true })
    const rejected = expect(pending).rejects.toThrow('Authentication failed')
    client.emit('error', Object.assign(new Error('Rejected'), { level: 'client-authentication' }))
    await rejected
    expect(credentials.save).not.toHaveBeenCalled()
  })
  it('requires a username before opening any network connection', async () => {
    const { service, client } = setup()
    await expect(service.connect({ ...connection, username: ' ' }, { password: 'secret', savePassword: false })).rejects.toThrow('用户名')
    expect(client.connect).not.toHaveBeenCalled()
  })
  it('rejects when the peer closes before the session is ready', async () => {
    const { service, client } = setup()
    const pending = service.connect(connection, { password: 'temporary', savePassword: false })
    client.emit('end')
    await expect(pending).rejects.toThrow('closed before it was ready')
  })
})
