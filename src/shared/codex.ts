export interface CodexRateWindow {
  usedPercent: number
  windowDurationMins: number
  resetsAt: number
}

export interface CodexDailyUsage {
  startDate: string
  tokens: number
}

export interface CodexStatus {
  primary: CodexRateWindow | null
  secondary: CodexRateWindow | null
  planType: string
  lifetimeTokens: number | null
  peakDailyTokens: number | null
  dailyUsageBuckets: CodexDailyUsage[]
  checkedAt: number
}

export function remainingQuotaPercent(window: Pick<CodexRateWindow, 'usedPercent'>): number {
  return Math.min(100, Math.max(0, Math.round((100 - window.usedPercent) * 10) / 10))
}

export function parseCodexStatus(rateResult: unknown, usageResult: unknown, checkedAt = Date.now()): CodexStatus {
  const rateLimits = record(record(rateResult).rateLimits)
  const summary = record(record(usageResult).summary)
  const buckets = record(usageResult).dailyUsageBuckets
  return {
    primary: rateWindow(rateLimits.primary),
    secondary: rateWindow(rateLimits.secondary),
    planType: string(rateLimits.planType),
    lifetimeTokens: nullableNumber(summary.lifetimeTokens),
    peakDailyTokens: nullableNumber(summary.peakDailyTokens),
    dailyUsageBuckets: Array.isArray(buckets) ? buckets.map((bucket) => record(bucket)).map((bucket) => ({ startDate: string(bucket.startDate), tokens: number(bucket.tokens) })).filter((bucket) => bucket.startDate && bucket.tokens >= 0) : [],
    checkedAt
  }
}

function rateWindow(value: unknown): CodexRateWindow | null {
  const source = record(value)
  if (!Object.keys(source).length) return null
  return { usedPercent: Math.min(100, Math.max(0, number(source.usedPercent))), windowDurationMins: number(source.windowDurationMins), resetsAt: number(source.resetsAt) }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 160) : ''
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
