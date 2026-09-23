import { lstat, readdir, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { LOCAL_COMPUTER_ROOT, type LocalDirectory, type LocalEntry, type LocalShortcut } from '../../shared/local-files'
import { MAX_TRANSFER_FILES } from '../../shared/transfer-limits'

type FileDetails = { isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number }
export type LocalFileSystem = {
  stat(path: string): Promise<Pick<FileDetails, 'isDirectory'>>
  lstat(path: string): Promise<FileDetails>
  readdir(path: string): Promise<string[]>
}
type LocalBrowserOptions = {
  defaultPath: string
  shortcuts: { location: LocalShortcut; path: string }[]
  platform?: NodeJS.Platform
  fileSystem?: LocalFileSystem
}
const fileSystem: LocalFileSystem = { stat: path => stat(path), lstat: path => lstat(path), readdir: path => readdir(path) }

async function availableDirectory(io: LocalFileSystem, path: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      io.stat(path).then(details => details.isDirectory()).catch(() => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000) })
    ])
  } finally { if (timer) clearTimeout(timer) }
}

export function localParentPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (path === LOCAL_COMPUTER_ROOT) return LOCAL_COMPUTER_ROOT
  const paths = platform === 'win32' ? win32 : posix
  const normalized = paths.resolve(path)
  const parent = paths.dirname(normalized)
  return parent === normalized ? LOCAL_COMPUTER_ROOT : parent
}

export async function listLocalDirectory(requestedPath: string | undefined, options: LocalBrowserOptions): Promise<LocalDirectory> {
  if (requestedPath !== undefined && typeof requestedPath !== 'string') throw new Error('Local directory path is invalid')
  const platform = options.platform ?? process.platform
  const paths = platform === 'win32' ? win32 : posix
  const io = options.fileSystem ?? fileSystem
  const input = requestedPath === undefined ? options.defaultPath : requestedPath
  if (input === LOCAL_COMPUTER_ROOT || !input.trim()) {
    const drives = platform === 'win32'
      ? Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`)
      : ['/']
    const candidates = [
      ...drives.map(path => ({ path, location: 'drive' as const })),
      ...options.shortcuts.map(item => ({ ...item }))
    ]
    const seen = new Set<string>()
    const unique = candidates.filter(item => {
      if (!paths.isAbsolute(item.path)) return false
      const normalized = paths.resolve(item.path)
      const key = platform === 'win32' ? normalized.toLowerCase() : normalized
      if (seen.has(key)) return false
      seen.add(key)
      item.path = normalized
      return true
    })
    const entries = (await Promise.all(unique.map(async item => {
      try {
        if (!await availableDirectory(io, item.path)) return null
        return { name: item.location === 'drive' ? item.path : paths.basename(item.path), path: item.path, type: 'directory' as const, size: 0, modifiedAt: 0, location: item.location }
      } catch { return null } // Disconnected drives and missing shortcuts must not hide other locations.
    }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    return { path: LOCAL_COMPUTER_ROOT, parentPath: LOCAL_COMPUTER_ROOT, entries }
  }
  if (input.length > 4096 || !paths.isAbsolute(input)) throw new Error('Local directory path is invalid')
  const path = paths.resolve(input)
  if (!(await io.stat(path)).isDirectory()) throw new Error('Local path is not a directory')
  // Read names first so inaccessible metadata on one root entry cannot fail the whole folder.
  const items = await io.readdir(path)
  const entries: LocalEntry[] = []
  const visibleItems = items.slice(0, MAX_TRANSFER_FILES)
  for (let index = 0; index < visibleItems.length; index += 256) {
    const batch = await Promise.all(visibleItems.slice(index, index + 256).map(async name => {
      const itemPath = paths.resolve(path, name)
      try {
        const details = await io.lstat(itemPath)
        const type: LocalEntry['type'] = details.isDirectory() ? 'directory' : details.isSymbolicLink() ? 'link' : 'file'
        return { name, path: itemPath, type, size: details.size, modifiedAt: details.mtimeMs }
      } catch { return null }
    }))
    entries.push(...batch.filter((item): item is NonNullable<typeof item> => item !== null))
  }
  entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name))
  return { path, parentPath: localParentPath(path, platform), entries }
}
