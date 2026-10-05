import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshOutput } from '../src/main/services/ssh-output'
import { SshService } from '../src/main/services/ssh'
import { createTerminalOutput } from '../src/renderer/terminal-output'
import type { Connection } from '../src/shared/types'

vi.mock('electron', () => ({ app: {}, safeStorage: {} }))
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('SSH output flow control', () => {
  it('batches small writes and preserves split UTF-8 and surrogate pairs', () => {
    const send = vi.fn()
    const output = new SshOutput(send, vi.fn(), vi.fn())
    const prefix = 'x'.repeat(32767)
    const data = Buffer.from(`${prefix}😀安全\u001b[31mOK`)
    for (let index = 0; index < data.length; index += 17) output.push(data.subarray(index, index + 17))
    vi.advanceTimersByTime(8)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe(prefix)
    output.acknowledge(1)
    vi.advanceTimersByTime(8)
    expect(send.mock.calls.map(call => call[0]).join('')).toBe(data.toString())
    output.finish()
  })

  it('pauses a real readable producer while a terminal is behind, then resumes without loss', async () => {
    const chunk = Buffer.alloc(8192, 'x')
    let produced = 0
    const source = new Readable({ read() { if (produced++ < 256) this.push(chunk); else this.push(null) } })
    const packets: { data: string; sequence: number }[] = []
    const output = new SshOutput((data, sequence) => packets.push({ data, sequence }), () => source.pause(), () => source.resume())
    source.on('data', chunk => output.push(chunk))
    const ended = new Promise<void>(resolve => source.on('end', () => { output.finish(); resolve() }))
    await vi.advanceTimersByTimeAsync(8)
    expect(source.isPaused()).toBe(true)
    expect(produced).toBeLessThan(32)
    expect(packets).toHaveLength(1)
    output.acknowledge(999)
    await vi.advanceTimersByTimeAsync(1000)
    expect(packets).toHaveLength(1)
    let consumed = 0
    for (let turn = 0; turn < 100 && !source.readableEnded; turn++) {
      const next = packets[consumed++]
      expect(next).toBeDefined()
      output.acknowledge(next.sequence)
      // A duplicate ACK must not open a second in-flight batch.
      output.acknowledge(next.sequence)
      await vi.advanceTimersByTimeAsync(8)
    }
    await ended
    expect(packets.reduce((sum, packet) => sum + packet.data.length, 0)).toBe(256 * chunk.length)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('delivers the final tail once and releases pending timers on close', () => {
    const send = vi.fn()
    const output = new SshOutput(send, vi.fn(), vi.fn())
    output.push(Buffer.from('last line'))
    output.finish()
    output.finish()
    output.push('late event')
    vi.runAllTimers()
    expect(send).toHaveBeenCalledExactlyOnceWith('last line', 1)
  })

  it('isolates 40 sessions and reduces 8,000 small chunks to 40 IPC batches', async () => {
    const send = vi.fn()
    const service = new SshService({ markConnected: vi.fn() } as never, { get: () => 'test-only' } as never, send)
    const clients: EventEmitter[] = []
    const streams: EventEmitter[] = []
    service['createClient'] = () => {
      const stream = Object.assign(new EventEmitter(), { pause: vi.fn(), resume: vi.fn(), close: vi.fn() })
      const client = Object.assign(new EventEmitter(), { connect: vi.fn(), end: vi.fn(), shell: (_options: unknown, done: (error: undefined, stream: unknown) => void) => done(undefined, stream) })
      clients.push(client); streams.push(stream)
      return client as never
    }
    const connection = { id: 'fixture', type: 'ssh', username: 'fixture' } as Connection
    try {
      for (let index = 0; index < 40; index++) {
        const connected = service.connect(connection, undefined, `tab-${index}`)
        clients[index].emit('ready')
        await connected
      }
      send.mockClear()
      for (let index = 0; index < 40; index++) for (let line = 0; line < 200; line++) streams[index].emit('data', Buffer.from(`${index}:${line}\r\n`))
      vi.advanceTimersByTime(8)
      expect(send).toHaveBeenCalledTimes(40)
      for (let index = 0; index < 40; index++) {
        expect(send.mock.calls[index]).toEqual(['ssh:data', { sessionId: `tab-${index}`, sequence: 1, data: Array.from({ length: 200 }, (_, line) => `${index}:${line}\r\n`).join('') }])
      }
    } finally { service.dispose() }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles a canceled pending connection and prevents late readiness from resurrecting it', async () => {
    const client = Object.assign(new EventEmitter(), { connect: vi.fn(), shell: vi.fn(), end: vi.fn() })
    const service = new SshService({} as never, { get: () => 'fixture' } as never, vi.fn())
    service['createClient'] = () => client as never
    const pending = service.connect({ type: 'ssh', username: 'fixture' } as Connection, undefined, 'pending')
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SSH_CONNECTION_CLOSED' })
    await expect(service.connect({ type: 'ssh', username: 'fixture' } as Connection, undefined, 'pending')).rejects.toMatchObject({ code: 'SSH_SESSION_INVALID' })
    service.disconnect('pending')
    client.emit('ready')
    await rejected
    expect(client.shell).not.toHaveBeenCalled()
    expect(service['sessions'].size).toBe(0)
  })
})

describe('terminal output scheduling', () => {
  it('waits for xterm parsing before acknowledging and delays background batches', () => {
    const callbacks: (() => void)[] = []
    const write = vi.fn((_data: string, done: () => void) => callbacks.push(done))
    const acknowledged = vi.fn()
    const output = createTerminalOutput(write, () => false)
    output.enqueue('one', acknowledged)
    output.enqueue('final tail', acknowledged)
    vi.advanceTimersByTime(199)
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(17)
    expect(write).toHaveBeenCalledTimes(1)
    expect(acknowledged).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(write).toHaveBeenCalledTimes(1)
    callbacks.shift()!()
    expect(acknowledged).toHaveBeenCalledTimes(1)
    output.flush()
    expect(write).toHaveBeenCalledTimes(2)
    output.dispose()
    callbacks.shift()!()
    expect(acknowledged).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles foreground input promptly and resumes a newly visible pane immediately', () => {
    const write = vi.fn((_data: string, done: () => void) => done())
    const acknowledged = vi.fn()
    let visible = true
    const output = createTerminalOutput(write, () => visible)
    output.enqueue('foreground', acknowledged)
    vi.advanceTimersByTime(0)
    expect(acknowledged).toHaveBeenCalledTimes(1)
    visible = false
    output.enqueue('background', acknowledged)
    vi.advanceTimersByTime(10)
    visible = true
    output.flush()
    expect(acknowledged).toHaveBeenCalledTimes(2)
    output.dispose()
  })

  it('spreads many background terminals across turns and prioritizes a newly visible pane', () => {
    const write = vi.fn((_data: string, done: () => void) => done())
    const outputs = Array.from({ length: 40 }, () => createTerminalOutput(write, () => false))
    outputs.forEach((output, index) => output.enqueue(String(index), () => {}))
    vi.advanceTimersByTime(200)
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(16)
    expect(write).toHaveBeenCalledTimes(1)
    outputs[39].flush()
    expect(write.mock.calls[1][0]).toBe('39')
    vi.advanceTimersByTime(16)
    expect(write).toHaveBeenCalledTimes(3)
    outputs.forEach(output => output.dispose())
    expect(vi.getTimerCount()).toBe(0)
  })
})
