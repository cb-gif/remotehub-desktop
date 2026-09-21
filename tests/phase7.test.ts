import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { DatabaseService } from '../src/main/services/database'
import type { DatabaseAdapter } from '../src/main/services/database/adapter'
import { buildPostgresCursorCommands, isPostgresSystemDatabase, mapPostgresError, PostgresAdapter, postgresSsl } from '../src/main/services/database/postgres'
import type { Connection } from '../src/shared/types'

describe('Phase 7 PostgreSQL adapter', () => {
  it('uses bounded server-side cursor commands and explicit SSL modes', () => {
    expect(buildPostgresCursorCommands(3, 200)).toEqual({
      move: 'MOVE ABSOLUTE 600 IN "__remotehub_page"',
      fetch: 'FETCH FORWARD 201 FROM "__remotehub_page"'
    })
    expect(postgresSsl('disable')).toBe(false)
    expect(postgresSsl('require')).toEqual({ rejectUnauthorized: false })
    expect(postgresSsl('verify-full')).toEqual({ rejectUnauthorized: true })
  })

  it('maps stable PostgreSQL errors', () => {
    expect(mapPostgresError(Object.assign(new Error('denied'), { code: '28P01' })).code).toBe('DATABASE_AUTH_FAILED')
    expect(mapPostgresError(Object.assign(new Error('missing'), { code: '3D000' })).code).toBe('DATABASE_NOT_FOUND')
    expect(mapPostgresError(Object.assign(new Error('syntax'), { code: '42601' })).code).toBe('DATABASE_SQL_INVALID')
  })

  it('opens a fresh cursor when a result is explicitly refreshed', async () => {
    const client = {
      on: vi.fn(), end: vi.fn(async () => undefined),
      query: vi.fn(async (query: string | { text: string }) => typeof query === 'object'
        ? { rows: [[1]], fields: [{ name: 'value', dataTypeID: 23 }], rowCount: 1 }
        : { rows: [], fields: [], rowCount: 0 })
    }
    const adapter = new PostgresAdapter(client as never, 'app', 'PostgreSQL 17')

    await adapter.query({ sql: 'SELECT value FROM items', page: 0, restart: true })
    await adapter.query({ sql: 'SELECT value FROM items', page: 0, restart: true })

    expect(client.query.mock.calls.filter(([query]) => typeof query === 'string' && query.startsWith('DECLARE'))).toHaveLength(2)
    adapter.close()
  })

  it('does not commit or roll back a user transaction when refreshing a cursor', async () => {
    const connection = new EventEmitter()
    const client = {
      connection, on: vi.fn(), end: vi.fn(async () => undefined),
      query: vi.fn(async (query: string | { text: string }) => typeof query === 'object'
        ? { rows: [[1]], fields: [{ name: 'value', dataTypeID: 23 }], rowCount: 1 }
        : { rows: [], fields: [], rowCount: 0 })
    }
    const adapter = new PostgresAdapter(client as never, 'app', 'PostgreSQL 17')
    connection.emit('readyForQuery', { status: 'T' })

    await adapter.query({ sql: 'SELECT value FROM items', page: 0, restart: true })
    await adapter.query({ sql: 'SELECT value FROM items', page: 0, restart: true })

    const commands = client.query.mock.calls.map(([query]) => typeof query === 'string' ? query : query.text)
    expect(commands.filter((query) => query.startsWith('DECLARE'))).toHaveLength(2)
    expect(commands).toContain('CLOSE "__remotehub_page"')
    expect(commands).not.toContain('BEGIN READ ONLY')
    expect(commands).not.toContain('COMMIT')
    expect(commands).not.toContain('ROLLBACK')
    adapter.close()
  })

  it('lists physical databases, marks system databases, and reconnects to switch database', async () => {
    const end = vi.fn(async () => undefined)
    const client = { query: vi.fn(async (sql: string) => ({ rows: sql.includes('pg_database') ? [{ name: 'app' }, { name: 'postgres' }] : [{ schema: 'public', name: 'users', kind: 'r', rows: '2' }] })), end }
    const nextClient = { query: vi.fn(), end: vi.fn(async () => undefined) }
    const adapter = new PostgresAdapter(client as never, 'app', 'PostgreSQL 17', undefined, async (database) => ({ client: nextClient as never, database, serverVersion: 'PostgreSQL 17' }))

    await expect(adapter.listDatabases()).resolves.toEqual([{ name: 'app', system: false }, { name: 'postgres', system: true }])
    await expect(adapter.listTables('app')).resolves.toEqual([{ database: 'public', name: 'users', type: 'table', estimatedRows: 2 }])
    expect(isPostgresSystemDatabase('template1')).toBe(true)
    await adapter.useDatabase('analytics')
    expect(adapter.database).toBe('analytics')
    expect(end).toHaveBeenCalledOnce()
  })

  it('routes PostgreSQL through the selected trusted SSH asset', async () => {
    const tunnel: Connection = {
      id: 'ssh-1', name: 'Bastion', type: 'ssh', host: 'bastion.local', port: 22, username: 'ops', authType: 'privateKey',
      credentialId: 'ssh-secret', hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`, favorite: false, sortOrder: 0, createdAt: 1, updatedAt: 1
    }
    const connection: Connection = {
      id: 'pg-1', name: 'Analytics', type: 'database', databaseType: 'postgres', host: 'postgres.internal', port: 5432,
      username: 'app', database: 'analytics', databaseSslMode: 'verify-full', sshTunnelId: tunnel.id,
      credentialId: 'pg-secret', favorite: false, sortOrder: 0, createdAt: 1, updatedAt: 1
    }
    const close = vi.fn()
    const adapter: DatabaseAdapter = {
      type: 'postgres', database: 'public', serverVersion: 'PostgreSQL 17', ping: async () => undefined,
      listDatabases: async () => [], useDatabase: async () => undefined, listTables: async () => [], listColumns: async () => [],
      query: async () => ({ kind: 'rows', columns: [], rows: [], page: 0, pageSize: 200, hasMore: false, affectedRows: 0, changedRows: 0, warningStatus: 0, durationMs: 1, statement: 'SELECT' }), close
    }
    const postgresFactory = { connect: vi.fn(async () => adapter) }
    const storage = { getConnection: (id: string) => id === tunnel.id ? tunnel : undefined, markConnected: vi.fn() }
    const credentials = { get: (id?: string) => id === 'pg-secret' ? 'db-password' : id === 'ssh-secret' ? 'private-key' : undefined }
    const service = new DatabaseService(storage as never, credentials as never, { connect: vi.fn() }, postgresFactory)

    await service.connect(connection)

    expect(postgresFactory.connect).toHaveBeenCalledWith(connection, 'db-password', { connection: tunnel, credential: 'private-key' })
    service.dispose()
    expect(close).toHaveBeenCalledOnce()
  })
})
