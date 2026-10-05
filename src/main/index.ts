import { app, BrowserWindow, dialog, session } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { configureIpcSecurity } from './ipc/security'
import { registerAppIpc } from './ipc/app.ipc'
import { registerConnectionIpc } from './ipc/connection.ipc'
import { registerSshIpc } from './ipc/ssh.ipc'
import { registerFtpIpc, registerSftpIpc } from './ipc/sftp.ipc'
import { registerSerialIpc } from './ipc/serial.ipc'
import { registerDatabaseIpc } from './ipc/database.ipc'
import { registerLocalShellIpc } from './ipc/local-shell.ipc'
import { StorageService } from './services/storage'
import { CredentialService } from './services/credentials'
import { SshService } from './services/ssh'
import { SftpService } from './services/sftp'
import { FtpService } from './services/ftp'
import { SerialService } from './services/serial'
import { DatabaseService } from './services/database'
import { LocalShellService } from './services/local-shell'

// Preserve the existing development profile when productName is introduced.
app.setPath('userData', join(app.getPath('appData'), 'remotehub-desktop'))
const smokeDirectory = app.commandLine.hasSwitch('smoke-test') ? process.env.REMOTEHUB_SMOKE_DIR : undefined
if (smokeDirectory) {
  mkdirSync(join(smokeDirectory, 'profile'), { recursive: true })
  app.setPath('userData', join(smokeDirectory, 'profile'))
}

let mainWindow: BrowserWindow | null = null
let storage: StorageService | null = null
let ssh: SshService | null = null
let sftp: SftpService | null = null
let ftp: FtpService | null = null
let serial: SerialService | null = null
let database: DatabaseService | null = null
let localShell: LocalShellService | null = null
const development = !app.isPackaged && app.commandLine.hasSwitch('dev')
const rendererFile = join(__dirname, '..', '..', 'dist', 'index.html')
configureIpcSecurity(() => mainWindow?.webContents || null, development ? 'http://127.0.0.1:5173/' : pathToFileURL(rendererFile).href)

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1040,
    minHeight: 680,
    show: !smokeDirectory,
    backgroundColor: '#000000',
    icon: join(__dirname, '..', '..', 'assets', 'remotehub.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : { titleBarOverlay: { color: '#000000', symbolColor: '#f7f9fc', height: 48 } }),
    title: 'RemoteHub',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.webContents.setZoomFactor(1.2)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  mainWindow.webContents.on('will-redirect', (event) => event.preventDefault())
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('app:fullscreen-changed', true))
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('app:fullscreen-changed', false))
  if (!smokeDirectory) mainWindow.on('close', (event) => {
    event.preventDefault()
    mainWindow?.webContents.send('app:close-requested')
  })
  if (development) {
    await mainWindow.loadURL('http://127.0.0.1:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    await mainWindow.loadFile(rendererFile)
  }
  mainWindow.on('closed', () => { mainWindow = null })
  if (smokeDirectory) {
    const { runPackagedSmokeTest } = await import('./smoke-test')
    const report = await runPackagedSmokeTest(mainWindow, smokeDirectory)
    writeFileSync(join(smokeDirectory, 'result.json'), JSON.stringify(report, null, 2))
    app.quit()
  }
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  storage = new StorageService()
  const credentials = new CredentialService()
  ssh = new SshService(storage, credentials, (channel, payload) => mainWindow?.webContents.send(channel, payload))
  sftp = new SftpService(storage, credentials, (channel, payload) => mainWindow?.webContents.send(channel, payload), (connection) => ssh?.temporaryPassword(connection))
  ftp = new FtpService(storage, credentials, (channel, payload) => mainWindow?.webContents.send(channel, payload))
  serial = new SerialService(storage, (channel, payload) => mainWindow?.webContents.send(channel, payload))
  database = new DatabaseService(storage, credentials, undefined, undefined, undefined, (event) => mainWindow?.webContents.send('database:status', event))
  localShell = new LocalShellService(storage, (channel, payload) => mainWindow?.webContents.send(channel, payload))
  registerAppIpc()
  registerConnectionIpc(storage, credentials, (connection) => serial!.test(connection), (connection, credential) => database!.test(connection, credential))
  registerSshIpc(storage, ssh)
  registerSftpIpc(storage, sftp)
  registerFtpIpc(storage, ftp)
  registerSerialIpc(storage, serial)
  registerDatabaseIpc(storage, database)
  registerLocalShellIpc(storage, localShell)
  await createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow().catch(startupFailure) })
}).catch(startupFailure)

function startupFailure(error: unknown): void {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  if (smokeDirectory) writeFileSync(join(smokeDirectory, 'result.json'), JSON.stringify({ ok: false, error: message }))
  else dialog.showErrorBox('RemoteHub could not start', message)
  app.exit(1)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  ssh?.dispose()
  sftp?.dispose()
  ftp?.dispose()
  serial?.dispose()
  database?.dispose()
  localShell?.dispose()
  storage?.close()
})
