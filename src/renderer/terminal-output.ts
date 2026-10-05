// Consume background output less frequently. Acknowledgements are sent only
// after xterm has parsed the batch, so its write queue cannot grow unbounded.
const backgroundWork = new Set<() => void>()
let backgroundTimer: ReturnType<typeof setTimeout> | undefined

function scheduleBackground(work: () => void): void {
  backgroundWork.add(work)
  if (backgroundTimer !== undefined) return
  backgroundTimer = setTimeout(() => {
    backgroundTimer = undefined
    const next = backgroundWork.values().next().value
    if (next) { backgroundWork.delete(next); next() }
    const following = backgroundWork.values().next().value
    if (following) scheduleBackground(following)
  }, 16)
}

function cancelBackground(work: () => void): void {
  backgroundWork.delete(work)
  if (!backgroundWork.size && backgroundTimer !== undefined) {
    clearTimeout(backgroundTimer)
    backgroundTimer = undefined
  }
}

export function createTerminalOutput(write: (data: string, done: () => void) => void, visible: () => boolean) {
  let disposed = false
  let writing = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const queue: { data: string; done: () => void }[] = []

  function schedule(): void {
    if (disposed || writing || timer !== undefined || !queue.length) return
    timer = setTimeout(() => {
      timer = undefined
      if (visible()) flush()
      else scheduleBackground(flush)
    }, visible() ? 0 : 200)
  }

  function flush(): void {
    cancelBackground(flush)
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (disposed || writing) return
    const batch = queue.shift()
    if (!batch) return
    writing = true
    write(batch.data, () => {
      writing = false
      if (disposed) return
      batch.done()
      schedule()
    })
  }

  return {
    enqueue(data: string, done: () => void): void {
      if (disposed) return
      queue.push({ data, done })
      schedule()
    },
    flush,
    dispose(): void {
      disposed = true
      cancelBackground(flush)
      if (timer !== undefined) clearTimeout(timer)
      queue.length = 0
    }
  }
}
