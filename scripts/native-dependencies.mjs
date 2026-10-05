import { chmodSync, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { rebuild } from '@electron/rebuild'

export function hasPtyPrebuild(moduleDirectory, platform, arch) {
  const files = platform === 'win32'
    ? ['conpty.node', 'conpty_console_list.node', 'pty.node', 'winpty.dll', 'winpty-agent.exe', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
    : platform === 'darwin' ? ['pty.node', 'spawn-helper'] : []
  return files.length > 0 && files.every(file => existsSync(join(moduleDirectory, 'prebuilds', `${platform}-${arch}`, file)))
}

export function hasPortablePrebuild(name, moduleDirectory, platform, arch, libc = 'glibc') {
  if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) return false
  if (name === 'better-sqlite3') {
    const target = platform === 'linux' && libc === 'musl' ? 'linuxmusl' : platform
    return existsSync(join(moduleDirectory, 'prebuilds', `${target}-${arch}.node`))
  }
  if (name === '@serialport/bindings-cpp') {
    const target = platform === 'darwin' ? 'darwin-x64+arm64' : `${platform}-${arch}`
    const arm = arch === 'arm64' && platform !== 'darwin' ? '.armv8' : ''
    const suffix = platform === 'linux' ? `.${libc}` : ''
    return existsSync(join(moduleDirectory, 'prebuilds', target, `@serialport+bindings-cpp${arm}${suffix}.node`))
  }
  return false
}

export function ensurePtyHelpersExecutable(moduleDirectory, platform, arch, io = { existsSync, statSync, chmodSync }) {
  if (platform !== 'darwin') return
  // node-pty 1.1.0's npm tarball ships its macOS spawn-helper with mode 0644.
  // Fix only package-owned helpers at build time, before asar/signing/DMG creation.
  // https://github.com/microsoft/node-pty/issues/850
  for (const directory of ['build/Release', 'build/Debug', `prebuilds/darwin-${arch}`]) {
    const helper = join(moduleDirectory, directory, 'spawn-helper')
    if (!io.existsSync(helper)) continue
    const info = io.statSync(helper)
    if (!info.isFile()) throw new Error(`PTY helper is not a regular file: ${helper}`)
    if ((info.mode & 0o111) !== 0o111) io.chmodSync(helper, 0o755)
  }
}

export async function rebuildNativeDependencies({ appDir, electronVersion, platform = process.platform, arch = process.arch }) {
  const targetPlatform = typeof platform === 'string' ? platform : platform.nodeName
  if (targetPlatform !== process.platform) throw new Error('Build native dependencies on their target operating system')
  // Electron 44's V8 headers use attributes rejected by Ubuntu's default GCC.
  // Prefer installed Clang without adding a separate compiler/sysroot download.
  if (targetPlatform === 'linux') {
    process.env.CC ||= 'clang'
    process.env.CXX ||= 'clang++'
  }
  const require = createRequire(join(appDir, 'package.json'))
  const ptyDirectory = dirname(require.resolve('node-pty/package.json'))
  // node-pty ships Node-API binaries and helper executables on Windows/macOS.
  // Keep those vendor artifacts; rebuilding them is unnecessary and on Windows
  // would require an additional Spectre-enabled Visual Studio toolchain.
  const usePtyPrebuild = hasPtyPrebuild(ptyDirectory, targetPlatform, arch)
  console.log(`node-pty: ${usePtyPrebuild ? 'using bundled Node-API prebuilds' : 'building for Electron'} (${targetPlatform}-${arch})`)
  const ignoreModules = usePtyPrebuild ? ['node-pty'] : []
  const libc = targetPlatform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? 'musl' : 'glibc'
  // SQLite 13 and serialport 13 ship ABI-stable Node-API binaries. Their vendor
  // filenames are not recognized by electron-rebuild's prebuildify detection.
  for (const name of ['better-sqlite3', '@serialport/bindings-cpp']) {
    const moduleDirectory = dirname(require.resolve(`${name}/package.json`))
    if (hasPortablePrebuild(name, moduleDirectory, targetPlatform, arch, libc)) {
      ignoreModules.push(name)
      console.log(`${name}: using bundled Node-API prebuilds (${targetPlatform}-${arch})`)
    }
  }
  ensurePtyHelpersExecutable(ptyDirectory, targetPlatform, arch)
  await rebuild({
    buildPath: appDir,
    electronVersion: electronVersion || require('electron/package.json').version,
    platform: targetPlatform,
    arch,
    mode: 'sequential',
    ignoreModules
  })
  ensurePtyHelpersExecutable(ptyDirectory, targetPlatform, arch)
}
