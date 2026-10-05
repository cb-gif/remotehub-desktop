import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export function codexCommand(cwd: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean } {
  const windows = platform === 'win32'
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || ''
  const project = realpathSync(cwd)
  const samePath = (a: string, b: string) => windows ? a.toLowerCase() === b.toLowerCase() : a === b
  const directories: string[] = []
  for (const entry of pathValue.split(windows ? ';' : ':')) {
    const directory = entry.replace(/^"(.*)"$/, '$1')
    // Never let the shell search the working directory or relative PATH entries.
    if (!isAbsolute(directory)) continue
    try {
      const absolute = realpathSync(directory)
      if (!samePath(absolute, project)) directories.push(absolute)
    } catch { /* skip missing or inaccessible PATH directories */ }
  }
  const childEnv = { ...env }
  for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'PATH') delete childEnv[key]
  childEnv.PATH = directories.join(windows ? ';' : ':')
  for (const directory of directories) {
    for (const name of windows ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex']) {
      try {
        const candidate = join(directory, name)
        const file = realpathSync(candidate)
        if (samePath(resolve(directory), resolve(cwd)) || samePath(dirname(file), project) || !statSync(file).isFile()) continue
        accessSync(file, windows ? constants.F_OK : constants.X_OK)
        if (windows && /\.(cmd|bat)$/i.test(file)) {
          // Batch shims require cmd.exe. Quote an absolute path and disallow
          // expansion characters; no project-controlled text enters the command.
          if (/["%!\r\n\0]/.test(file)) continue
          const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
          if (!isAbsolute(systemRoot)) continue
          return { file: join(systemRoot, 'System32', 'cmd.exe'), args: ['/d', '/v:off', '/s', '/c', `""${file}" app-server"`], cwd: dirname(file), env: childEnv, windowsVerbatimArguments: true }
        }
        // Account usage does not need project configuration. Run in the trusted
        // installation directory so npm shims cannot find project-local helpers.
        return { file, args: ['app-server'], cwd: dirname(file), env: childEnv }
      } catch { /* skip missing or inaccessible PATH candidates */ }
    }
  }
  throw new Error('Codex CLI was not found in an absolute PATH directory outside the working directory')
}
