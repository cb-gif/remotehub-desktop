<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from 'xterm'
import { terminalTheme } from '../terminal-theme'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import type { CodexRateWindow, CodexStatus, CodexDailyUsage } from '../../shared/codex'
import { withoutAnsiBackgrounds } from '../../shared/ansi'
import type { ServerStatus, SshDataEvent, SshSessionStatus, SshStatusEvent } from '../../shared/ssh'
import type { TabConnectionStatus } from '../../shared/connection-status'
import { t } from '../i18n'
import { loadTerminalFont, observeTerminalLayout } from '../terminal-layout'
import { terminalClipboardKeyHandler } from '../terminal-clipboard'
import UiIcon from './UiIcon.vue'
import type { SshPasswordOptions } from '../../shared/ssh'
import { useConnectionStore } from '../stores/connection'
import { useSshPasswordStore } from '../stores/ssh-password'

const props = defineProps<{ connectionId: string; active: boolean; local?: boolean; sftpOpen?: boolean }>()
const connectionStore = useConnectionStore()
const sshPassword = useSshPasswordStore()
const emit = defineEmits<{ toggleSftp: []; 'connection-status': [status: TabConnectionStatus] }>()

const terminalHost = ref<HTMLElement | null>(null)
const status = ref<SshSessionStatus>('connecting')
const statusMessage = ref('')
let pendingPassword: SshPasswordOptions | undefined
let connecting = false
const pendingFingerprint = ref('')
const contextMenu = ref<{ x: number; y: number } | null>(null)
const hasSelection = ref(false)
const overviewOpen = ref(false)
const overview = ref<ServerStatus | null>(null)
const loadAverageValues = computed(() => {
  const values = overview.value?.loadAverage.trim().split(/\s+/) || []
  return [values[0] || '—', values[1] || '—', values[2] || '—']
})
const overviewLoading = ref(false)
const overviewError = ref('')
const codexOpen = ref(false)
const codexStatus = ref<CodexStatus | null>(null)
const codexLoading = ref(false)
const codexError = ref('')

let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let sessionId: string | null = null
let disposed = false
let removeDataListener: (() => void) | undefined
let removeStatusListener: (() => void) | undefined
let removeInputListener: (() => void) | undefined
let removeSelectionListener: (() => void) | undefined
let removeContextMenuListener: (() => void) | undefined
let terminalLayout: ReturnType<typeof observeTerminalLayout> | undefined
let themeObserver: MutationObserver | undefined
let codexRefreshTimer: number | undefined
let overviewRefreshTimer: number | undefined
let pendingTerminalEscape = ''
const pendingData = new Map<string, string[]>()
const pendingStatus = new Map<string, SshStatusEvent>()

watch(status, (value) => emit('connection-status', value), { immediate: true, flush: 'sync' })


function terminalContrastRatio(): number {
  return 4.5
}

function writeTerminal(data: string): void {
  if (document.documentElement.dataset.theme !== 'light') {
    terminal?.write(pendingTerminalEscape + data)
    pendingTerminalEscape = ''
    return
  }
  const filtered = withoutAnsiBackgrounds(pendingTerminalEscape + data)
  pendingTerminalEscape = filtered.remainder
  terminal?.write(filtered.output)
}

const statusLabel = (): string => {
  if (status.value === 'connecting') return t('connecting')
  if (status.value === 'connected') return t('connected')
  if (status.value === 'closed') return t('closed')
  return t(props.local ? 'localShellUnavailable' : 'sshUnavailable')
}

const unavailableMessage = (): string => t(props.local ? 'localShellUnavailable' : 'sshUnavailable')

function handleData(event: SshDataEvent): void {
  if (event.sessionId !== sessionId) {
    if (!sessionId && status.value === 'connecting') {
      const queued = pendingData.get(event.sessionId) || []
      queued.push(event.data)
      pendingData.set(event.sessionId, queued)
    }
    return
  }
  writeTerminal(event.data)
}

function handleStatus(event: SshStatusEvent): void {
  if (event.sessionId !== sessionId) {
    if (!sessionId && status.value === 'connecting') pendingStatus.set(event.sessionId, event)
    return
  }
  status.value = event.status
  statusMessage.value = event.message || ''
  if (event.status !== 'connected') { closeCodexStatus(); closeOverview() }
}

function flushPending(id: string): void {
  const queued = pendingData.get(id) || []
  queued.forEach(writeTerminal)
  const previousStatus = pendingStatus.get(id)
  if (previousStatus) {
    status.value = previousStatus.status
    statusMessage.value = previousStatus.message || ''
  }
  pendingData.clear()
  pendingStatus.clear()
}

function resizeTerminal(): void {
  terminalLayout?.fit()
}

async function connect(): Promise<void> {
  if (connecting || disposed) return
  connecting = true
  if (sessionId) {
    await (props.local ? window.api.shell.disconnect(sessionId) : window.api.ssh.disconnect(sessionId)).catch(() => undefined)
    sessionId = null
  }
  status.value = 'connecting'
  statusMessage.value = ''
  pendingFingerprint.value = ''
  overview.value = null
  overviewError.value = ''
  closeCodexStatus()
  codexStatus.value = null
  codexError.value = ''
  pendingData.clear()
  pendingStatus.clear()
  pendingTerminalEscape = ''
  terminal?.clear()
  try {
    if (!props.local && !pendingPassword) {
      const { connections } = await window.api.connections.list()
      if (disposed) return
      const connection = connections.find((item: { id: string }) => item.id === props.connectionId)
      if (connection?.authType === 'none') {
        const answer = await sshPassword.request(connection.id, `${connection.name} · ${connection.username || ''}@${connection.host}`, 'ssh')
        if (answer.status !== 'submitted' || disposed) {
          if (answer.status === 'timeout') statusMessage.value = t('sshPasswordTimeout')
          status.value = answer.status === 'timeout' ? 'error' : 'closed'
          return
        }
        pendingPassword = answer.options
      }
    }
    const result = props.local ? await window.api.shell.connect(props.connectionId) : await window.api.ssh.connect(props.connectionId, pendingPassword)
    if ('trustRequired' in result && result.trustRequired) {
      if (disposed) return
      pendingData.clear()
      pendingStatus.clear()
      pendingFingerprint.value = result.fingerprint
      status.value = 'error'
      statusMessage.value = ''
      return
    }
    if (disposed) {
      await (props.local ? window.api.shell.disconnect(result.sessionId) : window.api.ssh.disconnect(result.sessionId)).catch(() => undefined)
      return
    }
    sessionId = result.sessionId
    if (pendingPassword?.savePassword) void connectionStore.load().catch(() => undefined)
    pendingPassword = undefined
    status.value = 'connected'
    flushPending(result.sessionId)
    resizeTerminal()
  } catch (error) {
    pendingPassword = undefined
    status.value = 'error'
    statusMessage.value = error instanceof Error ? error.message : unavailableMessage()
  } finally {
    connecting = false
  }
}

async function refreshOverview(): Promise<void> {
  if (!sessionId || props.local || overviewLoading.value) return
  const current = sessionId
  overviewLoading.value = true
  overviewError.value = ''
  try {
    const result = await window.api.ssh.statusOverview(current)
    if (sessionId === current) overview.value = result
  } catch (error) {
    overviewError.value = error instanceof Error ? error.message : t('serverStatusUnavailable')
  } finally {
    overviewLoading.value = false
  }
}

function toggleOverview(): void {
  if (overviewOpen.value) closeOverview()
  else {
    closeCodexStatus()
    overviewOpen.value = true
    void refreshOverview()
    overviewRefreshTimer = window.setInterval(() => { if (props.active) void refreshOverview() }, 15_000)
  }
  void nextTick(resizeTerminal)
}

function closeOverview(): void {
  overviewOpen.value = false
  if (overviewRefreshTimer !== undefined) window.clearInterval(overviewRefreshTimer)
  overviewRefreshTimer = undefined
}

async function refreshCodexStatus(): Promise<void> {
  if (!sessionId || codexLoading.value) return
  const current = sessionId
  codexLoading.value = true
  codexError.value = ''
  try {
    const result = await (props.local ? window.api.shell.codexStatus(current) : window.api.ssh.codexStatus(current))
    if (sessionId === current) codexStatus.value = result
  } catch (error) {
    if (sessionId === current) codexError.value = error instanceof Error ? error.message : t('codexStatusUnavailable')
  } finally {
    codexLoading.value = false
  }
}

function closeCodexStatus(): void {
  codexOpen.value = false
  if (codexRefreshTimer !== undefined) window.clearInterval(codexRefreshTimer)
  codexRefreshTimer = undefined
}

function toggleCodexStatus(): void {
  if (codexOpen.value) closeCodexStatus()
  else {
    closeOverview()
    codexOpen.value = true
    void refreshCodexStatus()
    codexRefreshTimer = window.setInterval(() => void refreshCodexStatus(), 120_000)
  }
  void nextTick(resizeTerminal)
}

function formatCheckedAt(value: number): string {
  return new Date(value).toLocaleTimeString()
}

function quotaWindows(): { key: string; label: string; value: CodexRateWindow }[] {
  if (!codexStatus.value) return []
  const windows: { key: string; label: string; value: CodexRateWindow }[] = []
  if (codexStatus.value.primary) windows.push({ key: 'primary', label: quotaWindowLabel(codexStatus.value.primary.windowDurationMins), value: codexStatus.value.primary })
  if (codexStatus.value.secondary) windows.push({ key: 'secondary', label: quotaWindowLabel(codexStatus.value.secondary.windowDurationMins), value: codexStatus.value.secondary })
  return windows
}

function quotaWindowLabel(minutes: number): string {
  if (minutes === 300) return t('fiveHourQuota')
  if (minutes === 10080) return t('weeklyQuota')
  return t('quotaWindow', { hours: Math.round(minutes / 60) })
}

function remainingPercent(window: CodexRateWindow): number {
  return Math.max(0, Math.round((100 - window.usedPercent) * 10) / 10)
}

function formatReset(timestamp: number): string {
  return timestamp ? new Date(timestamp * 1000).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
}

function formatTokens(tokens: number | null): string {
  return tokens === null ? '—' : new Intl.NumberFormat([], { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)
}

function recentDailyUsage(): CodexDailyUsage[] {
  const usage = new Map(codexStatus.value?.dailyUsageBuckets.map((bucket) => [bucket.startDate, bucket.tokens]) || [])
  return Array.from({ length: 14 }, (_, index) => {
    const date = new Date()
    date.setHours(12, 0, 0, 0)
    date.setDate(date.getDate() - 13 + index)
    const startDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    return { startDate, tokens: usage.get(startDate) || 0 }
  })
}

function usageBarHeight(tokens: number): string {
  const max = Math.max(...recentDailyUsage().map((bucket) => bucket.tokens), 1)
  return `${tokens ? Math.max(4, tokens / max * 100) : 0}%`
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`
}

function percent(used: number, total: number): number {
  return total ? Math.min(100, Math.round(used * 1000 / total) / 10) : 0
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor(seconds % 86400 / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  return `${days ? `${days}d ` : ''}${hours}h ${minutes}m`
}

async function trustHostKey(): Promise<void> {
  const fingerprint = pendingFingerprint.value
  if (!fingerprint) return
  try {
    await window.api.ssh.trustHostKey(props.connectionId, fingerprint)
    await connect()
  } catch (error) {
    status.value = 'error'
    statusMessage.value = error instanceof Error ? error.message : unavailableMessage()
  }
}

function showContextMenu(event: MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()
  hasSelection.value = terminal?.hasSelection() ?? false
  contextMenu.value = {
    x: Math.max(4, Math.min(event.clientX, window.innerWidth - 104)),
    y: Math.max(4, Math.min(event.clientY, window.innerHeight - 106))
  }
}

async function copySelection(): Promise<void> {
  const selection = terminal?.getSelection()
  contextMenu.value = null
  if (!selection) return
  try {
    await window.api.app.copyText(selection)
    terminal?.focus()
  } catch (error) {
    statusMessage.value = error instanceof Error ? error.message : unavailableMessage()
  }
}

async function pasteClipboard(): Promise<void> {
  contextMenu.value = null
  const current = sessionId
  const target = terminal
  if (!current || !target || status.value !== 'connected') return
  try {
    const text = await window.api.app.readText()
    if (disposed || sessionId !== current || status.value !== 'connected') return
    if (text) target.paste(text)
    target.focus()
  } catch (error) {
    statusMessage.value = error instanceof Error ? error.message : unavailableMessage()
  }
}

function selectAll(): void {
  terminal?.selectAll()
  hasSelection.value = terminal?.hasSelection() ?? false
  contextMenu.value = null
  terminal?.focus()
}

async function disconnect(): Promise<void> {
  if (!sessionId) return
  closeCodexStatus()
  closeOverview()
  const current = sessionId
  sessionId = null
  await (props.local ? window.api.shell.disconnect(current) : window.api.ssh.disconnect(current)).catch(() => undefined)
  status.value = 'closed'
}

onMounted(async () => {
  await loadTerminalFont(14)
  if (disposed || !terminalHost.value) return
  terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: '"JetBrains Mono", "Noto Sans SC", serif',
    fontSize: 14,
    lineHeight: 1.2,
    fontWeight: '400',
    fontWeightBold: '600',
    minimumContrastRatio: terminalContrastRatio(),
    theme: terminalTheme(),
    scrollback: 5000
  })
  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalHost.value)
  terminal.attachCustomKeyEventHandler(terminalClipboardKeyHandler(() => terminal?.hasSelection() ?? false, () => { void copySelection() }, () => { void pasteClipboard() }))
  themeObserver = new MutationObserver(() => { if (terminal) { terminal.options.theme = terminalTheme(); terminal.options.minimumContrastRatio = terminalContrastRatio() } })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  terminalLayout = observeTerminalLayout(terminalHost.value, terminal, fitAddon, () => {
    if (sessionId && terminal) void (props.local ? window.api.shell.resize(sessionId, terminal.cols, terminal.rows) : window.api.ssh.resize(sessionId, terminal.cols, terminal.rows)).catch(() => undefined)
  })
  removeDataListener = props.local ? window.api.shell.onData(handleData) : window.api.ssh.onData(handleData)
  removeStatusListener = props.local ? window.api.shell.onStatus(handleStatus) : window.api.ssh.onStatus(handleStatus)
  const input = terminal.onData((data) => {
    if (sessionId) void (props.local ? window.api.shell.write(sessionId, data) : window.api.ssh.write(sessionId, data)).catch((error) => {
      status.value = 'error'
      statusMessage.value = error instanceof Error ? error.message : unavailableMessage()
    })
  })
  removeInputListener = () => input.dispose()
  const selection = terminal.onSelectionChange(() => {
    hasSelection.value = terminal?.hasSelection() ?? false
  })
  removeSelectionListener = () => selection.dispose()
  const closeContextMenu = (): void => { contextMenu.value = null }
  document.addEventListener('pointerdown', closeContextMenu)
  removeContextMenuListener = () => document.removeEventListener('pointerdown', closeContextMenu)
  void connect()
  resizeTerminal()
})

watch(() => props.active, (active) => {
  if (active) void nextTick(resizeTerminal)
})

onBeforeUnmount(() => {
  pendingPassword = undefined
  disposed = true
  status.value = 'closed'
  closeCodexStatus()
  closeOverview()
  removeDataListener?.()
  removeStatusListener?.()
  removeInputListener?.()
  removeSelectionListener?.()
  removeContextMenuListener?.()
  terminalLayout?.dispose()
  themeObserver?.disconnect()
  if (sessionId) void (props.local ? window.api.shell.disconnect(sessionId) : window.api.ssh.disconnect(sessionId)).catch(() => undefined)
  terminal?.dispose()
})
</script>

<template>
  <section class="terminal-pane">
    <div class="terminal-toolbar" role="toolbar" :aria-label="local ? t('localShell') : 'SSH Terminal'">
      <div class="terminal-identity">
        <span class="terminal-kind" :class="{ 'shell-kind': local }"><UiIcon :name="local ? 'command' : 'terminal'" :size="13" /><b>{{ local ? 'LOCAL' : 'SSH' }}</b></span>
        <span class="terminal-title">{{ local ? t('localShell') : 'Terminal' }}</span>
      </div>
      <div class="terminal-session" role="status" aria-live="polite">
        <span class="terminal-status" :class="status"><span class="status-dot"></span>{{ statusLabel() }}</span>
        <span v-if="statusMessage" class="terminal-message" :title="statusMessage">{{ statusMessage }}</span>
      </div>
      <div class="terminal-actions">
        <button v-if="!local" class="toolbar-button muted sftp-toggle" :class="{ active: sftpOpen }" :aria-pressed="sftpOpen" :title="t(sftpOpen ? 'hideSftp' : 'showSftp')" @click="emit('toggleSftp')"><UiIcon name="transfer" /> <span>SFTP</span></button>
        <button v-if="!local" class="toolbar-button muted icon-only" :class="{ active: overviewOpen }" :title="t('serverOverview')" :aria-label="t('serverOverview')" :aria-pressed="overviewOpen" :disabled="status !== 'connected'" @click="toggleOverview"><UiIcon name="panel" /></button>
        <button v-if="status === 'connected'" class="toolbar-button muted icon-only" :class="{ active: codexOpen }" :title="t('codexStatus')" :aria-label="t('codexStatus')" :aria-pressed="codexOpen" @click="toggleCodexStatus"><UiIcon name="gauge" /></button>
        <button v-if="!pendingFingerprint && (status === 'error' || status === 'closed')" class="toolbar-button" @click="connect"><UiIcon name="refresh" /> <span>{{ t('reconnect') }}</span></button>
        <button v-else-if="local && status === 'connected'" class="toolbar-button muted" @click="disconnect"><UiIcon name="power" /> <span>{{ t('disconnect') }}</span></button>
      </div>
    </div>
    <div v-if="pendingFingerprint" class="terminal-host-key">
      <span>{{ t('hostKeyPrompt') }}</span><code>{{ t('hostKeyFingerprint') }}: {{ pendingFingerprint }}</code><button class="toolbar-button" @click="trustHostKey">{{ t('trustHostKey') }}</button>
    </div>
    <div class="terminal-body">
      <div ref="terminalHost" class="terminal-host" @contextmenu.capture.prevent.stop="showContextMenu"></div>
      <aside v-if="overviewOpen && !local" class="server-overview">
        <header><strong>{{ t('serverOverview') }}</strong><button :title="t('refresh')" :aria-label="t('refresh')" :disabled="overviewLoading" @click="refreshOverview"><UiIcon name="refresh" /></button><button :aria-label="t('closeTab')" @click="toggleOverview"><UiIcon name="close" /></button></header>
        <div v-if="overviewLoading && !overview" class="server-overview-state">{{ t('loading') }}</div>
        <div v-else-if="overviewError && !overview" class="server-overview-state error">{{ overviewError }}</div>
        <template v-if="overview">
          <section class="overview-card overview-basics">
            <h3>{{ t('basicInfo') }}</h3>
            <div><span>{{ t('user') }}</span><strong>{{ overview.user || '—' }}</strong></div><div><span>Host</span><strong :title="overview.host">{{ overview.host || '—' }}</strong></div>
            <div><span>{{ t('uptime') }}</span><strong>{{ formatUptime(overview.uptimeSeconds) }}</strong></div><div><span>{{ t('system') }}</span><strong :title="overview.os">{{ overview.os || overview.kernel || '—' }}</strong></div>
          </section>
          <section class="overview-card overview-load">
            <h3>{{ t('loadAverage') }}</h3>
            <div><span v-for="(value, index) in loadAverageValues" :key="index"><small>{{ [1, 5, 15][index] }}m</small><strong>{{ value }}</strong></span></div>
          </section>
          <section class="overview-card overview-metrics">
            <div><span>{{ t('cpu') }}</span><strong>{{ overview.cpuPercent.toFixed(1) }}%</strong><small>{{ overview.cpuCores }} {{ t('cpuCores') }}</small><progress max="100" :value="overview.cpuPercent"></progress></div>
            <div><span>{{ t('memory') }}</span><strong>{{ percent(overview.memoryUsedKb, overview.memoryTotalKb) }}%</strong><small>{{ formatBytes(overview.memoryUsedKb * 1024) }} / {{ formatBytes(overview.memoryTotalKb * 1024) }}</small><progress max="100" :value="percent(overview.memoryUsedKb, overview.memoryTotalKb)"></progress></div>
            <div><span>{{ t('swap') }}</span><strong>{{ percent(overview.swapUsedKb, overview.swapTotalKb) }}%</strong><small>{{ formatBytes(overview.swapUsedKb * 1024) }} / {{ formatBytes(overview.swapTotalKb * 1024) }}</small><progress max="100" :value="percent(overview.swapUsedKb, overview.swapTotalKb)"></progress></div>
            <div><span>{{ t('disk') }}</span><strong>{{ overview.diskPercent }}%</strong><small>{{ formatBytes(overview.diskUsedKb * 1024) }} / {{ formatBytes(overview.diskTotalKb * 1024) }}</small><progress max="100" :value="overview.diskPercent"></progress></div>
          </section>
          <section class="overview-card overview-network"><div><span>{{ t('networkReceived') }}</span><strong>↓ {{ formatBytes(overview.networkRxBytes) }}</strong></div><div><span>{{ t('networkSent') }}</span><strong>↑ {{ formatBytes(overview.networkTxBytes) }}</strong></div></section>
          <section class="overview-card overview-processes">
            <h3>{{ t('processes') }} <small>{{ overview.processCount }}</small></h3>
            <div class="process-heading"><span>{{ t('command') }}</span><span>{{ t('pid') }}</span><span>%CPU</span><span>{{ t('memory') }}</span></div>
            <div v-for="process in overview.processes" :key="process.pid" class="process-row"><strong :title="process.command">{{ process.command }}</strong><span>{{ process.pid }}</span><span>{{ process.cpuPercent.toFixed(1) }}</span><span>{{ formatBytes(process.memoryKb * 1024) }}</span></div>
            <p v-if="!overview.processes.length">{{ t('noProcessData') }}</p>
          </section>
          <p v-if="overviewError" class="server-overview-inline-error">{{ overviewError }}</p>
        </template>
      </aside>
      <aside v-if="codexOpen" class="server-overview codex-overview">
        <header><strong>{{ t('codexStatus') }}</strong><button :title="t('refresh')" :aria-label="t('refresh')" :disabled="codexLoading" @click="refreshCodexStatus"><UiIcon name="refresh" /></button><button :aria-label="t('closeTab')" @click="toggleCodexStatus"><UiIcon name="close" /></button></header>
        <div v-if="codexLoading && !codexStatus" class="server-overview-state">{{ t('loading') }}</div>
        <div v-else-if="codexError && !codexStatus" class="server-overview-state error">{{ codexError }}</div>
        <template v-if="codexStatus">
          <section class="overview-card codex-quota-card">
            <h3><span>{{ codexStatus.planType || 'Codex' }}</span><small>{{ t('lastChecked') }} {{ formatCheckedAt(codexStatus.checkedAt) }}</small></h3>
            <div v-for="quota in quotaWindows()" :key="quota.key" class="codex-quota-row">
              <div><span>{{ quota.label }}</span><strong>{{ remainingPercent(quota.value) }}% {{ t('quotaRemaining') }}</strong></div>
              <progress max="100" :value="quota.value.usedPercent"></progress>
              <small>{{ t('quotaUsed') }} {{ quota.value.usedPercent }}% · {{ t('resetsAt') }} {{ formatReset(quota.value.resetsAt) }}</small>
            </div>
            <p v-if="!quotaWindows().length" class="server-overview-state">{{ t('noQuotaData') }}</p>
          </section>
          <section class="overview-card codex-usage-card">
            <h3><span>{{ t('dailyTokenUsage') }}</span><small>14d</small></h3>
            <div class="codex-usage-summary"><span>{{ t('lifetimeTokens') }} <strong>{{ formatTokens(codexStatus.lifetimeTokens) }}</strong></span><span>{{ t('peakDailyTokens') }} <strong>{{ formatTokens(codexStatus.peakDailyTokens) }}</strong></span></div>
            <div class="codex-usage-chart" role="img" :aria-label="t('dailyTokenUsage')">
              <div v-for="bucket in recentDailyUsage()" :key="bucket.startDate" class="codex-usage-column" :title="`${bucket.startDate}: ${bucket.tokens.toLocaleString()} tokens`"><div><i :style="{ height: usageBarHeight(bucket.tokens) }"></i></div><small>{{ bucket.startDate.slice(8) }}</small></div>
            </div>
            <p v-if="codexError" class="server-overview-inline-error">{{ codexError }}</p>
          </section>
        </template>
      </aside>
    </div>
    <div v-if="contextMenu" class="terminal-context-menu" role="menu" :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }" @pointerdown.stop>
      <button role="menuitem" :disabled="!hasSelection" @click="copySelection">{{ t('copy') }}</button>
      <button role="menuitem" :disabled="status !== 'connected'" @click="pasteClipboard">{{ t('paste') }}</button>
      <button role="menuitem" @click="selectAll">{{ t('selectAll') }}</button>
    </div>
  </section>
</template>
