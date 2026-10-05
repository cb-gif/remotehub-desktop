import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ensurePtyHelpersExecutable, hasPortablePrebuild, hasPtyPrebuild } from '../scripts/native-dependencies.mjs'

describe('node-pty release prebuild selection', () => {
  it('selects portable SQLite and serial bindings for the target OS, architecture and libc', () => {
    const root = resolve(tmpdir())
    const directory = mkdtempSync(join(root, 'remotehub-prebuild-test-'))
    try {
      mkdirSync(join(directory, 'prebuilds', 'linux-arm64'), { recursive: true })
      mkdirSync(join(directory, 'prebuilds', 'darwin-x64+arm64'), { recursive: true })
      writeFileSync(join(directory, 'prebuilds', 'linuxmusl-arm64.node'), '')
      writeFileSync(join(directory, 'prebuilds', 'linux-arm64', '@serialport+bindings-cpp.armv8.glibc.node'), '')
      writeFileSync(join(directory, 'prebuilds', 'darwin-x64+arm64', '@serialport+bindings-cpp.node'), '')
      expect(hasPortablePrebuild('better-sqlite3', directory, 'linux', 'arm64', 'musl')).toBe(true)
      expect(hasPortablePrebuild('better-sqlite3', directory, 'linux', 'arm64', 'glibc')).toBe(false)
      expect(hasPortablePrebuild('better-sqlite3', directory, 'linux', 'x64', 'musl')).toBe(false)
      expect(hasPortablePrebuild('@serialport/bindings-cpp', directory, 'linux', 'arm64', 'glibc')).toBe(true)
      expect(hasPortablePrebuild('@serialport/bindings-cpp', directory, 'linux', 'arm64', 'musl')).toBe(false)
      expect(hasPortablePrebuild('@serialport/bindings-cpp', directory, 'darwin', 'x64')).toBe(true)
      expect(hasPortablePrebuild('@serialport/bindings-cpp', directory, 'darwin', 'arm64')).toBe(true)
      expect(hasPortablePrebuild('@serialport/bindings-cpp', directory, 'win32', 'x64')).toBe(false)
    } finally {
      if (dirname(directory) !== root || !directory.startsWith(join(root, 'remotehub-prebuild-test-'))) throw new Error('Unsafe test cleanup path')
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('restores execute permissions on macOS helpers before packaging', () => {
    const root = resolve('node_modules/node-pty')
    const helper = join(root, 'prebuilds/darwin-arm64/spawn-helper')
    const chmodSync = vi.fn()
    const io = {
      existsSync: (path: string) => path === helper,
      statSync: () => ({ isFile: () => true, mode: 0o100644 }),
      chmodSync
    }
    ensurePtyHelpersExecutable(root, 'darwin', 'arm64', io)
    expect(chmodSync).toHaveBeenCalledTimes(1)
    expect(chmodSync).toHaveBeenCalledWith(helper, 0o755)
    chmodSync.mockClear()
    ensurePtyHelpersExecutable(root, 'win32', 'x64', io)
    ensurePtyHelpersExecutable(root, 'linux', 'x64', io)
    expect(chmodSync).not.toHaveBeenCalled()
  })

  it('preserves already executable macOS helpers', () => {
    const chmodSync = vi.fn()
    ensurePtyHelpersExecutable(resolve('node_modules/node-pty'), 'darwin', 'x64', {
      existsSync: () => true,
      statSync: () => ({ isFile: () => true, mode: 0o100755 }),
      chmodSync
    })
    expect(chmodSync).not.toHaveBeenCalled()
  })

  it('requires both the native module and its helper for the exact architecture', () => {
    const root = resolve(tmpdir())
    const directory = mkdtempSync(join(root, 'remotehub-prebuild-test-'))
    try {
      const prebuild = join(directory, 'prebuilds', 'darwin-arm64')
      mkdirSync(prebuild, { recursive: true })
      writeFileSync(join(prebuild, 'pty.node'), '')
      expect(hasPtyPrebuild(directory, 'darwin', 'arm64')).toBe(false)
      writeFileSync(join(prebuild, 'spawn-helper'), '')
      expect(hasPtyPrebuild(directory, 'darwin', 'arm64')).toBe(true)
      expect(hasPtyPrebuild(directory, 'darwin', 'x64')).toBe(false)
      expect(hasPtyPrebuild(directory, 'linux', 'x64')).toBe(false)
    } finally {
      if (dirname(directory) !== root || !directory.startsWith(join(root, 'remotehub-prebuild-test-'))) throw new Error('Unsafe test cleanup path')
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
