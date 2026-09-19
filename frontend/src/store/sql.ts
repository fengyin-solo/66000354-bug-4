import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface SQLTable {
  name: string
  columns: { name: string; type: string; pk?: boolean; fk?: string }[]
  rowCount: number
}

export interface QueryPlan {
  operation: string
  table?: string
  cost: number
  rows: number
  children: QueryPlan[]
  index?: string
  filter?: string
  error?: string
}

export interface SQLJoin {
  /** 原始写法归一化后的连接类型：INNER / LEFT / RIGHT / FULL / CROSS */
  type: string
  /** 被连接的表名 */
  table: string
  /** 表别名（若有） */
  alias?: string
  /** ON 连接条件原文 */
  condition: string
  /** 该连接段存在的问题（缺条件 / 表不存在 / 条件引用非法等） */
  error?: string
}

export interface ParsedQuery {
  type: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE' | 'UNKNOWN'
  tables: string[]
  columns: string[]
  baseTable?: string
  joins: SQLJoin[]
  whereConditions: string[]
  orderBy: string[]
  groupBy: string[]
  limit?: number
  hasSubquery: boolean
  /** 连接写错或指向不存在的表等结构性问题 */
  errors: string[]
  complexity: number
  suggestions: string[]
  estimatedCost: number
}

const SCHEMA: SQLTable[] = [
  { name: 'users', rowCount: 50000, columns: [
    { name: 'id', type: 'INT', pk: true }, { name: 'username', type: 'VARCHAR(50)' },
    { name: 'email', type: 'VARCHAR(100)' }, { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'status', type: 'ENUM' }
  ]},
  { name: 'orders', rowCount: 200000, columns: [
    { name: 'id', type: 'INT', pk: true }, { name: 'user_id', type: 'INT', fk: 'users.id' },
    { name: 'product_id', type: 'INT', fk: 'products.id' }, { name: 'amount', type: 'DECIMAL' },
    { name: 'status', type: 'VARCHAR(20)' }, { name: 'created_at', type: 'TIMESTAMP' }
  ]},
  { name: 'products', rowCount: 10000, columns: [
    { name: 'id', type: 'INT', pk: true }, { name: 'name', type: 'VARCHAR(200)' },
    { name: 'price', type: 'DECIMAL' }, { name: 'category_id', type: 'INT', fk: 'categories.id' },
    { name: 'stock', type: 'INT' }
  ]},
  { name: 'categories', rowCount: 100, columns: [
    { name: 'id', type: 'INT', pk: true }, { name: 'name', type: 'VARCHAR(50)' },
    { name: 'parent_id', type: 'INT' }
  ]},
]

const JOIN_TYPE_RE = 'INNER|LEFT(?:\\s+OUTER)?|RIGHT(?:\\s+OUTER)?|FULL(?:\\s+OUTER)?|CROSS'
const JOIN_START_RE = new RegExp(
  `\\b(?:(${JOIN_TYPE_RE})\\s+)?JOIN\\s+` +
  `([a-zA-Z_]\\w*)` +
  `(?:\\s+(?:AS\\s+)?(?!(?:ON|WHERE|GROUP|ORDER|LIMIT|HAVING|UNION|INNER|LEFT|RIGHT|FULL|CROSS|JOIN)\\b)([a-zA-Z_]\\w*))?`,
  'i'
)
const JOIN_GLOBAL_RE = new RegExp(
  `\\b(?:(${JOIN_TYPE_RE})\\s+)?JOIN\\s+` +
  `([a-zA-Z_]\\w*)` +
  `(?:\\s+(?:AS\\s+)?(?!(?:ON|WHERE|GROUP|ORDER|LIMIT|HAVING|UNION|INNER|LEFT|RIGHT|FULL|CROSS|JOIN)\\b)([a-zA-Z_]\\w*))?` +
  `\\s*(?:ON\\s+([\\s\\S]*?))?` +
  `(?=\\s+(?:${JOIN_TYPE_RE})?\\s*JOIN\\b|\\s+(?:WHERE|GROUP|ORDER|LIMIT|HAVING|UNION)\\b|;|$)`,
  'gi'
)

function normalizeJoinType(raw?: string): string {
  if (!raw) return 'INNER'
  const t = raw.toUpperCase().replace(/\s+/g, ' ')
  if (t.startsWith('LEFT')) return 'LEFT'
  if (t.startsWith('RIGHT')) return 'RIGHT'
  if (t.startsWith('FULL')) return 'FULL'
  if (t === 'CROSS') return 'CROSS'
  return 'INNER'
}

function parseSQL(sql: string): ParsedQuery {
  const up = sql.toUpperCase().trim()
  const type = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE'].find(t => up.startsWith(t)) as ParsedQuery['type'] || 'UNKNOWN'
  const tables = Array.from(sql.matchAll(/(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z_]\w*)/gi)).map(m => m[1].toLowerCase())
  const columns = type === 'SELECT' ? Array.from(sql.matchAll(/SELECT\s+([\s\S]*?)\s+FROM/gi))[0]?.[1]?.split(',').map((s: string) => s.trim()) || [] : []

  // 主表（FROM 后的第一张表）及其别名
  const fromMatch = sql.match(
    /\bFROM\s+([a-zA-Z_]\w*)(?:\s+(?:AS\s+)?(?!(?:WHERE|GROUP|ORDER|LIMIT|HAVING|JOIN|INNER|LEFT|RIGHT|FULL|CROSS)\b)([a-zA-Z_]\w*))?/i
  )
  const baseTable = fromMatch?.[1]?.toLowerCase() || tables[0]
  const baseAlias = fromMatch?.[2]?.toLowerCase()

  // 逐个解析连接段：类型、被连接的表、别名、ON 条件
  const joins: SQLJoin[] = Array.from(sql.matchAll(JOIN_GLOBAL_RE)).map(m => ({
    type: normalizeJoinType(m[1]),
    table: m[2].toLowerCase(),
    alias: m[3]?.toLowerCase() || undefined,
    condition: (m[4] || '').trim().replace(/\s+/g, ' '),
  }))

  // 有 JOIN 关键字却没能解析出完整连接段（表名缺失 / ON 悬挂），显式报错，绝不静默按单表处理
  const joinKeywordCount = (sql.match(/\bJOIN\b/gi) || []).length
  if (joinKeywordCount > joins.length) {
    const bad = sql.match(new RegExp(`(?:(?:${JOIN_TYPE_RE})\\s+)?JOIN\\b[^;]*`, 'i'))
    joins.push({
      type: 'UNKNOWN',
      table: '?',
      condition: '',
      error: `无法解析的连接片段「${(bad?.[0] || 'JOIN ...').trim().slice(0, 60)}」：JOIN 后缺少被连接的表，或 ON 子句不完整`,
    })
  }

  // 别名/表名 -> 实际表名，用于校验连接条件引用
  const aliasToTable: Record<string, string> = {}
  if (baseTable) {
    aliasToTable[baseTable] = baseTable
    if (baseAlias) aliasToTable[baseAlias] = baseTable
  }
  joins.forEach(j => { if (j.table !== '?') aliasToTable[j.table] = j.table })
  joins.forEach(j => { if (j.alias) aliasToTable[j.alias] = j.table })

  const schemaByName = new Map(SCHEMA.map(s => [s.name, s]))
  const errors: string[] = []

  joins.forEach((j, i) => {
    if (j.type === 'UNKNOWN') { errors.push(j.error!); return }
    const segment = `${j.type} JOIN ${j.table}${j.alias ? ' ' + j.alias : ''}${j.condition ? ' ON ' + j.condition : ''}`
    const where = `第 ${i + 1} 个连接段「${segment.length > 60 ? segment.slice(0, 60) + '…' : segment}」`

    if (j.table !== '?' && !schemaByName.has(j.table)) {
      j.error = `${where} 指向的表 "${j.table}" 在当前 Schema 中不存在`
    } else if (j.type !== 'CROSS' && !j.condition) {
      j.error = `${where} 缺少 ON 连接条件（${j.type} JOIN 必须给出连接条件）`
    } else if (j.condition) {
      for (const ref of j.condition.matchAll(/\b([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)\b/g)) {
        const [, qualifier, column] = ref
        const targetTable = aliasToTable[qualifier.toLowerCase()]
        if (!targetTable) {
          j.error = `${where} 的连接条件 "${j.condition}" 引用了不存在的表或别名 "${qualifier}"`
          break
        }
        const target = schemaByName.get(targetTable)
        if (target && !target.columns.some(c => c.name === column)) {
          j.error = `${where} 的连接条件引用了表 ${targetTable} 中不存在的列 "${column}"`
          break
        }
      }
    }
    if (j.error) errors.push(j.error)
  })

  const whereMatch = sql.match(/WHERE\s+([\s\S]*?)(?:GROUP|ORDER|LIMIT|$)/i)
  const whereConditions = whereMatch ? whereMatch[1].split(/\s+AND\s+|\s+OR\s+/i).map(s => s.trim()).filter(Boolean) : []
  const orderBy = Array.from(sql.matchAll(/ORDER\s+BY\s+([\s\S]*?)(?:LIMIT|$)/gi))[0]?.[1]?.split(',').map((s: string) => s.trim()) || []
  const groupBy = Array.from(sql.matchAll(/GROUP\s+BY\s+([\s\S]*?)(?:HAVING|ORDER|LIMIT|$)/gi))[0]?.[1]?.split(',').map((s: string) => s.trim()) || []
  const limitMatch = sql.match(/LIMIT\s+(\d+)/i)
  const limit = limitMatch ? parseInt(limitMatch[1]) : undefined
  const hasSubquery = /\(\s*SELECT\b/i.test(sql)

  // 复杂度、成本与建议全部以解析出的连接为准（含写错的连接，不会塌回单表档）
  const complexity = tables.length + joins.length * 2 + whereConditions.length + orderBy.length + (sql.includes('DISTINCT') ? 3 : 0) + (sql.includes('HAVING') ? 2 : 0)
  const estimatedCost = tables.reduce((sum, t) => { const tbl = SCHEMA.find(s => s.name === t); return sum + (tbl?.rowCount || 1000) }, 0) * (joins.length + 1) / (limit || 100)

  const suggestions: string[] = []
  if (joins.length > 3) suggestions.push(`连接表过多（${joins.length} 个连接，>3），考虑分解查询`)
  if (!whereConditions.length && type === 'SELECT') suggestions.push('无 WHERE 条件，将扫描全表')
  if (sql.includes('SELECT *')) suggestions.push('避免 SELECT *，明确指定列名')
  if (sql.toUpperCase().includes("LIKE '%")) suggestions.push("前缀通配符 LIKE '%...' 无法使用索引")
  if (!limit && type === 'SELECT') suggestions.push('建议添加 LIMIT 限制结果集大小')

  return { type, tables, columns, baseTable, joins, whereConditions, orderBy, groupBy, limit, hasSubquery, errors, complexity, suggestions, estimatedCost: Math.round(estimatedCost) }
}

function buildScan(table: string, parsed: ParsedQuery): QueryPlan {
  const tbl = SCHEMA.find(s => s.name === table)
  const rows = tbl?.rowCount || 1000
  const useIndex = parsed.whereConditions.length > 0
  return {
    operation: useIndex ? 'Index Scan' : 'Seq Scan',
    table,
    cost: rows * 0.01,
    rows: Math.round(rows * (useIndex ? 0.1 : 1)),
    children: [],
    index: useIndex ? 'idx_' + table + '_id' : undefined,
  }
}

function joinOperation(j: SQLJoin): string {
  switch (j.type) {
    case 'LEFT': return 'Hash Left Join'
    case 'RIGHT': return 'Hash Right Join'
    case 'FULL': return 'Hash Full Join'
    case 'CROSS': return 'Nested Loop (Cross Join)'
    default: return 'Hash Join'
  }
}

function buildPlan(parsed: ParsedQuery): QueryPlan {
  if (parsed.tables.length === 0) return { operation: 'EMPTY', cost: 0, rows: 0, children: [] }

  const scans: Record<string, QueryPlan> = {}
  parsed.tables.forEach(t => { scans[t] = buildScan(t, parsed) })

  // 子查询：外层表 + Subquery Scan，由 Subquery Filter 关联（不算 JOIN 连接）
  if (parsed.hasSubquery && parsed.joins.length === 0) {
    const outer = parsed.baseTable ? scans[parsed.baseTable] : undefined
    const innerTables = parsed.tables.filter(t => t !== parsed.baseTable)
    const children: QueryPlan[] = [
      ...(outer ? [outer] : []),
      ...innerTables.map(t => ({ ...buildScan(t, parsed), operation: 'Subquery Scan' })),
    ]
    const filter: QueryPlan = {
      operation: 'Subquery Filter',
      cost: children.reduce((s, n) => s + n.cost, 0) * 1.3,
      rows: outer ? outer.rows : children[0]?.rows || 0,
      children,
    }
    return { operation: 'Sort', cost: filter.cost * 1.2, rows: filter.rows, children: [filter] }
  }

  // 单表：呈现保持原样（Sort -> Scan）
  if (parsed.joins.length === 0 || !parsed.baseTable) {
    const only = scans[parsed.baseTable || parsed.tables[0]]
    return { operation: 'Sort', cost: only.cost * 1.2, rows: only.rows, children: [only] }
  }

  // 多表：按解析出的连接逐段搭建计划节点，类型/条件/错误都挂在对应连接节点上
  let root: QueryPlan = scans[parsed.baseTable]
  parsed.joins.forEach(j => {
    if (j.table === '?') {
      root = {
        operation: 'INVALID JOIN',
        cost: root.cost * 1.5,
        rows: root.rows,
        children: [root],
        filter: undefined,
        error: j.error,
      }
      return
    }
    const right = scans[j.table] || buildScan(j.table, parsed)
    const joinNode: QueryPlan = {
      operation: joinOperation(j),
      cost: (root.cost + right.cost) * 1.5,
      rows: Math.round(Math.max(root.rows, right.rows) * 0.3),
      children: [root, right],
      filter: j.condition || undefined,
      error: j.error,
    }
    root = joinNode
  })

  return { operation: parsed.orderBy.length ? 'Sort' : 'Result', cost: root.cost * 1.1, rows: root.rows, children: [root] }
}

export const SQL_TEMPLATES = [
  { name: '基础查询', sql: `SELECT id, username, email
FROM users
WHERE status = 'active'
LIMIT 100;` },
  { name: '多表JOIN', sql: `SELECT u.username, o.id AS order_id, p.name AS product, o.amount
FROM users u
INNER JOIN orders o ON u.id = o.user_id
INNER JOIN products p ON o.product_id = p.id
WHERE o.status = 'completed'
ORDER BY o.created_at DESC
LIMIT 50;` },
  { name: '聚合分析', sql: `SELECT c.name AS category, COUNT(o.id) AS order_count, SUM(o.amount) AS revenue, AVG(o.amount) AS avg_amount
FROM categories c
LEFT JOIN products p ON c.id = p.category_id
LEFT JOIN orders o ON p.id = o.product_id
GROUP BY c.id, c.name
HAVING COUNT(o.id) > 10
ORDER BY revenue DESC;` },
  { name: '子查询', sql: `SELECT username, email
FROM users
WHERE id IN (
  SELECT DISTINCT user_id
  FROM orders
  WHERE amount > 1000
  AND created_at >= '2024-01-01'
)
ORDER BY username;` },
  { name: '全表扫描', sql: `SELECT *
FROM orders
WHERE YEAR(created_at) = 2024;` },
]

export const SCHEMA_TABLES = SCHEMA

export const useSQLStore = defineStore('sql', () => {
  const sql = ref(SQL_TEMPLATES[0].sql)
  const parsed = ref<ParsedQuery | null>(null)
  const plan = ref<QueryPlan | null>(null)
  const activeSchema = ref<SQLTable | null>(null)

  function analyze() {
    parsed.value = parseSQL(sql.value)
    plan.value = buildPlan(parsed.value)
  }

  const complexityLabel = computed(() => {
    const c = parsed.value?.complexity || 0
    if (c <= 2) return { label: '简单', color: 'text-green-400' }
    if (c <= 5) return { label: '中等', color: 'text-yellow-400' }
    if (c <= 8) return { label: '复杂', color: 'text-orange-400' }
    return { label: '非常复杂', color: 'text-red-400' }
  })

  return { sql, parsed, plan, activeSchema, complexityLabel, analyze }
})
