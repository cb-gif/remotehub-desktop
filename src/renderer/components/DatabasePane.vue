<script setup lang="ts">
import { basicSetup, EditorView } from 'codemirror'
import { Compartment } from '@codemirror/state'
import { MySQL, PostgreSQL, SQLite, sql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DatabaseAdapterType, DatabaseCatalog, DatabaseCell, DatabaseColumn, DatabaseQueryResult, DatabaseTable } from '../../shared/database'
import { createSessionStatusTracker, type TabConnectionStatus } from '../../shared/connection-status'
import { DATABASE_PAGE_SIZE, databaseCellDetail, databaseDisplayRows, databaseSqlLiteral, parseDatabaseCsv } from '../../shared/database'
import { t } from '../i18n'
import { useConnectionStore } from '../stores/connection'

const props = defineProps<{ connectionId: string }>()
const emit = defineEmits<{ 'connection-status': [status: TabConnectionStatus] }>()
const connections = useConnectionStore()
const connection = computed(() => connections.connections.find((item) => item.id === props.connectionId))
const isPostgres = computed(() => connection.value?.databaseType === 'postgres')
const isSqlite = computed(() => connection.value?.databaseType === 'sqlite')
const databaseDialect = ref<DatabaseAdapterType | null>(null)
type EditableRow = { values: DatabaseCell[]; original?: DatabaseCell[]; selected: boolean }

const editorHost = ref<HTMLElement | null>(null)
const sessionId = ref('')
const databases = ref<DatabaseCatalog[]>([])
const selectedDatabase = ref('')
const activeDatabase = ref('')
const tables = ref<DatabaseTable[]>([])
const columnsByTable = ref<Record<string, DatabaseColumn[]>>({})
const expandedSchema = ref('')
const collapsedSections = ref<Record<string, boolean>>({})
const openedTables = ref<DatabaseTable[]>([])
const openedStructures = ref<DatabaseTable[]>([])
const activeTableName = ref('')
const activeTable = computed(() => [...openedTables.value, ...openedStructures.value].find((table) => tableKey(table) === activeTableName.value) || null)
const workspaceMode = ref<'home' | 'table' | 'structure' | 'sql'>('home')
const schemaFilter = ref('')
const rowFilter = ref('')
const filterVisible = ref(false)
const columnPickerVisible = ref(false)
const hiddenColumns = ref<Record<string, string[]>>({})
const columnWidths = ref<Record<string, number>>({})
const tableDrafts = ref<Record<string, EditableRow[]>>({})
const deletedRows = ref<Record<string, DatabaseCell[][]>>({})
const sortColumn = ref(-1)
const sortDirection = ref<'asc' | 'desc'>('asc')
const tableSorts = ref<Record<string, { column: string; direction: 'asc' | 'desc' }>>({})
const sqlResult = ref<DatabaseQueryResult | null>(null)
const tableResults = ref<Record<string, DatabaseQueryResult>>({})
const connecting = ref(true)
const loadingSchema = ref(false)
const running = ref(false)
const errorMessage = ref('')
const sqlLastSql = ref('')
const tableLastSql = ref<Record<string, string>>({})
const cellContextMenu = ref<{ x: number; y: number; row: DatabaseCell[]; rowIndex: number; columnIndex: number; value: DatabaseCell } | null>(null)
const tabContextMenu = ref<{ x: number; y: number; kind: 'table' | 'structure'; table: DatabaseTable } | null>(null)
const selectedCell = ref<{ row: DatabaseCell[]; rowNumber: number; columnIndex: number; columnName: string; columnType: string; value: DatabaseCell } | null>(null)
const structureSection = ref<'fields' | 'indexes' | 'foreignKeys' | 'checks' | 'triggers' | 'advanced'>('fields')
const selectedStructureColumnName = ref('')
const csvInput = ref<HTMLInputElement | null>(null)
const workspaceHost = ref<HTMLElement | null>(null)
const schemaWidth = ref(235)
const schemaCollapsed = ref(false)
const resizingSchema = ref(false)
let editor: EditorView | undefined
const editorTheme = new Compartment()
let themeObserver: MutationObserver | undefined
let disposed = false
let removeStatusListener: (() => void) | undefined
let connectionStatus: TabConnectionStatus = 'connecting'
const statusTracker = createSessionStatusTracker((status, message) => {
  connectionStatus = status
  emit('connection-status', status)
  if (message) errorMessage.value = message
  if (status === 'error' || status === 'closed') {
    sessionId.value = ''
    databaseDialect.value = null
  }
})
statusTracker.start()
let columnResize: { key: string; startX: number; startWidth: number } | null = null

const tokyoNightEditorTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--tn-canvas)', color: 'var(--tn-text)' },
  '.cm-content': { caretColor: 'var(--tn-strong)' },
  '.cm-cursor': { borderLeftColor: 'var(--tn-strong)' },
  '.cm-activeLine': { backgroundColor: 'var(--tn-highlight)' },
  '.cm-gutters': { backgroundColor: 'var(--tn-toolbar)', color: 'var(--tn-comment)', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--tn-highlight)', color: 'var(--tn-muted)' },
  '.cm-selectionBackground': { backgroundColor: 'var(--ui-selected)' }
}, { dark: true })

const tokyoLightEditorTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--tn-canvas)', color: 'var(--tn-text)' },
  '.cm-content': { caretColor: 'var(--tn-strong)' },
  '.cm-cursor': { borderLeftColor: 'var(--tn-strong)' },
  '.cm-activeLine': { backgroundColor: 'var(--tn-highlight)' },
  '.cm-gutters': { backgroundColor: 'var(--tn-toolbar)', color: 'var(--tn-comment)', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--tn-highlight)', color: 'var(--tn-muted)' },
  '.cm-selectionBackground': { backgroundColor: 'var(--ui-selected)' }
}, { dark: false })

function databaseEditorTheme() {
  const theme = document.documentElement.dataset.theme
  if (theme === 'light') return []
  if (theme === 'tokyo-light') return tokyoLightEditorTheme
  return theme === 'tokyo-night' || theme === 'tokyo-storm' ? [oneDark, tokyoNightEditorTheme] : oneDark
}

function sectionsFor(source: DatabaseTable[]): { type: string; label: string; items: DatabaseTable[] }[] {
  const needle = schemaFilter.value.trim().toLocaleLowerCase()
  const visible = needle ? source.filter((table) => table.name.toLocaleLowerCase().includes(needle)) : source
  return [
    { type: 'table', label: t('tables'), items: visible.filter((table) => table.type === 'table') },
    { type: 'view', label: t('views'), items: visible.filter((table) => table.type === 'view') }
  ].filter((section) => section.items.length)
}

const tableSections = computed(() => sectionsFor(tables.value))
const visibleDatabases = computed(() => isPostgres.value ? databases.value.filter((database) => !database.system) : databases.value)
const postgresSchemas = computed(() => [...new Set(tables.value.map((table) => table.database))].map((name) => ({
  name,
  sections: sectionsFor(tables.value.filter((table) => table.database === name))
})))

const result = computed(() => workspaceMode.value === 'table' && activeTableName.value
  ? tableResults.value[activeTableName.value] || null
  : workspaceMode.value === 'sql' ? sqlResult.value : null)

const lastSql = computed(() => workspaceMode.value === 'table' && activeTableName.value
  ? tableLastSql.value[activeTableName.value] || ''
  : sqlLastSql.value)

const activeDraftRows = computed(() => tableDrafts.value[activeTableName.value] || [])
const displayRows = computed(() => result.value?.kind === 'rows'
  ? databaseDisplayRows(workspaceMode.value === 'table' ? activeDraftRows.value.map((row) => row.values) : result.value.rows, rowFilter.value, workspaceMode.value === 'table' ? -1 : sortColumn.value, sortDirection.value)
  : [])
const visibleColumnIndexes = computed(() => result.value?.kind === 'rows'
  ? result.value.columns.map((_, index) => index).filter((index) => !hiddenColumns.value[activeTableName.value]?.includes(result.value!.columns[index].name))
  : [])
const canEditTable = computed(() => workspaceMode.value === 'table' && activeTable.value?.type === 'table' && result.value?.kind === 'rows')
const hasPrimaryKey = computed(() => (columnsByTable.value[activeTableName.value] || []).some((column) => column.key === 'PRI'))
const canEditCells = computed(() => canEditTable.value && hasPrimaryKey.value)
const selectedRowCount = computed(() => activeDraftRows.value.filter((row) => row.selected).length)
const canDeleteSelected = computed(() => canEditTable.value && activeDraftRows.value.filter((row) => row.selected).every((row) => !row.original || hasPrimaryKey.value))
const pendingChangeCount = computed(() => (deletedRows.value[activeTableName.value]?.length || 0) + activeDraftRows.value.filter((row) => !row.original || !sameRow(row.values, row.original)).length)
const homeTables = computed(() => {
  const needle = schemaFilter.value.trim().toLocaleLowerCase()
  return needle ? tables.value.filter((table) => table.name.toLocaleLowerCase().includes(needle)) : tables.value
})
const structureSections = computed(() => (['fields', 'indexes', 'foreignKeys', 'checks', 'triggers', 'advanced'] as const).map((key) => ({ key, label: t(key) })))
const selectedStructureColumn = computed(() => (columnsByTable.value[activeTableName.value] || []).find((column) => column.name === selectedStructureColumnName.value) || null)

const resultSummary = computed(() => {
  if (!result.value) return t('queryReady')
  if (result.value.kind === 'mutation') return t('affectedRows', { count: result.value.affectedRows, duration: result.value.durationMs })
  return rowFilter.value.trim()
    ? t('visibleRows', { visible: displayRows.value.length, total: result.value.rows.length, duration: result.value.durationMs })
    : t('queryRows', { count: result.value.rows.length, duration: result.value.durationMs })
})
const selectedCellDetail = computed(() => selectedCell.value ? databaseCellDetail(selectedCell.value.value) : null)

watch(result, () => {
  cellContextMenu.value = null
  selectedCell.value = null
})

async function connect(): Promise<void> {
  connecting.value = true
  errorMessage.value = ''
  const previousSession = sessionId.value
  sessionId.value = ''
  databaseDialect.value = null
  statusTracker.start()
  if (previousSession) await window.api.database.disconnect(previousSession).catch(() => undefined)
  try {
    const connected = await window.api.database.connect(props.connectionId)
    if (disposed) {
      await window.api.database.disconnect(connected.sessionId).catch(() => undefined)
      return
    }
    sessionId.value = connected.sessionId
    statusTracker.bind(connected.sessionId)
    if (!sessionId.value) return
    databaseDialect.value = connected.adapter
    databases.value = await window.api.database.listDatabases(connected.sessionId)
    selectedDatabase.value = connected.database && visibleDatabases.value.some((item) => item.name === connected.database)
      ? connected.database
      : visibleDatabases.value[0]?.name || ''
    if (selectedDatabase.value) await changeDatabase()
  } catch (error) {
    if (!disposed && connectionStatus === 'connecting') statusTracker.finish('error')
    showError(error)
  } finally { connecting.value = false }
}

async function changeDatabase(): Promise<void> {
  if (!sessionId.value || !selectedDatabase.value) return
  const previousDatabase = activeDatabase.value
  loadingSchema.value = true
  errorMessage.value = ''
  try {
    await window.api.database.useDatabase(sessionId.value, selectedDatabase.value)
    const nextTables = await window.api.database.listTables(sessionId.value, selectedDatabase.value)
    activeDatabase.value = selectedDatabase.value
    tables.value = nextTables
    expandedSchema.value = ''
    collapsedSections.value = {}
    openedTables.value = []
    openedStructures.value = []
    activeTableName.value = ''
    sqlResult.value = null
    sqlLastSql.value = ''
    tableResults.value = {}
    tableLastSql.value = {}
    tableDrafts.value = {}
    deletedRows.value = {}
    hiddenColumns.value = {}
    columnWidths.value = {}
    tableSorts.value = {}
    columnsByTable.value = {}
    workspaceMode.value = 'home'
    if (isPostgres.value) expandedSchema.value = postgresSchemas.value.some((schema) => schema.name === 'public') ? 'public' : postgresSchemas.value[0]?.name || ''
  } catch (error) {
    if (previousDatabase && previousDatabase !== selectedDatabase.value) await window.api.database.useDatabase(sessionId.value, previousDatabase).catch(() => undefined)
    selectedDatabase.value = previousDatabase
    showError(error)
  } finally { loadingSchema.value = false }
}

async function selectDatabase(name: string): Promise<void> {
  if (name === selectedDatabase.value || running.value) return
  selectedDatabase.value = name
  await changeDatabase()
}

async function refreshSchema(): Promise<void> {
  if (!sessionId.value) return
  try {
    databases.value = await window.api.database.listDatabases(sessionId.value)
    if (selectedDatabase.value) {
      tables.value = await window.api.database.listTables(sessionId.value, selectedDatabase.value)
      columnsByTable.value = {}
      if (isPostgres.value && !postgresSchemas.value.some((schema) => schema.name === expandedSchema.value)) expandedSchema.value = postgresSchemas.value[0]?.name || ''
    }
  } catch (error) { showError(error) }
}

async function loadColumns(table: DatabaseTable): Promise<void> {
  const key = tableKey(table)
  if (columnsByTable.value[key] || !sessionId.value) return
  columnsByTable.value = {
    ...columnsByTable.value,
    [key]: await window.api.database.listColumns(sessionId.value, isPostgres.value ? table.database : selectedDatabase.value, table.name)
  }
}

function toggleSection(key: string): void {
  collapsedSections.value[key] = !collapsedSections.value[key]
}

async function openTable(table: DatabaseTable): Promise<void> {
  const key = tableKey(table)
  if (!openedTables.value.some((item) => tableKey(item) === key)) openedTables.value.push(table)
  activeTableName.value = key
  workspaceMode.value = 'table'
  rowFilter.value = ''
  restoreTableSort(key)
  try { await loadColumns(table) } catch (error) { showError(error) }
  if (!tableResults.value[key]) await runQuery(0, tableQuery(table))
}

function activateTable(table: DatabaseTable): void {
  const key = tableKey(table)
  activeTableName.value = key
  workspaceMode.value = 'table'
  rowFilter.value = ''
  restoreTableSort(key)
}

function showTableStructure(): void {
  if (!activeTable.value) return
  const table = activeTable.value
  if (!openedStructures.value.some((item) => tableKey(item) === activeTableName.value)) openedStructures.value.push(table)
  structureSection.value = 'fields'
  const columns = columnsByTable.value[activeTableName.value] || []
  if (!columns.some((column) => column.name === selectedStructureColumnName.value)) selectedStructureColumnName.value = columns[0]?.name || ''
  workspaceMode.value = 'structure'
}

function activateStructure(table: DatabaseTable): void {
  activeTableName.value = tableKey(table)
  const columns = columnsByTable.value[activeTableName.value] || []
  if (!columns.some((column) => column.name === selectedStructureColumnName.value)) selectedStructureColumnName.value = columns[0]?.name || ''
  workspaceMode.value = 'structure'
}

function showTableData(): void {
  if (activeTable.value) activateTable(activeTable.value)
}

function openSqlEditor(): void {
  workspaceMode.value = 'sql'
  void nextTick(() => editor?.focus())
}

function closeTable(table: DatabaseTable): void {
  const key = tableKey(table)
  const index = openedTables.value.findIndex((item) => tableKey(item) === key)
  if (index < 0) return
  openedTables.value.splice(index, 1)
  delete tableResults.value[key]
  delete tableLastSql.value[key]
  delete tableDrafts.value[key]
  delete deletedRows.value[key]
  delete hiddenColumns.value[key]
  delete tableSorts.value[key]
  if (workspaceMode.value !== 'table' || activeTableName.value !== key) return
  const next = openedTables.value[index] || openedTables.value[index - 1]
  if (next) activateTable(next)
  else {
    const structure = openedStructures.value[0]
    if (structure) activateStructure(structure)
    else workspaceMode.value = 'home'
  }
}

function closeStructure(table: DatabaseTable): void {
  const key = tableKey(table)
  const index = openedStructures.value.findIndex((item) => tableKey(item) === key)
  if (index < 0) return
  openedStructures.value.splice(index, 1)
  if (workspaceMode.value !== 'structure' || activeTableName.value !== key) return
  const next = openedStructures.value[index] || openedStructures.value[index - 1]
  if (next) activateStructure(next)
  else {
    const data = openedTables.value.find((item) => tableKey(item) === key)
    if (data) activateTable(data)
    else {
      activeTableName.value = ''
      workspaceMode.value = 'home'
    }
  }
}

function showTabContextMenu(event: MouseEvent, kind: 'table' | 'structure', table: DatabaseTable): void {
  event.preventDefault()
  event.stopPropagation()
  cellContextMenu.value = null
  tabContextMenu.value = {
    x: Math.max(4, Math.min(event.clientX, window.innerWidth - 154)),
    y: Math.max(4, Math.min(event.clientY, window.innerHeight - 76)),
    kind,
    table
  }
}

function closeTabFromMenu(): void {
  const target = tabContextMenu.value
  tabContextMenu.value = null
  if (!target) return
  if (target.kind === 'table') closeTable(target.table)
  else closeStructure(target.table)
}

function closeAllDatabaseTabs(): void {
  tabContextMenu.value = null
  for (const table of [...openedTables.value]) closeTable(table)
  for (const table of [...openedStructures.value]) closeStructure(table)
}

function openTableSql(): void {
  openSqlEditor()
  if (activeTable.value) setEditorText(tableQuery(activeTable.value))
}

async function runEditorQuery(): Promise<void> {
  workspaceMode.value = 'sql'
  rowFilter.value = ''
  sortColumn.value = -1
  await runQuery(0)
}

async function refreshResult(): Promise<void> {
  const page = result.value?.kind === 'rows' ? result.value.page : 0
  await runQuery(page, workspaceMode.value === 'table' && activeTable.value ? tableQuery(activeTable.value) : lastSql.value)
}

async function runQuery(page = 0, sqlOverride?: string, restart = true): Promise<void> {
  if (!sessionId.value || running.value) return
  const targetTable = workspaceMode.value === 'table' ? activeTableName.value : ''
  const previousSql = targetTable ? tableLastSql.value[targetTable] : sqlLastSql.value
  const query = sqlOverride ?? (page === 0 ? selectedSql() : previousSql)
  if (!query.trim()) return
  if (targetTable) tableLastSql.value[targetTable] = query
  else sqlLastSql.value = query
  running.value = true
  errorMessage.value = ''
  try {
    const nextResult = await window.api.database.query(sessionId.value, { sql: query, page, pageSize: DATABASE_PAGE_SIZE, restart })
    if (targetTable) {
      if (openedTables.value.some((table) => tableKey(table) === targetTable)) {
        tableResults.value[targetTable] = nextResult
        if (nextResult.kind === 'rows') {
          tableDrafts.value[targetTable] = nextResult.rows.map((values: DatabaseCell[]) => ({ values: [...values], original: [...values], selected: false }))
          deletedRows.value[targetTable] = []
        }
      }
    } else sqlResult.value = nextResult
    if (nextResult.kind === 'mutation') await refreshSchema()
  } catch (error) { showError(error) } finally { running.value = false }
}

function selectedSql(): string {
  if (!editor) return ''
  const selection = editor.state.selection.main
  return selection.empty ? editor.state.doc.toString() : editor.state.sliceDoc(selection.from, selection.to)
}

function setEditorText(value: string): void {
  if (!editor) return
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, selection: { anchor: value.length } })
  editor.focus()
}

function handleEditorKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault()
    void runEditorQuery()
  }
}

async function toggleSort(index: number): Promise<void> {
  if (running.value || (workspaceMode.value === 'table' && pendingChangeCount.value)) return
  if (sortColumn.value === index) sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
  else {
    sortColumn.value = index
    sortDirection.value = 'asc'
  }
  if (workspaceMode.value === 'table' && activeTable.value && result.value?.kind === 'rows') {
    tableSorts.value[activeTableName.value] = { column: result.value.columns[index].name, direction: sortDirection.value }
    await runQuery(0, tableQuery(activeTable.value))
  }
}

function restoreTableSort(key: string): void {
  const sort = tableSorts.value[key]
  const tableResult = tableResults.value[key]
  sortColumn.value = sort && tableResult?.kind === 'rows' ? tableResult.columns.findIndex((column) => column.name === sort.column) : -1
  sortDirection.value = sort?.direction || 'asc'
}

function columnWidthKey(index: number): string {
  return `${workspaceMode.value}:${activeTableName.value}:${result.value?.columns[index]?.name || index}:${index}`
}

function columnStyle(index: number): Record<string, string> {
  const width = columnWidths.value[columnWidthKey(index)]
  return width ? { width: `${width}px`, minWidth: `${width}px`, maxWidth: `${width}px` } : {}
}

function setColumnWidth(key: string, width: number): void {
  columnWidths.value[key] = Math.max(64, Math.round(width))
}

function startColumnResize(index: number, event: PointerEvent): void {
  const handle = event.currentTarget as HTMLElement
  columnResize = { key: columnWidthKey(index), startX: event.clientX, startWidth: handle.parentElement!.getBoundingClientRect().width }
  handle.setPointerCapture(event.pointerId)
}

function resizeColumn(event: PointerEvent): void {
  if (columnResize) setColumnWidth(columnResize.key, columnResize.startWidth + event.clientX - columnResize.startX)
}

function stopColumnResize(event: PointerEvent): void {
  columnResize = null
  const handle = event.currentTarget as HTMLElement
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
}

function resizeColumnWithKeyboard(index: number, event: KeyboardEvent): void {
  const delta = event.key === 'ArrowLeft' ? -12 : event.key === 'ArrowRight' ? 12 : 0
  if (!delta) return
  setColumnWidth(columnWidthKey(index), (event.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().width + delta)
  event.preventDefault()
}

function columnMetadata(index: number): DatabaseColumn | undefined {
  const name = result.value?.columns[index]?.name
  return workspaceMode.value === 'table' && activeTable.value && name
    ? columnsByTable.value[tableKey(activeTable.value)]?.find((column) => column.name === name)
    : undefined
}

function columnType(index: number): string {
  return columnMetadata(index)?.columnType || result.value?.columns[index]?.type || ''
}

function columnDetails(index: number): string {
  const column = columnMetadata(index)
  return [columnType(index), column?.length != null ? `${t('length')}: ${column.length}` : '', column?.comment ? `${t('comment')}: ${column.comment}` : ''].filter(Boolean).join(' · ')
}

function tableQuery(table: DatabaseTable): string {
  const sort = tableSorts.value[tableKey(table)]
  return `SELECT * FROM ${qualifiedTableName(table)}${sort ? ` ORDER BY ${quoteIdentifier(sort.column)} ${sort.direction.toUpperCase()}` : ''};`
}

function qualifiedTableName(table: DatabaseTable): string {
  return `${quoteIdentifier(isPostgres.value ? table.database : selectedDatabase.value)}.${quoteIdentifier(table.name)}`
}

function tableKey(table?: DatabaseTable): string {
  return table ? `${table.database}.${table.name}` : ''
}

function quoteIdentifier(value: string): string {
  return isPostgres.value || isSqlite.value ? `"${value.replaceAll('"', '""')}"` : `\`${value.replaceAll('`', '``')}\``
}

function displayCell(value: string | number | boolean | null): string {
  return value == null ? 'NULL' : String(value)
}

function sameRow(left: DatabaseCell[], right: DatabaseCell[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function editableRow(values: DatabaseCell[]): EditableRow | undefined {
  return activeDraftRows.value.find((row) => row.values === values)
}

function updateCell(values: DatabaseCell[], index: number, event: Event): void {
  const row = editableRow(values)
  if (!row || (row.original && !canEditCells.value)) return
  row.values[index] = (event.target as HTMLInputElement).value
}

function addRow(): void {
  if (!canEditTable.value || result.value?.kind !== 'rows') return
  activeDraftRows.value.unshift({ values: result.value.columns.map(() => null), selected: true })
}

function toggleRowSelection(values: DatabaseCell[]): void {
  const row = editableRow(values)
  if (row) row.selected = !row.selected
}

async function refreshStructure(): Promise<void> {
  if (!activeTable.value) return
  delete columnsByTable.value[activeTableName.value]
  try {
    await loadColumns(activeTable.value)
    selectedStructureColumnName.value = columnsByTable.value[activeTableName.value]?.[0]?.name || ''
  } catch (error) { showError(error) }
}

function deleteSelectedRows(): void {
  if (!canEditTable.value || !selectedRowCount.value) return
  const removed = activeDraftRows.value.filter((row) => row.selected)
  deletedRows.value[activeTableName.value] = [...(deletedRows.value[activeTableName.value] || []), ...removed.flatMap((row) => row.original ? [row.original] : [])]
  tableDrafts.value[activeTableName.value] = activeDraftRows.value.filter((row) => !row.selected)
}

function discardChanges(): void {
  if (result.value?.kind !== 'rows') return
  tableDrafts.value[activeTableName.value] = result.value.rows.map((values) => ({ values: [...values], original: [...values], selected: false }))
  deletedRows.value[activeTableName.value] = []
}

async function saveChanges(): Promise<void> {
  const dialect = databaseDialect.value
  if (!dialect || !canEditTable.value || !activeTable.value || result.value?.kind !== 'rows' || !pendingChangeCount.value || running.value) return
  const columns = result.value.columns
  const metadata = columnsByTable.value[activeTableName.value] || []
  const keys = columns.map((column, index) => metadata.find((item) => item.name === column.name)?.key === 'PRI' ? index : -1).filter((index) => index >= 0)
  const whereIndexes = keys.length ? keys : columns.map((_, index) => index)
  const table = qualifiedTableName(activeTable.value)
  const predicate = (values: DatabaseCell[]) => whereIndexes.map((index) => `${quoteIdentifier(columns[index].name)} ${values[index] == null ? 'IS NULL' : `= ${databaseSqlLiteral(values[index], dialect)}`}`).join(' AND ')
  const statements: string[] = []
  for (const values of deletedRows.value[activeTableName.value] || []) statements.push(`DELETE FROM ${table} WHERE ${predicate(values)}`)
  for (const row of activeDraftRows.value) {
    if (!row.original) {
      const indexes = columns.map((_, index) => index).filter((index) => row.values[index] != null || metadata.find((item) => item.name === columns[index].name)?.extra !== 'auto increment')
      statements.push(indexes.length
        ? `INSERT INTO ${table} (${indexes.map((index) => quoteIdentifier(columns[index].name)).join(', ')}) VALUES (${indexes.map((index) => databaseSqlLiteral(row.values[index], dialect)).join(', ')})`
        : isPostgres.value || isSqlite.value ? `INSERT INTO ${table} DEFAULT VALUES` : `INSERT INTO ${table} () VALUES ()`)
    } else if (!sameRow(row.values, row.original)) {
      const changed = columns.map((_, index) => index).filter((index) => row.values[index] !== row.original![index])
      statements.push(`UPDATE ${table} SET ${changed.map((index) => `${quoteIdentifier(columns[index].name)} = ${databaseSqlLiteral(row.values[index], dialect)}`).join(', ')} WHERE ${predicate(row.original)}`)
    }
  }
  running.value = true
  errorMessage.value = ''
  try {
    for (const sql of statements) await window.api.database.query(sessionId.value, { sql })
  } catch (error) {
    showError(error)
    return
  } finally { running.value = false }
  await runQuery(result.value.page, tableQuery(activeTable.value))
}

function toggleColumn(name: string): void {
  const hidden = hiddenColumns.value[activeTableName.value] || []
  hiddenColumns.value[activeTableName.value] = hidden.includes(name) ? hidden.filter((item) => item !== name) : [...hidden, name]
}

async function importCsv(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !canEditTable.value || result.value?.kind !== 'rows') return
  try {
    const imported = parseDatabaseCsv(await file.text())
    const indexes = result.value.columns.map((column) => imported.columns.indexOf(column.name))
    if (indexes.every((index) => index < 0)) throw new Error(t('importCsvFailed'))
    for (const source of imported.rows) activeDraftRows.value.push({ values: indexes.map((index) => index < 0 ? null : source[index]), selected: false })
  } catch (error) { showError(error) }
}

function startSchemaResize(event: PointerEvent): void {
  resizingSchema.value = true
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function resizeSchema(event: PointerEvent): void {
  if (!resizingSchema.value || !workspaceHost.value) return
  schemaWidth.value = Math.max(180, Math.min(520, event.clientX - workspaceHost.value.getBoundingClientRect().left))
}

function stopSchemaResize(event: PointerEvent): void {
  resizingSchema.value = false
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
}

function resizeSchemaWithKeyboard(event: KeyboardEvent): void {
  const delta = event.key === 'ArrowLeft' ? -12 : event.key === 'ArrowRight' ? 12 : 0
  if (!delta) return
  schemaWidth.value = Math.max(180, Math.min(520, schemaWidth.value + delta))
  event.preventDefault()
}

function showCellContextMenu(event: MouseEvent, row: DatabaseCell[], rowIndex: number, columnIndex: number, value: DatabaseCell): void {
  event.preventDefault()
  event.stopPropagation()
  tabContextMenu.value = null
  cellContextMenu.value = {
    x: Math.max(4, Math.min(event.clientX, window.innerWidth - 154)),
    y: Math.max(4, Math.min(event.clientY, window.innerHeight - 48)),
    row,
    rowIndex,
    columnIndex,
    value
  }
}

function updateCellDetail(row: DatabaseCell[], rowIndex: number, columnIndex: number, value: DatabaseCell, open = false): void {
  if ((!selectedCell.value && !open) || result.value?.kind !== 'rows') return
  selectedCell.value = {
    row,
    rowNumber: result.value.page * result.value.pageSize + rowIndex + 1,
    columnIndex,
    columnName: result.value.columns[columnIndex]?.name || `#${columnIndex + 1}`,
    columnType: columnType(columnIndex),
    value
  }
}

function showFullCellData(): void {
  const target = cellContextMenu.value
  if (!target) return
  updateCellDetail(target.row, target.rowIndex, target.columnIndex, target.value, true)
  cellContextMenu.value = null
}

function closeCellDetail(): void {
  selectedCell.value = null
}

function closeContextMenus(): void {
  cellContextMenu.value = null
  tabContextMenu.value = null
}

function showError(error: unknown): void {
  errorMessage.value = error instanceof Error ? error.message : t('databaseUnavailable')
}

async function exportResult(): Promise<void> {
  if (!result.value || result.value.kind !== 'rows') return
  try {
    await window.api.database.exportCsv({
      fileName: `remotehub-results-page-${result.value.page + 1}.csv`,
      columns: result.value.columns.map((column) => column.name),
      rows: displayRows.value
    })
  } catch (error) { showError(error) }
}

onMounted(async () => {
  removeStatusListener = window.api.database.onStatus(statusTracker.handle)
  document.addEventListener('pointerdown', closeContextMenus)
  await nextTick()
  if (disposed) return
  if (editorHost.value) editor = new EditorView({
    parent: editorHost.value,
    doc: isSqlite.value ? 'SELECT sqlite_version() AS version;' : 'SELECT VERSION() AS version;',
    extensions: [basicSetup, sql({ dialect: isPostgres.value ? PostgreSQL : isSqlite.value ? SQLite : MySQL }), editorTheme.of(databaseEditorTheme()), EditorView.lineWrapping]
  })
  themeObserver = new MutationObserver(() => editor?.dispatch({ effects: editorTheme.reconfigure(databaseEditorTheme()) }))
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  await connect()
})

onBeforeUnmount(() => {
  disposed = true
  const currentSession = sessionId.value
  statusTracker.finish('closed')
  removeStatusListener?.()
  document.removeEventListener('pointerdown', closeContextMenus)
  themeObserver?.disconnect()
  editor?.destroy()
  if (currentSession) void window.api.database.disconnect(currentSession).catch(() => undefined)
})
</script>

<template>
  <section class="database-pane">
    <header class="database-toolbar">
      <div class="database-identity">
        <span class="database-engine">{{ connection?.databaseType?.toUpperCase() }}</span>
        <span class="database-identity-copy"><strong>{{ connection?.name }}</strong><small>{{ connection?.host }}<template v-if="connection?.port">:{{ connection.port }}</template></small></span>
      </div>
      <label v-if="!isPostgres" class="database-selector">
        <span>{{ t('defaultDatabase') }}</span>
        <select v-model="selectedDatabase" :disabled="!sessionId || connecting || running" @change="changeDatabase">
          <option v-if="!databases.length" value="">{{ t('noDatabase') }}</option>
          <option v-for="database in databases" :key="database.name" :value="database.name">{{ database.name }}{{ database.system ? ` · ${t('systemDatabase')}` : '' }}</option>
        </select>
      </label>
      <span class="database-connection-state" :class="{ online: Boolean(sessionId) }"><i></i>{{ connecting ? t('connecting') : sessionId ? t('connected') : t('closed') }}</span>
      <button v-if="!sessionId && !connecting" class="toolbar-button" @click="connect">{{ t('reconnect') }}</button>
    </header>
    <div v-if="errorMessage" class="database-error"><span>{{ errorMessage }}</span><button class="icon-button" @click="errorMessage = ''">×</button></div>
    <div ref="workspaceHost" class="database-workspace" :class="{ resizing: resizingSchema }">
      <aside class="schema-explorer" :class="{ collapsed: schemaCollapsed }" :style="{ width: `${schemaCollapsed ? 34 : schemaWidth}px`, flexBasis: `${schemaCollapsed ? 34 : schemaWidth}px` }">
        <div class="schema-heading"><span>{{ t('schemaExplorer') }}</span><small>{{ tables.length }}</small><button :title="t(schemaCollapsed ? 'expandSchema' : 'collapseSchema')" :aria-label="t(schemaCollapsed ? 'expandSchema' : 'collapseSchema')" @click="schemaCollapsed = !schemaCollapsed">{{ schemaCollapsed ? '›' : '‹' }}</button></div>
        <label class="schema-search"><span>⌕</span><input v-model="schemaFilter" :placeholder="t('searchObjects')"></label>
        <template v-if="isPostgres">
          <div v-if="!visibleDatabases.length && connecting" class="schema-empty">{{ t('loading') }}</div>
          <div v-for="database in visibleDatabases" v-else :key="database.name" class="database-node" :class="{ active: selectedDatabase === database.name }">
            <button :disabled="running" @click="selectDatabase(database.name)"><span>{{ selectedDatabase === database.name ? '⌄' : '›' }}</span><i>DB</i><strong>{{ database.name }}</strong></button>
            <template v-if="selectedDatabase === database.name">
              <div v-if="loadingSchema" class="schema-empty">{{ t('loading') }}</div>
              <div v-else-if="!tables.length" class="schema-empty">{{ t('emptyDatabase') }}</div>
              <div v-for="schema in postgresSchemas" v-else :key="schema.name" class="schema-node" :class="{ active: expandedSchema === schema.name }">
                <button @click="expandedSchema = expandedSchema === schema.name ? '' : schema.name"><span>{{ expandedSchema === schema.name ? '⌄' : '›' }}</span><i>S</i><strong>{{ schema.name }}</strong></button>
                <template v-if="expandedSchema === schema.name">
                  <div v-if="!schema.sections.length" class="schema-empty">{{ t('noMatchingObjects') }}</div>
                  <template v-for="section in schema.sections" v-else :key="section.type">
                    <button class="schema-group" :aria-expanded="!collapsedSections[`${schema.name}:${section.type}`]" @click="toggleSection(`${schema.name}:${section.type}`)"><span>{{ collapsedSections[`${schema.name}:${section.type}`] ? '›' : '⌄' }}</span><strong>{{ section.type === 'table' ? '▦' : '▤' }} {{ section.label }}</strong><small>{{ section.items.length }}</small></button>
                    <div v-for="table in collapsedSections[`${schema.name}:${section.type}`] ? [] : section.items" :key="tableKey(table)" class="schema-table" :class="{ active: activeTableName === tableKey(table) }">
                      <button :title="t('doubleClickPreview')" @dblclick="openTable(table)"><i>{{ table.type === 'view' ? 'V' : 'T' }}</i><strong>{{ table.name }}</strong><small v-if="table.estimatedRows != null">{{ table.estimatedRows }}</small></button>
                    </div>
                  </template>
                </template>
              </div>
            </template>
          </div>
        </template>
        <template v-else>
          <div v-if="loadingSchema" class="schema-empty">{{ t('loading') }}</div>
          <div v-else-if="!selectedDatabase" class="schema-empty">{{ t('chooseDatabase') }}</div>
          <div v-else-if="!tables.length" class="schema-empty">{{ t('emptyDatabase') }}</div>
          <div v-else-if="!tableSections.length" class="schema-empty">{{ t('noMatchingObjects') }}</div>
          <template v-for="section in tableSections" v-else :key="section.type">
            <button class="schema-group" :aria-expanded="!collapsedSections[section.type]" @click="toggleSection(section.type)"><span>{{ collapsedSections[section.type] ? '›' : '⌄' }}</span><strong>{{ section.type === 'table' ? '▦' : '▤' }} {{ section.label }}</strong><small>{{ section.items.length }}</small></button>
            <div v-for="table in collapsedSections[section.type] ? [] : section.items" :key="tableKey(table)" class="schema-table" :class="{ active: activeTableName === tableKey(table) }">
              <button :title="t('doubleClickPreview')" @dblclick="openTable(table)"><i>{{ table.type === 'view' ? 'V' : 'T' }}</i><strong>{{ table.name }}</strong><small v-if="table.estimatedRows != null">{{ table.estimatedRows }}</small></button>
            </div>
          </template>
        </template>
      </aside>
      <div v-if="!schemaCollapsed" class="schema-resizer" role="separator" tabindex="0" aria-orientation="vertical" :aria-valuemin="180" :aria-valuemax="520" :aria-valuenow="Math.round(schemaWidth)" @pointerdown.prevent="startSchemaResize" @pointermove="resizeSchema" @pointerup="stopSchemaResize" @pointercancel="stopSchemaResize" @keydown="resizeSchemaWithKeyboard"></div>
      <main class="sql-workspace">
        <nav class="database-tabs" role="tablist">
          <button role="tab" :aria-selected="workspaceMode === 'home'" :class="{ active: workspaceMode === 'home' }" @click="workspaceMode = 'home'">▦ {{ t('tableList') }}</button>
          <button role="tab" :aria-selected="workspaceMode === 'sql'" :class="{ active: workspaceMode === 'sql' }" @click="openSqlEditor">⌁ {{ t('sqlEditor') }}</button>
          <div v-for="table in openedTables" :key="`data:${tableKey(table)}`" role="presentation" class="database-table-tab" :class="{ active: workspaceMode === 'table' && activeTableName === tableKey(table) }" @contextmenu="showTabContextMenu($event, 'table', table)"><button role="tab" :aria-selected="workspaceMode === 'table' && activeTableName === tableKey(table)" @click="activateTable(table)">▦ {{ isPostgres ? `${table.database}.${table.name}` : table.name }}</button><button class="database-tab-close" :aria-label="t('closeTab')" @click="closeTable(table)">×</button></div>
          <div v-for="table in openedStructures" :key="`structure:${tableKey(table)}`" role="presentation" class="database-table-tab" :class="{ active: workspaceMode === 'structure' && activeTableName === tableKey(table) }" @contextmenu="showTabContextMenu($event, 'structure', table)"><button role="tab" :aria-selected="workspaceMode === 'structure' && activeTableName === tableKey(table)" @click="activateStructure(table)">▤ {{ isPostgres ? `${table.database}.${table.name}` : table.name }}</button><button class="database-tab-close" :aria-label="t('closeTab')" @click="closeStructure(table)">×</button></div>
        </nav>
        <section v-if="workspaceMode === 'home'" class="database-home">
          <div class="database-home-toolbar">
            <button class="toolbar-button icon-only" :title="t('newQuery')" :aria-label="t('newQuery')" @click="openSqlEditor">⌁</button>
            <button class="toolbar-button icon-only" :title="t('refresh')" :aria-label="t('refresh')" :disabled="loadingSchema" @click="refreshSchema">↻</button>
            <strong>{{ t('tableList') }}</strong><small>{{ homeTables.length }}</small>
            <label class="row-filter"><span>⌕</span><input v-model="schemaFilter" :placeholder="t('searchObjects')"></label>
          </div>
          <div v-if="!homeTables.length" class="result-empty">{{ loadingSchema ? t('loading') : t('emptyDatabase') }}</div>
          <div v-else class="database-table-list">
            <button v-for="table in homeTables" :key="tableKey(table)" :title="t('tableData')" @click="openTable(table)"><span>{{ table.type === 'view' ? '▤' : '▦' }}</span><strong>{{ isPostgres ? `${table.database}.${table.name}` : table.name }}</strong><small v-if="table.estimatedRows != null">{{ table.estimatedRows }}</small></button>
          </div>
        </section>
        <section v-show="workspaceMode === 'sql'" class="sql-editor-section">
          <div class="sql-section-toolbar"><span>{{ t('sqlEditor') }}</span><small>{{ t('runShortcut') }}</small><button class="toolbar-button icon-only" :title="running ? t('runningQuery') : t('runQuery')" :aria-label="running ? t('runningQuery') : t('runQuery')" :disabled="!sessionId || running" @click="runEditorQuery">▶</button></div>
          <div ref="editorHost" class="sql-editor-host" @keydown="handleEditorKeydown"></div>
        </section>
        <section v-if="workspaceMode === 'structure' && activeTable" class="table-structure-section">
          <div class="structure-toolbar">
            <button class="toolbar-button icon-only" :title="t('applySchema')" :aria-label="t('applySchema')" disabled>▣</button>
            <span></span>
            <button class="toolbar-button icon-only" :title="t('addRow')" :aria-label="t('addRow')" disabled>＋</button>
            <button class="toolbar-button icon-only" :title="t('remove')" :aria-label="t('remove')" disabled>×</button>
            <button class="toolbar-button icon-only" :title="t('refresh')" :aria-label="t('refresh')" @click="refreshStructure">↻</button>
            <nav class="structure-tabs"><button v-for="section in structureSections" :key="section.key" :class="{ active: structureSection === section.key }" @click="structureSection = section.key">{{ section.label }}</button></nav>
            <button class="toolbar-button icon-only" :title="t('tableData')" :aria-label="t('tableData')" @click="showTableData">▦</button>
          </div>
          <div v-if="structureSection !== 'fields'" class="result-empty">{{ t('schemaDetailsUnavailable') }}</div>
          <div v-else class="structure-content">
            <div class="structure-table-wrap">
              <table class="structure-field-table">
                <thead><tr><th>{{ t('name') }}</th><th>{{ t('type') }}</th><th>{{ t('length') }}</th><th>{{ t('decimals') }}</th><th>{{ t('nullable') }}</th><th>{{ t('primaryKey') }}</th><th>{{ t('comment') }}</th></tr></thead>
                <tbody><tr v-for="column in columnsByTable[activeTableName] || []" :key="column.name" :class="{ selected: selectedStructureColumnName === column.name }" @click="selectedStructureColumnName = column.name"><td>{{ column.name }}</td><td>{{ column.dataType }}</td><td>{{ column.length ?? '' }}</td><td>{{ column.scale ?? '' }}</td><td><input type="checkbox" :checked="column.nullable" disabled></td><td><span class="structure-key" :class="{ primary: column.key === 'PRI' }">◆</span>{{ column.key === 'PRI' ? column.ordinal : '' }}</td><td>{{ column.comment || '' }}</td></tr></tbody>
              </table>
            </div>
            <aside v-if="selectedStructureColumn" class="structure-detail">
              <label><span>{{ t('fields') }}</span><input readonly :value="selectedStructureColumn.name"></label>
              <label><span>{{ t('comment') }}</span><textarea readonly :value="selectedStructureColumn.comment || ''"></textarea></label>
              <fieldset><legend>{{ t('defaultValue') }}</legend><label><input type="radio" :checked="selectedStructureColumn.defaultValue == null" disabled> NULL</label><label><input type="radio" :checked="selectedStructureColumn.defaultValue != null" disabled> {{ t('defaultValue') }}</label></fieldset>
              <label><span>{{ t('defaultValue') }}</span><input readonly :value="displayCell(selectedStructureColumn.defaultValue ?? null)"></label>
              <label><span>{{ t('autoGenerated') }}</span><input readonly :value="selectedStructureColumn.extra || ''"></label>
            </aside>
          </div>
        </section>
        <section v-if="workspaceMode === 'table' || workspaceMode === 'sql'" class="result-section" :class="{ 'table-mode': workspaceMode === 'table' }">
          <div class="result-toolbar">
            <strong>{{ workspaceMode === 'table' && activeTable ? isPostgres ? `${activeTable.database}.${activeTable.name}` : activeTable.name : t('resultGrid') }}</strong>
            <small v-if="workspaceMode !== 'table' || pendingChangeCount">{{ workspaceMode === 'table' ? t('pendingChanges', { count: pendingChangeCount }) : resultSummary }}</small>
            <label v-if="result?.kind === 'rows' && (workspaceMode === 'sql' || filterVisible)" class="row-filter"><span>⌕</span><input v-model="rowFilter" :placeholder="t('filterRows')"></label>
            <button class="toolbar-button muted icon-only" :title="t('refresh')" :aria-label="t('refresh')" :disabled="!result || running || (workspaceMode === 'table' && Boolean(pendingChangeCount))" @click="refreshResult">↻</button>
            <template v-if="workspaceMode === 'table'">
              <button class="toolbar-button icon-only" :title="t('addRow')" :aria-label="t('addRow')" :disabled="!canEditTable || running" @click="addRow">＋</button>
              <button class="toolbar-button icon-only" :title="t('deleteSelectedRows')" :aria-label="t('deleteSelectedRows')" :disabled="!canDeleteSelected || !selectedRowCount || running" @click="deleteSelectedRows">−</button>
              <button class="toolbar-button icon-only" :title="t('saveChanges')" :aria-label="t('saveChanges')" :disabled="!pendingChangeCount || running" @click="saveChanges">◫</button>
              <button class="toolbar-button icon-only" :title="t('discardChanges')" :aria-label="t('discardChanges')" :disabled="!pendingChangeCount || running" @click="discardChanges">↶</button>
              <button class="toolbar-button icon-only" :class="{ active: filterVisible }" :title="t('filterRows')" :aria-label="t('filterRows')" @click="filterVisible = !filterVisible">▽</button>
              <span class="column-picker-wrap"><button class="toolbar-button icon-only" :class="{ active: columnPickerVisible }" :title="t('chooseColumns')" :aria-label="t('chooseColumns')" @click.stop="columnPickerVisible = !columnPickerVisible">☷</button><span v-if="columnPickerVisible && result?.kind === 'rows'" class="column-picker"><label v-for="column in result.columns" :key="column.name"><input type="checkbox" :checked="!hiddenColumns[activeTableName]?.includes(column.name)" @change="toggleColumn(column.name)"><span>{{ column.name }}</span></label></span></span>
              <button class="toolbar-button icon-only" :title="t('importCsv')" :aria-label="t('importCsv')" :disabled="!canEditTable" @click="csvInput?.click()">⇧</button>
              <button class="toolbar-button icon-only" :title="t('exportPage')" :aria-label="t('exportPage')" @click="exportResult">⇩</button>
              <button class="toolbar-button icon-only" :title="t('tableStructure')" :aria-label="t('tableStructure')" @click="showTableStructure">▤</button>
              <button class="toolbar-button icon-only" :title="t('openInSql')" :aria-label="t('openInSql')" @click="openTableSql">⌁</button>
            </template>
            <button v-else-if="result?.kind === 'rows'" class="toolbar-button icon-only" :title="t('exportPage')" :aria-label="t('exportPage')" @click="exportResult">⇩</button>
          </div>
          <div class="result-grid-wrap">
            <div v-if="!result" class="result-empty">{{ t('queryReady') }}</div>
            <div v-else-if="result.kind === 'mutation'" class="mutation-result"><strong>{{ t('queryCompleted') }}</strong><span>{{ t('affectedRows', { count: result.affectedRows, duration: result.durationMs }) }}</span><span v-if="result.insertId">Insert ID: {{ result.insertId }}</span></div>
            <table v-else class="result-grid" :class="{ editable: canEditCells }">
              <thead><tr><th class="row-number">#</th><th v-for="index in visibleColumnIndexes" :key="`${result.columns[index].name}:${index}`" :title="result.columns[index].table" :style="columnStyle(index)"><button :disabled="running || (workspaceMode === 'table' && Boolean(pendingChangeCount))" @click="toggleSort(index)"><span>{{ result.columns[index].name }} <i :class="{ active: sortColumn === index }">{{ sortColumn === index ? (sortDirection === 'asc' ? '↑' : '↓') : '↕' }}</i></span><small v-if="columnDetails(index)" :title="columnDetails(index)">{{ columnDetails(index) }}</small></button><span class="result-column-resizer" role="separator" tabindex="0" aria-orientation="vertical" aria-valuemin="64" aria-valuemax="2000" :aria-valuenow="columnWidths[columnWidthKey(index)]" :aria-label="result.columns[index].name" @pointerdown.prevent.stop="startColumnResize(index, $event)" @pointermove="resizeColumn" @pointerup="stopColumnResize" @pointercancel="stopColumnResize" @keydown="resizeColumnWithKeyboard(index, $event)"></span></th></tr></thead>
              <tbody><tr v-for="(row, rowIndex) in displayRows" :key="`${activeTableName}:${rowIndex}`" :class="{ selected: editableRow(row)?.selected, inserted: editableRow(row) && !editableRow(row)?.original }"><td class="row-number"><button v-if="workspaceMode === 'table' && editableRow(row)" :class="{ active: editableRow(row)?.selected }" :aria-label="t('selectRow')" @click="toggleRowSelection(row)">{{ result.page * result.pageSize + rowIndex + 1 }}</button><template v-else>{{ result.page * result.pageSize + rowIndex + 1 }}</template></td><td v-for="cellIndex in visibleColumnIndexes" :key="cellIndex" :class="{ null: row[cellIndex] == null, selected: selectedCell?.row === row && selectedCell.columnIndex === cellIndex }" :style="columnStyle(cellIndex)" :title="displayCell(row[cellIndex])" @click="updateCellDetail(row, rowIndex, cellIndex, row[cellIndex])" @contextmenu="showCellContextMenu($event, row, rowIndex, cellIndex, row[cellIndex])"><input v-if="canEditCells || (canEditTable && !editableRow(row)?.original)" :value="row[cellIndex] == null ? '' : String(row[cellIndex])" @change="updateCell(row, cellIndex, $event)"><template v-else>{{ displayCell(row[cellIndex]) }}</template></td></tr></tbody>
            </table>
          </div>
          <section v-if="selectedCell && selectedCellDetail" class="cell-detail-panel">
            <header><strong>{{ t('cellDetail') }}</strong><span>{{ selectedCell.columnName }}<template v-if="selectedCell.columnType"> · {{ selectedCell.columnType }}</template></span><b v-if="selectedCellDetail.format === 'json'">JSON</b><small>#{{ selectedCell.rowNumber }}</small><button :aria-label="t('closeView')" @click="closeCellDetail">×</button></header>
            <textarea readonly spellcheck="false" :value="selectedCellDetail.text"></textarea>
          </section>
          <footer v-if="result?.kind === 'rows'" class="result-status">
            <code :title="lastSql">{{ lastSql }}</code><span>{{ resultSummary }}</span>
            <div class="result-pager"><button :disabled="running || result.page === 0" @click="runQuery(result.page - 1, undefined, false)">‹</button><span>{{ t('pageNumber', { page: result.page + 1 }) }}</span><button :disabled="running || !result.hasMore" @click="runQuery(result.page + 1, undefined, false)">›</button></div>
          </footer>
        </section>
      </main>
    </div>
    <input ref="csvInput" class="visually-hidden" type="file" accept=".csv,text/csv" @change="importCsv">
    <div v-if="cellContextMenu" class="database-cell-context-menu" role="menu" :style="{ left: `${cellContextMenu.x}px`, top: `${cellContextMenu.y}px` }" @pointerdown.stop>
      <button role="menuitem" @click="showFullCellData">{{ t('showFullData') }}</button>
    </div>
    <div v-if="tabContextMenu" class="database-cell-context-menu" role="menu" :style="{ left: `${tabContextMenu.x}px`, top: `${tabContextMenu.y}px` }" @pointerdown.stop>
      <button role="menuitem" @click="closeTabFromMenu">{{ t('closeCurrentPage') }}</button>
      <button role="menuitem" @click="closeAllDatabaseTabs">{{ t('closeAllPages') }}</button>
    </div>
  </section>
</template>
