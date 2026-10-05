import { StringDecoder } from 'node:string_decoder'

const BATCH_SIZE = 32 * 1024
const HIGH_WATER = 128 * 1024

// One acknowledged batch per terminal keeps Electron and xterm queues bounded.
// Pause the SSH readable stream when its consumer falls behind, without dropping
// output or suspending the SSH connection's keepalives/control messages.
export class SshOutput {
  private readonly decoder = new StringDecoder('utf8')
  private chunks: string[] = []
  private length = 0
  private sequence = 0
  private pending = 0
  private paused = false
  private closed = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly send: (data: string, sequence: number) => void, private readonly pause: () => void, private readonly resume: () => void) {}

  push(chunk: unknown): void {
    if (this.closed) return
    const data = Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : String(chunk)
    if (!data) return
    this.chunks.push(data)
    this.length += data.length
    if (this.length >= HIGH_WATER && !this.paused) { this.paused = true; this.pause() }
    this.schedule()
  }

  acknowledge(sequence: number): void {
    if (this.closed || sequence !== this.pending) return
    this.pending = 0
    this.schedule()
  }

  finish(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    const tail = this.chunks.join('') + this.decoder.end()
    this.chunks = []
    this.length = 0
    // The final bounded tail must precede the closed status; no future ACK can
    // arrive for a session that has already been removed from the service.
    if (tail) this.send(tail, ++this.sequence)
  }

  private schedule(): void {
    if (!this.length || this.pending || this.timer || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const queued = this.chunks.join('')
      let end = Math.min(queued.length, BATCH_SIZE)
      const last = queued.charCodeAt(end - 1)
      if (end < queued.length && last >= 0xd800 && last <= 0xdbff) end--
      const data = queued.slice(0, end)
      const rest = queued.slice(end)
      this.chunks = rest ? [rest] : []
      this.length = rest.length
      this.pending = ++this.sequence
      this.send(data, this.pending)
      if (this.paused && this.length < HIGH_WATER / 2) { this.paused = false; this.resume() }
    }, 8)
  }
}
