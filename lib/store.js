/**
 * 插件本地数据模型: 归一化后的用量/费用行 + 区间聚合。
 *
 * 存储里刻意使用短字段名 (一条历史行 ≈ 40 字节, 十年数据也只有几百 KB):
 *   日用量   { d, m, k, t, n }          日期 / 模型 / API Key 名 / 类型 / 数量
 *   日费用   { d, m, k, c, u }          日期 / 模型 / API Key 名 / 费用 / 币种
 *   时用量   { d, h, m, k, t, n }       再加小时 0-23
 *   时费用   { d, h, m, k, c, u }
 *
 * 行按复合主键去重 (同一窗口重跑是幂等的), 平台删除久远数据也不会抹掉本地历史。
 * 本模块是纯函数, 不碰 KV / HTTP。
 */

import { TYPE_LABELS, TOKEN_TYPES } from './platform.js'

export const SCHEMA_VERSION = 1

/** 默认自动同步间隔 (分钟)。 */
export const DEFAULT_AUTO_SYNC_MINUTES = 30
/** 面板提供的自动同步选项; 0 表示关闭。 */
export const AUTO_SYNC_CHOICES = [0, 15, 30, 60, 180]
/** 自动同步间隔上限 (分钟)。 */
export const MAX_AUTO_SYNC_MINUTES = 24 * 60

/** 规范化自动同步间隔: 数字、取整、夹到 [0, 1440]。 */
export function normalizeAutoSyncMinutes(raw, fallback = DEFAULT_AUTO_SYNC_MINUTES) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_AUTO_SYNC_MINUTES, Math.max(0, Math.round(n)))
}

const TOKEN_TYPE_SET = new Set(TOKEN_TYPES)

/** 空文档。 */
export function createDoc() {
  return {
    schema: SCHEMA_VERSION,
    token: null,
    meta: {
      lastSyncAt: null,
      lastSyncStatus: 'never',
      lastSyncMessage: null,
      accountKeys: [],
      earliest: null,
      latest: null,
      summary: null,
      /** 自动同步间隔 (分钟), 0 = 关闭。 */
      autoSyncMinutes: DEFAULT_AUTO_SYNC_MINUTES,
    },
    daily: new Map(),
    dailyCost: new Map(),
    hourly: new Map(),
    hourlyCost: new Map(),
  }
}

// ---------------------------------------------------------------------------
// 主键
// ---------------------------------------------------------------------------

const dailyKey = (row) => `${row.d}|${row.m}|${row.k}|${row.t}`
const dailyCostKey = (row) => `${row.d}|${row.m}|${row.k}|${row.u}`
const hourlyKey = (row) => `${row.d}|${row.h}|${row.m}|${row.k}|${row.t}`
const hourlyCostKey = (row) => `${row.d}|${row.h}|${row.m}|${row.k}|${row.u}`

function isRow(row, extra) {
  return row !== null && typeof row === 'object'
    && typeof row.d === 'string' && row.d.length === 10
    && ['m', 'k'].every((field) => typeof row[field] === 'string')
    && extra.every((field) => Number.isFinite(row[field]))
}

/** 把归一化行合并进文档 (同主键覆盖)。返回写入行数。 */
export function mergeRows(doc, kind, rows) {
  const table = tableOf(doc, kind)
  if (!table) throw new Error(`unknown row kind: ${kind}`)
  const keyOf = keyOfKind(kind)
  const extra = kind === 'daily' || kind === 'hourly' ? ['n'] : ['c']
  let written = 0
  for (const row of rows ?? []) {
    if (!isRow(row, extra)) continue
    table.set(keyOf(row), row)
    written += 1
  }
  if (written > 0) refreshMeta(doc)
  return written
}

function tableOf(doc, kind) {
  switch (kind) {
    case 'daily': return doc.daily
    case 'dailyCost': return doc.dailyCost
    case 'hourly': return doc.hourly
    case 'hourlyCost': return doc.hourlyCost
    default: return null
  }
}

function keyOfKind(kind) {
  switch (kind) {
    case 'daily': return dailyKey
    case 'dailyCost': return dailyCostKey
    case 'hourly': return hourlyKey
    case 'hourlyCost': return hourlyCostKey
    default: return null
  }
}

/** 重新计算 earliest / latest。 */
export function refreshMeta(doc) {
  let earliest = null
  let latest = null
  for (const table of [doc.daily, doc.hourly]) {
    for (const row of table.values()) {
      if (earliest === null || row.d < earliest) earliest = row.d
      if (latest === null || row.d > latest) latest = row.d
    }
  }
  doc.meta.earliest = earliest
  doc.meta.latest = latest
}

/** 清空所有数据行 (凭证与汇总保留)。 */
export function clearRows(doc) {
  const counts = {
    daily: doc.daily.size,
    dailyCost: doc.dailyCost.size,
    hourly: doc.hourly.size,
    hourlyCost: doc.hourlyCost.size,
  }
  doc.daily.clear()
  doc.dailyCost.clear()
  doc.hourly.clear()
  doc.hourlyCost.clear()
  doc.meta.earliest = null
  doc.meta.latest = null
  doc.meta.summary = null
  doc.meta.accountKeys = []
  return counts
}

// ---------------------------------------------------------------------------
// 序列化 (KV 里只存 JSON 安全的形状)
// ---------------------------------------------------------------------------

/** @returns {{schema:number, token:object|null, meta:object, daily:object[], dailyCost:object[], hourly:object[], hourlyCost:object[]}} */
export function serializeDoc(doc) {
  return {
    schema: SCHEMA_VERSION,
    token: doc.token,
    meta: doc.meta,
    daily: [...doc.daily.values()],
    dailyCost: [...doc.dailyCost.values()],
    hourly: [...doc.hourly.values()],
    hourlyCost: [...doc.hourlyCost.values()],
  }
}

/** 从磁盘形状恢复; 任何坏数据都只会被丢弃, 不会抛错。 */
export function hydrateDoc(raw) {
  const doc = createDoc()
  if (!raw || typeof raw !== 'object') return doc
  if (typeof raw.token?.value === 'string' && raw.token.value.trim()) {
    doc.token = {
      value: raw.token.value.trim(),
      savedAt: Number.isFinite(raw.token.savedAt) ? raw.token.savedAt : null,
      source: raw.token.source === 'file' ? 'file' : 'paste',
    }
  }
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {}
  doc.meta.lastSyncAt = Number.isFinite(meta.lastSyncAt) ? meta.lastSyncAt : null
  doc.meta.lastSyncStatus = typeof meta.lastSyncStatus === 'string' ? meta.lastSyncStatus : 'never'
  doc.meta.lastSyncMessage = typeof meta.lastSyncMessage === 'string' ? meta.lastSyncMessage : null
  doc.meta.accountKeys = Array.isArray(meta.accountKeys) ? meta.accountKeys.filter((k) => typeof k === 'string') : []
  doc.meta.summary = meta.summary && typeof meta.summary === 'object' ? meta.summary : null
  doc.meta.autoSyncMinutes = normalizeAutoSyncMinutes(meta.autoSyncMinutes)
  mergeRows(doc, 'daily', Array.isArray(raw.daily) ? raw.daily : [])
  mergeRows(doc, 'dailyCost', Array.isArray(raw.dailyCost) ? raw.dailyCost : [])
  mergeRows(doc, 'hourly', Array.isArray(raw.hourly) ? raw.hourly : [])
  mergeRows(doc, 'hourlyCost', Array.isArray(raw.hourlyCost) ? raw.hourlyCost : [])
  return doc
}

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

/** 计费类型展示名。 */
export function typeLabel(type) {
  return TYPE_LABELS[type] ?? type
}

/** API Key 展示名 (平台允许空名)。 */
export function keyLabel(name) {
  return name && name.trim() ? name : '(未命名 Key)'
}

function segmentOf(row, group) {
  if (group === 'type') return { id: row.t, label: typeLabel(row.t) }
  if (group === 'key') return { id: row.k || '', label: keyLabel(row.k) }
  return { id: row.m || 'unknown', label: row.m || 'unknown' }
}

/** 从 start 到 end 的完整日历日列表 (含两端)。上限由调用方约束。 */
export function dateRange(start, end) {
  const out = []
  let cursor = start
  // 保护: 防止 start > end 或异常输入造成死循环
  for (let i = 0; i < 4000 && cursor <= end; i += 1) {
    out.push(cursor)
    const next = new Date(Date.parse(`${cursor}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    if (next <= cursor) break
    cursor = next
  }
  return out
}

function emptyScope() {
  return { tokens: 0, requests: 0, cost: 0 }
}

function addToScope(scope, tokens, requests, cost) {
  scope.tokens += tokens
  scope.requests += requests
  scope.cost += cost
}

/**
 * 日粒度序列: 每天一个堆叠柱。
 *
 * @param {ReturnType<createDoc>} doc
 * @param {{start:string, end:string, group:'model'|'type'|'key'}} scope
 */
export function dailySeries(doc, scope) {
  const group = scope.group ?? 'model'
  const dates = dateRange(scope.start, scope.end)
  const byDay = new Map(dates.map((date) => [date, new Map()]))
  const dayCost = new Map(dates.map((date) => [date, 0]))
  const dayRequests = new Map(dates.map((date) => [date, 0]))
  const currencies = new Set()
  const segTotals = new Map()

  for (const row of doc.daily.values()) {
    if (row.d < scope.start || row.d > scope.end) continue
    if (!byDay.has(row.d)) continue
    if (row.t === 'request_count') {
      dayRequests.set(row.d, (dayRequests.get(row.d) ?? 0) + row.n)
      continue
    }
    if (!TOKEN_TYPE_SET.has(row.t)) continue
    const seg = segmentOf(row, group)
    const bucket = byDay.get(row.d)
    bucket.set(seg.id, (bucket.get(seg.id) ?? 0) + row.n)
    segTotals.set(seg.id, segTotals.get(seg.id) ?? { label: seg.label, total: 0 })
    segTotals.get(seg.id).total += row.n
  }

  for (const row of doc.dailyCost.values()) {
    if (row.d < scope.start || row.d > scope.end) continue
    if (!dayCost.has(row.d)) continue
    dayCost.set(row.d, (dayCost.get(row.d) ?? 0) + row.c)
    if (row.u) currencies.add(row.u)
  }

  const segments = [...segTotals.entries()]
    .map(([id, info]) => ({ id, label: info.label, total: info.total }))
    .sort((a, b) => b.total - a.total)

  const totals = emptyScope()
  const days = dates.map((date) => {
    const bucket = byDay.get(date)
    const values = {}
    let tokens = 0
    for (const [id, value] of bucket) {
      values[id] = value
      tokens += value
    }
    const requests = dayRequests.get(date) ?? 0
    const cost = dayCost.get(date) ?? 0
    addToScope(totals, tokens, requests, cost)
    return { date, tokens, requests, cost, values }
  })

  return {
    granularity: 'day',
    scope: { start: scope.start, end: scope.end, group },
    segments,
    days,
    totals: {
      ...totals,
      days: days.length,
      activeDays: days.filter((day) => day.tokens > 0 || day.requests > 0).length,
      currencies: [...currencies].sort(),
    },
  }
}

/**
 * 小时粒度序列: 单日 24 个堆叠柱。
 */
export function hourlySeries(doc, scope) {
  const group = scope.group ?? 'model'
  const day = scope.date
  const byHour = new Map(Array.from({ length: 24 }, (_, hour) => [hour, new Map()]))
  const hourCost = new Map(Array.from({ length: 24 }, (_, hour) => [hour, 0]))
  const hourRequests = new Map(Array.from({ length: 24 }, (_, hour) => [hour, 0]))
  const currencies = new Set()
  const segTotals = new Map()

  for (const row of doc.hourly.values()) {
    if (row.d !== day) continue
    if (!byHour.has(row.h)) continue
    if (row.t === 'request_count') {
      hourRequests.set(row.h, (hourRequests.get(row.h) ?? 0) + row.n)
      continue
    }
    if (!TOKEN_TYPE_SET.has(row.t)) continue
    const seg = segmentOf(row, group)
    const bucket = byHour.get(row.h)
    bucket.set(seg.id, (bucket.get(seg.id) ?? 0) + row.n)
    segTotals.set(seg.id, segTotals.get(seg.id) ?? { label: seg.label, total: 0 })
    segTotals.get(seg.id).total += row.n
  }

  for (const row of doc.hourlyCost.values()) {
    if (row.d !== day) continue
    if (!hourCost.has(row.h)) continue
    hourCost.set(row.h, (hourCost.get(row.h) ?? 0) + row.c)
    if (row.u) currencies.add(row.u)
  }

  const segments = [...segTotals.entries()]
    .map(([id, info]) => ({ id, label: info.label, total: info.total }))
    .sort((a, b) => b.total - a.total)

  const totals = emptyScope()
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const bucket = byHour.get(hour)
    const values = {}
    let tokens = 0
    for (const [id, value] of bucket) {
      values[id] = value
      tokens += value
    }
    const requests = hourRequests.get(hour) ?? 0
    const cost = hourCost.get(hour) ?? 0
    addToScope(totals, tokens, requests, cost)
    return { hour, tokens, requests, cost, values }
  })

  return {
    granularity: 'hour',
    scope: { date: day, group },
    segments,
    hours,
    totals: { ...totals, currencies: [...currencies].sort() },
  }
}

/**
 * 区间内的模型 / Key / 计费类型汇总 (表格用)。
 */
export function breakdown(doc, scope) {
  const models = new Map()
  const keys = new Map()
  const types = new Map()
  const touch = (map, id, label) => {
    if (!map.has(id)) map.set(id, { id, label, tokens: 0, requests: 0, cost: 0 })
    return map.get(id)
  }

  for (const row of doc.daily.values()) {
    if (row.d < scope.start || row.d > scope.end) continue
    const isRequest = row.t === 'request_count'
    if (!isRequest && !TOKEN_TYPE_SET.has(row.t)) continue
    for (const entry of [touch(models, row.m || 'unknown', row.m || 'unknown'), touch(keys, row.k || '', keyLabel(row.k))]) {
      if (isRequest) entry.requests += row.n
      else entry.tokens += row.n
    }
    const type = touch(types, row.t, typeLabel(row.t))
    if (isRequest) type.requests += row.n
    else type.tokens += row.n
  }

  for (const row of doc.dailyCost.values()) {
    if (row.d < scope.start || row.d > scope.end) continue
    touch(models, row.m || 'unknown', row.m || 'unknown').cost += row.c
    touch(keys, row.k || '', keyLabel(row.k)).cost += row.c
  }

  const sort = (map) => [...map.values()].sort((a, b) => (b.tokens - a.tokens) || (b.cost - a.cost))
  return {
    scope: { start: scope.start, end: scope.end },
    models: sort(models),
    keys: sort(keys),
    types: sort(types),
  }
}

/**
 * 总览: 全量 / 本月 / 今日。
 */
export function summarize(doc, options = {}) {
  const today = options.today
  const month = today.slice(0, 7)
  const total = emptyScope()
  const monthScope = emptyScope()
  const todayScope = emptyScope()
  const currencies = new Set()

  for (const row of doc.daily.values()) {
    const isRequest = row.t === 'request_count'
    if (!isRequest && !TOKEN_TYPE_SET.has(row.t)) continue
    const n = isRequest ? 0 : row.n
    const requests = isRequest ? row.n : 0
    addToScope(total, n, requests, 0)
    if (row.d.startsWith(month)) addToScope(monthScope, n, requests, 0)
    if (row.d === today) addToScope(todayScope, n, requests, 0)
  }

  for (const row of doc.dailyCost.values()) {
    addToScope(total, 0, 0, row.c)
    if (row.d.startsWith(month)) addToScope(monthScope, 0, 0, row.c)
    if (row.d === today) addToScope(todayScope, 0, 0, row.c)
    if (row.u) currencies.add(row.u)
  }

  return {
    today,
    month,
    total,
    monthScope,
    todayScope,
    earliest: doc.meta.earliest,
    latest: doc.meta.latest,
    days: doc.meta.earliest && doc.meta.latest
      ? dateRange(doc.meta.earliest, doc.meta.latest).length
      : 0,
    currencies: [...currencies].sort(),
    rows: {
      daily: doc.daily.size,
      dailyCost: doc.dailyCost.size,
      hourly: doc.hourly.size,
      hourlyCost: doc.hourlyCost.size,
    },
  }
}
