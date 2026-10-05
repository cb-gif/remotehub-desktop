import { app, BrowserWindow, clipboard, dialog } from 'electron'
import { handleIpc } from './security'
import { listLocalDirectory } from '../services/local-files'

export function registerAppIpc(): void {
  handleIpc('app:getInfo', () => ({
    name: 'RemoteHub',
    version: app.getVersion(),
    platform: process.platform,
    dataPath: app.getPath('userData')
  }))
  handleIpc('app:copyText', async (_event, text: string) => {
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('Clipboard text is invalid')
    await clipboard.writeText(text)
    return { ok: true }
  })
  handleIpc('app:readText', async () => (await clipboard.readText()).slice(0, 1024 * 1024))
  handleIpc('app:confirmClose', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.destroy()
    return { ok: true }
  })
  handleIpc('app:setTheme', (event, theme: string) => {
    if (theme !== 'dark' && theme !== 'light' && theme !== 'tokyo-night' && theme !== 'tokyo-storm' && theme !== 'tokyo-light') throw new Error('Theme is invalid')
    const window = BrowserWindow.fromWebContents(event.sender)
    const background = theme === 'light' ? '#edf1f5' : theme === 'tokyo-night' ? '#16161e' : theme === 'tokyo-storm' ? '#1f2335' : theme === 'tokyo-light' ? '#d6d8df' : '#000000'
    window?.setBackgroundColor(background)
    if (process.platform !== 'darwin') window?.setTitleBarOverlay({ color: background, symbolColor: theme === 'light' ? '#182230' : theme === 'tokyo-light' ? '#363c4d' : '#c0caf5', height: 48 })
    return { ok: true }
  })
  handleIpc('app:listLocalDirectory', (_event, requestedPath?: string) => listLocalDirectory(requestedPath, {
    defaultPath: app.getPath('downloads'),
    shortcuts: (['home', 'desktop', 'documents', 'downloads'] as const).map(location => ({ location, path: app.getPath(location) }))
  }))
  handleIpc('app:choosePrivateKey', async () => {
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
  handleIpc('app:chooseDatabaseFile', async () => {
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
  handleIpc('app:chooseShellDirectory', async () => {
    const result = await dialog.showOpenDialog({ title: 'Choose shell working directory', properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0] || null
  })
  handleIpc('app:chooseUploadFiles', async () => {
    const result = await dialog.showOpenDialog({ title: 'Choose files to upload', properties: ['openFile', 'multiSelections'] })
    return result.canceled ? [] : result.filePaths
  })
  handleIpc('app:chooseUploadFolder', async () => {
    const result = await dialog.showOpenDialog({ title: 'Choose folder to upload', properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0] || null
  })
  handleIpc('app:chooseDownloadPath', async (_event, defaultName: string) => {
    if (typeof defaultName !== 'string' || defaultName.length > 255) throw new Error('Download filename is invalid')
    const result = await dialog.showSaveDialog({ title: 'Save remote file', defaultPath: defaultName })
    return result.canceled ? null : result.filePath || null
  })
  handleIpc('app:chooseDownloadDirectory', async () => {
    const result = await dialog.showOpenDialog({ title: 'Choose download folder', properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0] || null
  })
}
