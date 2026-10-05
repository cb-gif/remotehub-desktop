import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureIpcSecurity, handleIpc, isTrustedPage } from '../src/main/ipc/security'
import { registerConnectionIpc } from '../src/main/ipc/connection.ipc'
import { registerAppIpc } from '../src/main/ipc/app.ipc'
import { SftpService } from '../src/main/services/sftp'
import { createConnectionExport } from '../src/shared/connection'
import { databaseResultToCsv, parseDatabaseCsv } from '../src/shared/database'
import type { Connection, ConnectionInput } from '../src/shared/types'

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), importPath: '', readClipboard: vi.fn(), writeClipboard: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler) },
  clipboard: { readText: mocks.readClipboard, writeText: mocks.writeClipboard },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [mocks.importPath] }) }
}))

const page = 'file:///C:/RemoteHub/dist/index.html'
const contents = { isDestroyed: () => false, mainFrame: { url: `${page}#/` } }
const trustedEvent = () => ({ sender: contents, senderFrame: contents.mainFrame }) as unknown as IpcMainInvokeEvent
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'remotehub-security-test-'))
  mocks.importPath = join(directory, 'connections.json')
  mocks.handlers.clear()
  mocks.readClipboard.mockReset()
  mocks.writeClipboard.mockReset()
  contents.mainFrame.url = `${page}#/`
  configureIpcSecurity(() => contents as unknown as WebContents, page)
})
afterEach(() => {
  configureIpcSecurity(() => null, '')
  if (dirname(resolve(directory)) === resolve(tmpdir())) rmSync(directory, { recursive: true, force: true })
})

describe('trusted IPC boundary', () => {
  it('awaits asynchronous clipboard operations and preserves read limits', async () => {
    registerAppIpc()
    mocks.readClipboard.mockResolvedValue('a'.repeat(1024 * 1024 + 1))
    await expect(mocks.handlers.get('app:readText')!(trustedEvent())).resolves.toHaveLength(1024 * 1024)
    mocks.writeClipboard.mockRejectedValueOnce(new Error('Clipboard unavailable'))
    await expect(mocks.handlers.get('app:copyText')!(trustedEvent(), 'value')).rejects.toThrow('Clipboard unavailable')
    expect(mocks.writeClipboard).toHaveBeenCalledWith('value')
  })
  it('accepts only the application main frame and checks before dispatch', () => {
    const action = vi.fn(() => 'accepted')
    handleIpc('security:test', action)
    const invoke = mocks.handlers.get('security:test')!
    expect(invoke(trustedEvent())).toBe('accepted')
    expect(() => invoke({ ...trustedEvent(), sender: {} })).toThrow(/trusted/)
    expect(() => invoke({ ...trustedEvent(), senderFrame: { url: page } })).toThrow(/trusted/)
    expect(() => invoke({ ...trustedEvent(), senderFrame: null })).toThrow(/trusted/)
    contents.mainFrame.url = 'https://example.invalid/'
    expect(() => invoke(trustedEvent())).toThrow(/trusted/)
    configureIpcSecurity(() => null, page)
    expect(() => invoke(trustedEvent())).toThrow(/trusted/)
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('allows hash routing without trusting a sibling file, origin lookalike or different dev page', () => {
    expect(isTrustedPage(`${page}#/workspace`, page)).toBe(true)
    expect(isTrustedPage(`${page}.html`, page)).toBe(false)
    expect(isTrustedPage(`${page}?external=true`, page)).toBe(false)
    expect(isTrustedPage('http://127.0.0.1:5173/#/', 'http://127.0.0.1:5173/')).toBe(true)
    expect(isTrustedPage('http://127.0.0.1:5173/untrusted.html', 'http://127.0.0.1:5173/')).toBe(false)
    expect(isTrustedPage('http://127.0.0.1:5173@evil.invalid/', 'http://127.0.0.1:5173/')).toBe(false)
    expect(isTrustedPage('not a URL', page)).toBe(false)
  })

  it('registers every public IPC handler through the sender guard', () => {
    for (const file of ['app', 'connection', 'database', 'local-shell', 'serial', 'sftp', 'ssh']) {
      const source = readFileSync(resolve(`src/main/ipc/${file}.ipc.ts`), 'utf8')
      expect(source).not.toContain('ipcMain.handle')
      expect(source).toContain('handleIpc(')
    }
  })
})

describe('imported credential identity', () => {
  const previous: Connection = { id: 'asset', name: 'Database', type: 'database', databaseType: 'postgres', databaseSslMode: 'verify-full', host: 'db.invalid', port: 5432, username: 'user', authType: 'password', credentialId: 'saved-secret', favorite: false, sortOrder: 0, createdAt: 1, updatedAt: 1 }

  async function importConnection(changes: Partial<ConnectionInput>, sharedCredential = false) {
    let saved: ConnectionInput = previous
    const storage = {
      listGroups: () => [], getConnection: () => saved,
      validateConnection: (input: ConnectionInput) => input,
      saveConnection: (input: ConnectionInput) => { saved = input; return input },
      hasCredentialReference: (id: string) => sharedCredential || saved.credentialId === id
    }
    const credentials = { delete: vi.fn() }
    const imported = createConnectionExport([previous], [])
    Object.assign(imported.connections[0], changes)
    writeFileSync(mocks.importPath, JSON.stringify(imported))
    registerConnectionIpc(storage as never, credentials as never)
    await mocks.handlers.get('connections:import')!(trustedEvent())
    return { saved, credentials }
  }

  it.each([
    { host: 'attacker.invalid' }, { port: 1234 }, { username: 'other' },
    { type: 'ftp' as const, port: 21 }, { authType: 'privateKey' as const },
    { databaseType: 'mysql' as const }, { databaseSslMode: 'disable' as const },
    { sshTunnelId: 'other-tunnel' }, { database: 'other-database' }
  ])('drops the saved secret when identity changes: %j', async (changes) => {
    const { saved, credentials } = await importConnection(changes)
    expect(saved.credentialId).toBeUndefined()
    expect(credentials.delete).toHaveBeenCalledWith('saved-secret')
  })

  it('preserves credentials when only display metadata changes', async () => {
    const { saved, credentials } = await importConnection({ name: 'Renamed', notes: 'Updated notes', favorite: true })
    expect(saved.credentialId).toBe('saved-secret')
    expect(credentials.delete).not.toHaveBeenCalled()
  })

  it('keeps a detached credential when another connection still uses it', async () => {
    const { saved, credentials } = await importConnection({ host: 'other.invalid' }, true)
    expect(saved.credentialId).toBeUndefined()
    expect(credentials.delete).not.toHaveBeenCalled()
  })
})

describe('bounded SFTP editing', () => {
  function serviceFor(stream: Readable, size = 0) {
    const service = new SftpService({} as never, {} as never, () => {})
    service['sessions'].set('fixture', { sftp: { stat: (_path: string, done: (error: undefined, attrs: object) => void) => done(undefined, { size, mtime: 1 }), createReadStream: () => stream } } as never)
    return service
  }

  it('stops an unbounded response even if the server announces a zero-byte file', async () => {
    let bytesProduced = 0
    const stream = new Readable({ read() { bytesProduced += 64 * 1024; this.push(Buffer.alloc(64 * 1024, 'a')) } })
    await expect(serviceFor(stream).readText('fixture', '/file')).rejects.toMatchObject({ code: 'SFTP_EDIT_TOO_LARGE' })
    expect(stream.destroyed).toBe(true)
    expect(bytesProduced).toBeLessThanOrEqual(2 * 1024 * 1024 + 2 * 64 * 1024)
  })

  it('preserves UTF-8 data and timestamps across chunks', async () => {
    const data = Buffer.from('安全文本')
    const stream = Readable.from([data.subarray(0, 2), data.subarray(2)])
    await expect(serviceFor(stream).readText('fixture', '/file')).resolves.toEqual({ content: '安全文本', modifiedAt: 1000 })
  })

  it('rejects binary input and read failures', async () => {
    await expect(serviceFor(Readable.from([Buffer.from([0])])).readText('fixture', '/file')).rejects.toMatchObject({ code: 'SFTP_EDIT_BINARY' })
    const stream = new Readable({ read() { this.destroy(new Error('remote failed')) } })
    await expect(serviceFor(stream).readText('fixture', '/file')).rejects.toThrow('remote failed')
    expect(stream.destroyed).toBe(true)
  })
})

describe('spreadsheet-safe CSV', () => {
  it('protects formula prefixes in text and headings while preserving numeric cells', () => {
    const values = ['=1+1', '+cmd', '-cmd', '@SUM(A1)', '  =1', '\t=1', '＝1+1', 'a,"b"', -12, null]
    const csv = databaseResultToCsv({ fileName: 'result.csv', columns: values.map((_, i) => i === 0 ? '=header' : `c${i}`), rows: [values] })
    const parsed = parseDatabaseCsv(csv)
    expect(csv).toContain('"\t=header"')
    expect(parsed.rows[0]).toEqual(['\t=1+1', '\t+cmd', '\t-cmd', '\t@SUM(A1)', '\t  =1', '\t\t=1', '\t＝1+1', 'a,"b"', '-12', ''])
  })

  it('retains exact values only when raw CSV is explicitly requested', () => {
    const csv = databaseResultToCsv({ fileName: 'result.csv', columns: ['value'], rows: [['=1+1']], spreadsheetSafe: false })
    expect(csv).toBe('value\r\n=1+1')
  })
})
