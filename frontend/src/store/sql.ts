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
  joinType?: string
  invalid?: boolean
}

export interface ParsedJoin {
  type: string
  table: string
  alias?: string
  condition: string
  from?: string
  valid: boolean
}

export interface ParseError {
  segment: string
  message: string
}

export interface ParsedQuery {
  type: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE' | 'UNKNOWN'
  tables: string[]
  columns: string[]
  joins: ParsedJoin[]
  errors: ParseError[]
  whereConditions: string[]
  orderBy: string[]
  groupBy: string[]
  limit?: number
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

const IDENT = '[`"]?[a-zA-Z_]\\w*[`"]?'
const TERMINATOR_RE = /\b(?:WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|UNION|RETURNING)\b/i
const JOIN_RE = /(NATURAL\s+)?(?:(LEFT|RIGHT|FULL)(?:\s+OUTER)?|INNER|OUTER|CROSS)?\s+JOIN\b/gi

/** 屏蔽字符串字面量与注释，保证关键字识别只在真实 SQL 代码上进行（位置保持不变） */
function maskLiterals(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|--[^\n]*|\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
}

/** 计算每个位置的括号深度（深度 > 0 即位于子查询内） */
function depthAt(sql: string, index: number): number {
  let depth = 0
  for (let i = 0; i < index; i++) {
    if (sql[i] === '(') depth++
    else if (sql[i] === ')') depth = Math.max(0, depth - 1)
  }
  return depth
}

function unquote(name: string): string {
  return name.replace(/[`"]/g, '').toLowerCase()
}

function truncate(s: string, n = 40): string {
  const t = s.trim().replace(/\s+/g, ' ')
  return t.length > n ? t.slice(0, n) + '…' : t
}

interface TableRef { name: string; alias?: string }

/** 解析 FROM 之后、终止关键字之前的顶层表引用链（含全部 JOIN）。orig 与 masked 等长，按同一偏移取文本 */
function parseTableChain(orig: string, masked: string, schemaNames: string[], errors: ParseError[]): { base?: TableRef; joins: ParsedJoin[]; hasCommaJoin: boolean } {
  const joins: ParsedJoin[] = []
  let hasCommaJoin = false

  const firstKw = masked.search(TERMINATOR_RE)
  const end = firstKw >= 0 ? firstKw : masked.length
  const chain = masked.slice(0, end)
  const origChain = orig.slice(0, end)
  if (!chain.trim()) return { joins, hasCommaJoin }

  // 顶层逗号分隔：FROM a, b —— 隐式交叉连接
  const commaParts = chain.split(',').map(s => s.trim()).filter(Boolean)
  const head = commaParts.shift()!
  if (commaParts.length) hasCommaJoin = true

  const RESERVED = /^(ON|USING|WHERE|GROUP|HAVING|ORDER|LIMIT|UNION|JOIN|LEFT|RIGHT|FULL|INNER|OUTER|CROSS|NATURAL)$/i
  const readRef = (text: string, pos: number): { ref?: TableRef; next: number } => {
    const m = text.slice(pos).match(new RegExp(`^\\s*(?:${IDENT}\\s*\\.\\s*)?(${IDENT})`))
    if (!m) return { next: pos }
    const rawName = m[1]
    // ON / USING 等关键字紧跟 JOIN，说明缺失表名
    if (/^(ON|USING)$/i.test(rawName)) return { next: pos }
    const name = unquote(rawName)
    let next = pos + m[0].length
    let alias: string | undefined
    const aliasM = text.slice(next).match(new RegExp(`^\\s+(?:AS\\s+)?(${IDENT})\\b`))
    if (aliasM && !RESERVED.test(aliasM[1])) {
      alias = unquote(aliasM[1])
      next += aliasM[0].length
    }
    return { ref: { name, alias }, next }
  }

  const headParsed = readRef(chain, 0)
  let prev: TableRef | undefined = headParsed.ref
  if (prev && !schemaNames.includes(prev.name)) {
    errors.push({ segment: `FROM ${prev.name}`, message: `FROM 子句中的表 "${prev.name}" 在当前 Schema 中不存在` })
  }
  for (const part of commaParts) {
    const { ref } = readRef(part, 0)
    if (!ref) continue
    if (!schemaNames.includes(ref.name)) {
      errors.push({ segment: `FROM …, ${ref.name}`, message: `逗号连接的表 "${ref.name}" 在当前 Schema 中不存在` })
    }
    joins.push({ type: 'CROSS JOIN', table: ref.name, alias: ref.alias, condition: '', from: prev?.name, valid: schemaNames.includes(ref.name) })
    prev = ref
  }

  const joinTypeLabel = (jm: RegExpExecArray): string => {
    if (jm[2]) return (jm[1] ? 'NATURAL ' : '') + jm[2].toUpperCase() + ' JOIN'
    if (/CROSS/i.test(jm[0])) return 'CROSS JOIN'
    const word = jm[0].replace(/\s*JOIN\s*$/i, '').replace(/NATURAL/i, '').trim().toUpperCase()
    return (jm[1] ? 'NATURAL ' : '') + (word || 'INNER') + ' JOIN'
  }

  JOIN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = JOIN_RE.exec(chain))) {
    const afterJoin = JOIN_RE.lastIndex
    const { ref, next } = readRef(chain, afterJoin)
    const rawSegment = origChain.slice(m.index, next)

    if (!ref) {
      errors.push({ segment: truncate(rawSegment || m[0]), message: 'JOIN 后缺少被连接的表名' })
      JOIN_RE.lastIndex = afterJoin
      continue
    }

    const type = joinTypeLabel(m)
    const tail = chain.slice(next)
    const usingM = tail.match(/^\s+USING\s*\(\s*([^)]*?)\s*\)/i)
    // ON 后必须有实际条件；USING 子句不能被 ON 懒匹配吞掉
    const onM = usingM ? null : tail.match(/^\s+ON\s+([\s\S]*?)(?=\s+(?:NATURAL\s+)?(?:(?:LEFT|RIGHT|FULL)(?:\s+OUTER)?|INNER|OUTER|CROSS)?\s*JOIN\b|\s*$)/i)

    let condition = ''
    let valid = schemaNames.includes(ref.name)

    if (usingM) {
      condition = `USING (${usingM[1].trim()})`
    } else if (/CROSS/i.test(m[0]) && !(onM && onM[1].trim())) {
      condition = ''
    } else if (!onM || !onM[1].trim()) {
      valid = false
      errors.push({ segment: truncate(rawSegment), message: `${type} "${ref.name}" 缺少 ON 连接条件` })
    } else {
      const condStart = next + onM.index! + onM[0].lastIndexOf(onM[1])
      condition = origChain.slice(condStart, condStart + onM[1].length).trim().replace(/\s+/g, ' ')
    }

    if (!schemaNames.includes(ref.name)) {
      errors.push({ segment: truncate(rawSegment), message: `${type} 指向的表 "${ref.name}" 在当前 Schema 中不存在` })
    }

    joins.push({ type, table: ref.name, alias: ref.alias, condition, from: prev?.name, valid })
    prev = ref
    JOIN_RE.lastIndex = next
  }

  return { base: headParsed.ref, joins, hasCommaJoin }
}

function splitConditions(clause: string): string[] {
  const parts: string[] = []
  let depth = 0, start = 0
  for (let i = 0; i < clause.length; i++) {
    if (clause[i] === '(') depth++
    else if (clause[i] === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0) {
      const kw = clause[i] === 'A' ? 'AND' : clause[i] === 'O' ? 'OR' : null
      if (kw && /\s$/.test(clause[i - 1] || ' ') && new RegExp(`^${kw}\\s`, 'i').test(clause.slice(i))) {
        parts.push(clause.slice(start, i).trim())
        start = i + kw.length
        i += kw.length - 1
      }
    }
  }
  const tail = clause.slice(start).trim().replace(/;+\s*$/, '').trim()
  if (tail) parts.push(tail)
  return parts.filter(Boolean)
}

function parseSQL(sql: string): ParsedQuery {
  const masked = maskLiterals(sql)
  const up = masked.toUpperCase().trim()
  const type = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE'].find(t => up.startsWith(t)) as ParsedQuery['type'] || 'UNKNOWN'

  const errors: ParseError[] = []
  const schemaNames = SCHEMA.map(s => s.name)

  // 仅提取顶层 FROM（深度 0），子查询内的表不计入外层表与连接
  let baseTable: TableRef | undefined
  let joins: ParsedJoin[] = []
  let hasCommaJoin = false
  const fromM = masked.match(/\bFROM\b/i)
  if (fromM && depthAt(masked, fromM.index!) === 0) {
    const bodyOrig = sql.slice(fromM.index! + 4)
    const bodyMasked = masked.slice(fromM.index! + 4)
    const chain = parseTableChain(bodyOrig, bodyMasked, schemaNames, errors)
    baseTable = chain.base
    joins = chain.joins
    hasCommaJoin = chain.hasCommaJoin
  }
  // UPDATE/INSERT ... INTO 的目标表
  if (!baseTable) {
    const targetM = masked.match(/\b(?:UPDATE|INTO)\s+([a-zA-Z_]\w*)/i)
    if (targetM && depthAt(masked, targetM.index!) === 0) {
      const name = targetM[1].toLowerCase()
      baseTable = { name }
      if (!schemaNames.includes(name)) {
        errors.push({ segment: truncate(targetM[0]), message: `目标表 "${name}" 在当前 Schema 中不存在` })
      }
    }
  }

  const tables = baseTable ? [baseTable.name, ...joins.map(j => j.table)] : []

  const columns = type === 'SELECT'
    ? Array.from(sql.matchAll(/SELECT\s+([\s\S]*?)\s+FROM/gi))[0]?.[1]?.split(',').map((s: string) => s.trim()) || []
    : []
  const whereMatch = sql.match(/WHERE\s+([\s\S]*?)(?:\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|\s*$)/i)
  const whereConditions = whereMatch ? splitConditions(whereMatch[1]) : []
  const orderBy = Array.from(sql.matchAll(/ORDER\s+BY\s+([\s\S]*?)(?:LIMIT|$)/gi))[0]?.[1]?.split(',').map((s: string) => s.trim()) || []
  const groupBy = Array.from(sql.matchAll(/GROUP\s+BY\s+([\s\S]*?)(?:HAVING|ORDER|LIMIT|$)/gi))[0]?.[1]?.split(',').map((s: string) => s.trim()) || []
  const limitMatch = sql.match(/LIMIT\s+(\d+)/i)
  const limit = limitMatch ? parseInt(limitMatch[1]) : undefined

  const badJoins = joins.filter(j => !j.valid).length
  const complexity = tables.length + joins.length * 2 + whereConditions.length + orderBy.length
    + (masked.toUpperCase().includes('DISTINCT') ? 3 : 0) + (masked.toUpperCase().includes('HAVING') ? 2 : 0)
    + badJoins * 2
  const estimatedCost = tables.reduce((sum, t) => { const tbl = SCHEMA.find(s => s.name === t); return sum + (tbl?.rowCount || 1000) }, 0) * (joins.length + 1) / (limit || 100)

  const suggestions: string[] = []
  if (joins.length > 3) suggestions.push(`连接表过多（${joins.length} 个 JOIN，>3），考虑分解查询`)
  if (hasCommaJoin) suggestions.push('检测到逗号隐式连接，建议改写为显式 JOIN ... ON 并补充连接条件')
  if (joins.some(j => j.condition && !j.condition.startsWith('USING') && !/(?<![<>!])=(?!=)/.test(j.condition))) {
    suggestions.push('存在非等值连接条件，可能无法使用索引且结果集膨胀')
  }
  if (!whereConditions.length && type === 'SELECT' && tables.length) suggestions.push('无 WHERE 条件，将扫描全表')
  if (sql.includes('SELECT *')) suggestions.push('避免 SELECT *，明确指定列名')
  if (sql.toUpperCase().includes("LIKE '%")) suggestions.push("前缀通配符 LIKE '%...' 无法使用索引")
  if (!limit && type === 'SELECT' && tables.length) suggestions.push('建议添加 LIMIT 限制结果集大小')

  return { type, tables, columns, joins, errors, whereConditions, orderBy, groupBy, limit, complexity, suggestions, estimatedCost: Math.round(estimatedCost) }
}

function scanNode(table: string, parsed: ParsedQuery): QueryPlan {
  const tbl = SCHEMA.find(s => s.name === table)
  const known = !!tbl
  const rowCount = tbl?.rowCount || 1000
  const useIndex = parsed.whereConditions.length > 0
  return {
    operation: useIndex ? 'Index Scan' : 'Seq Scan',
    table,
    cost: rowCount * 0.01,
    rows: Math.round(rowCount * (useIndex ? 0.1 : 1)),
    children: [],
    index: useIndex ? 'idx_' + table + '_id' : undefined,
    invalid: !known,
  }
}

function buildPlan(parsed: ParsedQuery): QueryPlan {
  if (parsed.tables.length === 0) return { operation: 'EMPTY', cost: 0, rows: 0, children: [] }

  const baseTable = parsed.tables[0]
  let root: QueryPlan = scanNode(baseTable, parsed)

  // 单表语句保持原有的 Sort → Scan 两层结构
  if (parsed.joins.length === 0) {
    return { operation: 'Sort', cost: root.cost * 1.2, rows: root.rows, children: [root], invalid: root.invalid }
  }

  // 严格按解析出的连接链逐层嵌套连接节点
  parsed.joins.forEach(j => {
    const right = scanNode(j.table, parsed)
    const isCross = /CROSS/i.test(j.type)
    const joinOp = isCross ? 'Nested Loop Join' : 'Hash Join'
    const joinNode: QueryPlan = {
      operation: joinOp,
      cost: (root.cost + right.cost) * 1.5,
      rows: isCross ? root.rows * right.rows : Math.round(root.rows * 0.5),
      children: [root, right],
      joinType: j.type,
      filter: j.condition || undefined,
      invalid: !j.valid,
    }
    root = joinNode
  })

  const top: QueryPlan = {
    operation: parsed.orderBy.length ? 'Sort' : 'Result',
    cost: root.cost * 1.1,
    rows: root.rows,
    children: [root],
  }
  return top
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
