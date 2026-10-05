import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'

// Real SSH on loopback only: ephemeral host key/password, no saved assets,
// credentials or user servers. Build first, then run with an optional tab count.
const require = createRequire(import.meta.url)
const { Server, utils } = require('ssh2')
const { SshService } = require('../dist-electron/main/services/ssh.js')
const { fingerprintHostKey } = require('../dist-electron/main/services/host-key.js')
const sessions = Number(process.argv[2] || 40)
assert(Number.isInteger(sessions) && sessions >= 1 && sessions <= 100)
const writesPerSession = 1024
const password = randomBytes(24).toString('hex')
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const hostKey = privateKey.export({ type: 'pkcs1', format: 'pem' })
const fingerprint = fingerprintHostKey(utils.parseKey(hostKey).getPublicSSH())
const peers = new Set()
const timers = new Set()
const results = new Map()
let packets = 0
let bytes = 0
const line = id => `${id} 安全输出 🚀 ${'x'.repeat(220)}\r\n`
const server = new Server({ hostKeys: [hostKey] }, peer => {
  peers.add(peer)
  peer.on('close', () => peers.delete(peer))
  peer.on('error', () => {})
  let id
  peer.on('authentication', context => {
    if (context.method !== 'password' || context.password !== password) return context.reject()
    id = context.username
    context.accept()
  })
  peer.on('ready', () => peer.on('session', accept => {
    const session = accept()
    session.on('pty', accept => accept())
    session.on('shell', accept => {
      const stream = accept()
      void (async () => {
        const data = Buffer.from(line(id))
        for (let index = 0; index < writesPerSession; index++) {
          if (!stream.write(data)) await once(stream, 'drain')
        }
        stream.end()
      })().catch(error => results.get(id)?.reject(error))
    })
  }))
})
const service = new SshService({ markConnected() {} }, { get: () => password }, (channel, event) => {
  const result = results.get(event.sessionId)
  if (!result) return
  if (channel === 'ssh:data') {
    packets++
    bytes += Buffer.byteLength(event.data)
    result.hash.update(event.data)
    // Model one foreground consumer and slower background terminals. Unit
    // tests separately verify the real renderer's 200 ms background cadence.
    const timer = setTimeout(() => { timers.delete(timer); service.acknowledgeOutput(event.sessionId, event.sequence) }, event.sessionId === 'load-0' ? 0 : 20)
    timers.add(timer)
  } else if (event.status === 'error') result.reject(new Error(event.message))
  else if (event.status === 'closed') result.resolve()
})
let timeout
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const started = performance.now()
  const completed = Array.from({ length: sessions }, (_, index) => {
    const id = `load-${index}`
    const done = new Promise((resolve, reject) => results.set(id, { resolve, reject, hash: createHash('sha256') }))
    const connected = service.connect({ id, type: 'ssh', name: id, host: '127.0.0.1', port, username: id, authType: 'password', hostKeyFingerprint: fingerprint }, undefined, id)
    return Promise.all([connected, done])
  })
  await Promise.race([Promise.all(completed), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('SSH load test timed out')), 30000) })])
  for (const [id, result] of results) assert.equal(result.hash.digest('hex'), createHash('sha256').update(line(id).repeat(writesPerSession)).digest('hex'), `Output mismatch for ${id}`)
  assert.equal(service.sessions.size, 0, 'SSH sessions must be released')
  console.log(JSON.stringify({ ok: true, sessions, producerWrites: sessions * writesPerSession, ipcBatches: packets, bytes, utf8Integrity: true, elapsedMs: Math.round(performance.now() - started) }, null, 2))
} finally {
  clearTimeout(timeout)
  service.dispose()
  for (const timer of timers) clearTimeout(timer)
  for (const peer of peers) peer.end()
  await new Promise(resolve => server.close(resolve))
}
