import { describe, expect, it } from 'vitest'
import { databaseCellDetail, databaseDisplayRows, databaseResultToCsv, databaseSqlLiteral, parseDatabaseCsv } from '../src/shared/database'
import { SqliteAdapter } from '../src/main/services/database/sqlite'

describe('Phase 8 SQLite workspace', () => {
  it('exposes schema with bounded pages and supports writes', async () => {
    const database = {
      pragma: () => [{ name: 'main' }],
      prepare: (sql: string) => ({
        reader: !sql.startsWith('INSERT'),
        all: () => sql.includes('sqlite_schema') ? [{ name: 'devices', type: 'table' }]
          : sql.startsWith('PRAGMA') ? [
              { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
              { cid: 1, name: 'name', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 }
            ] : [],
        columns: () => [{ name: 'id', table: 'devices', type: 'INTEGER' }, { name: 'name', table: 'devices', type: 'TEXT' }],
        raw: () => ({ all: () => [[1, 'alpha'], [2, 'beta']] }),
        run: () => ({ changes: 1, lastInsertRowid: 3 })
      }),
      close: () => undefined
    }
    const adapter = new SqliteAdapter(database as never, 'SQLite test')

    await expect(adapter.listDatabases()).resolves.toContainEqual({ name: 'main', system: false })
    await expect(adapter.listTables('main')).resolves.toContainEqual({ database: 'main', name: 'devices', type: 'table' })
    await expect(adapter.listColumns('main', 'devices')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'id', key: 'PRI' }), expect.objectContaining({ name: 'name', nullable: false })
    ]))
    await expect(adapter.query({ sql: 'SELECT * FROM devices ORDER BY id', pageSize: 1 })).resolves.toMatchObject({
      kind: 'rows', rows: [[1, 'alpha']], hasMore: true
    })
    await expect(adapter.query({ sql: "INSERT INTO devices VALUES (3, 'gamma')" })).resolves.toMatchObject({
      kind: 'mutation', affectedRows: 1, insertId: '3'
    })
    adapter.close()
  })

  it('exports the current result page as valid CSV', () => {
    expect(databaseResultToCsv({
      fileName: 'devices.csv', columns: ['name', 'note'], rows: [['alpha', 'one, two'], ['"beta"', 'line\nbreak']]
    })).toBe('name,note\r\nalpha,"one, two"\r\n"""beta""","line\nbreak"')
  })

  it('imports quoted CSV values and safely quotes edited values', () => {
    expect(parseDatabaseCsv('\uFEFFid,note\r\n1,"hello, ""world"""\r\n')).toEqual({ columns: ['id', 'note'], rows: [['1', 'hello, "world"']] })
    expect(databaseSqlLiteral("O'Reilly")).toBe("'O''Reilly'")
    expect(databaseSqlLiteral('', 'mysql')).toBe("''")
    expect(databaseSqlLiteral("C:\\new\\test's", 'mysql')).toBe("CONVERT(X'433a5c6e65775c746573742773' USING utf8mb4)")
    expect(databaseSqlLiteral(null)).toBe('NULL')
  })

  it('filters and sorts the visible result page', () => {
    const rows = [[10, 'Beta'], [2, 'alpha'], [null, 'alphabet']] as const
    expect(databaseDisplayRows(rows.map((row) => [...row]), 'alpha', 0, 'desc')).toEqual([[null, 'alphabet'], [2, 'alpha']])
  })

  it('formats JSON cell values and leaves plain text unchanged', () => {
    expect(databaseCellDetail('{"device":"A1","values":[1,{"ok":true}]}')).toEqual({
      format: 'json',
      text: '{\n  "device": "A1",\n  "values": [\n    1,\n    {\n      "ok": true\n    }\n  ]\n}'
    })
    expect(databaseCellDetail('{invalid json}')).toEqual({ format: 'text', text: '{invalid json}' })
    expect(databaseCellDetail(null)).toEqual({ format: 'text', text: 'NULL' })
  })
})
