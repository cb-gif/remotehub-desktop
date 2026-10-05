import { describe, expect, it, vi } from 'vitest'
import type { RemoteHubApi } from '../src/preload'
const mock = vi.hoisted(() => ({ api: null as RemoteHubApi | null, handlers: new Map<string, Set<(...args: unknown[]) => void>>() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: RemoteHubApi) => { mock.api = api } },
  webUtils: {},
  ipcRenderer: {
    on: (channel: string, handler: (...args: unknown[]) => void) => { const handlers = mock.handlers.get(channel) || new Set(); handlers.add(handler); mock.handlers.set(channel, handlers) },
    removeListener: (channel: string, handler: (...args: unknown[]) => void) => mock.handlers.get(channel)?.delete(handler)
  }
}))
import '../src/preload'

describe('SSH preload routing', () => {
  it('uses one IPC listener and invokes only the owning pane across 40 subscriptions', () => {
    const listeners = Array.from({ length: 40 }, () => vi.fn())
    const remove = listeners.map((listener, index) => mock.api!.ssh.onData(listener, `tab-${index}`))
    try {
      expect(mock.handlers.get('ssh:data')?.size).toBe(1)
      for (let index = 0; index < 40; index++) {
        const data = { sessionId: `tab-${index}`, data: `output-${index}`, sequence: 1 }
        mock.handlers.get('ssh:data')!.forEach(handler => handler({}, data))
      }
      for (let index = 0; index < 40; index++) expect(listeners[index]).toHaveBeenCalledExactlyOnceWith({ sessionId: `tab-${index}`, data: `output-${index}`, sequence: 1 })
      remove[0]()
      mock.handlers.get('ssh:data')!.forEach(handler => handler({}, { sessionId: 'tab-0', data: 'late' }))
      expect(listeners[0]).toHaveBeenCalledTimes(1)
    } finally { remove.forEach(dispose => dispose()) }
    expect(mock.handlers.get('ssh:data')?.size).toBe(0)
  })
})
