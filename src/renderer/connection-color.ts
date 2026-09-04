import type { Connection } from '../shared/types'

export function connectionLabelColor(connections: readonly Pick<Connection, 'id' | 'color'>[], connectionId?: string): string | undefined {
  if (!connectionId) return undefined
  const color = connections.find((connection) => connection.id === connectionId)?.color
  return typeof color === 'string' && color.length === 7 && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined
}
