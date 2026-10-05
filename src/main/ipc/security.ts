import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'

let getTrustedContents: () => WebContents | null = () => null
let trustedPage = ''

export function configureIpcSecurity(contents: () => WebContents | null, page: string): void {
  getTrustedContents = contents
  trustedPage = page
}

export function isTrustedPage(url: string, expected: string): boolean {
  try {
    const actual = new URL(url)
    const trusted = new URL(expected)
    actual.hash = ''
    trusted.hash = ''
    return actual.href === trusted.href
  } catch { return false }
}

export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const contents = getTrustedContents()
  if (!contents || contents.isDestroyed() || event.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame || !isTrustedPage(event.senderFrame.url, trustedPage)) {
    throw new Error('IPC sender is not the trusted application page')
  }
}

export function handleIpc(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event)
    return listener(event, ...args)
  })
}
