import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ConnectionOrderItem, ConnectionSaveRequest, ConnectionTestRequest } from '../shared/types'
import type { SshDataEvent, SshStatusEvent, SshPasswordOptions } from '../shared/ssh'
import type { SftpTransferEvent } from '../shared/sftp'
import type { SessionConnectionStatusEvent } from '../shared/connection-status'
import type { SerialDataEvent, SerialStatusEvent } from '../shared/serial'
import type { DatabaseCsvExport, DatabaseQueryRequest } from '../shared/database'
import type { LocalShellDataEvent, LocalShellStatusEvent } from '../shared/local-shell'
import type { LocalDirectory } from '../shared/local-files'

function remoteFiles(prefix: 'sftp' | 'ftp') {
  return {
    connect: (connectionId: string, options?: SshPasswordOptions) => ipcRenderer.invoke(`${prefix}:connect`, connectionId, options),
    list: (sessionId: string, path: string) => ipcRenderer.invoke(`${prefix}:list`, sessionId, path),
    mkdir: (sessionId: string, path: string) => ipcRenderer.invoke(`${prefix}:mkdir`, sessionId, path),
    rename: (sessionId: string, oldPath: string, newPath: string) => ipcRenderer.invoke(`${prefix}:rename`, sessionId, oldPath, newPath),
    readText: (sessionId: string, path: string) => ipcRenderer.invoke(`${prefix}:readText`, sessionId, path),
    writeText: (sessionId: string, path: string, content: string, expectedModifiedAt: number) => ipcRenderer.invoke(`${prefix}:writeText`, sessionId, path, content, expectedModifiedAt),
    remove: (sessionId: string, path: string, type: 'file' | 'directory' | 'link') => ipcRenderer.invoke(`${prefix}:remove`, sessionId, path, type),
    enqueueUploads: (sessionId: string, localPaths: string[], remoteDirectory: string, overwrite = false) => ipcRenderer.invoke(`${prefix}:enqueueUploads`, sessionId, localPaths, remoteDirectory, overwrite),
    enqueueDownload: (sessionId: string, remotePath: string, localDirectory: string, entryType: 'file' | 'directory' | 'link', overwrite = false) => ipcRenderer.invoke(`${prefix}:enqueueDownload`, sessionId, remotePath, localDirectory, entryType, overwrite),
    listTransfers: (sessionId: string) => ipcRenderer.invoke(`${prefix}:listTransfers`, sessionId),
    pauseTransfer: (sessionId: string, transferId: string) => ipcRenderer.invoke(`${prefix}:pauseTransfer`, sessionId, transferId),
    resumeTransfer: (sessionId: string, transferId: string) => ipcRenderer.invoke(`${prefix}:resumeTransfer`, sessionId, transferId),
    cancelTransfer: (sessionId: string, transferId: string) => ipcRenderer.invoke(`${prefix}:cancelTransfer`, sessionId, transferId),
    retryTransfer: (sessionId: string, transferId: string) => ipcRenderer.invoke(`${prefix}:retryTransfer`, sessionId, transferId),
    clearFinishedTransfers: (sessionId: string) => ipcRenderer.invoke(`${prefix}:clearFinishedTransfers`, sessionId),
    disconnect: (sessionId: string) => ipcRenderer.invoke(`${prefix}:disconnect`, sessionId),
    onStatus: (listener: (event: SessionConnectionStatusEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: SessionConnectionStatusEvent): void => listener(payload)
      ipcRenderer.on(`${prefix}:status`, handler)
      return () => ipcRenderer.removeListener(`${prefix}:status`, handler)
    },
    onTransfer: (listener: (event: SftpTransferEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: SftpTransferEvent): void => listener(payload)
      ipcRenderer.on(`${prefix}:transfer`, handler)
      return () => ipcRenderer.removeListener(`${prefix}:transfer`, handler)
    }
  }
}

const api = {
  app: {
    getInfo: () => ipcRenderer.invoke('app:getInfo'),
    copyText: (text: string) => ipcRenderer.invoke('app:copyText', text),
    readText: () => ipcRenderer.invoke('app:readText'),
    setTheme: (theme: 'dark' | 'light' | 'tokyo-night' | 'tokyo-storm') => ipcRenderer.invoke('app:setTheme', theme),
    listLocalDirectory: (path?: string): Promise<LocalDirectory> => ipcRenderer.invoke('app:listLocalDirectory', path),
    choosePrivateKey: () => ipcRenderer.invoke('app:choosePrivateKey'),
    chooseDatabaseFile: () => ipcRenderer.invoke('app:chooseDatabaseFile'),
    chooseShellDirectory: () => ipcRenderer.invoke('app:chooseShellDirectory'),
    chooseUploadFiles: () => ipcRenderer.invoke('app:chooseUploadFiles'),
    chooseUploadFolder: () => ipcRenderer.invoke('app:chooseUploadFolder'),
    chooseDownloadPath: (defaultName: string) => ipcRenderer.invoke('app:chooseDownloadPath', defaultName),
    chooseDownloadDirectory: () => ipcRenderer.invoke('app:chooseDownloadDirectory'),
    confirmClose: () => ipcRenderer.invoke('app:confirmClose'),
    onCloseRequest: (listener: () => void) => {
      const handler = (): void => listener()
      ipcRenderer.on('app:close-requested', handler)
      return () => ipcRenderer.removeListener('app:close-requested', handler)
    },
    onFullscreenChange: (listener: (fullscreen: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, fullscreen: boolean): void => listener(fullscreen)
      ipcRenderer.on('app:fullscreen-changed', handler)
      return () => ipcRenderer.removeListener('app:fullscreen-changed', handler)
    }
  },
  files: {
    getPath: (file: File) => webUtils.getPathForFile(file)
  },
  connections: {
    list: () => ipcRenderer.invoke('connections:list'),
    save: (request: ConnectionSaveRequest) => ipcRenderer.invoke('connections:save', request),
    delete: (id: string) => ipcRenderer.invoke('connections:delete', id),
    duplicate: (id: string) => ipcRenderer.invoke('connections:duplicate', id),
    reorder: (items: ConnectionOrderItem[]) => ipcRenderer.invoke('connections:reorder', items),
    export: () => ipcRenderer.invoke('connections:export'),
    import: () => ipcRenderer.invoke('connections:import'),
    test: (target: string | ConnectionTestRequest) => ipcRenderer.invoke('connections:test', target)
  },
  ssh: {
    connect: (connectionId: string, options?: SshPasswordOptions) => ipcRenderer.invoke('ssh:connect', connectionId, options),
    trustHostKey: (connectionId: string, fingerprint: string) => ipcRenderer.invoke('ssh:trustHostKey', connectionId, fingerprint),
    hasSessionCredential: (connectionId: string): Promise<boolean> => ipcRenderer.invoke('ssh:hasSessionCredential', connectionId),
    write: (sessionId: string, data: string) => ipcRenderer.invoke('ssh:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke('ssh:resize', sessionId, cols, rows),
    statusOverview: (sessionId: string) => ipcRenderer.invoke('ssh:statusOverview', sessionId),
    codexStatus: (sessionId: string) => ipcRenderer.invoke('ssh:codexStatus', sessionId),
    disconnect: (sessionId: string) => ipcRenderer.invoke('ssh:disconnect', sessionId),
    onData: (listener: (event: SshDataEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: SshDataEvent): void => listener(payload)
      ipcRenderer.on('ssh:data', handler)
      return () => ipcRenderer.removeListener('ssh:data', handler)
    },
    onStatus: (listener: (event: SshStatusEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: SshStatusEvent): void => listener(payload)
      ipcRenderer.on('ssh:status', handler)
      return () => ipcRenderer.removeListener('ssh:status', handler)
    }
  },
  sftp: {
    ...remoteFiles('sftp'),
    trustHostKey: (connectionId: string, fingerprint: string) => ipcRenderer.invoke('sftp:trustHostKey', connectionId, fingerprint),
  },
  ftp: remoteFiles('ftp'),
  serial: {
    listPorts: () => ipcRenderer.invoke('serial:listPorts'),
    connect: (connectionId: string) => ipcRenderer.invoke('serial:connect', connectionId),
    write: (sessionId: string, data: string) => ipcRenderer.invoke('serial:write', sessionId, data),
    disconnect: (sessionId: string) => ipcRenderer.invoke('serial:disconnect', sessionId),
    onData: (listener: (event: SerialDataEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: SerialDataEvent): void => listener(payload)
      ipcRenderer.on('serial:data', handler)
      return () => ipcRenderer.removeListener('serial:data', handler)
    },
    onStatus: (listener: (event: SerialStatusEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: SerialStatusEvent): void => listener(payload)
      ipcRenderer.on('serial:status', handler)
      return () => ipcRenderer.removeListener('serial:status', handler)
    }
  },
  shell: {
    connect: (connectionId: string) => ipcRenderer.invoke('shell:connect', connectionId),
    write: (sessionId: string, data: string) => ipcRenderer.invoke('shell:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke('shell:resize', sessionId, cols, rows),
    codexStatus: (sessionId: string) => ipcRenderer.invoke('shell:codexStatus', sessionId),
    disconnect: (sessionId: string) => ipcRenderer.invoke('shell:disconnect', sessionId),
    onData: (listener: (event: LocalShellDataEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: LocalShellDataEvent): void => listener(payload)
      ipcRenderer.on('shell:data', handler)
      return () => ipcRenderer.removeListener('shell:data', handler)
    },
    onStatus: (listener: (event: LocalShellStatusEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: LocalShellStatusEvent): void => listener(payload)
      ipcRenderer.on('shell:status', handler)
      return () => ipcRenderer.removeListener('shell:status', handler)
    }
  },
  database: {
    connect: (connectionId: string) => ipcRenderer.invoke('database:connect', connectionId),
    listDatabases: (sessionId: string) => ipcRenderer.invoke('database:listDatabases', sessionId),
    useDatabase: (sessionId: string, name: string) => ipcRenderer.invoke('database:useDatabase', sessionId, name),
    listTables: (sessionId: string, name: string) => ipcRenderer.invoke('database:listTables', sessionId, name),
    listColumns: (sessionId: string, name: string, table: string) => ipcRenderer.invoke('database:listColumns', sessionId, name, table),
    query: (sessionId: string, request: DatabaseQueryRequest) => ipcRenderer.invoke('database:query', sessionId, request),
    exportCsv: (request: DatabaseCsvExport) => ipcRenderer.invoke('database:exportCsv', request),
    disconnect: (sessionId: string) => ipcRenderer.invoke('database:disconnect', sessionId),
    onStatus: (listener: (event: SessionConnectionStatusEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: SessionConnectionStatusEvent): void => listener(payload)
      ipcRenderer.on('database:status', handler)
      return () => ipcRenderer.removeListener('database:status', handler)
    }
  },
  groups: {
    save: (name: string, id?: string) => ipcRenderer.invoke('groups:save', name, id),
    reorder: (ids: string[]) => ipcRenderer.invoke('groups:reorder', ids),
    delete: (id: string) => ipcRenderer.invoke('groups:delete', id)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type RemoteHubApi = typeof api
