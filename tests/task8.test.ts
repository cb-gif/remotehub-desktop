import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once, Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConnectionExport, parseConnectionExport } from '../src/shared/connection'
import { buildUploadPlan, pipeTransfer, SftpService } from '../src/main/services/sftp'
import type { Connection } from '../src/shared/types'

const temporaryPaths: string[] = []
afterEach(() => temporaryPaths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))

describe('connection JSON and SFTP upload metadata', () => {
  it('exports connection settings without credentials and validates imports', () => {
    const connection: Connection = { id: 'ssh-1', name: 'Server', type: 'ssh', host: 'server.test', port: 22, credentialId: 'secret', hostKeyFingerprint: 'SHA256:secret', favorite: false, sortOrder: 0, createdAt: 1, updatedAt: 2 }
    const exported = createConnectionExport([connection], [])
    expect(exported.connections[0]).not.toHaveProperty('credentialId')
    expect(exported.connections[0]).not.toHaveProperty('hostKeyFingerprint')
    expect(parseConnectionExport(JSON.stringify(exported))).toEqual(exported)
    expect(() => parseConnectionExport('{"version":2,"groups":[],"connections":[]}')).toThrow()
  })

  it('keeps source modification times in the upload plan', () => {
    const root = mkdtempSync(join(tmpdir(), 'remotehub-upload-'))
    temporaryPaths.push(root)
    const folder = join(root, 'folder')
    const file = join(folder, 'note.txt')
    mkdirSync(folder)
    writeFileSync(file, 'hello')
    const fileTime = new Date('2024-01-02T03:04:05Z')
    const folderTime = new Date('2023-06-07T08:09:10Z')
    utimesSync(file, fileTime, fileTime)
    utimesSync(folder, folderTime, folderTime)

    const plan = buildUploadPlan([folder], '/remote')
    expect(plan.files[0]).toMatchObject({ remotePath: '/remote/folder/note.txt', modifiedAt: Math.floor(fileTime.getTime() / 1000) })
    expect(plan.directories).toContainEqual({ path: '/remote/folder', modifiedAt: Math.floor(folderTime.getTime() / 1000) })
  })

  it('accepts more than 100 files in one upload plan', () => {
    const root = mkdtempSync(join(tmpdir(), 'remotehub-bulk-upload-'))
    temporaryPaths.push(root)
    const files = Array.from({ length: 101 }, (_, index) => {
      const path = join(root, `file-${index}.txt`)
      writeFileSync(path, '')
      return path
    })
    expect(buildUploadPlan(files, '/remote').files).toHaveLength(101)
  })

  it('waits for the destination handle to close before completing an upload', async () => {
    const done = vi.fn()
    const target = new Writable({ autoDestroy: false, write: (_chunk, _encoding, callback) => callback() })
    const closed = once(target, 'close')
    pipeTransfer(Readable.from('hello'), target, 0, { progress: () => undefined, done })
    await once(target, 'finish')
    expect(done).not.toHaveBeenCalled()
    target.destroy()
    await closed
    expect(done).toHaveBeenCalledOnce()
  })

  it('keeps the remote modification time after downloading a file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'remotehub-download-'))
    temporaryPaths.push(root)
    const localPath = join(root, 'note.txt')
    const modifiedAt = Math.floor(new Date('2024-01-02T03:04:05Z').getTime() / 1000)
    const done = vi.fn()
    const service = new SftpService(null as never, null as never, () => undefined)

    service['startDownload'](
      { createReadStream: () => Readable.from('hello') } as never,
      { localPath, remotePath: '/note.txt', relativePath: 'note.txt', size: 5, modifiedAt },
      0,
      { progress: () => undefined, done }
    )

    await vi.waitFor(() => expect(done).toHaveBeenCalledWith())
    expect(Math.floor(statSync(localPath).mtimeMs / 1000)).toBe(modifiedAt)
  })
})
