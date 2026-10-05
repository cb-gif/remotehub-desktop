import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexCommand } from '../src/main/services/codex-command'

let root: string
let project: string
let installed: string
const windows = process.platform === 'win32'
const filename = windows ? 'codex.cmd' : 'codex'
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'remotehub-cli-test-'))
  project = join(root, 'project')
  installed = join(root, 'trusted tools & spaces')
  mkdirSync(project); mkdirSync(installed)
  for (const [directory, marker] of [[project, 'PROJECT_EXECUTED'], [installed, 'TRUSTED_CLI']]) {
    const file = join(directory, filename)
    writeFileSync(file, windows ? `@echo off\r\necho ${marker}\r\n` : `#!/bin/sh\nprintf '${marker}\\n'\n`)
    if (!windows) chmodSync(file, 0o755)
  }
})
afterEach(() => { if (dirname(resolve(root)) === resolve(tmpdir())) rmSync(root, { recursive: true, force: true }) })

describe('local Codex executable selection', () => {
  it('runs the installed CLI instead of a same-name executable in the project', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: ['', '.', project, installed].join(windows ? ';' : ':') }
    // Remove any differently cased PATH key on Windows.
    for (const key of Object.keys(env)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete env[key]
    const command = codexCommand(project, env)
    const child = spawnSync(command.file, command.args, { cwd: command.cwd, env: command.env, shell: false, windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments, encoding: 'utf8', timeout: 5000 })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout.trim()).toBe('TRUSTED_CLI')
  })

  it('also prevents a trusted shim from loading project-local helpers', () => {
    const helper = windows ? 'remotehub-helper.cmd' : 'remotehub-helper'
    for (const [directory, marker] of [[project, 'PROJECT_EXECUTED'], [installed, 'TRUSTED_HELPER']]) {
      const path = join(directory, helper)
      writeFileSync(path, windows ? `@echo off\r\necho ${marker}\r\n` : `#!/bin/sh\nprintf '${marker}\\n'\n`)
      if (!windows) chmodSync(path, 0o755)
    }
    writeFileSync(join(installed, filename), windows ? `@echo off\r\ncall ${helper}\r\n` : `#!/bin/sh\n${helper}\n`)
    const command = codexCommand(project, { ...process.env, PATH: [project, '.', installed].join(windows ? ';' : ':') })
    const child = spawnSync(command.file, command.args, { cwd: command.cwd, env: command.env, shell: false, windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments, encoding: 'utf8', timeout: 5000 })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    expect(child.stdout.trim()).toBe('TRUSTED_HELPER')
  })

  it('fails closed when only project or relative paths contain the CLI', () => {
    expect(() => codexCommand(project, { PATH: ['', '.', project].join(windows ? ';' : ':') })).toThrow(/not found/)
  })
})
