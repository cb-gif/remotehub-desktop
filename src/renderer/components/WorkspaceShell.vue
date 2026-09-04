<script setup lang="ts">
import { defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Connection } from '../../shared/types'
import type { TabConnectionStatus } from '../../shared/connection-status'
import { useConnectionStore } from '../stores/connection'
import { clampSplitRatio, useWorkspaceStore, type WorkspaceViewCount } from '../stores/workspace'
import TerminalPane from './TerminalPane.vue'
import SerialTerminalPane from './SerialTerminalPane.vue'
import SftpPane from './SftpPane.vue'
import SplitPane from './SplitPane.vue'
import { t } from '../i18n'
import { tabDragScroll, tabWheelDelta } from '../tab-navigation'
import { connectionLabelColor } from '../connection-color'
import ConnectionIcon from './ConnectionIcon.vue'
import UiIcon from './UiIcon.vue'
import appIcon from '../../../assets/remotehub.png'

const DatabasePane = defineAsyncComponent(() => import('./DatabasePane.vue'))

const props = defineProps<{ shortcutModifier: string }>()
const workspace = useWorkspaceStore()
const connections = useConnectionStore()
const tabStatuses = ref<Record<string, TabConnectionStatus>>({})
const workspaceContent = ref<HTMLElement | null>(null)
const tabStrip = ref<HTMLElement | null>(null)
const draggingTabId = ref('')
const tabDrop = ref<{ id: string; after: boolean } | null>(null)
let dragScrollFrame: number | undefined
let dragClientX = 0
const workspaceSplitX = ref(50)
const workspaceSplitY = ref(50)
let workspaceDrag: 'x' | 'y' | null = null

onMounted(() => {
  window.addEventListener('keydown', handleShortcut)
  document.addEventListener('pointerdown', closeOpenMenus)
  void nextTick(revealActiveTab)
})
onUnmounted(() => {
  window.removeEventListener('keydown', handleShortcut)
  document.removeEventListener('pointerdown', closeOpenMenus)
  finishTabDrag()
})

watch(() => workspace.activeId, () => { void nextTick(revealActiveTab) })
watch(() => workspace.tabs.map(tab => tab.id), (ids) => {
  for (const id of Object.keys(tabStatuses.value)) if (!ids.includes(id)) delete tabStatuses.value[id]
})

function revealActiveTab(): void {
  const tab = Array.from(tabStrip.value?.querySelectorAll<HTMLElement>('[data-tab-id]') || []).find((item) => item.dataset.tabId === workspace.activeId)
  tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function scrollTabs(event: WheelEvent): void {
  const strip = tabStrip.value
  if (!strip || strip.scrollWidth <= strip.clientWidth) return
  const delta = tabWheelDelta(event, strip.clientWidth)
  if (!delta) return
  event.preventDefault()
  strip.scrollLeft += delta
}

function startTabDrag(event: DragEvent, id: string): void {
  if (!workspace.tabs.some((tab) => tab.id === id && tab.closable) || !event.dataTransfer) { event.preventDefault(); return }
  draggingTabId.value = id
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('application/x-remotehub-workspace-tab', id)
}

function scrollDuringDrag(): void {
  dragScrollFrame = undefined
  if (!draggingTabId.value || !tabStrip.value) return
  const bounds = tabStrip.value.getBoundingClientRect()
  const speed = tabDragScroll(dragClientX, bounds.left, bounds.right)
  if (speed) {
    tabStrip.value.scrollLeft += speed
    dragScrollFrame = window.requestAnimationFrame(scrollDuringDrag)
  }
}

function dragOverStrip(event: DragEvent): void {
  if (!draggingTabId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragClientX = event.clientX
  if (dragScrollFrame === undefined) dragScrollFrame = window.requestAnimationFrame(scrollDuringDrag)
}

function dragOverTab(event: DragEvent, id: string): void {
  if (!draggingTabId.value) return
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  tabDrop.value = { id, after: event.clientX >= bounds.left + bounds.width / 2 }
}

function dropTab(event: DragEvent, targetId?: string): void {
  if (!draggingTabId.value) return
  event.preventDefault()
  const target = targetId || workspace.tabs.at(-1)?.id
  if (target) workspace.moveTab(draggingTabId.value, target, targetId ? tabDrop.value?.id === targetId && tabDrop.value.after : true)
  finishTabDrag()
}

function finishTabDrag(): void {
  draggingTabId.value = ''
  tabDrop.value = null
  if (dragScrollFrame !== undefined) window.cancelAnimationFrame(dragScrollFrame)
  dragScrollFrame = undefined
}

function panePosition(id: string): { gridColumn: number; gridRow: number } | undefined {
  if (workspace.viewCount === 1) return undefined
  const index = workspace.paneIndex(id)
  return { gridColumn: index % 2 + 1, gridRow: Math.floor(index / 2) + 1 }
}

function closeOpenMenus(event: PointerEvent): void {
  document.querySelectorAll<HTMLDetailsElement>('.tab-menu[open], .sftp-layout-menu[open]').forEach((menu) => {
    if (!menu.contains(event.target as Node)) menu.open = false
  })
}

function iconFor(type: string): string {
  return type === 'terminal' ? 'terminal' : type === 'sftp' ? 'transfer' : type === 'sql' ? 'database' : 'grid'
}

function connectionFor(connectionId?: string): Connection | null {
  return connections.connections.find((connection) => connection.id === connectionId) || null
}

function setTabStatus(tabId: string, status: TabConnectionStatus): void {
  if (workspace.tabs.some(tab => tab.id === tabId)) tabStatuses.value[tabId] = status
}

function statusFor(tabId: string): TabConnectionStatus {
  return tabStatuses.value[tabId] ?? 'closed'
}

function statusText(tabId: string): string {
  const status = statusFor(tabId)
  return t(status === 'error' ? 'connectionFailed' : status)
}

function tabColor(connectionId?: string): string | undefined {
  return connectionLabelColor(connections.connections, connectionId)
}

function openConnection(connection: Connection): void {
  connections.select(connection.id)
  workspace.openConnection(connection.id, connection.name, connection.type === 'database' ? 'sql' : connection.type === 'ftp' ? 'sftp' : 'terminal')
}

function openActiveAgain(): void {
  const tab = workspace.activeTab
  if (tab?.connectionId && (tab.type === 'terminal' || tab.type === 'sftp' || tab.type === 'sql')) workspace.openConnection(tab.connectionId, tab.title, tab.type)
}

function closeMenu(event: MouseEvent): void {
  (event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')
}

function handleShortcut(event: KeyboardEvent): void {
  const modifier = props.shortcutModifier === '⌘' ? event.metaKey : event.ctrlKey
  if (!modifier) return
  const key = event.key.toLowerCase()
  if (/^[1-9]$/.test(key)) workspace.activate(workspace.tabs[Number(key) - 1]?.id || workspace.activeId)
  else if (event.key === 'Tab') workspace.cycle(event.shiftKey ? -1 : 1)
  else if (key === 'w') event.shiftKey ? workspace.closeAll() : workspace.close(workspace.activeId)
  else if (key === 't') openActiveAgain()
  else if (event.key === '\\') setViewCount(workspace.viewCount === 1 ? 2 : 1)
  else return
  event.preventDefault()
}

function setViewCount(count: WorkspaceViewCount): void {
  workspaceSplitX.value = 50
  workspaceSplitY.value = 50
  workspace.setViewCount(count)
}

function startWorkspaceResize(axis: 'x' | 'y', event: PointerEvent): void {
  workspaceDrag = axis
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function resizeWorkspace(event: PointerEvent): void {
  if (!workspaceDrag || !workspaceContent.value) return
  const bounds = workspaceContent.value.getBoundingClientRect()
  const value = workspaceDrag === 'x' ? (event.clientX - bounds.left) / bounds.width : (event.clientY - bounds.top) / bounds.height
  ;(workspaceDrag === 'x' ? workspaceSplitX : workspaceSplitY).value = clampSplitRatio(value * 100)
}

function stopWorkspaceResize(event: PointerEvent): void {
  workspaceDrag = null
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
}

function resizeWorkspaceWithKeyboard(axis: 'x' | 'y', event: KeyboardEvent): void {
  const delta = axis === 'x'
    ? event.key === 'ArrowLeft' ? -2 : event.key === 'ArrowRight' ? 2 : 0
    : event.key === 'ArrowUp' ? -2 : event.key === 'ArrowDown' ? 2 : 0
  if (!delta) return
  ;(axis === 'x' ? workspaceSplitX : workspaceSplitY).value = clampSplitRatio((axis === 'x' ? workspaceSplitX : workspaceSplitY).value + delta)
  event.preventDefault()
}
</script>

<template>
  <section class="workspace-shell">
    <div class="tab-bar">
      <div ref="tabStrip" class="tab-strip" role="tablist" @wheel="scrollTabs" @dragover="dragOverStrip" @drop="dropTab($event)">
        <div v-for="tab in workspace.tabs" :key="tab.id" class="workspace-tab" :class="{ active: workspace.activeId === tab.id, secondary: workspace.secondaryIds.includes(tab.id), dragging: draggingTabId === tab.id, 'drop-before': tabDrop?.id === tab.id && !tabDrop.after, 'drop-after': tabDrop?.id === tab.id && tabDrop.after }" :style="{ '--tab-color': tabColor(tab.connectionId) }" role="tab" :data-tab-id="tab.id" :draggable="tab.closable" :title="tab.connectionId ? `${tab.title} · ${statusText(tab.id)}` : tab.title" :aria-label="tab.connectionId ? `${tab.title} · ${statusText(tab.id)}` : tab.title" :tabindex="workspace.activeId === tab.id ? 0 : -1" :aria-selected="workspace.activeId === tab.id" @click="workspace.activate(tab.id)" @keydown.enter="workspace.activate(tab.id)" @dragstart="startTabDrag($event, tab.id)" @dragover="dragOverTab($event, tab.id)" @drop.stop="dropTab($event, tab.id)" @dragend="finishTabDrag">
          <span class="tab-icon"><UiIcon :name="iconFor(tab.type)" /></span><span v-if="tab.connectionId" class="tab-connection-status" :class="statusFor(tab.id)" :data-status="statusFor(tab.id)" role="img" :aria-label="statusText(tab.id)" :title="statusText(tab.id)"></span><span class="tab-title">{{ tab.title }}</span><span v-if="tab.pinned" class="tab-pin" :title="t('pinnedTab')"><UiIcon name="pin" :size="12" /></span><button v-else-if="tab.closable" class="tab-close" :aria-label="t('closeTab')" @click.stop="workspace.close(tab.id)"><UiIcon name="close" :size="14" /></button>
        </div>
        <button class="new-tab" :title="`${t('newTab')} (${shortcutModifier} T)`" :aria-label="t('newTab')" :disabled="!workspace.activeTab?.connectionId" @click="openActiveAgain"><UiIcon name="plus" /></button>
      </div>
      <div class="tab-tools">
        <div class="view-switch" :aria-label="t('multiView')">
          <button :class="{ active: workspace.viewCount === 1 }" :title="t('singleView')" :aria-label="t('singleView')" @click="setViewCount(1)"><UiIcon name="layoutOne" /></button>
          <button :class="{ active: workspace.viewCount === 2 }" :title="t('doubleView')" :aria-label="t('doubleView')" :disabled="!workspace.canUseViewCount(2)" @click="setViewCount(2)"><UiIcon name="layoutTwo" /></button>
          <button :class="{ active: workspace.viewCount === 4 }" :title="t('quadView')" :aria-label="t('quadView')" :disabled="!workspace.canUseViewCount(4)" @click="setViewCount(4)"><UiIcon name="layoutFour" /></button>
        </div>
        <button :title="workspace.activeTab?.pinned ? t('unpinTab') : t('pinTab')" :aria-label="workspace.activeTab?.pinned ? t('unpinTab') : t('pinTab')" :disabled="!workspace.activeTab?.closable" @click="workspace.togglePinned()"><UiIcon name="pin" /></button>
        <details class="tab-menu">
          <summary :aria-label="t('tabActions')"><UiIcon name="more" /></summary>
          <div class="tab-menu-popover">
            <button :disabled="!workspace.activeTab?.closable" @click="workspace.closeOthers(); closeMenu($event)">{{ t('closeOthers') }}</button>
            <button :disabled="!workspace.activeTab?.closable" @click="workspace.closeRight(); closeMenu($event)">{{ t('closeRight') }}</button>
            <button @click="workspace.closeAll(); closeMenu($event)">{{ t('closeAll') }}</button>
          </div>
        </details>
      </div>
    </div>
    <div ref="workspaceContent" class="workspace-content" :class="`layout-${workspace.viewCount}`" :style="{ '--workspace-split-x': `${workspaceSplitX}%`, '--workspace-split-y': `${workspaceSplitY}%` }">
      <div v-show="workspace.activeId === 'welcome'" class="welcome-view workspace-pane-slot primary">
        <div class="welcome-heading">
          <img class="welcome-glyph" :src="appIcon" alt=""><div><h1>{{ t('workspace') }}</h1><p>{{ t('allConnections') }}</p></div>
        </div>
        <div v-if="connections.connections.length" class="workspace-connections">
          <button v-for="connection in connections.connections" :key="connection.id" class="workspace-connection-card" :title="t('doubleClick')" @dblclick="openConnection(connection)">
            <ConnectionIcon :connection="connection" />
            <span><strong>{{ connection.name }}</strong><small>{{ connection.type === 'shell' ? connection.host : connection.type === 'serial' ? `${connection.host} · ${connection.port} baud` : `${connection.host}:${connection.port}` }}</small></span>
            <em>{{ connection.type === 'database' ? connection.databaseType : connection.type.toUpperCase() }}</em>
          </button>
        </div>
        <div v-else class="workspace-empty">{{ t('emptyConnections') }}</div>
        <div class="shortcut-grid">
          <div><kbd>{{ shortcutModifier }} K</kbd><span>{{ t('searchShortcut') }}</span></div><div><kbd>{{ shortcutModifier }} N</kbd><span>{{ t('addShortcut') }}</span></div>
        </div>
      </div>
      <template v-for="tab in workspace.tabs" :key="tab.id">
        <div v-if="tab.connectionId" v-show="workspace.isVisible(tab.id)" class="workspace-pane-slot" :class="{ focused: workspace.activeId === tab.id }" :style="panePosition(tab.id)" :data-pane-tab="tab.id" @pointerdown.capture="workspace.focusPane(tab.id)" @focusin.capture="workspace.focusPane(tab.id)">
          <div v-if="workspace.viewCount > 1" class="split-pane-heading"><select class="pane-connection-picker" :value="tab.id" :title="tab.title" :aria-label="t('selectViewConnection')" @change="workspace.showInPane(tab.id, ($event.target as HTMLSelectElement).value)"><option v-for="option in workspace.tabs.filter(item => item.closable)" :key="option.id" :value="option.id">{{ option.title }}</option></select><small v-if="workspace.activeId === tab.id">{{ t('focusedView') }}</small><button :title="t('closeView')" :aria-label="t('closeView')" @click.stop="workspace.closePane(tab.id)"><UiIcon name="close" /></button></div>
          <div class="workspace-pane-body">
            <SplitPane v-if="tab.type === 'terminal' && connectionFor(tab.connectionId)?.type === 'ssh'" class="ssh-workspace" :class="[`sftp-${tab.sftpPosition ?? 'bottom'}`, { 'second-collapsed': tab.sftpOpen === false }]" :direction="tab.sftpPosition === 'left' || tab.sftpPosition === 'right' ? 'horizontal' : 'vertical'" :reverse="tab.sftpPosition === 'left' || tab.sftpPosition === 'top'" :initial="60">
              <template #first><TerminalPane :connection-id="tab.connectionId" :active="workspace.isVisible(tab.id)" :sftp-open="tab.sftpOpen !== false" @toggle-sftp="workspace.toggleSftp(tab.id)" @connection-status="setTabStatus(tab.id, $event)" /></template>
              <template #second><SftpPane v-show="tab.sftpOpen !== false" :connection-id="tab.connectionId" embedded :position="tab.sftpPosition ?? 'bottom'" @position="workspace.setSftpPosition(tab.id, $event)" /></template>
            </SplitPane>
            <TerminalPane v-else-if="tab.type === 'terminal' && connectionFor(tab.connectionId)?.type === 'shell'" :connection-id="tab.connectionId" :active="workspace.isVisible(tab.id)" local @connection-status="setTabStatus(tab.id, $event)" />
            <SerialTerminalPane v-else-if="tab.type === 'terminal' && connectionFor(tab.connectionId)?.type === 'serial'" :connection-id="tab.connectionId" :active="workspace.isVisible(tab.id)" @connection-status="setTabStatus(tab.id, $event)" />
            <SftpPane v-else-if="tab.type === 'sftp' && (connectionFor(tab.connectionId)?.type === 'ssh' || connectionFor(tab.connectionId)?.type === 'ftp')" :connection-id="tab.connectionId" :protocol="connectionFor(tab.connectionId)?.type === 'ftp' ? 'ftp' : 'sftp'" @connection-status="setTabStatus(tab.id, $event)" />
            <DatabasePane v-else-if="tab.type === 'sql' && connectionFor(tab.connectionId)?.type === 'database'" :connection-id="tab.connectionId" @connection-status="setTabStatus(tab.id, $event)" />
            <div v-else class="workspace-placeholder">
              <div class="connection-overview">
                <div class="overview-icon"><UiIcon :name="connectionFor(tab.connectionId)?.type === 'database' ? 'database' : 'terminal'" :size="20" /></div>
                <span class="status-dot"></span>
                <div><span class="eyebrow">{{ t('workspaceReady') }}</span><h2>{{ connectionFor(tab.connectionId)?.name }}</h2><p>{{ connectionFor(tab.connectionId)?.host }}:{{ connectionFor(tab.connectionId)?.port }} · {{ connectionFor(tab.connectionId)?.type === 'database' ? connectionFor(tab.connectionId)?.databaseType : 'SSH' }}</p></div>
              </div>
              <div class="module-placeholders">
                <button class="module-tile" disabled><span><UiIcon name="terminal" /></span><strong>Terminal</strong><small>{{ t('terminalPhase') }}</small></button>
                <button class="module-tile" disabled><span><UiIcon name="transfer" /></span><strong>SFTP</strong><small>{{ t('sftpPhase') }}</small></button>
                <button class="module-tile" disabled><span><UiIcon name="database" /></span><strong>Database</strong><small>{{ t('databasePhase') }}</small></button>
              </div>
            </div>
          </div>
        </div>
      </template>
      <div v-if="workspace.viewCount > 1" class="workspace-divider vertical" role="separator" tabindex="0" aria-orientation="vertical" :aria-valuemin="20" :aria-valuemax="80" :aria-valuenow="Math.round(workspaceSplitX)" @pointerdown.prevent="startWorkspaceResize('x', $event)" @pointermove="resizeWorkspace" @pointerup="stopWorkspaceResize" @pointercancel="stopWorkspaceResize" @keydown="resizeWorkspaceWithKeyboard('x', $event)"></div>
      <div v-if="workspace.viewCount === 4" class="workspace-divider horizontal" role="separator" tabindex="0" aria-orientation="horizontal" :aria-valuemin="20" :aria-valuemax="80" :aria-valuenow="Math.round(workspaceSplitY)" @pointerdown.prevent="startWorkspaceResize('y', $event)" @pointermove="resizeWorkspace" @pointerup="stopWorkspaceResize" @pointercancel="stopWorkspaceResize" @keydown="resizeWorkspaceWithKeyboard('y', $event)"></div>
    </div>
  </section>
</template>
