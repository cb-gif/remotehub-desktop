import { describe, expect, it, vi } from 'vitest'
import { databaseStatement, isPageableStatement, normalizeQueryRequest } from '../src/shared/database'
import { buildPagedMysqlQuery, mapMysqlError, serializeDatabaseValue } from '../src/main/services/database/mysql'
import { DatabaseService } from '../src/main/services/database'
import type { DatabaseAdapter } from '../src/main/services/database/adapter'

describe('Phase 6 MySQL adapter', () => {
  it('classifies SQL after comments and validates bounded pages', () => {
    expect(databaseStatement('-- dashboard query\n SELECT 1')).toBe('SELECT')
    expect(databaseStatement('/* explain */\nWITH source AS (SELECT 1) SELECT * FROM source')).toBe('WITH')
    expect(isPageableStatement('SHOW TABLES')).toBe(false)
    expect(normalizeQueryRequest({ sql: 'SELECT 1', page: 2, pageSize: 500 })).toEqual({ sql: 'SELECT 1', page: 2, pageSize: 500, restart: false })
    expect(() => normalizeQueryRequest({ sql: 'SELECT 1', pageSize: 501 })).toThrow(/between 1 and 500/)
  })

  it('wraps result queries with a bounded server-side page', () => {
    expect(buildPagedMysqlQuery('SELECT * FROM cells;', 3, 200)).toBe('SELECT * FROM cells LIMIT 201 OFFSET 600')
    expect(buildPagedMysqlQuery('SELECT * FROM cells LIMIT 100;', 1, 20)).toBe('SELECT * FROM (SELECT * FROM cells LIMIT 100) AS `__remotehub_page` LIMIT 21 OFFSET 20')
    expect(buildPagedMysqlQuery("SELECT 'LIMIT 10' AS note FROM cells;", 0, 10)).toBe("SELECT 'LIMIT 10' AS note FROM cells LIMIT 11 OFFSET 0")
  })

  it('serializes values before crossing Electron IPC', () => {
    expect(serializeDatabaseValue(9007199254740993n)).toBe('9007199254740993')
    expect(serializeDatabaseValue(Buffer.from([0xde, 0xad]))).toBe('<binary 2 bytes: dead>')
    expect(serializeDatabaseValue(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z')
    expect(serializeDatabaseValue({ ok: true })).toBe('{"ok":true}')
  })

  it('maps stable MySQL error codes without exposing driver objects', () => {
    expect(mapMysqlError(Object.assign(new Error('denied'), { code: 'ER_ACCESS_DENIED_ERROR' })).code).toBe('DATABASE_AUTH_FAILED')
    expect(mapMysqlError(Object.assign(new Error('bad SQL'), { code: 'ER_PARSE_ERROR' })).code).toBe('DATABASE_SQL_INVALID')
    expect(mapMysqlError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })).code).toBe('DATABASE_CONNECTION_REFUSED')
  })

  it('owns independent sessions and rejects overlapping queries', async () => {
    let finishQuery: ((value: ReturnType<DatabaseAdapter['query']> extends Promise<infer R> ? R : never) => void) | undefined
    const close = vi.fn()
    const adapter: DatabaseAdapter = {
      type: 'mysql', database: 'mes', serverVersion: '8.4.0', ping: async () => undefined,
      listDatabases: async () => [{ name: 'mes', system: false }],
      useDatabase: async () => undefined, listTables: async () => [], listColumns: async () => [], close,
      query: () => new Promise((resolve) => { finishQuery = resolve })
    }
    const markConnected = vi.fn()
    const factory = { connect: vi.fn(async () => adapter) }
    const service = new DatabaseService({ markConnected } as never, { get: () => 'secret' } as never, factory)
    const connected = await service.connect({
      id: 'mysql-1', name: 'MES MySQL', type: 'database', databaseType: 'mysql', host: 'db.local', port: 3306,
      username: 'app', database: 'mes', credentialId: 'cred-1', favorite: false, sortOrder: 0, createdAt: 1, updatedAt: 1
    })
    const running = service.query(connected.sessionId, { sql: 'SELECT 1' })
    await expect(service.query(connected.sessionId, { sql: 'SELECT 2' })).rejects.toMatchObject({ code: 'DATABASE_BUSY' })
    finishQuery?.({ kind: 'rows', columns: [], rows: [], page: 0, pageSize: 200, hasMore: false, affectedRows: 0, changedRows: 0, warningStatus: 0, durationMs: 1, statement: 'SELECT' })
    await expect(running).resolves.toMatchObject({ kind: 'rows' })
    service.disconnect(connected.sessionId)
    expect(factory.connect).toHaveBeenCalledWith(expect.objectContaining({ id: 'mysql-1' }), 'secret')
    expect(markConnected).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })
})
