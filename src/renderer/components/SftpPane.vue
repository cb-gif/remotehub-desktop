<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { SftpEntry, SftpQueueResult, SftpTransferItem, SftpTransferStatus } from '../../shared/sftp'
import { createSessionStatusTracker, type TabConnectionStatus } from '../../shared/connection-status'
import { joinRemotePath, parentRemotePath, selectSftpPaths, transferProgress } from '../../shared/sftp'
import { LOCAL_COMPUTER_ROOT, localNavigationTarget, localTransferDirectory, type LocalEntry } from '../../shared/local-files'
import { t } from '../i18n'
import { confirmDialog } from '../dialog'
import { useConnectionStore } from '../stores/connection'
import { useSshPasswordStore } from '../stores/ssh-password'
import type { SshPasswordOptions } from '../../shared/ssh'
import FileTypeIcon from './FileTypeIcon.vue'
import SplitPane from './SplitPane.vue'
import UiIcon from './UiIcon.vue'

type SftpPosition = 'right' | 'left' | 'top' | 'bottom'

const props = defineProps<{ connectionId: string; embedded?: boolean; position?: SftpPosition; protocol?: 'sftp' | 'ftp' }>()
const emit = defineEmits<{ position: [position: SftpPosition]; 'connection-status': [status: TabConnectionStatus] }>()
const connectionStore = useConnectionStore()
const sshPassword = useSshPasswordStore()
const protocolName = computed(() => props.protocol === 'ftp' ? 'FTP' : 'SFTP')
const remoteApi = computed(() => props.protocol === 'ftp' ? window.api.ftp : window.api.sftp)

const sessionId = ref('')
const connectionStatus = ref<TabConnectionStatus>('connecting')
const path = ref('/')
const pathInput = ref('/')
const entries = ref<SftpEntry[]>([])
const loading = ref(true)
const errorMessage = ref('')
const pendingFingerprint = ref('')
const transfers = ref<SftpTransferItem[]>([])
const transferPanelOpen = ref(true)
const visibleTransferCount = ref(200)
const transferIndex = new Map<string, number>()
const visibleTransfers = computed(() => transfers.value.slice(0, visibleTransferCount.value))
const localPath = ref('')
const isLocalComputerRoot = computed(() => localPath.value === LOCAL_COMPUTER_ROOT)
const localPathInput = ref('')
const localParentPath = ref('')
const localEntries = ref<LocalEntry[]>([])
const selectedLocalPaths = ref<string[]>([])
const selectedRemotePaths = ref<string[]>([])
const selectedLocalSet = computed(() => new Set(selectedLocalPaths.value))
const selectedRemoteSet = computed(() => new Set(selectedRemotePaths.value))
const localLoading = ref(true)
const localError = ref('')
const entryMenu = ref<{ side: 'local' | 'remote'; entry: LocalEntry | SftpEntry; x: number; y: number } | null>(null)
const renamingEntry = ref<SftpEntry | null>(null)
const renameName = ref('')
const editor = ref<{ entry: SftpEntry; content: string; modifiedAt: number } | null>(null)
const editorSaving = ref(false)
const creatingDirectory = ref(false)
const directoryName = ref('')
let removeTransferListener: (() => void) | undefined
let removeStatusListener: (() => void) | undefined
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let localSelectionAnchor = ''
let remoteSelectionAnchor = ''
let localRequestId = 0
let pendingPassword: SshPasswordOptions | undefined
let connecting = false

const statusTracker = createSessionStatusTracker((status, message) => {
  connectionStatus.value = status
  emit('connection-status', status)
  if (message) errorMessage.value = message
  if (status === 'error' || status === 'closed') sessionId.value = ''
})
statusTracker.start()

const activeTransfers = computed(() => transfers.value.filter((item) => item.status === 'running' || item.status === 'queued' || item.status === 'paused'))
const finishedTransfers = computed(() => transfers.value.filter((item) => item.status === 'completed' || item.status === 'error' || item.status === 'cancelled'))
const totalTransferred = computed(() => transfers.value.reduce((sum, item) => sum + item.transferred, 0))
const totalBytes = computed(() => transfers.value.reduce((sum, item) => sum + item.total, 0))
function transferEvent(event: SftpTransferItem): void {
  if (event.sessionId !== sessionId.value) return
  upsertTransfer(event)
  if (event.status === 'completed') {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => { void refresh(); void refreshLocal() }, 350)
  }
}

function upsertTransfer(item: SftpTransferItem): void {
  const index = transferIndex.get(item.transferId)
  if (index !== undefined) transfers.value[index] = item
  else {
    transferIndex.set(item.transferId, transfers.value.length)
    transfers.value.push(item)
  }
}

function rebuildTransferIndex(): void {
  transferIndex.clear()
  transfers.value.forEach((item, index) => transferIndex.set(item.transferId, index))
}

function retainSelection(selected: string[], items: { path: string }[]): string[] {
  const paths = new Set(items.map((item) => item.path))
  return selected.filter((path) => paths.has(path))
}

function selectEntry(event: MouseEvent, side: 'local' | 'remote', entry: LocalEntry | SftpEntry): void {
  const paths = (side === 'local' ? localEntries.value : entries.value).map((item) => item.path)
  const selected = side === 'local' ? selectedLocalPaths : selectedRemotePaths
  const anchor = side === 'local' ? localSelectionAnchor : remoteSelectionAnchor
  selected.value = selectSftpPaths(paths, selected.value, entry.path, anchor, event.shiftKey, event.ctrlKey || event.metaKey)
  if (!event.shiftKey) {
    if (side === 'local') localSelectionAnchor = entry.path
    else remoteSelectionAnchor = entry.path
  }
}

function selectedEntries(side: 'local' | 'remote'): (LocalEntry | SftpEntry)[] {
  const selected = side === 'local' ? selectedLocalSet.value : selectedRemoteSet.value
  return (side === 'local' ? localEntries.value : entries.value).filter((entry) => selected.has(entry.path))
}

function isSelected(side: 'local' | 'remote', path: string): boolean {
  return (side === 'local' ? selectedLocalSet.value : selectedRemoteSet.value).has(path)
}

async function connect(): Promise<void> {
  if (connecting || disposed) return
  connecting = true
  loading.value = true
  errorMessage.value = ''
  pendingFingerprint.value = ''
  const previousSession = sessionId.value
  sessionId.value = ''
  statusTracker.start()
  if (previousSession) await remoteApi.value.disconnect(previousSession).catch(() => undefined)
  transfers.value = []
  transferIndex.clear()
  visibleTransferCount.value = 200
  selectedRemotePaths.value = []
  remoteSelectionAnchor = ''
  try {
    if (props.protocol !== 'ftp' && !pendingPassword) {
      const { connections } = await window.api.connections.list()
      if (disposed) return
      const connection = connections.find((item: { id: string }) => item.id === props.connectionId)
      if (connection?.authType === 'none' && !await window.api.ssh.hasSessionCredential(props.connectionId)) {
        const answer = await sshPassword.request(connection.id, `${connection.name} · ${connection.username || ''}@${connection.host}`, props.embedded ? 'ssh' : 'sftp')
        if (answer.status !== 'submitted' || disposed) {
          if (answer.status === 'timeout') {
            errorMessage.value = t('sshPasswordTimeout')
            statusTracker.finish('error', errorMessage.value)
          } else statusTracker.finish('closed')
          return
        }
        pendingPassword = answer.options
      }
    }
    const options = pendingPassword && props.embedded ? { ...pendingPassword, savePassword: false } : pendingPassword
    const result = await remoteApi.value.connect(props.connectionId, options)
    if (result.trustRequired) {
      if (disposed) return
      pendingFingerprint.value = result.fingerprint
      statusTracker.finish('error')
      return
    }
    if (disposed) {
      await remoteApi.value.disconnect(result.sessionId).catch(() => undefined)
      return
    }
    sessionId.value = result.sessionId
    statusTracker.bind(result.sessionId)
    if (!sessionId.value) return
    if (pendingPassword?.savePassword && !props.embedded) void connectionStore.load().catch(() => undefined)
    pendingPassword = undefined
    path.value = result.homePath
    pathInput.value = result.homePath
    transfers.value = await remoteApi.value.listTransfers(result.sessionId)
    rebuildTransferIndex()
    await refresh()
  } catch (error) {
    pendingPassword = undefined
    if (!disposed && connectionStatus.value === 'connecting') statusTracker.finish('error')
    errorMessage.value = error instanceof Error ? error.message : t('sftpUnavailable')
  } finally {
    loading.value = false
    connecting = false
  }
}

async function trustHostKey(): Promise<void> {
  if (!pendingFingerprint.value) return
  try {
    await window.api.sftp.trustHostKey(props.connectionId, pendingFingerprint.value)
    await connect()
  } catch (error) {
    statusTracker.finish('error')
    errorMessage.value = error instanceof Error ? error.message : t('sftpUnavailable')
  }
}

async function refresh(nextPath = path.value): Promise<void> {
  if (!sessionId.value) return
  loading.value = true
  errorMessage.value = ''
  try {
    entries.value = await remoteApi.value.list(sessionId.value, nextPath)
    selectedRemotePaths.value = retainSelection(selectedRemotePaths.value, entries.value)
    if (!selectedRemotePaths.value.includes(remoteSelectionAnchor)) remoteSelectionAnchor = ''
    path.value = nextPath
    pathInput.value = nextPath
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : t('sftpUnavailable')
  } finally {
    loading.value = false
  }
}

function openEntry(entry: SftpEntry): void {
  if (entry.type === 'directory') void refresh(entry.path)
  else if (entry.type === 'file') void openRemoteFile(entry)
}

async function refreshLocal(nextPath?: string): Promise<void> {
  const requestId = ++localRequestId
  localLoading.value = true
  localError.value = ''
  entryMenu.value = null
  try {
    const result = await window.api.app.listLocalDirectory(localNavigationTarget(nextPath, localPath.value))
    if (disposed || requestId !== localRequestId) return
    localPath.value = result.path
    localPathInput.value = result.path === LOCAL_COMPUTER_ROOT ? '' : result.path
    localParentPath.value = result.parentPath
    localEntries.value = result.entries
    selectedLocalPaths.value = retainSelection(selectedLocalPaths.value, result.entries)
    if (!selectedLocalPaths.value.includes(localSelectionAnchor)) localSelectionAnchor = ''
  } catch (error) {
    if (!disposed && requestId === localRequestId) localError.value = error instanceof Error ? error.message : t('operationFailed')
  } finally {
    if (!disposed && requestId === localRequestId) localLoading.value = false
  }
}

function localEntryName(entry: LocalEntry): string {
  if (entry.location === 'desktop') return t('localDesktop')
  if (entry.location === 'documents') return t('localDocuments')
  if (entry.location === 'downloads') return t('localDownloads')
  return entry.name
}

function openLocalEntry(entry: LocalEntry): void {
  if (entry.type === 'directory') void refreshLocal(entry.path)
}

async function chooseLocalDirectory(): Promise<void> {
  const directory = await window.api.app.chooseDownloadDirectory()
  if (directory) await refreshLocal(directory)
}

function showEntryMenu(event: MouseEvent, side: 'local' | 'remote', entry: LocalEntry | SftpEntry): void {
  if (side === 'local' && isLocalComputerRoot.value) return
  if (!isSelected(side, entry.path)) {
    if (side === 'local') {
      selectedLocalPaths.value = [entry.path]
      localSelectionAnchor = entry.path
    } else {
      selectedRemotePaths.value = [entry.path]
      remoteSelectionAnchor = entry.path
    }
  }
  entryMenu.value = { side, entry, x: Math.max(4, Math.min(event.clientX, window.innerWidth - 150)), y: Math.max(4, Math.min(event.clientY, window.innerHeight - 128)) }
}

function runEntryAction(action: 'upload' | 'download' | 'open' | 'rename' | 'remove'): void {
  const menu = entryMenu.value
  entryMenu.value = null
  if (!menu) return
  const selected = selectedEntries(menu.side)
  if (menu.side === 'local') void queueUploads(selected.map((entry) => entry.path))
  else if (action === 'download') void download(selected as SftpEntry[])
  else if (action === 'open' && selected.length === 1) void openRemoteFile(selected[0] as SftpEntry)
  else if (action === 'rename' && selected.length === 1) void renameEntry(selected[0] as SftpEntry)
  else if (action === 'remove') void removeEntries(selected as SftpEntry[])
}

function setPosition(position: SftpPosition, event: MouseEvent): void {
  emit('position', position)
  ;(event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')
}

function createDirectory(): void {
  directoryName.value = ''
  creatingDirectory.value = true
}

async function submitDirectory(): Promise<void> {
  const name = directoryName.value.trim()
  if (!name || !sessionId.value) return
  try {
    await remoteApi.value.mkdir(sessionId.value, joinRemotePath(path.value, name))
    creatingDirectory.value = false
    await refresh()
  } catch (error) { showError(error) }
}

function renameEntry(entry: SftpEntry): void {
  errorMessage.value = ''
  renamingEntry.value = entry
  renameName.value = entry.name
}

async function submitRename(): Promise<void> {
  const entry = renamingEntry.value
  const name = renameName.value.trim()
  if (!entry || !name || name === entry.name || !sessionId.value) return
  try {
    await remoteApi.value.rename(sessionId.value, entry.path, joinRemotePath(parentRemotePath(entry.path), name))
    renamingEntry.value = null
    await refresh()
  } catch (error) { showError(error) }
}

async function openRemoteFile(entry: SftpEntry): Promise<void> {
  if (!sessionId.value || entry.type !== 'file') return
  errorMessage.value = ''
  try {
    const result = await remoteApi.value.readText(sessionId.value, entry.path)
    editor.value = { entry, ...result }
  } catch (error) { showError(error) }
}

async function saveRemoteFile(): Promise<void> {
  if (!sessionId.value || !editor.value || editorSaving.value) return
  editorSaving.value = true
  try {
    await remoteApi.value.writeText(sessionId.value, editor.value.entry.path, editor.value.content, editor.value.modifiedAt)
    editor.value = null
    await refresh()
  } catch (error) { showError(error) } finally { editorSaving.value = false }
}

async function removeEntry(entry: SftpEntry): Promise<void> {
  await removeEntries([entry])
}

async function removeEntries(items: SftpEntry[]): Promise<void> {
  if (!sessionId.value || !items.length) return
  const names = items.slice(0, 3).map((entry) => entry.name).join(', ') + (items.length > 3 ? ` (+${items.length - 3})` : '')
  if (!await confirmDialog({ title: t('confirmTitle'), message: t('deleteRemoteConfirm', { name: names }), confirmText: t('remove'), danger: true })) return
  try {
    await Promise.all(items.map((entry) => remoteApi.value.remove(sessionId.value, entry.path, entry.type)))
  } catch (error) { showError(error) } finally { await refresh() }
}

async function chooseUploadFiles(): Promise<void> {
  const paths = await window.api.app.chooseUploadFiles()
  if (paths.length) await queueUploads(paths)
}

async function chooseUploadFolder(): Promise<void> {
  const folder = await window.api.app.chooseUploadFolder()
  if (folder) await queueUploads([folder])
}

async function queueUploads(paths: string[]): Promise<void> {
  if (!sessionId.value) return
  try {
    let result: SftpQueueResult = await remoteApi.value.enqueueUploads(sessionId.value, paths, path.value, false)
    if (result.conflicts.length) {
      if (!await confirmOverwrite(result)) return
      result = await remoteApi.value.enqueueUploads(sessionId.value, paths, path.value, true)
    }
    transferPanelOpen.value = true
    if (!result.transferIds.length) await refresh()
  } catch (error) { showError(error) }
}

function startEntryDrag(event: DragEvent, side: 'local' | 'remote', entry: LocalEntry | SftpEntry): void {
  if (side === 'local' && isLocalComputerRoot.value) { event.preventDefault(); return }
  const selected = side === 'local' ? selectedLocalPaths : selectedRemotePaths
  if (!selected.value.includes(entry.path)) {
    selected.value = [entry.path]
    if (side === 'local') localSelectionAnchor = entry.path
    else remoteSelectionAnchor = entry.path
  }
  event.dataTransfer?.setData('application/x-remotehub-sftp-entry', JSON.stringify({ side, paths: selectedEntries(side).map((item) => item.path) }))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}

function draggedEntries(event: DragEvent): { side: 'local' | 'remote'; paths: string[] } | null {
  try {
    const value = JSON.parse(event.dataTransfer?.getData('application/x-remotehub-sftp-entry') || '') as { side?: string; paths?: unknown }
    return (value.side === 'local' || value.side === 'remote') && Array.isArray(value.paths) && value.paths.length > 0 && value.paths.every((path) => typeof path === 'string')
      ? value as { side: 'local' | 'remote'; paths: string[] }
      : null
  } catch { return null }
}

function dropOnRemote(event: DragEvent): void {
  event.preventDefault()
  const internal = draggedEntries(event)
  if (internal?.side === 'local') return void queueUploads(internal.paths)
  const paths = [...(event.dataTransfer?.files || [])].map((file) => window.api.files.getPath(file)).filter(Boolean)
  if (paths.length) void queueUploads(paths)
}

function dropOnLocal(event: DragEvent): void {
  event.preventDefault()
  const internal = draggedEntries(event)
  const selected = new Set(internal?.side === 'remote' ? internal.paths : [])
  const items = entries.value.filter((entry) => selected.has(entry.path))
  if (items.length) void download(items)
}

async function download(input: SftpEntry | SftpEntry[]): Promise<void> {
  if (!sessionId.value) return
  const localDirectory = localTransferDirectory(localPath.value) || await window.api.app.chooseDownloadDirectory()
  if (!localDirectory) return
  const items = Array.isArray(input) ? input : [input]
  try {
    const pending: { entry: SftpEntry; result: SftpQueueResult }[] = []
    for (const entry of items) {
      const result = await remoteApi.value.enqueueDownload(sessionId.value, entry.path, localDirectory, entry.type, false)
      if (result.conflicts.length) pending.push({ entry, result })
    }
    const conflicts = pending.flatMap(({ result }) => result.conflicts)
    if (conflicts.length && await confirmOverwrite({ transferIds: [], conflicts })) {
      for (const { entry } of pending) await remoteApi.value.enqueueDownload(sessionId.value, entry.path, localDirectory, entry.type, true)
    }
    transferPanelOpen.value = true
  } catch (error) { showError(error) }
}

function confirmOverwrite(result: SftpQueueResult): Promise<boolean> {
  const examples = result.conflicts.slice(0, 3).map((item) => `• ${item.name}`).join('\n')
  const remaining = result.conflicts.length > 3 ? `\n${t('andMore', { count: result.conflicts.length - 3 })}` : ''
  return confirmDialog({ title: t('overwriteTitle'), message: `${t('overwriteConfirm', { count: result.conflicts.length })}\n\n${examples}${remaining}`, confirmText: t('overwrite') })
}

async function pauseOrResume(item: SftpTransferItem): Promise<void> {
  if (!sessionId.value) return
  try {
    const updated = item.status === 'paused'
      ? await remoteApi.value.resumeTransfer(sessionId.value, item.transferId)
      : await remoteApi.value.pauseTransfer(sessionId.value, item.transferId)
    upsertTransfer(updated)
  } catch (error) { showError(error) }
}

async function cancelTransfer(item: SftpTransferItem): Promise<void> {
  if (!sessionId.value) return
  try { upsertTransfer(await remoteApi.value.cancelTransfer(sessionId.value, item.transferId)) } catch (error) { showError(error) }
}

async function retryTransfer(item: SftpTransferItem): Promise<void> {
  if (!sessionId.value) return
  try { upsertTransfer(await remoteApi.value.retryTransfer(sessionId.value, item.transferId)) } catch (error) { showError(error) }
}

async function clearFinished(): Promise<void> {
  if (!sessionId.value) return
  try {
    await remoteApi.value.clearFinishedTransfers(sessionId.value)
    transfers.value = transfers.value.filter((item) => item.status === 'queued' || item.status === 'running' || item.status === 'paused')
    rebuildTransferIndex()
  } catch (error) { showError(error) }
}

function showError(error: unknown): void {
  errorMessage.value = error instanceof Error ? error.message : t('operationFailed')
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function statusText(status: SftpTransferStatus): string {
  const keys: Record<SftpTransferStatus, Parameters<typeof t>[0]> = { queued: 'queued', running: 'transferring', paused: 'paused', completed: 'completed', error: 'failed', cancelled: 'cancelled' }
  return t(keys[status])
}

function canPause(item: SftpTransferItem): boolean {
  return item.status === 'queued' || item.status === 'running' || item.status === 'paused'
}

function canCancel(item: SftpTransferItem): boolean {
  return item.status === 'queued' || item.status === 'running' || item.status === 'paused'
}

onMounted(() => {
  removeTransferListener = remoteApi.value.onTransfer(transferEvent)
  removeStatusListener = remoteApi.value.onStatus(statusTracker.handle)
  document.addEventListener('pointerdown', closeEntryMenu)
  void refreshLocal()
  void connect()
})

onBeforeUnmount(() => {
  disposed = true
  pendingPassword = undefined
  const currentSession = sessionId.value
  statusTracker.finish('closed')
  if (refreshTimer) clearTimeout(refreshTimer)
  removeTransferListener?.()
  removeStatusListener?.()
  document.removeEventListener('pointerdown', closeEntryMenu)
  if (currentSession) void remoteApi.value.disconnect(currentSession).catch(() => undefined)
})

function closeEntryMenu(): void {
  entryMenu.value = null
}
</script>

<template>
  <section class="sftp-pane">
    <div class="sftp-toolbar" role="toolbar" :aria-label="protocolName">
      <div class="sftp-toolbar-heading">
        <span class="terminal-kind" :class="{ 'ftp-kind': props.protocol === 'ftp' }"><UiIcon name="transfer" :size="13" /><b>{{ protocolName }}</b></span>
        <span><strong>{{ t('remoteFiles') }}</strong><small :class="{ error: connectionStatus === 'error' }">{{ t(connectionStatus === 'error' ? 'failed' : connectionStatus) }}</small></span>
      </div>
      <div class="sftp-toolbar-actions">
        <button v-if="!pendingFingerprint && (connectionStatus === 'closed' || connectionStatus === 'error')" class="toolbar-button" @click="connect"><UiIcon name="refresh" /> {{ t('reconnect') }}</button>
        <button class="toolbar-button sftp-responsive-action primary-transfer" :title="t('upload')" :aria-label="t('upload')" :disabled="!sessionId" @click="chooseUploadFiles"><UiIcon name="upload" /> <span>{{ t('upload') }}</span></button>
        <button class="toolbar-button sftp-responsive-action" :title="t('uploadFolder')" :aria-label="t('uploadFolder')" :disabled="!sessionId" @click="chooseUploadFolder"><UiIcon name="folderUpload" /> <span>{{ t('uploadFolder') }}</span></button>
        <button class="toolbar-button sftp-responsive-action" :title="t('newFolder')" :aria-label="t('newFolder')" :disabled="!sessionId" @click="createDirectory"><UiIcon name="folderPlus" /> <span>{{ t('newFolder') }}</span></button>
        <details class="sftp-layout-menu">
          <summary :title="t('actions')" :aria-label="t('actions')"><UiIcon name="more" /></summary>
          <div @click="($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')">
            <button v-if="!pendingFingerprint && (connectionStatus === 'closed' || connectionStatus === 'error')" @click="connect"><UiIcon name="refresh" /> {{ t('reconnect') }}</button>
            <button :disabled="!sessionId" @click="chooseUploadFiles"><UiIcon name="upload" /> {{ t('upload') }}</button>
            <button :disabled="!sessionId" @click="chooseUploadFolder"><UiIcon name="folderUpload" /> {{ t('uploadFolder') }}</button>
            <button :disabled="!sessionId" @click="createDirectory"><UiIcon name="folderPlus" /> {{ t('newFolder') }}</button>
            <template v-if="embedded">
<button :class="{ active: position === 'left' }" @click="setPosition('left', $event)"><UiIcon name="arrowLeft" /> {{ t('dockLeft') }}</button><button :class="{ active: position === 'right' }" @click="setPosition('right', $event)"><UiIcon name="arrowRight" /> {{ t('dockRight') }}</button><button :class="{ active: position === 'top' }" @click="setPosition('top', $event)"><UiIcon name="arrowUp" /> {{ t('dockTop') }}</button><button :class="{ active: position === 'bottom' }" @click="setPosition('bottom', $event)"><UiIcon name="arrowDown" /> {{ t('dockBottom') }}</button>
            </template>
          </div>
        </details>
      </div>
    </div>
    <div v-if="pendingFingerprint" class="terminal-host-key"><span>{{ t('hostKeyPrompt') }}</span><code>{{ t('hostKeyFingerprint') }}: {{ pendingFingerprint }}</code><button class="toolbar-button" @click="trustHostKey">{{ t('trustHostKey') }}</button></div>
    <div v-if="errorMessage" class="sftp-error"><span>{{ errorMessage }}</span><button class="icon-button" :aria-label="t('cancel')" @click="errorMessage = ''"><UiIcon name="close" /></button></div>
    <SplitPane class="sftp-file-split" :direction="position === 'left' || position === 'right' ? 'vertical' : 'horizontal'">
      <template #first><section class="sftp-browser local-browser" @dragover.prevent @drop.stop="dropOnLocal">
        <div class="sftp-browser-title"><span class="sftp-browser-mark" aria-hidden="true"><UiIcon name="drive" /></span><strong>{{ t('localFiles') }}</strong><span class="sftp-entry-count">{{ localEntries.length }}</span><button class="text-button" @click="chooseLocalDirectory">{{ t('chooseFolder') }}</button></div>
        <div class="sftp-browser-nav"><button :title="t('parentFolder')" :aria-label="t('parentFolder')" :disabled="localLoading || !localPath || localParentPath === localPath" @click="refreshLocal(localParentPath)"><UiIcon name="arrowUp" /></button><button :title="t('localComputer')" :aria-label="t('localComputer')" :disabled="localLoading || isLocalComputerRoot" @click="refreshLocal(LOCAL_COMPUTER_ROOT)"><UiIcon name="drive" /></button><form class="sftp-path" @submit.prevent="refreshLocal(localPathInput)"><input v-model="localPathInput" :aria-label="t('localFiles')" :placeholder="t('localComputer')"><button type="submit">{{ t('go') }}</button></form><button :title="t('refresh')" :aria-label="t('refresh')" @click="refreshLocal()"><UiIcon name="refresh" /></button></div>
        <div v-if="localError" class="sftp-error"><span>{{ localError }}</span><button class="icon-button" :aria-label="t('cancel')" @click="localError = ''"><UiIcon name="close" /></button></div>
        <div class="sftp-table-wrap">
          <table class="sftp-table">
            <thead><tr><th scope="col">{{ t('name') }}</th><th scope="col">{{ t('size') }}</th><th scope="col">{{ t('modified') }}</th><th scope="col">{{ t('actions') }}</th></tr></thead>
            <tbody>
              <tr v-if="localPath && localParentPath !== localPath" class="parent-entry" @dblclick="refreshLocal(localParentPath)"><td><FileTypeIcon type="directory" /><button class="file-name" @click.stop="refreshLocal(localParentPath)" @keydown.enter.prevent="refreshLocal(localParentPath)">..</button></td><td>—</td><td>—</td><td></td></tr>
              <tr v-if="localLoading"><td colspan="4" class="sftp-empty">{{ t('loading') }}</td></tr>
              <tr v-else-if="!localEntries.length"><td colspan="4" class="sftp-empty">{{ t('emptyFolder') }}</td></tr>
              <tr v-for="entry in localEntries" :key="entry.path" :class="{ selected: isSelected('local', entry.path) }" :draggable="!isLocalComputerRoot" @click="selectEntry($event, 'local', entry)" @dragstart="startEntryDrag($event, 'local', entry)" @dblclick="openLocalEntry(entry)" @contextmenu.prevent="showEntryMenu($event, 'local', entry)">
                <td><FileTypeIcon :type="entry.type" :name="entry.name" /><button class="file-name" @keydown.enter.prevent="openLocalEntry(entry)">{{ localEntryName(entry) }}</button></td><td>{{ entry.type === 'directory' ? '—' : formatSize(entry.size) }}</td><td>{{ entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : '—' }}</td><td class="file-actions"><button v-if="!isLocalComputerRoot" @click.stop="queueUploads([entry.path])"><UiIcon name="upload" /> {{ t('upload') }}</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section></template>
      <template #second><section class="sftp-browser remote-browser" @dragover.prevent @drop.stop="dropOnRemote">
        <div class="sftp-browser-title"><span class="sftp-browser-mark remote" aria-hidden="true"><UiIcon name="cloud" /></span><strong>{{ t('remoteFiles') }}</strong><span class="sftp-entry-count">{{ entries.length }}</span></div>
        <div class="sftp-browser-nav"><button :title="t('parentFolder')" :aria-label="t('parentFolder')" :disabled="!sessionId || path === '/'" @click="refresh(parentRemotePath(path))"><UiIcon name="arrowUp" /></button><form class="sftp-path" @submit.prevent="refresh(pathInput)"><input v-model="pathInput" :aria-label="t('remoteFiles')" :disabled="!sessionId"><button type="submit" :disabled="!sessionId">{{ t('go') }}</button></form><button :title="t('refresh')" :aria-label="t('refresh')" :disabled="!sessionId" @click="refresh()"><UiIcon name="refresh" /></button></div>
        <div class="sftp-table-wrap">
          <table class="sftp-table">
            <thead><tr><th scope="col">{{ t('name') }}</th><th scope="col">{{ t('size') }}</th><th scope="col">{{ t('modified') }}</th><th scope="col">{{ t('actions') }}</th></tr></thead>
            <tbody>
              <tr v-if="path !== '/'" class="parent-entry" @dblclick="refresh(parentRemotePath(path))"><td><FileTypeIcon type="directory" /><button class="file-name" @click.stop="refresh(parentRemotePath(path))" @keydown.enter.prevent="refresh(parentRemotePath(path))">..</button></td><td>—</td><td>—</td><td></td></tr>
              <tr v-if="loading"><td colspan="4" class="sftp-empty">{{ t('loading') }}</td></tr>
              <tr v-else-if="!entries.length"><td colspan="4" class="sftp-empty">{{ t('emptyFolder') }}</td></tr>
              <tr v-for="entry in entries" :key="entry.path" :class="{ selected: isSelected('remote', entry.path) }" draggable="true" @click="selectEntry($event, 'remote', entry)" @dragstart="startEntryDrag($event, 'remote', entry)" @dblclick="openEntry(entry)" @contextmenu.prevent="showEntryMenu($event, 'remote', entry)">
                <td><FileTypeIcon :type="entry.type" :name="entry.name" /><button class="file-name" @keydown.enter.prevent="openEntry(entry)">{{ entry.name }}</button></td><td>{{ entry.type === 'directory' ? '—' : formatSize(entry.size) }}</td><td>{{ entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : '—' }}</td><td class="file-actions compact"><button :title="t('download')" :aria-label="t('download')" @click.stop="download(entry)"><UiIcon name="download" /></button><button :title="t('rename')" :aria-label="t('rename')" @click.stop="renameEntry(entry)"><UiIcon name="edit" /></button><button class="danger" :title="t('remove')" :aria-label="t('remove')" @click.stop="removeEntry(entry)"><UiIcon name="trash" /></button></td>
              </tr>
            </tbody>
          </table>
          <div class="sftp-drop-hint"><UiIcon name="upload" /> <span>{{ t('dropUploadHint') }}</span></div>
        </div>
      </section></template>
    </SplitPane>
    <section v-if="transfers.length" class="transfer-manager" :class="{ collapsed: !transferPanelOpen }">
      <button class="transfer-header" :aria-expanded="transferPanelOpen" @click="transferPanelOpen = !transferPanelOpen">
        <span><UiIcon name="swapVertical" /> {{ t('transferQueue') }}</span>
        <span>{{ t('transferSummary', { active: activeTransfers.length, total: transfers.length }) }} · {{ formatSize(totalTransferred) }} / {{ formatSize(totalBytes) }}</span>
        <span><UiIcon :name="transferPanelOpen ? 'arrowDown' : 'arrowUp'" /></span>
      </button>
      <template v-if="transferPanelOpen">
        <div class="transfer-list">
          <div v-for="item in visibleTransfers" :key="item.transferId" class="transfer-row" :class="item.status">
            <span class="transfer-direction"><UiIcon :name="item.direction === 'upload' ? 'upload' : 'download'" /></span>
            <span class="transfer-copy"><strong :title="item.relativePath">{{ item.relativePath }}</strong><span class="transfer-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="transferProgress(item)"><i :style="{ width: `${transferProgress(item)}%` }"></i></span><small>{{ statusText(item.status) }} · {{ transferProgress(item) }}% · {{ formatSize(item.transferred) }} / {{ formatSize(item.total) }}<template v-if="item.speed"> · {{ formatSize(item.speed) }}/s</template><template v-if="item.message"> · {{ item.message }}</template></small></span>
            <span class="transfer-actions"><button v-if="canPause(item)" @click="pauseOrResume(item)"><UiIcon :name="item.status === 'paused' ? 'play' : 'pause'" /> {{ item.status === 'paused' ? t('resume') : t('pause') }}</button><button v-if="canCancel(item)" class="danger" @click="cancelTransfer(item)"><UiIcon name="close" /> {{ t('cancel') }}</button><button v-if="item.status === 'error' || item.status === 'cancelled'" @click="retryTransfer(item)"><UiIcon name="refresh" /> {{ t('retry') }}</button></span>
          </div>
        </div>
        <div class="transfer-footer"><span>{{ activeTransfers.length ? t('parallelTransfers') : t('transferIdle') }}</span><button v-if="visibleTransferCount < transfers.length" class="text-button" @click="visibleTransferCount += 200">{{ t('showMoreTransfers', { count: Math.min(200, transfers.length - visibleTransferCount) }) }}</button><button v-if="finishedTransfers.length" class="text-button" @click="clearFinished">{{ t('clearFinished') }}</button></div>
      </template>
    </section>
    <div v-if="entryMenu" class="sftp-context-menu" :style="{ left: `${entryMenu.x}px`, top: `${entryMenu.y}px` }" @pointerdown.stop>
      <button v-if="entryMenu.side === 'local'" @click="runEntryAction('upload')"><UiIcon name="upload" /> {{ t('upload') }}</button>
      <template v-else><button v-if="selectedEntries('remote').length === 1 && entryMenu.entry.type === 'file'" @click="runEntryAction('open')"><UiIcon name="file" /> {{ t('openFile') }}</button><button @click="runEntryAction('download')"><UiIcon name="download" /> {{ t('download') }}</button><button v-if="selectedEntries('remote').length === 1" @click="runEntryAction('rename')"><UiIcon name="edit" /> {{ t('rename') }}</button><button class="danger" @click="runEntryAction('remove')"><UiIcon name="trash" /> {{ t('remove') }}</button></template>
    </div>
    <div v-if="creatingDirectory" class="modal-layer" @click.self="creatingDirectory = false">
      <form class="connection-dialog compact-dialog" @submit.prevent="submitDirectory">
        <div class="dialog-heading"><div><span class="eyebrow">{{ protocolName }}</span><h2>{{ t('newFolder') }}</h2></div><button type="button" class="icon-button" :aria-label="t('cancel')" @click="creatingDirectory = false"><UiIcon name="close" /></button></div>
        <label class="field"><span>{{ t('folderName') }}</span><input v-model="directoryName" required maxlength="255" autofocus></label>
        <div class="dialog-actions"><button type="button" class="button secondary" @click="creatingDirectory = false">{{ t('cancel') }}</button><button type="submit" class="button primary">{{ t('newFolder') }}</button></div>
      </form>
    </div>
    <div v-if="renamingEntry" class="modal-layer" @click.self="renamingEntry = null">
      <form class="connection-dialog" @submit.prevent="submitRename">
        <div class="dialog-heading"><h2>{{ t('rename') }}</h2><button type="button" class="icon-button" :aria-label="t('cancel')" @click="renamingEntry = null"><UiIcon name="close" /></button></div>
        <div v-if="errorMessage" class="sftp-error"><span>{{ errorMessage }}</span></div>
        <label class="field"><span>{{ t('newName') }}</span><input v-model="renameName" required autofocus></label>
        <div class="dialog-actions"><button type="button" class="button secondary" @click="renamingEntry = null">{{ t('cancel') }}</button><button type="submit" class="button primary">{{ t('rename') }}</button></div>
      </form>
    </div>
    <div v-if="editor" class="modal-layer" @click.self="editor = null">
      <div class="connection-dialog sftp-editor">
        <div class="dialog-heading"><div><span class="eyebrow">{{ protocolName }}</span><h2>{{ editor.entry.name }}</h2></div><button type="button" class="icon-button" :aria-label="t('cancel')" @click="editor = null"><UiIcon name="close" /></button></div>
        <div v-if="errorMessage" class="sftp-error"><span>{{ errorMessage }}</span></div>
        <textarea v-model="editor.content" :aria-label="t('onlineEditor')" spellcheck="false"></textarea>
        <div class="dialog-actions"><button type="button" class="button secondary" @click="editor = null">{{ t('cancel') }}</button><button type="button" class="button primary" :disabled="editorSaving" @click="saveRemoteFile">{{ editorSaving ? t('saving') : t('saveFile') }}</button></div>
      </div>
    </div>
  </section>
</template>
