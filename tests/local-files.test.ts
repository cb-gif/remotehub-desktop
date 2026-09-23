import { describe, expect, it, vi } from 'vitest'
import { listLocalDirectory, localParentPath, type LocalFileSystem } from '../src/main/services/local-files'
import { LOCAL_COMPUTER_ROOT, localNavigationTarget, localTransferDirectory } from '../src/shared/local-files'
import { MAX_TRANSFER_FILES } from '../src/shared/transfer-limits'

const shortcuts = [
  { location: 'home', path: 'C:\\Users\\test-user' },
  { location: 'desktop', path: 'C:\\Users\\test-user\\Desktop' },
  { location: 'documents', path: 'C:\\Users\\test-user\\Documents' },
  { location: 'downloads', path: 'D:\\Downloads' }
] as const

function fakeFileSystem(): LocalFileSystem {
  const folders = new Set(['C:\\', 'D:\\', 'D:\\Learning', ...shortcuts.map(item => item.path)])
  return {
    stat: vi.fn(async path => {
      if (!folders.has(path)) throw new Error('Drive or folder not available')
      return { isDirectory: () => true }
    }),
    readdir: vi.fn(async () => ['protected', 'note.txt', 'Learning']),
    lstat: vi.fn(async path => {
      if (path.endsWith('protected')) throw new Error('Access denied')
      return { isDirectory: () => path.endsWith('Learning'), isSymbolicLink: () => false, size: 12, mtimeMs: 123 }
    })
  }
}

describe('local browser computer root for SFTP and FTP', () => {
  it('navigates from a child to the drive root and then to the computer view', () => {
    expect(localParentPath('D:\\Learning\\project', 'win32')).toBe('D:\\Learning')
    expect(localParentPath('D:\\Learning', 'win32')).toBe('D:\\')
    expect(localParentPath('D:\\', 'win32')).toBe(LOCAL_COMPUTER_ROOT)
    expect(localParentPath('C:/', 'win32')).toBe(LOCAL_COMPUTER_ROOT)
    expect(localParentPath('\\\\server\\share\\folder', 'win32')).toBe('\\\\server\\share\\')
    expect(localParentPath('\\\\server\\share\\', 'win32')).toBe(LOCAL_COMPUTER_ROOT)
    expect(localParentPath('/', 'linux')).toBe(LOCAL_COMPUTER_ROOT)
    expect(localParentPath(LOCAL_COMPUTER_ROOT, 'win32')).toBe(LOCAL_COMPUTER_ROOT)
  })

  it('keeps refresh at the virtual root and treats an explicit empty path as computer view', () => {
    expect(localNavigationTarget(undefined, LOCAL_COMPUTER_ROOT)).toBe(LOCAL_COMPUTER_ROOT)
    expect(localNavigationTarget('', 'D:\\')).toBe(LOCAL_COMPUTER_ROOT)
    expect(localNavigationTarget('  ', 'D:\\')).toBe(LOCAL_COMPUTER_ROOT)
    expect(localNavigationTarget('C:\\', LOCAL_COMPUTER_ROOT)).toBe('C:\\')
    expect(localNavigationTarget(undefined, '')).toBeUndefined()
  })

  it('lists available drives plus user, desktop, documents, and downloads shortcuts', async () => {
    const io = fakeFileSystem()
    const options = { defaultPath: 'D:\\Downloads', shortcuts: [...shortcuts], platform: 'win32' as const, fileSystem: io }
    const root = await listLocalDirectory(LOCAL_COMPUTER_ROOT, options)
    expect(root.path).toBe(LOCAL_COMPUTER_ROOT)
    expect(root.parentPath).toBe(LOCAL_COMPUTER_ROOT)
    expect(root.entries.map(entry => entry.name)).toEqual(['C:\\', 'D:\\', 'test-user', 'Desktop', 'Documents', 'Downloads'])
    expect(root.entries.map(entry => entry.location)).toEqual(['drive', 'drive', 'home', 'desktop', 'documents', 'downloads'])
    expect(io.readdir).not.toHaveBeenCalled()
    const drive = await listLocalDirectory(root.entries[1].path, options)
    expect(drive.path).toBe('D:\\')
    expect(drive.parentPath).toBe(LOCAL_COMPUTER_ROOT)
    const back = await listLocalDirectory(drive.parentPath, options)
    expect(back.entries).toEqual(root.entries)
  })

  it('skips unavailable entries and deduplicates Windows shortcuts without case sensitivity', async () => {
    const root = await listLocalDirectory('', {
      defaultPath: 'D:\\Downloads', platform: 'win32', fileSystem: fakeFileSystem(),
      shortcuts: [...shortcuts, { location: 'downloads', path: 'd:\\DOWNLOADS\\' }, { location: 'desktop', path: 'D:\\missing' }]
    })
    expect(root.entries).toHaveLength(6)
  })

  it('retains normal directory browsing when a protected entry cannot be read', async () => {
    const result = await listLocalDirectory('D:\\Learning', { defaultPath: 'D:\\Downloads', shortcuts: [], platform: 'win32', fileSystem: fakeFileSystem() })
    expect(result.parentPath).toBe('D:\\')
    expect(result.entries.map(entry => entry.name)).toEqual(['Learning', 'note.txt'])
  })

  it('shows up to 10,000 local files without launching all metadata reads at once', async () => {
    const names = Array.from({ length: MAX_TRANSFER_FILES + 1 }, (_, index) => `file-${index}.txt`)
    let active = 0
    let peak = 0
    const io: LocalFileSystem = {
      stat: async () => ({ isDirectory: () => true }),
      readdir: async () => names,
      lstat: async () => {
        active++
        peak = Math.max(peak, active)
        await Promise.resolve()
        active--
        return { isDirectory: () => false, isSymbolicLink: () => false, size: 1, mtimeMs: 0 }
      }
    }
    const result = await listLocalDirectory('D:\\', { defaultPath: 'D:\\', shortcuts: [], platform: 'win32', fileSystem: io })
    expect(result.entries).toHaveLength(MAX_TRANSFER_FILES)
    expect(peak).toBeLessThanOrEqual(256)
  })

  it('does not let an unresponsive mapped drive block the computer view', async () => {
    vi.useFakeTimers()
    try {
      const io = fakeFileSystem()
      const stat = io.stat
      io.stat = path => path === 'Z:\\' ? new Promise(() => {}) : stat(path)
      const result = listLocalDirectory(LOCAL_COMPUTER_ROOT, { defaultPath: 'D:\\', shortcuts: [], platform: 'win32', fileSystem: io })
      await vi.advanceTimersByTimeAsync(2000)
      expect((await result).entries.map(entry => entry.path)).toEqual(['C:\\', 'D:\\'])
    } finally { vi.useRealTimers() }
  })

  it('keeps a filesystem root and home shortcuts available on macOS and Linux', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const io = fakeFileSystem()
      io.stat = async () => ({ isDirectory: () => true })
      const result = await listLocalDirectory(LOCAL_COMPUTER_ROOT, { defaultPath: '/home/test/Downloads', shortcuts: [{ location: 'home', path: '/home/test' }], platform, fileSystem: io })
      expect(result.entries.map(entry => entry.path)).toEqual(['/', '/home/test'])
    }
  })

  it('uses downloads only for the initial unspecified path and rejects invalid paths', async () => {
    const options = { defaultPath: 'D:\\Downloads', shortcuts: [], platform: 'win32' as const, fileSystem: fakeFileSystem() }
    expect((await listLocalDirectory(undefined, options)).path).toBe('D:\\Downloads')
    await expect(listLocalDirectory('D:', options)).rejects.toThrow('invalid')
    await expect(listLocalDirectory('../', options)).rejects.toThrow('invalid')
    await expect(listLocalDirectory(null as unknown as string, options)).rejects.toThrow('invalid')
  })

  it('never passes the computer view to a download queue as a directory', () => {
    expect(localTransferDirectory(LOCAL_COMPUTER_ROOT)).toBeNull()
    expect(localTransferDirectory('')).toBeNull()
    expect(localTransferDirectory('D:\\')).toBe('D:\\')
  })
})
