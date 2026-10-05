import type { Connection, ConnectionInput, ConnectionTestResult, Group } from './types'
import { normalizeSerialOptions } from './serial'

export interface ConnectionExport {
  version: 1
  groups: Group[]
  connections: ConnectionInput[]
}

export function createConnectionExport(connections: Connection[], groups: Group[]): ConnectionExport {
  return {
    version: 1,
    groups: groups.map(({ id, name, sortOrder }) => ({ id, name, sortOrder })),
    connections: connections.map(({ id, name, notes, color, initialCommand, serialOptions, type, host, port, username, authType, databaseType, database, databaseSslMode, sshTunnelId, groupId, favorite, sortOrder }) => ({ id, name, notes, color, initialCommand, serialOptions, type, host, port, username, authType, databaseType, database, databaseSslMode, sshTunnelId, groupId, favorite, sortOrder }))
  }
}

export function parseConnectionExport(text: string): ConnectionExport {
  const source = JSON.parse(text) as { version?: unknown; groups?: unknown; connections?: unknown }
  if (source.version !== 1 || !Array.isArray(source.groups) || !Array.isArray(source.connections) || source.groups.length > 10_000 || source.connections.length > 10_000) throw new Error('Connection JSON format is invalid')
  return {
    version: 1,
    groups: source.groups.map((value) => {
      const item = record(value)
      if (typeof item.id !== 'string' || !item.id || item.id.length > 100 || typeof item.name !== 'string') throw new Error('Connection JSON contains an invalid group')
      return { id: item.id, name: item.name, sortOrder: Number(item.sortOrder) || 0 }
    }),
    connections: source.connections.map((value) => {
      const item = record(value)
      if (typeof item.id !== 'string' || !item.id || item.id.length > 100) throw new Error('Connection JSON contains an invalid connection')
      return {
        id: item.id,
        name: String(item.name || ''),
        notes: metadataString(item.notes),
        color: metadataString(item.color),
        initialCommand: metadataString(item.initialCommand),
        serialOptions: item.type === 'serial' ? normalizeSerialOptions(item.serialOptions as ConnectionInput['serialOptions']) : undefined,
        type: item.type as ConnectionInput['type'],
        host: String(item.host || ''),
        port: Number(item.port),
        username: optionalString(item.username),
        authType: item.authType as ConnectionInput['authType'],
        databaseType: item.databaseType as ConnectionInput['databaseType'],
        database: optionalString(item.database),
        databaseSslMode: item.databaseSslMode as ConnectionInput['databaseSslMode'],
        sshTunnelId: optionalString(item.sshTunnelId),
        groupId: optionalString(item.groupId),
        favorite: Boolean(item.favorite),
        sortOrder: Number(item.sortOrder) || 0
      }
    })
  }
}

// Imported metadata is untrusted. A stored secret belongs to its original
// endpoint and authentication settings, not just to an exported asset ID.
export function canRetainImportedCredential(previous: Connection | undefined, incoming: ConnectionInput): boolean {
  if (!previous?.credentialId) return false
  const identity = ['type', 'host', 'port', 'username', 'authType', 'databaseType', 'database', 'databaseSslMode', 'sshTunnelId'] as const
  return identity.every((key) => previous[key] === incoming[key])
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Connection JSON format is invalid')
  return value as Record<string, unknown>
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function metadataString(value: unknown): string | undefined {
  if (value !== undefined && typeof value !== 'string') throw new Error('Connection metadata must be text')
  return value as string | undefined
}

export function connectionErrorCode(code?: string): ConnectionTestResult['code'] {
  if (code === 'ETIMEDOUT') return 'CONNECTION_TIMEOUT'
  if (code === 'ECONNREFUSED') return 'CONNECTION_REFUSED'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'HOST_NOT_FOUND'
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'NETWORK_UNREACHABLE'
  return 'CONNECTION_FAILED'
}
