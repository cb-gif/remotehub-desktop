export type DatabaseAdapterType = 'mysql' | 'postgres' | 'sqlite'
export type DatabaseObjectType = 'table' | 'view'
export type DatabaseCell = string | number | boolean | null

export interface DatabaseConnectResult {
  sessionId: string
  adapter: DatabaseAdapterType
  database?: string
  serverVersion: string
}

export interface DatabaseCatalog {
  name: string
  system: boolean
}

export interface DatabaseTable {
  database: string
  name: string
  type: DatabaseObjectType
  estimatedRows?: number
}

export interface DatabaseColumn {
  database: string
  table: string
  name: string
  ordinal: number
  dataType: string
  columnType: string
  nullable: boolean
  key?: string
  defaultValue?: DatabaseCell
  extra?: string
  length?: number
  scale?: number
  comment?: string
}

export interface DatabaseResultColumn {
  name: string
  table?: string
  type?: string
}

export interface DatabaseQueryRequest {
  sql: string
  page?: number
  pageSize?: number
  restart?: boolean
}

export interface DatabaseQueryResult {
  kind: 'rows' | 'mutation'
  columns: DatabaseResultColumn[]
  rows: DatabaseCell[][]
  page: number
  pageSize: number
  hasMore: boolean
  affectedRows: number
  changedRows: number
  insertId?: string
  warningStatus: number
  durationMs: number
  statement: string
}

export interface DatabaseCsvExport {
  fileName: string
  columns: string[]
  rows: DatabaseCell[][]
}

export interface DatabaseCellDetail {
  text: string
  format: 'text' | 'json'
}

export const DATABASE_PAGE_SIZE = 200
export const DATABASE_MAX_PAGE_SIZE = 500
export const DATABASE_MAX_SQL_LENGTH = 1024 * 1024

export function databaseDisplayRows(rows: DatabaseCell[][], filter = '', sortColumn = -1, direction: 'asc' | 'desc' = 'asc'): DatabaseCell[][] {
  const needle = filter.trim().toLocaleLowerCase()
  const visible = needle ? rows.filter((row) => row.some((cell) => (cell == null ? 'null' : String(cell)).toLocaleLowerCase().includes(needle))) : [...rows]
  if (sortColumn < 0) return visible
  return visible.sort((left, right) => {
    const a = left[sortColumn]
    const b = right[sortColumn]
    const compared = typeof a === 'number' && typeof b === 'number'
      ? a - b
      : a == null ? 1 : b == null ? -1 : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
    return direction === 'asc' ? compared : -compared
  })
}

export function normalizeQueryRequest(request: DatabaseQueryRequest): Required<DatabaseQueryRequest> {
  if (!request || typeof request !== 'object') throw databaseInputError('DATABASE_QUERY_INVALID', 'Query request is invalid')
  const sql = String(request.sql || '').trim()
  if (!sql || sql.length > DATABASE_MAX_SQL_LENGTH) throw databaseInputError('DATABASE_QUERY_INVALID', 'SQL must contain between 1 byte and 1 MB')
  const page = Number(request.page ?? 0)
  const pageSize = Number(request.pageSize ?? DATABASE_PAGE_SIZE)
  const restart = request.restart ?? page === 0
  if (!Number.isInteger(page) || page < 0 || page > 1_000_000) throw databaseInputError('DATABASE_PAGE_INVALID', 'Query page is invalid')
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > DATABASE_MAX_PAGE_SIZE) throw databaseInputError('DATABASE_PAGE_INVALID', `Page size must be between 1 and ${DATABASE_MAX_PAGE_SIZE}`)
  if (typeof restart !== 'boolean') throw databaseInputError('DATABASE_QUERY_INVALID', 'Query restart option is invalid')
  return { sql, page, pageSize, restart }
}

export function databaseStatement(sql: string): string {
  const withoutLeadingComments = sql
    .replace(/^\uFEFF/, '')
    .replace(/^(?:\s|--[^\r\n]*(?:\r?\n|$)|#[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/, '')
  return withoutLeadingComments.match(/^([a-z]+)/i)?.[1]?.toUpperCase() || 'UNKNOWN'
}

export function isPageableStatement(sql: string): boolean {
  const statement = databaseStatement(sql)
  return statement === 'SELECT' || statement === 'WITH'
}

export function databaseResultToCsv(input: DatabaseCsvExport): string {
  if (!input || !Array.isArray(input.columns) || !Array.isArray(input.rows) || input.columns.length > 1000 || input.rows.length > DATABASE_MAX_PAGE_SIZE) {
    throw databaseInputError('DATABASE_EXPORT_INVALID', 'Export data is invalid')
  }
  const width = input.columns.length
  if (!width || input.rows.some((row) => !Array.isArray(row) || row.length !== width)) throw databaseInputError('DATABASE_EXPORT_INVALID', 'Export rows do not match the columns')
  return [input.columns, ...input.rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
}

export function parseDatabaseCsv(source: string): { columns: string[]; rows: DatabaseCell[][] } {
  const records: string[][] = [['']]
  let quoted = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        const row = records[records.length - 1]
        row[row.length - 1] += '"'
        index++
      } else quoted = !quoted
    } else if (char === ',' && !quoted) records.at(-1)!.push('')
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[index + 1] === '\n') index++
      records.push([''])
    } else records.at(-1)![records.at(-1)!.length - 1] += char
  }
  if (quoted) throw databaseInputError('DATABASE_IMPORT_INVALID', 'CSV contains an unterminated quoted field')
  while (records.length && records.at(-1)!.every((cell) => !cell)) records.pop()
  const columns = (records.shift() || []).map((column, index) => (index === 0 ? column.replace(/^\uFEFF/, '') : column).trim())
  if (!columns.length || columns.some((column) => !column)) throw databaseInputError('DATABASE_IMPORT_INVALID', 'CSV header is missing')
  return { columns, rows: records.map((row) => columns.map((_, index) => row[index] ?? '')) }
}

export function databaseSqlLiteral(value: DatabaseCell, dialect: DatabaseAdapterType = 'sqlite'): string {
  if (value == null) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : `'${String(value)}'`
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (dialect === 'mysql') {
    if (!value) return "''"
    const hex = [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    return `CONVERT(X'${hex}' USING utf8mb4)`
  }
  return `'${value.replaceAll("'", "''")}'`
}

export function databaseCellDetail(value: DatabaseCell): DatabaseCellDetail {
  const text = value == null ? 'NULL' : String(value)
  if (typeof value !== 'string') return { text, format: 'text' }
  const source = value.trim()
  if (!(source.startsWith('{') && source.endsWith('}')) && !(source.startsWith('[') && source.endsWith(']'))) return { text, format: 'text' }
  try {
    const parsed = JSON.parse(source) as unknown
    if (parsed == null || typeof parsed !== 'object') return { text, format: 'text' }
    return { text: JSON.stringify(parsed, null, 2), format: 'json' }
  } catch {
    return { text, format: 'text' }
  }
}

function csvCell(value: DatabaseCell): string {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function databaseInputError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}
