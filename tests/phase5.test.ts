import { describe, expect, it, vi } from 'vitest'
import { TransferManager, type TransferHooks } from '../src/main/services/transfer-manager'
import { transferProgress, type SftpTransferItem } from '../src/shared/sftp'

describe('Phase 5 transfer manager', () => {
  it('queues work, pauses and resumes an active stream, then schedules the next file', () => {
    const events: SftpTransferItem[] = []
    const hooks = new Map<string, TransferHooks>()
    const paused = vi.fn()
    const resumed = vi.fn()
    const manager = new TransferManager((item) => events.push(item), 1)
    const job = (name: string) => manager.enqueue({
      sessionId: 'session-1', direction: 'upload', name, relativePath: name, total: 100,
      start: (_offset, transferHooks) => {
        hooks.set(name, transferHooks)
        return { pause: paused, resume: resumed, cancel: vi.fn() }
      }
    })

    const first = job('first.bin')
    const second = job('second.bin')
    expect(manager.getItem(first.transferId).status).toBe('running')
    expect(manager.getItem(second.transferId).status).toBe('queued')

    manager.pause(first.transferId)
    expect(paused).toHaveBeenCalledOnce()
    expect(manager.getItem(first.transferId).status).toBe('paused')
    manager.resume(first.transferId)
    expect(resumed).toHaveBeenCalledOnce()

    hooks.get('first.bin')?.progress(50)
    expect(manager.getItem(first.transferId).transferred).toBe(50)
    hooks.get('first.bin')?.done()
    expect(manager.getItem(first.transferId).status).toBe('completed')
    expect(manager.getItem(second.transferId).status).toBe('running')
    expect(events.some((item) => item.status === 'queued')).toBe(true)
  })

  it('cancels and retries a transfer from the beginning', () => {
    let hooks: TransferHooks | undefined
    const cancel = vi.fn()
    const manager = new TransferManager(() => undefined, 1)
    const item = manager.enqueue({
      sessionId: 'session-1', direction: 'download', name: 'data.db', relativePath: 'data.db', total: 200,
      start: (_offset, value) => { hooks = value; return { pause: vi.fn(), resume: vi.fn(), cancel } }
    })
    hooks?.progress(80)
    manager.cancel(item.transferId)
    expect(cancel).toHaveBeenCalledOnce()
    expect(manager.getItem(item.transferId).status).toBe('cancelled')
    manager.retry(item.transferId)
    expect(manager.getItem(item.transferId)).toMatchObject({ status: 'running', transferred: 0 })
    hooks?.done(new Error('network lost'))
    expect(manager.getItem(item.transferId)).toMatchObject({ status: 'error', message: 'network lost' })
  })

  it('clamps serializable percentage values', () => {
    expect(transferProgress({ transferred: 50, total: 200 })).toBe(25)
    expect(transferProgress({ transferred: 300, total: 200 })).toBe(100)
    expect(transferProgress({ transferred: 0, total: 0 })).toBe(0)
  })

  it('settles only once when a driver completes synchronously', () => {
    const manager = new TransferManager(() => undefined, 1)
    const first = manager.enqueue({
      sessionId: 'session-1', direction: 'upload', name: 'empty.txt', relativePath: 'empty.txt', total: 0,
      start: (_offset, hooks) => {
        hooks.done()
        hooks.done(new Error('late callback'))
        return { pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() }
      }
    })
    const second = manager.enqueue({
      sessionId: 'session-1', direction: 'upload', name: 'next.txt', relativePath: 'next.txt', total: 1,
      start: () => ({ pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() })
    })
    expect(manager.getItem(first.transferId)).toMatchObject({ status: 'completed', message: undefined })
    expect(manager.getItem(second.transferId).status).toBe('running')
  })

  it('does not start queued jobs from a session while closing it', () => {
    const manager = new TransferManager(() => undefined, 1)
    const activeCancel = vi.fn()
    const queuedStart = vi.fn(() => ({ pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() }))
    const otherStart = vi.fn(() => ({ pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() }))
    manager.enqueue({
      sessionId: 'closing', direction: 'download', name: 'active', relativePath: 'active', total: 1,
      start: () => ({ pause: vi.fn(), resume: vi.fn(), cancel: activeCancel })
    })
    manager.enqueue({ sessionId: 'closing', direction: 'download', name: 'queued', relativePath: 'queued', total: 1, start: queuedStart })
    manager.enqueue({ sessionId: 'other', direction: 'download', name: 'other', relativePath: 'other', total: 1, start: otherStart })

    manager.closeSession('closing')

    expect(activeCancel).toHaveBeenCalledOnce()
    expect(queuedStart).not.toHaveBeenCalled()
    expect(otherStart).toHaveBeenCalledOnce()
    expect(manager.list('closing')).toEqual([])
  })
})
