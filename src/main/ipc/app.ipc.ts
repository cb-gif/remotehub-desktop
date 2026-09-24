import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { listLocalDirectory } from '../services/local-files'

export function registerAppIpc(): void {
  ipcMain.handle('app:getInfo', () => ({
    name: 'RemoteHub',
    version: app.getVersion(),
    platform: process.platform,
    dataPath: app.getPath('userData')
  }))
  ipcMain.handle('app:copyText', (_event, text: string) => {
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('Clipboard text is invalid')
    clipboard.writeText(text)
    return { ok: true }
  })
  ipcMain.handle('app:readText', () => clipboard.readText().slice(0, 1024 * 1024))
  ipcMain.handle('app:confirmClose', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.destroy()
    return { ok: true }
  })
  ipcMain.handle('app:setTheme', (event, theme: string) => {
    if (theme !== 'dark' && theme !== 'light' && theme !== 'tokyo-night') throw new Error('Theme is invalid')
    const window = BrowserWindow.fromWebContents(event.sender)
    const background = theme === 'light' ? '#edf1f5' : theme === 'tokyo-night' ? '#16161e' : '#000000'
    window?.setBackgroundColor(background)
    if (process.platform !== 'darwin') window?.setTitleBarOverlay({ color: background, symbolColor: theme === 'light' ? '#182230' : '#c0caf5', height: 48 })
    return { ok: true }
  })
  ipcMain.handle('app:listLocalDirectory', (_event, requestedPath?: string) => listLocalDirectory(requestedPath, {
    defaultPath: app.getPath('downloads'),
    shortcuts: (['home', 'desktop', 'documents', 'downloads'] as const).map(location => ({ location, path: app.getPath(location) }))
  }))
  ipcMain.handle('app:choosePrivateKey', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose private key',
      properties: ['openFile'],
      filters: [
        { name: 'Private keys', extensions: ['pem', 'key', 'ppk'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : result.filePaths[0] || null
  })
  ipcMain.handle('app:chooseDatabaseFile', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose SQLite database',
      properties: ['openFile'],
      filters: [
        { name: 'SQLite databases', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : result.filePaths[0] || null
  })
  ipcMain.handle('app:chooseShellDirectory', async () => {
    const result = await dialog.showOpenDialog({ title: 'Choose shell working directory', properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0] || null
  })
  ipcMain.handle('app:chooseUploadFiles', async () => {
    const result = await dialog.showOpenDialog({ title: 'Choose files to upload', properties: ['openFile', 'multiSelections'] })
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('app:chooseUploadFolder', async () => {
    const result = await dialog.showOpenDialog({ title: 'Choose folder to upload', properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0] || null
  })
  ipcMain.handle('app:chooseDownloadPath', async (_event, defaultName: string) => {
    if (typeof defaultName !== 'string' || defaultName.length > 255) throw new Error('Download filename is invalid')
    const result = await dialog.showSaveDialog({ title: 'Save remote file', defaultPath: defaultName })
    return result.canceled ? null : result.filePath || null
  })
  ipcMain.handle('app:chooseDownloadDirectory', async () => {
    const result = await dialog.showOpenDialog({ title: 'Choose download folder', properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0] || null
  })
}
