<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import ConnectionDialog from '../components/ConnectionDialog.vue'
import ConnectionExplorer from '../components/ConnectionExplorer.vue'
import WorkspaceShell from '../components/WorkspaceShell.vue'
import { useConnectionStore } from '../stores/connection'
import { useWorkspaceStore } from '../stores/workspace'
import type { Connection, ConnectionInput } from '../../shared/types'
import type { Group } from '../../shared/types'
import { locale, t, toggleLocale } from '../i18n'
import { confirmDialog } from '../dialog'
import { connectionLabelColor } from '../connection-color'
import appIcon from '../../../assets/remotehub.png'

const connectionStore = useConnectionStore()
const workspace = useWorkspaceStore()
const activeConnectionColor = computed(() => connectionLabelColor(connectionStore.connections, workspace.activeTab?.connectionId))
const dialogOpen = ref(false)
const editing = ref<Connection | null>(null)
const groupDialogOpen = ref(false)
const editingGroup = ref<Group | null>(null)
const groupName = ref('')
const fullscreen = ref(false)
const appInfo = ref<{ name: string; version: string; platform: string; dataPath: string } | null>(null)
type MessageKey = Parameters<typeof t>[0]
const statusKey = ref<MessageKey>('initializing')
const statusValues = ref<Record<string, string | number>>({})
const statusError = ref('')
const statusText = computed(() => statusError.value || t(statusKey.value, statusValues.value))
const shortcutModifier = computed(() => appInfo.value?.platform === 'darwin' ? '⌘' : 'Ctrl')
type Theme = 'light' | 'dark'
const savedTheme = localStorage.getItem('remotehub.theme')
const theme = ref<Theme>(savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
let removeFullscreenListener: (() => void) | undefined
document.documentElement.dataset.theme = theme.value

function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme.value
  localStorage.setItem('remotehub.theme', theme.value)
  if (window.api) void window.api.app.setTheme(theme.value).catch(() => undefined)
}

onMounted(async () => {
  if (window.api) void window.api.app.setTheme(theme.value).catch(() => undefined)
  removeFullscreenListener = window.api.app.onFullscreenChange((value) => { fullscreen.value = value })
  try {
    await connectionStore.load()
    workspace.restore(connectionStore.connections.map((connection) => connection.id))
    appInfo.value = await window.api.app.getInfo()
    setStatus('ready')
  } catch (error) {
    setError(error, 'initFailed')
  }
  window.addEventListener('keydown', handleShortcut)
})
onUnmounted(() => {
  window.removeEventListener('keydown', handleShortcut)
  removeFullscreenListener?.()
})

function setStatus(key: MessageKey, values: Record<string, string | number> = {}): void {
  statusError.value = ''
  statusKey.value = key
  statusValues.value = values
}

function setError(error: unknown, fallback: MessageKey): void {
  statusError.value = error instanceof Error ? error.message : t(fallback)
}

function handleShortcut(event: KeyboardEvent): void {
  const modifier = appInfo.value?.platform === 'darwin' ? event.metaKey : event.ctrlKey
  if (!modifier) return
  if (event.key.toLowerCase() === 'k') {
    event.preventDefault()
    document.querySelector<HTMLInputElement>('#connection-search')?.focus()
  } else if (event.key.toLowerCase() === 'n') {
    event.preventDefault()
    openCreate()
  }
}

function openCreate(): void {
  editing.value = null
  dialogOpen.value = true
}

function openEdit(connection: Connection): void {
  editing.value = connection
  dialogOpen.value = true
}

async function saveConnection(input: ConnectionInput, credential?: string, clearCredential?: boolean, privateKeyPath?: string): Promise<void> {
  try {
    await connectionStore.save(input, credential, clearCredential, privateKeyPath)
    dialogOpen.value = false
    setStatus('saved')
  } catch (error) {
    setError(error, 'saveFailed')
  }
}

async function removeConnection(connection: Connection): Promise<void> {
  if (!await confirmDialog({ title: t('confirmTitle'), message: t('deleteConnectionConfirm', { name: connection.name }), confirmText: t('remove'), danger: true })) return
  try {
    await connectionStore.remove(connection.id)
    workspace.removeConnection(connection.id)
    setStatus('deleted')
  } catch (error) {
    setError(error, 'saveFailed')
  }
}

function selectConnection(id: string): void {
  connectionStore.select(id)
  const selected = connectionStore.selected
  if (selected) workspace.openConnection(selected.id, selected.name, selected.type === 'database' ? 'sql' : selected.type === 'ftp' ? 'sftp' : 'terminal')
}

function openSftp(connection: Connection): void {
  connectionStore.select(connection.id)
  workspace.openConnection(connection.id, `${connection.name} · SFTP`, 'sftp')
}

async function duplicateConnection(connection: Connection): Promise<void> {
  try {
    await connectionStore.duplicate(connection.id)
    setStatus('duplicated')
  } catch (error) {
    setError(error, 'saveFailed')
  }
}

async function importConnections(): Promise<void> {
  try {
    const result = await connectionStore.importConnections()
    if (!result.canceled) setStatus('importedConnections', { count: result.count })
  } catch (error) { setError(error, 'importFailed') }
}

async function exportConnections(): Promise<void> {
  try {
    const result = await connectionStore.exportConnections()
    if (!result.canceled) setStatus('exportedConnections', { count: result.count })
  } catch (error) { setError(error, 'exportFailed') }
}

async function testConnection(connection: Connection): Promise<void> {
  try {
    const result = await connectionStore.test(connection.id)
    setStatus(result.ok ? 'testOk' : 'testFailed', result.ok ? { latency: result.latencyMs } : { code: result.code })
  } catch (error) {
    setError(error, 'testFailed')
  }
}

async function moveConnection(id: string, beforeId?: string, groupId?: string): Promise<void> {
  try {
    await connectionStore.move(id, beforeId, groupId)
  } catch (error) {
    setError(error, 'saveFailed')
  }
}

async function moveGroup(id: string, targetId: string, after: boolean): Promise<void> {
  try {
    await connectionStore.moveGroup(id, targetId, after)
  } catch (error) {
    setError(error, 'saveFailed')
  }
}

function createGroup(): void {
  editingGroup.value = null
  groupName.value = ''
  groupDialogOpen.value = true
}

function editGroup(group: Group): void {
  editingGroup.value = group
  groupName.value = group.name
  groupDialogOpen.value = true
}

async function saveGroup(): Promise<void> {
  const name = groupName.value.trim()
  if (!name) return
  try {
    await connectionStore.saveGroup(name, editingGroup.value?.id)
    groupDialogOpen.value = false
    setStatus('saved')
  } catch (error) {
    setError(error, 'saveFailed')
  }
}

async function removeGroup(group: Group): Promise<void> {
  if (await confirmDialog({ title: t('confirmTitle'), message: t('deleteGroupConfirm', { name: group.name }), confirmText: t('remove'), danger: true })) try { await connectionStore.deleteGroup(group.id) } catch (error) { setError(error, 'saveFailed') }
}
</script>

<template>
  <div class="app-frame" :class="{ darwin: appInfo?.platform === 'darwin', fullscreen }">
    <header class="top-toolbar">
      <div class="brand"><img class="brand-mark" :src="appIcon" alt=""><div><strong>RemoteHub</strong><small>DESKTOP WORKBENCH</small></div></div>
      <div class="toolbar-context" :style="{ '--workspace-color': activeConnectionColor }"><button class="toolbar-label" @click="workspace.activate('welcome')">{{ t('workspace') }}</button><span class="toolbar-separator">/</span><span>{{ workspace.activeTab?.title }}</span></div>
      <div class="toolbar-actions"><button class="toolbar-button" @click="openCreate">＋ {{ t('newConnection') }}</button><button class="toolbar-button muted theme-toggle" :title="theme === 'dark' ? t('lightMode') : t('darkMode')" :aria-label="theme === 'dark' ? t('lightMode') : t('darkMode')" @click="toggleTheme">{{ theme === 'dark' ? '☀' : '☾' }}</button><button class="toolbar-button muted" @click="toggleLocale">{{ locale === 'zh-CN' ? 'EN' : '中文' }}</button></div>
    </header>
    <div class="app-body">
      <ConnectionExplorer :connections="connectionStore.filteredConnections" :groups="connectionStore.groups" :selected-id="connectionStore.selectedId" :search="connectionStore.search" @update:search="connectionStore.search = $event" @select="selectConnection" @sftp="openSftp" @create="openCreate" @edit="openEdit" @remove="removeConnection" @duplicate="duplicateConnection" @import-connections="importConnections" @export-connections="exportConnections" @test="testConnection" @move="moveConnection" @move-group="moveGroup" @create-group="createGroup" @edit-group="editGroup" @remove-group="removeGroup" />
      <main class="main-workspace"><WorkspaceShell :shortcut-modifier="shortcutModifier" /></main>
    </div>
    <footer class="status-bar"><span class="status-item"><span class="status-dot"></span>{{ statusText }}</span><span class="status-item">{{ appInfo?.platform || 'desktop' }} · {{ t('localOnly') }}</span><span class="status-item version">{{ appInfo?.version ? `v${appInfo.version}` : 'v0.1.0' }}</span></footer>
    <ConnectionDialog :open="dialogOpen" :connection="editing" :groups="connectionStore.groups" :connections="connectionStore.connections" :platform="appInfo?.platform" @close="dialogOpen = false" @save="saveConnection" />
    <div v-if="groupDialogOpen" class="modal-layer" @click.self="groupDialogOpen = false">
      <form class="connection-dialog" @submit.prevent="saveGroup">
        <div class="dialog-heading"><div><span class="eyebrow">{{ t('group') }}</span><h2>{{ editingGroup ? t('renameGroup') : t('newGroup') }}</h2></div><button type="button" class="icon-button" :aria-label="t('cancel')" @click="groupDialogOpen = false">×</button></div>
        <label class="field"><span>{{ t('groupName') }}</span><input v-model="groupName" required maxlength="80" autofocus></label>
        <div class="dialog-actions"><button type="button" class="button secondary" @click="groupDialogOpen = false">{{ t('cancel') }}</button><button type="submit" class="button primary">{{ editingGroup ? t('renameGroup') : t('newGroup') }}</button></div>
      </form>
    </div>
  </div>
</template>
