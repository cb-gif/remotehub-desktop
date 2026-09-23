import { describe, expect, it, vi } from 'vitest'
import { ftpPath, FtpService } from '../src/main/services/ftp'
import type { FilePlan } from '../src/main/services/sftp'

describe('FTP path validation', () => {
  it('normalizes paths and blocks FTP command injection', () => {
    expect(ftpPath('/files/../upload/report.txt')).toBe('/upload/report.txt')
    expect(() => ftpPath('/upload/report.txt\r\nDELE /important')).toThrow('line breaks')
  })
})

describe('FTP bulk upload conflict checks', () => {
  it('lists each destination directory once for many dragged files', async () => {
    const service = new FtpService(null as never, null as never, () => undefined)
    const list = vi.fn(async () => [{ name: 'existing.txt' }])
    const files: FilePlan[] = ['existing.txt', 'new.txt', 'another.txt'].map((name) => ({
      localPath: `C:\\${name}`, remotePath: `/upload/${name}`, relativePath: name, size: 1, modifiedAt: 0
    }))
    const conflicts = await service['uploadConflicts']({ list } as never, files)
    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith('/upload')
    expect(conflicts).toEqual([{ direction: 'upload', path: '/upload/existing.txt', name: 'existing.txt' }])
  })
})
