import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

export type WorkspaceTabType = 'welcome' | 'terminal' | 'sftp' | 'sql' | 'table'
export type WorkspaceViewCount = 1 | 2 | 4
export type SftpPosition = 'right' | 'left' | 'top' | 'bottom'

export function normalizeSftpPosition(value: string | null): SftpPosition {
  return value === 'right' || value === 'left' || value === 'top' ? value : 'bottom'
}

export function clampSplitRatio(value: number): number {
  return Math.min(80, Math.max(20, value))
}

export interface WorkspaceTab {
  id: string
  type: WorkspaceTabType
  title: string
  connectionId?: string
  closable: boolean
  pinned?: boolean
  sftpOpen?: boolean
  sftpPosition?: SftpPosition
}

function tabSftpPreferences(value: Record<string, unknown> = {}): Pick<WorkspaceTab, 'sftpOpen' | 'sftpPosition'> {
  const storage = typeof localStorage === 'undefined' ? undefined : localStorage
  return {
    sftpOpen: typeof value.sftpOpen === 'boolean' ? value.sftpOpen : storage?.getItem('remotehub.sftpOpen') !== 'false',
    sftpPosition: normalizeSftpPosition(typeof value.sftpPosition === 'string' ? value.sftpPosition : storage?.getItem('remotehub.sftpPosition') ?? null)
  }
}

const STORAGE_KEY = 'remotehub.workspace'
const welcomeTab: WorkspaceTab = { id: 'welcome', type: 'welcome', title: '', closable: false }
const connectionTabTypes = new Set<WorkspaceTabType>(['terminal', 'sftp', 'sql'])

export const useWorkspaceStore = defineStore('workspace', () => {
  const tabs = ref<WorkspaceTab[]>([{ ...welcomeTab }])
  const activeId = ref('welcome')
  // Physical pane order is independent from the currently focused tab and tab-strip order.
  const paneIds = ref<string[]>(['welcome'])
  const secondaryIds = computed(() => paneIds.value.filter((id) => id !== activeId.value))
  const viewCount = ref<WorkspaceViewCount>(1)
  const secondaryId = computed(() => secondaryIds.value[0] || null)
  const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeId.value) || tabs.value[0])
  const visibleIds = computed(() => paneIds.value)
  let nextTabId = 0

  watch([tabs, activeId, paneIds, viewCount], persist, { deep: true })

  function openConnection(connectionId: string, title: string, type: 'terminal' | 'sftp' | 'sql'): void {
    const id = `connection:${connectionId}:${++nextTabId}`
    tabs.value.push({ id, type, title, connectionId, closable: true, ...(type === 'terminal' ? tabSftpPreferences() : {}) })
    activate(id)
  }

  function toggleSftp(id: string): void {
    const tab = tabs.value.find((item) => item.id === id && item.type === 'terminal')
    if (tab) tab.sftpOpen = tab.sftpOpen === false
  }

  function setSftpPosition(id: string, position: SftpPosition): void {
    const tab = tabs.value.find((item) => item.id === id && item.type === 'terminal')
    if (tab) tab.sftpPosition = normalizeSftpPosition(position)
  }

  function activate(id: string): void {
    if (!tabs.value.some((tab) => tab.id === id)) return
    if (id === 'welcome') paneIds.value = ['welcome']
    else if (!paneIds.value.includes(id)) paneIds.value[Math.max(0, paneIds.value.indexOf(activeId.value))] = id
    activeId.value = id
    normalizeViewCount()
  }

  function focusPane(id: string): void {
    if (paneIds.value.includes(id)) activeId.value = id
  }

  function showInPane(targetId: string, id: string): void {
    const target = paneIds.value.indexOf(targetId)
    if (target < 0 || !tabs.value.some((tab) => tab.id === id && tab.closable)) return
    const current = paneIds.value.indexOf(id)
    if (current >= 0 && current !== target) paneIds.value[current] = targetId
    paneIds.value[target] = id
    activeId.value = id
    normalizeViewCount()
  }

  function paneIndex(id: string): number {
    return paneIds.value.indexOf(id)
  }

  function moveTab(id: string, targetId: string, after = false): void {
    if (id === targetId) return
    const index = tabs.value.findIndex((tab) => tab.id === id && tab.closable)
    if (index < 0 || !tabs.value.some((tab) => tab.id === targetId)) return
    const [tab] = tabs.value.splice(index, 1)
    const target = tabs.value.findIndex((item) => item.id === targetId)
    tabs.value.splice(Math.max(1, target + (after ? 1 : 0)), 0, tab)
  }

  function close(id: string, force = false): void {
    const index = tabs.value.findIndex((tab) => tab.id === id)
    const tab = tabs.value[index]
    if (!tab?.closable || (tab.pinned && !force)) return
    tabs.value.splice(index, 1)
    const pane = paneIds.value.indexOf(id)
    if (pane >= 0) {
      const replacement = [...tabs.value.slice(0, index).reverse(), ...tabs.value.slice(index)].find((item) => item.closable && !paneIds.value.includes(item.id))
      if (replacement) paneIds.value[pane] = replacement.id
      else paneIds.value.splice(pane, 1)
      if (activeId.value === id) activeId.value = paneIds.value[Math.min(pane, paneIds.value.length - 1)] || 'welcome'
    }
    normalizeViewCount()
  }

  function togglePinned(id = activeId.value): void {
    const tab = tabs.value.find((item) => item.id === id)
    if (tab?.closable) tab.pinned = !tab.pinned
  }

  function closeOthers(id = activeId.value): void {
    tabs.value.filter((tab) => tab.id !== id && tab.closable && !tab.pinned).forEach((tab) => close(tab.id))
    activate(id)
  }

  function closeRight(id = activeId.value): void {
    const index = tabs.value.findIndex((tab) => tab.id === id)
    tabs.value.slice(index + 1).filter((tab) => tab.closable && !tab.pinned).forEach((tab) => close(tab.id))
  }

  function closeAll(): void {
    tabs.value.filter((tab) => tab.closable && !tab.pinned).forEach((tab) => close(tab.id))
  }

  function openSplit(id = activeId.value): void {
    const index = tabs.value.findIndex((tab) => tab.id === id && tab.closable)
    if (index < 0) return
    const first = activeId.value !== id && activeTab.value?.closable ? activeId.value
      : [...tabs.value.slice(0, index).reverse(), ...tabs.value.slice(index + 1)].find((tab) => tab.closable && tab.id !== id)?.id
    if (!first) return
    paneIds.value = [first, id]
    activeId.value = first
    normalizeViewCount()
  }

  function closeSplit(): void {
    setViewCount(1)
  }

  function setViewCount(count: WorkspaceViewCount): void {
    if (count === 1) {
      paneIds.value = [activeId.value]
      normalizeViewCount()
      return
    }
    const connectionTabs = tabs.value.filter((tab) => tab.closable)
    if (!activeTab.value?.closable || connectionTabs.length < count) return
    const next = paneIds.value.filter((id) => connectionTabs.some((tab) => tab.id === id)).slice(0, count)
    if (!next.includes(activeId.value)) next[Math.max(0, next.length - 1)] = activeId.value
    for (const tab of [...connectionTabs].reverse()) {
      if (next.length >= count) break
      if (!next.includes(tab.id)) next.push(tab.id)
    }
    paneIds.value = next
    normalizeViewCount()
  }

  function closePane(id: string): void {
    paneIds.value = paneIds.value.filter((item) => item !== id)
    normalizeViewCount()
  }

  function isVisible(id: string): boolean {
    return visibleIds.value.includes(id)
  }

  function canUseViewCount(count: WorkspaceViewCount): boolean {
    return count === 1 || Boolean(activeTab.value?.closable && tabs.value.filter((tab) => tab.closable).length >= count)
  }

  function cycle(direction: 1 | -1): void {
    const connectionTabs = tabs.value.filter((tab) => tab.closable)
    if (!connectionTabs.length) return
    const index = connectionTabs.findIndex((tab) => tab.id === activeId.value)
    activate(connectionTabs[(index + direction + connectionTabs.length) % connectionTabs.length].id)
  }

  function removeConnection(connectionId: string): void {
    tabs.value.filter((tab) => tab.connectionId === connectionId).forEach((tab) => close(tab.id, true))
  }

  function restore(validConnectionIds: Iterable<string>, serialized?: string | null): void {
    const validIds = new Set(validConnectionIds)
    try {
      const state = JSON.parse(serialized === undefined ? localStorage.getItem(STORAGE_KEY) || '{}' : serialized || '{}') as Record<string, unknown>
      const restored = Array.isArray(state.tabs) ? state.tabs.filter((value): value is Record<string, unknown> => {
        if (!value || typeof value !== 'object') return false
        return typeof value.id === 'string' && typeof value.title === 'string' && typeof value.connectionId === 'string'
          && connectionTabTypes.has(value.type as WorkspaceTabType) && validIds.has(value.connectionId)
      }).map((value) => ({
        id: value.id as string,
        type: value.type as WorkspaceTabType,
        title: value.title as string,
        connectionId: value.connectionId as string,
        closable: true,
        pinned: value.pinned === true,
        ...(value.type === 'terminal' ? tabSftpPreferences(value) : {})
      })) : []
      const unique = restored.filter((tab, index) => restored.findIndex((item) => item.id === tab.id) === index)
      tabs.value = [{ ...welcomeTab }, ...unique]
      const savedActiveId = typeof state.activeId === 'string' && unique.some((tab) => tab.id === state.activeId) ? state.activeId : undefined
      activeId.value = savedActiveId || unique[0]?.id || 'welcome'
      const restoredSecondaryIds = Array.isArray(state.secondaryIds) ? state.secondaryIds : typeof state.secondaryId === 'string' ? [state.secondaryId] : []
      const restoredPanes = Array.isArray(state.paneIds) ? state.paneIds : [activeId.value, ...restoredSecondaryIds]
      const maximum = state.viewCount === 4 ? 4 : restoredPanes.length > 1 ? 2 : 1
      paneIds.value = restoredPanes.filter((id): id is string => typeof id === 'string' && tabs.value.some((tab) => tab.id === id)).slice(0, maximum)
      if (activeId.value !== 'welcome' && !paneIds.value.includes(activeId.value)) paneIds.value = [activeId.value, ...paneIds.value.filter((id) => id !== 'welcome')].slice(0, maximum)
      normalizeViewCount()
      nextTabId = Math.max(0, ...unique.map((tab) => Number(tab.id.match(/:(\d+)$/)?.[1] || 0)))
    } catch {
      tabs.value = [{ ...welcomeTab }]
      activeId.value = 'welcome'
      paneIds.value = ['welcome']
      viewCount.value = 1
    }
  }

  function persist(): void {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      tabs: tabs.value.filter((tab) => tab.closable),
      activeId: activeId.value,
      secondaryId: secondaryId.value,
      secondaryIds: secondaryIds.value,
      paneIds: paneIds.value,
      viewCount: viewCount.value
    }))
  }

  function normalizeViewCount(): void {
    paneIds.value = paneIds.value.filter((id, index) => paneIds.value.indexOf(id) === index && tabs.value.some((tab) => tab.id === id)).slice(0, 4)
    if (paneIds.value.length > 1) paneIds.value = paneIds.value.filter((id) => id !== 'welcome')
    if (!paneIds.value.length) paneIds.value = [tabs.value.some((tab) => tab.id === activeId.value) ? activeId.value : 'welcome']
    if (!paneIds.value.includes(activeId.value)) activeId.value = paneIds.value[0]
    viewCount.value = paneIds.value.length >= 3 ? 4 : paneIds.value.length === 2 ? 2 : 1
  }

  return { tabs, activeId, secondaryId, secondaryIds, viewCount, activeTab, visibleIds, openConnection, activate, focusPane, showInPane, paneIndex, moveTab, close, togglePinned, toggleSftp, setSftpPosition, closeOthers, closeRight, closeAll, openSplit, closeSplit, setViewCount, closePane, isVisible, canUseViewCount, cycle, removeConnection, restore }
})
