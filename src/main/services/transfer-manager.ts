import { randomUUID } from 'node:crypto'
import type { SftpTransferItem, SftpTransferStatus } from '../../shared/sftp'
import { appError } from './storage'

export interface TransferControl {
  pause(): void
  resume(): void
  cancel(): void
}

export interface TransferHooks {
  progress(transferred: number): void
  done(error?: Error): void
}

export interface TransferJobInput {
  sessionId: string
  direction: 'upload' | 'download'
  name: string
  relativePath: string
  total: number
  start(offset: number, hooks: TransferHooks): TransferControl
}

type RuntimeJob = {
  item: SftpTransferItem
  start: TransferJobInput['start']
  control?: TransferControl
  generation: number
  sampleAt: number
  sampleBytes: number
  lastPublishAt: number
}

export class TransferManager {
  private readonly jobs = new Map<string, RuntimeJob>()
  private readonly pending: string[] = []
  private activeCount = 0

  constructor(private readonly emit: (item: SftpTransferItem) => void, private readonly concurrency = 2) {}

  enqueue(input: TransferJobInput): SftpTransferItem {
    if (!input.sessionId || !input.name || !Number.isFinite(input.total) || input.total < 0) throw appError('TRANSFER_INVALID', 'Transfer input is invalid')
    const transferId = randomUUID()
    const now = Date.now()
    const item: SftpTransferItem = {
      transferId,
      sessionId: input.sessionId,
      direction: input.direction,
      name: input.name.slice(0, 255),
      relativePath: input.relativePath.slice(0, 4096),
      transferred: 0,
      total: input.total,
      speed: 0,
      status: 'queued',
      createdAt: now,
      updatedAt: now
    }
    this.jobs.set(transferId, { item, start: input.start, generation: 0, sampleAt: now, sampleBytes: 0, lastPublishAt: now })
    this.pending.push(transferId)
    this.publish(item)
    this.schedule()
    return { ...item }
  }

  list(sessionId: string): SftpTransferItem[] {
    return [...this.jobs.values()].filter((job) => job.item.sessionId === sessionId).map((job) => ({ ...job.item })).sort((a, b) => a.createdAt - b.createdAt)
  }

  getItem(transferId: string): SftpTransferItem {
    return { ...this.get(transferId).item }
  }

  pause(transferId: string): SftpTransferItem {
    const job = this.get(transferId)
    if (job.item.status === 'queued') {
      job.item.status = 'paused'
      this.removePending(transferId)
    } else if (job.item.status === 'running') {
      job.control?.pause()
      job.item.status = 'paused'
    } else {
      throw appError('TRANSFER_STATE_INVALID', 'Only queued or running transfers can be paused')
    }
    job.item.speed = 0
    this.touch(job)
    return { ...job.item }
  }

  resume(transferId: string): SftpTransferItem {
    const job = this.get(transferId)
    if (job.item.status !== 'paused') throw appError('TRANSFER_STATE_INVALID', 'Only paused transfers can be resumed')
    if (job.control) {
      job.control.resume()
      job.item.status = 'running'
      job.sampleAt = Date.now()
      job.sampleBytes = job.item.transferred
      this.touch(job)
    } else {
      job.item.status = 'queued'
      this.pending.push(transferId)
      this.touch(job)
      this.schedule()
    }
    return { ...job.item }
  }

  cancel(transferId: string): SftpTransferItem {
    const job = this.get(transferId)
    if (isTerminal(job.item.status)) return { ...job.item }
    this.cancelJob(transferId, job)
    this.schedule()
    return { ...job.item }
  }

  retry(transferId: string): SftpTransferItem {
    const job = this.get(transferId)
    if (job.item.status !== 'error' && job.item.status !== 'cancelled') throw appError('TRANSFER_STATE_INVALID', 'Only failed or cancelled transfers can be retried')
    job.item.status = 'queued'
    job.item.message = undefined
    job.item.speed = 0
    job.item.transferred = 0
    job.control = undefined
    this.pending.push(transferId)
    this.touch(job)
    this.schedule()
    return { ...job.item }
  }

  clearFinished(sessionId: string): void {
    for (const [id, job] of this.jobs) if (job.item.sessionId === sessionId && isTerminal(job.item.status)) this.jobs.delete(id)
  }

  closeSession(sessionId: string): void {
    const sessionJobs = [...this.jobs].filter(([, job]) => job.item.sessionId === sessionId)
    // Remove every queued item before freeing an active slot. Otherwise cancelling
    // the first active item can start a later download while the session is closing.
    for (const [id] of sessionJobs) this.removePending(id)
    for (const [id, job] of sessionJobs) {
      if (!isTerminal(job.item.status)) this.cancelJob(id, job)
      this.jobs.delete(id)
    }
    this.schedule()
  }

  private schedule(): void {
    while (this.activeCount < this.concurrency) {
      const transferId = this.pending.shift()
      if (!transferId) return
      const job = this.jobs.get(transferId)
      if (!job || job.item.status !== 'queued') continue
      this.start(job)
    }
  }

  private start(job: RuntimeJob): void {
    job.item.status = 'running'
    job.item.message = undefined
    job.sampleAt = Date.now()
    job.sampleBytes = job.item.transferred
    const generation = ++job.generation
    this.activeCount++
    this.touch(job)
    try {
      const control = job.start(job.item.transferred, {
        progress: (transferred) => {
          if (generation !== job.generation || job.item.status === 'cancelled') return
          const next = Math.min(job.item.total || transferred, Math.max(job.item.transferred, transferred))
          const now = Date.now()
          const elapsed = now - job.sampleAt
          job.item.transferred = next
          if (elapsed >= 400) {
            job.item.speed = Math.max(0, (next - job.sampleBytes) / (elapsed / 1000))
            job.sampleAt = now
            job.sampleBytes = next
          }
          if (now - job.lastPublishAt >= 100 || (job.item.total > 0 && next >= job.item.total)) this.touch(job)
        },
        done: (error) => {
          if (generation !== job.generation || isTerminal(job.item.status)) return
          job.generation++
          job.control = undefined
          this.activeCount = Math.max(0, this.activeCount - 1)
          job.item.speed = 0
          job.item.status = error ? 'error' : 'completed'
          job.item.message = error?.message
          if (!error) job.item.transferred = job.item.total
          this.touch(job)
          this.schedule()
        }
      })
      if (generation === job.generation && !isTerminal(job.item.status)) job.control = control
    } catch (error) {
      if (generation !== job.generation || isTerminal(job.item.status)) return
      job.generation++
      job.control = undefined
      this.activeCount = Math.max(0, this.activeCount - 1)
      job.item.status = 'error'
      job.item.message = error instanceof Error ? error.message : 'Transfer failed'
      this.touch(job)
      this.schedule()
    }
  }

  private get(transferId: string): RuntimeJob {
    if (typeof transferId !== 'string' || transferId.length > 100) throw appError('TRANSFER_INVALID', 'Transfer identifier is invalid')
    const job = this.jobs.get(transferId)
    if (!job) throw appError('TRANSFER_NOT_FOUND', 'Transfer not found')
    return job
  }

  private cancelJob(transferId: string, job: RuntimeJob): void {
    this.removePending(transferId)
    const wasActive = Boolean(job.control)
    job.generation++
    try { job.control?.cancel() } catch { /* best effort */ }
    job.control = undefined
    if (wasActive) this.activeCount = Math.max(0, this.activeCount - 1)
    job.item.status = 'cancelled'
    job.item.speed = 0
    this.touch(job)
  }

  private touch(job: RuntimeJob): void {
    job.item.updatedAt = Date.now()
    job.lastPublishAt = job.item.updatedAt
    this.publish(job.item)
  }

  private publish(item: SftpTransferItem): void {
    this.emit({ ...item })
  }

  private removePending(transferId: string): void {
    let index = this.pending.indexOf(transferId)
    while (index >= 0) {
      this.pending.splice(index, 1)
      index = this.pending.indexOf(transferId)
    }
  }
}

function isTerminal(status: SftpTransferStatus): boolean {
  return status === 'completed' || status === 'error' || status === 'cancelled'
}
