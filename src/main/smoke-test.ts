import { app, nativeImage, type BrowserWindow } from 'electron'
import Database from 'better-sqlite3'
import { SerialPort } from 'serialport'
import { join } from 'node:path'
import { spawn } from 'node-pty'

// Explicit test mode only. No saved connections or real remote endpoints are used.
export async function runPackagedSmokeTest(window: BrowserWindow, directory: string): Promise<Record<string, unknown>> {
  if (!app.isPackaged) throw new Error('Smoke test requires a packaged application')
  if (nativeImage.createFromPath(join(app.getAppPath(), 'assets', 'remotehub.png')).isEmpty()) throw new Error('Packaged application icon is missing')
  await testPackagedPty(directory)
  const filename = join(directory, 'smoke.sqlite')
  const client = new Database(filename)
  try {
    client.exec('CREATE TABLE sample (value TEXT NOT NULL)')
    client.prepare('INSERT INTO sample VALUES (?)').run('{"release":true,"nested":[1,2]}')
  } finally { client.close() }
  // Construction loads the native serial binding without opening any hardware.
  const port = new SerialPort({ path: 'remotehub-smoke-unused', baudRate: 9600, autoOpen: false })
  if (port.isOpen) throw new Error('Smoke test must not open serial hardware')
  const report = await window.webContents.executeJavaScript(`(async () => {
    if (location.protocol !== 'file:') throw new Error('Renderer must load offline');
    if (!document.querySelector('.workspace-shell')) throw new Error('Workspace did not render');
    if (typeof window.require !== 'undefined') throw new Error('Node integration exposed');
    const probe = document.createElement('script');
    probe.textContent = 'window.__remotehubInlineScriptExecuted = true';
    document.head.append(probe);
    probe.remove();
    if (window.__remotehubInlineScriptExecuted) throw new Error('Content security policy allowed inline script');
    const info = await window.api.app.getInfo();
    const group = await window.api.groups.save('Packaged smoke');
    const connection = await window.api.connections.save({connection:{name:'Smoke SQLite',type:'database',databaseType:'sqlite',host:${JSON.stringify(filename)},port:1,groupId:group.id}});
    const session = await window.api.database.connect(connection.id);
    try {
      const result = await window.api.database.query(session.sessionId, {sql:'SELECT value FROM sample',page:0,pageSize:200});
      if (result.rows?.[0]?.[0] !== '{"release":true,"nested":[1,2]}') throw new Error('SQLite IPC query failed');
    } finally { await window.api.database.disconnect(session.sessionId); }
    return {ok:true,version:info.version,platform:info.platform,offline:true,preload:true,csp:true,sqlite:true,serialBinding:true,pty:true,appIcon:true};
  })()`)
  return report as Record<string, unknown>
}

async function testPackagedPty(directory: string): Promise<void> {
  // A fixed, non-interactive command verifies native helpers without loading
  // PowerShell profiles or connecting to any user-configured terminal.
  const windows = process.platform === 'win32'
  const command = windows ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') : '/bin/sh'
  const args = windows ? ['/d', '/c', 'echo REMOTEHUB_PTY_OK'] : ['-c', 'printf REMOTEHUB_PTY_OK']
  const child = spawn(command, args, { cwd: directory, env: process.env, name: 'xterm-256color', cols: 80, rows: 24 })
  let output = ''
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { try { child.kill() } catch { /* already exited */ } reject(new Error('Packaged PTY test timed out')) }, 10000)
    child.onData(data => { output += data })
    child.onExit(({ exitCode }) => {
      clearTimeout(timer)
      if (exitCode === 0 && output.includes('REMOTEHUB_PTY_OK')) resolve()
      else reject(new Error(`Packaged PTY test failed (exit ${exitCode})`))
    })
  })
}
