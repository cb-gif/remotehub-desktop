import { createPinia, setActivePinia } from 'pinia'
import { computed } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Connection } from '../src/shared/types'
import { connectionLabelColor } from '../src/renderer/connection-color'
import { useConnectionStore } from '../src/renderer/stores/connection'
import { useWorkspaceStore } from '../src/renderer/stores/workspace'

function profile(id: string, color?: string): Connection {
  return { id, color, name: id, type: 'shell', host: '', port: 0, favorite: false, sortOrder: 0, createdAt: 1, updatedAt: 1 }
}

beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
  setActivePinia(createPinia())
})

afterEach(() => {
  useWorkspaceStore().$dispose()
  useConnectionStore().$dispose()
  vi.unstubAllGlobals()
})

function setup() {
  const connections = useConnectionStore()
  const workspace = useWorkspaceStore()
  connections.connections = [profile('red', '#ff4d4f'), profile('green', '#52c41a'), profile('blue', '#1677ff'), profile('none')]
  const activeColor = computed(() => connectionLabelColor(connections.connections, workspace.activeTab.connectionId))
  const open = (id: string) => {
    workspace.openConnection(id, id, 'terminal')
    return workspace.activeId
  }
  return { connections, workspace, activeColor, open }
}

describe('connection label color', () => {
  it('looks up only the requested connection and accepts six-digit hexadecimal colors', () => {
    const profiles = [{ id: 'red', color: '#ff4d4f' }, { id: 'upper', color: '#A1B2C3' }]
    expect(connectionLabelColor(profiles, 'red')).toBe('#ff4d4f')
    expect(connectionLabelColor(profiles, 'upper')).toBe('#A1B2C3')
    expect(connectionLabelColor(profiles, 'missing')).toBeUndefined()
    expect(connectionLabelColor(profiles)).toBeUndefined()
  })

  it.each(['', 'red', '#fff', '#12345678', '#gggggg', ' #123456', '#123456 ', '#123456\n', 'var(--blue)', 'url(example)'])('falls back for invalid color %j', (color) => {
    expect(connectionLabelColor([{ id: 'asset', color }], 'asset')).toBeUndefined()
  })
})

describe('active workspace color', () => {
  it('follows the clicked tab, not the selected asset', () => {
    const { connections, workspace, activeColor, open } = setup()
    const redTab = open('red')
    const greenTab = open('green')
    connections.select('blue')
    expect(activeColor.value).toBe('#52c41a')
    workspace.activate(redTab)
    expect(activeColor.value).toBe('#ff4d4f')
    connections.select('none')
    expect(activeColor.value).toBe('#ff4d4f')
    workspace.activate(greenTab)
    expect(activeColor.value).toBe('#52c41a')
    expect(connections.selectedId).toBe('none')
  })

  it.each([2, 4] as const)('follows focus across all %i panes without replacing their connections', (count) => {
    const { connections, workspace, activeColor, open } = setup()
    for (const id of ['red', 'green', 'blue', 'none']) open(id)
    workspace.setViewCount(count)
    const panes = [...workspace.visibleIds]
    connections.select('red')
    for (const tabId of panes) {
      const connectionId = workspace.tabs.find((tab) => tab.id === tabId)?.connectionId
      workspace.focusPane(tabId)
      expect(workspace.activeId).toBe(tabId)
      expect(activeColor.value).toBe(connectionLabelColor(connections.connections, connectionId))
      expect(workspace.visibleIds).toEqual(panes)
    }
    expect(connections.selectedId).toBe('red')
  })

  it('updates when a different connection is selected for the focused split pane', () => {
    const { workspace, activeColor, open } = setup()
    const redTab = open('red')
    open('green')
    open('blue')
    workspace.setViewCount(2)
    const [left, right] = workspace.visibleIds
    workspace.showInPane(right, redTab)
    expect(workspace.visibleIds).toEqual([left, redTab])
    expect(activeColor.value).toBe('#ff4d4f')
  })

  it('reacts to saved color edits without reopening or replacing any tab', async () => {
    const { connections, workspace, activeColor, open } = setup()
    const redTab = open('red')
    const tab = workspace.activeTab
    const save = vi.fn().mockResolvedValue(profile('red', '#a855f7'))
    vi.stubGlobal('window', { api: { connections: { save } } })
    await connections.save({ ...profile('red'), color: '#a855f7' })
    expect(activeColor.value).toBe('#a855f7')
    expect(workspace.activeId).toBe(redTab)
    expect(workspace.activeTab).toBe(tab)
    expect(connectionLabelColor(connections.connections, tab.connectionId)).toBe('#a855f7')
    save.mockResolvedValue(profile('red'))
    await connections.save(profile('red'))
    expect(activeColor.value).toBeUndefined()
  })

  it('keeps duplicate sessions on the same live asset color independently of tab order', () => {
    const { connections, workspace, activeColor, open } = setup()
    const first = open('red')
    const second = open('red')
    connections.connections[0].color = '#13c2c2'
    workspace.moveTab(second, first)
    for (const id of [first, second]) {
      workspace.activate(id)
      expect(activeColor.value).toBe('#13c2c2')
    }
  })

  it('uses the default color for Welcome, uncolored assets, and removed assets', () => {
    const { connections, workspace, activeColor, open } = setup()
    connections.select('red')
    expect(activeColor.value).toBeUndefined()
    open('red')
    expect(activeColor.value).toBe('#ff4d4f')
    workspace.activate('welcome')
    expect(activeColor.value).toBeUndefined()
    open('none')
    expect(activeColor.value).toBeUndefined()
    open('green')
    connections.connections = connections.connections.filter((connection) => connection.id !== 'green')
    expect(activeColor.value).toBeUndefined()
    workspace.removeConnection('green')
    expect(activeColor.value).toBeUndefined()
  })

  it('adopts the replacement tab color after closing the active tab', () => {
    const { workspace, activeColor, open } = setup()
    open('red')
    const greenTab = open('green')
    expect(activeColor.value).toBe('#52c41a')
    workspace.close(greenTab)
    expect(activeColor.value).toBe('#ff4d4f')
    workspace.closeAll()
    expect(activeColor.value).toBeUndefined()
  })
})
