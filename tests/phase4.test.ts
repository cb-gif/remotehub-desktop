import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { isPrivateKeyText, privateKeyFileName } from '../src/shared/private-key'
import { isValidBaudRate } from '../src/shared/serial'
import { fileIcon, joinRemotePath, normalizeRemotePath, parentRemotePath, selectSftpPaths } from '../src/shared/sftp'
import { localShellCommand, localShellName } from '../src/shared/local-shell'
import { parseServerStatus } from '../src/shared/ssh'
import { parseCodexStatus, remainingQuotaPercent } from '../src/shared/codex'
import { useWorkspaceStore } from '../src/renderer/stores/workspace'
import { fileVisual, fileVisualIcon } from '../src/renderer/file-icon'

describe('Phase 4 SFTP, serial, and private key files', () => {
  it('normalizes remote paths without escaping the remote root', () => {
    expect(normalizeRemotePath('/var/log/../tmp/./')).toBe('/var/tmp')
    expect(joinRemotePath('/home/user', '中文.txt')).toBe('/home/user/中文.txt')
    expect(parentRemotePath('/home/user')).toBe('/home')
    expect(parentRemotePath('/')).toBe('/')
  })

  it('uses familiar folder and file-type icons', () => {
    expect(fileIcon('directory')).toBe('📁')
    expect(fileIcon('file', 'photo.png')).toBe('🖼️')
    expect(fileIcon('file', 'data.xlsx')).toBe('📊')
    expect(fileIcon('file', 'README')).toBe('📄')
  })

  it('maps common SFTP file types to distinct vector icons', () => {
    expect([
      fileVisualIcon('directory', 'src'), fileVisualIcon('link', 'current'), fileVisualIcon('file', 'app.ts'),
      fileVisualIcon('file', '.env'), fileVisualIcon('file', 'README.md'), fileVisualIcon('file', 'manual.pdf'),
      fileVisualIcon('file', 'data.xlsx'), fileVisualIcon('file', 'slides.ppt'), fileVisualIcon('file', 'photo.heic'),
      fileVisualIcon('file', 'song.flac'), fileVisualIcon('file', 'movie.mkv'), fileVisualIcon('file', 'backup.tar.gz'),
      fileVisualIcon('file', 'cache.sqlite'), fileVisualIcon('file', 'id_ed25519'), fileVisualIcon('file', 'ui.woff2'),
      fileVisualIcon('file', 'setup.exe'), fileVisualIcon('file', 'unknown')
    ]).toEqual(['folder', 'link', 'code', 'config', 'code', 'pdf', 'table', 'presentation', 'image', 'audio', 'video', 'archive', 'database', 'key', 'font', 'executable', 'file'])
  })

  it('uses recognizable language badges for modern source files', () => {
    expect([
      fileVisual('file', 'index.php'), fileVisual('file', 'main.ts'), fileVisual('file', 'App.vue'),
      fileVisual('file', 'server.py'), fileVisual('file', 'index.html'), fileVisual('file', 'styles.css'),
      fileVisual('file', 'package.json'), fileVisual('file', 'compose.yaml'), fileVisual('file', 'Dockerfile')
    ].map(({ badge, tone }) => [badge, tone])).toEqual([
      ['php', 'language-php'], ['TS', 'language-typescript'], ['V', 'language-vue'],
      ['PY', 'language-python'], ['5', 'language-html'], ['3', 'language-css'],
      ['{}', 'language-json'], ['YML', 'language-yaml'], ['DK', 'language-docker']
    ])
  })

  it('covers office, design, and unknown extensions without a generic fallback', () => {
    expect([
      fileVisual('file', 'report.docx'), fileVisual('file', 'budget.xlsx'), fileVisual('file', 'pitch.pptx'),
      fileVisual('file', 'mockup.psd'), fileVisual('file', 'model.blend'), fileVisual('file', 'novel.epub'),
      fileVisual('file', 'firmware.uf2'), fileVisual('file', 'archive.unknownformat'), fileVisual('file', 'README')
    ]).toEqual([
      { icon: 'fileText', badge: 'W', tone: 'language-word' },
      { icon: 'table', badge: 'X', tone: 'language-excel' },
      { icon: 'presentation', badge: 'P', tone: 'language-powerpoint' },
      { icon: 'image', badge: 'Ps', tone: 'language-photoshop' },
      { icon: 'cube', tone: 'cube' }, { icon: 'book', tone: 'book' },
      { icon: 'file', badge: 'UF2', tone: 'language-extension' },
      { icon: 'file', badge: 'UNKN', tone: 'language-extension' },
      { icon: 'fileText', tone: 'fileText' }
    ])
  })

  it('selects SFTP entries with Ctrl and Shift', () => {
    const paths = ['/a', '/b', '/c', '/d']
    expect(selectSftpPaths(paths, ['/a'], '/c', '/a', true, false)).toEqual(['/a', '/b', '/c'])
    expect(selectSftpPaths(paths, ['/a'], '/c', '/a', false, true)).toEqual(['/a', '/c'])
    expect(selectSftpPaths(paths, ['/a', '/d'], '/c', '/a', true, true)).toEqual(['/a', '/d', '/b', '/c'])
  })

  it('recognizes OpenSSH, PEM, PKCS8, and PuTTY key files', () => {
    expect(isPrivateKeyText('-----BEGIN OPENSSH PRIVATE KEY-----\nkey')).toBe(true)
    expect(isPrivateKeyText('-----BEGIN RSA PRIVATE KEY-----\nkey')).toBe(true)
    expect(isPrivateKeyText('-----BEGIN PRIVATE KEY-----\nkey')).toBe(true)
    expect(isPrivateKeyText('PuTTY-User-Key-File-3: ssh-rsa')).toBe(true)
    expect(isPrivateKeyText('not a key')).toBe(false)
    expect(privateKeyFileName('C:\\keys\\mes.ppk')).toBe('mes.ppk')
  })

  it('validates practical serial baud rates', () => {
    expect(isValidBaudRate(9600)).toBe(true)
    expect(isValidBaudRate(115200)).toBe(true)
    expect(isValidBaudRate(0)).toBe(false)
    expect(isValidBaudRate(4_000_001)).toBe(false)
  })

  it('starts the operating system shell without another dependency', () => {
    expect(localShellCommand('win32', {})).toEqual({ command: 'powershell.exe', args: ['-NoLogo'] })
    expect(localShellCommand('linux', { SHELL: '/bin/bash' })).toEqual({ command: '/bin/bash', args: ['-i'] })
    expect(localShellName('darwin')).toBe('Zsh')
    expect(localShellName('win32')).toBe('PowerShell')
    expect(localShellName('linux')).toBe('Bash')
  })

  it('parses the SSH server overview response', () => {
    const status = parseServerStatus('user\troot\nhost\tserver.local\ncpu_percent\t12.5\nmemory_total_kb\t2048\nmemory_used_kb\t1024\nprocess\t42|3.5|128|sshd\n')
    expect(status).toMatchObject({ user: 'root', host: 'server.local', cpuPercent: 12.5, memoryTotalKb: 2048, memoryUsedKb: 1024 })
    expect(status.processes).toEqual([{ pid: 42, cpuPercent: 3.5, memoryKb: 128, command: 'sshd' }])
  })

  it('parses Codex quota windows and daily token usage', () => {
    const status = parseCodexStatus(
      { rateLimits: { planType: 'plus', primary: { usedPercent: 82, windowDurationMins: 300, resetsAt: 123 }, secondary: { usedPercent: 13, windowDurationMins: 10080, resetsAt: 456 } } },
      { summary: { lifetimeTokens: 1000, peakDailyTokens: 700 }, dailyUsageBuckets: [{ startDate: '2026-08-30', tokens: 700 }] },
      789
    )
    expect(status).toMatchObject({ planType: 'plus', primary: { usedPercent: 82, windowDurationMins: 300 }, secondary: { usedPercent: 13 }, lifetimeTokens: 1000, checkedAt: 789 })
    expect(status.dailyUsageBuckets).toEqual([{ startDate: '2026-08-30', tokens: 700 }])
  })

  it('fills the quota bar according to available rather than used capacity', () => {
    expect(remainingQuotaPercent({ usedPercent: 2 })).toBe(98)
    expect(remainingQuotaPercent({ usedPercent: 79 })).toBe(21)
    expect(remainingQuotaPercent({ usedPercent: 100 })).toBe(0)
  })

  it('opens independent SFTP and serial terminal tabs', () => {
    setActivePinia(createPinia())
    const workspace = useWorkspaceStore()
    workspace.openConnection('ssh-1', 'Files', 'sftp')
    workspace.openConnection('serial-1', 'COM3', 'terminal')
    expect(workspace.tabs.at(-2)?.type).toBe('sftp')
    expect(workspace.tabs.at(-1)?.type).toBe('terminal')
  })
})
