import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  breakdown,
  clearRows,
  createDoc,
  dailySeries,
  dateRange,
  hydrateDoc,
  hourlySeries,
  mergeRows,
  normalizeAutoSyncMinutes,
  serializeDoc,
  summarize,
} from '../lib/store.js'

function seed() {
  const doc = createDoc()
  const day1 = '2026-10-25'
  const day2 = '2026-10-26'
  mergeRows(doc, 'daily', [
    { d: day1, m: 'deepseek-chat', k: 'prod', t: 'input_cache_hit_tokens', n: 100 },
    { d: day1, m: 'deepseek-chat', k: 'prod', t: 'input_cache_miss_tokens', n: 50 },
    { d: day1, m: 'deepseek-chat', k: 'prod', t: 'output_tokens', n: 25 },
    { d: day1, m: 'deepseek-chat', k: 'prod', t: 'request_count', n: 4 },
    { d: day2, m: 'deepseek-reasoner', k: 'dev', t: 'input_cache_hit_tokens', n: 200 },
    { d: day2, m: 'deepseek-reasoner', k: 'dev', t: 'output_tokens', n: 100 },
    { d: day2, m: 'deepseek-reasoner', k: 'dev', t: 'request_count', n: 2 },
    // prompt_tokens 是汇总桶, 不应被当作 token 计入
    { d: day2, m: 'deepseek-reasoner', k: 'dev', t: 'prompt_tokens', n: 999 },
  ])
  mergeRows(doc, 'dailyCost', [
    { d: day1, m: 'deepseek-chat', k: 'prod', c: 0.5, u: 'CNY' },
    { d: day2, m: 'deepseek-reasoner', k: 'dev', c: 1.25, u: 'CNY' },
  ])
  mergeRows(doc, 'hourly', [
    { d: day2, h: 9, m: 'deepseek-reasoner', k: 'dev', t: 'output_tokens', n: 40 },
    { d: day2, h: 9, m: 'deepseek-reasoner', k: 'dev', t: 'request_count', n: 1 },
    { d: day2, h: 14, m: 'deepseek-reasoner', k: 'dev', t: 'output_tokens', n: 60 },
  ])
  mergeRows(doc, 'hourlyCost', [
    { d: day2, h: 9, m: 'deepseek-reasoner', k: 'dev', c: 0.25, u: 'CNY' },
  ])
  return doc
}

test('写入按复合主键幂等覆盖', () => {
  const doc = createDoc()
  const rows = [{ d: '2026-10-26', m: 'm', k: 'k', t: 'output_tokens', n: 10 }]
  assert.equal(mergeRows(doc, 'daily', rows), 1)
  assert.equal(mergeRows(doc, 'daily', rows), 1)
  assert.equal(doc.daily.size, 1)
  // 同键新值覆盖
  mergeRows(doc, 'daily', [{ ...rows[0], n: 99 }])
  assert.equal(doc.daily.size, 1)
  assert.equal([...doc.daily.values()][0].n, 99)
  // 坏行被丢弃
  assert.equal(mergeRows(doc, 'daily', [{ d: 'x' }, null, { d: '2026-10-26', m: 'm', k: 'k', t: 'output_tokens', n: 'NaN' }]), 0)
})

test('日期区间包含两端并跨月', () => {  assert.deepEqual(dateRange('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
  assert.deepEqual(dateRange('2026-10-26', '2026-10-26'), ['2026-10-26'])
  assert.deepEqual(dateRange('2026-10-27', '2026-10-26'), [])
})

test('日序列: 补零、分组与合计', () => {
  const doc = seed()
  const series = dailySeries(doc, { start: '2026-10-24', end: '2026-10-26', group: 'model' })

  assert.equal(series.days.length, 3)
  assert.deepEqual(series.days.map((day) => day.date), ['2026-10-24', '2026-10-25', '2026-10-26'])
  // 没有数据的那天补 0 而不是跳过
  assert.equal(series.days[0].tokens, 0)
  assert.equal(series.days[1].tokens, 175) // 100 + 50 + 25
  assert.equal(series.days[2].tokens, 300) // 200 + 100 (prompt_tokens 不计)
  assert.equal(series.days[1].requests, 4)
  assert.equal(series.days[2].cost, 1.25)

  assert.deepEqual(series.segments.map((segment) => segment.id), ['deepseek-reasoner', 'deepseek-chat'])
  assert.equal(series.totals.tokens, 475)
  assert.equal(series.totals.requests, 6)
  assert.equal(series.totals.cost, 1.75)
  assert.equal(series.totals.activeDays, 2)
  assert.deepEqual(series.totals.currencies, ['CNY'])

  // 按计费类型分组时, 段就是类型
  const byType = dailySeries(doc, { start: '2026-10-25', end: '2026-10-26', group: 'type' })
  assert.deepEqual(byType.segments.map((segment) => segment.id).sort(), [
    'input_cache_hit_tokens', 'input_cache_miss_tokens', 'output_tokens',
  ])
  assert.equal(byType.totals.tokens, 475)

  // 按 Key 分组
  const byKey = dailySeries(doc, { start: '2026-10-25', end: '2026-10-26', group: 'key' })
  assert.deepEqual(byKey.segments.map((segment) => segment.id), ['dev', 'prod'])
})

test('时序列: 24 个桶一个不少', () => {
  const doc = seed()
  const series = hourlySeries(doc, { date: '2026-10-26', group: 'model' })
  assert.equal(series.hours.length, 24)
  assert.equal(series.hours[9].tokens, 40)
  assert.equal(series.hours[9].requests, 1)
  assert.equal(series.hours[9].cost, 0.25)
  assert.equal(series.hours[14].tokens, 60)
  assert.equal(series.hours[0].tokens, 0)
  assert.equal(series.totals.tokens, 100)
  assert.equal(series.totals.cost, 0.25)
})

test('构成表: 模型 / Key / 类型各自汇总', () => {
  const doc = seed()
  const result = breakdown(doc, { start: '2026-10-25', end: '2026-10-26' })
  const chat = result.models.find((row) => row.id === 'deepseek-chat')
  assert.equal(chat.tokens, 175)
  assert.equal(chat.requests, 4)
  assert.equal(chat.cost, 0.5)
  const prod = result.keys.find((row) => row.id === 'prod')
  assert.equal(prod.tokens, 175)
  const types = Object.fromEntries(result.types.map((row) => [row.id, row]))
  assert.equal(types.output_tokens.tokens, 125)
  assert.equal(types.request_count.requests, 6)
})

test('总览: 全量 / 本月 / 今日', () => {
  const doc = seed()
  const summary = summarize(doc, { today: '2026-10-26' })
  assert.equal(summary.total.tokens, 475)
  assert.equal(summary.total.requests, 6)
  assert.equal(summary.total.cost, 1.75)
  assert.equal(summary.monthScope.tokens, 475)
  assert.equal(summary.todayScope.tokens, 300)
  assert.equal(summary.todayScope.cost, 1.25)
  assert.equal(summary.earliest, '2026-10-25')
  assert.equal(summary.latest, '2026-10-26')
  assert.deepEqual(summary.currencies, ['CNY'])
  assert.deepEqual(summary.rows, { daily: 8, dailyCost: 2, hourly: 3, hourlyCost: 1 })
})

test('序列化往返保留全部行, 并丢弃坏行', () => {
  const doc = seed()
  const raw = JSON.parse(JSON.stringify(serializeDoc(doc)))
  const restored = hydrateDoc(raw)
  assert.equal(restored.daily.size, doc.daily.size)
  assert.equal(restored.dailyCost.size, doc.dailyCost.size)
  assert.equal(restored.hourly.size, doc.hourly.size)
  assert.equal(restored.meta.earliest, '2026-10-25')

  const dirty = hydrateDoc({ schema: 1, daily: [{ d: '2026-10-26', m: 'm', k: 'k', t: 'output_tokens', n: 5 }, { bad: true }, 'x'], token: { value: ' tok ', savedAt: 1, source: 'file' } })
  assert.equal(dirty.daily.size, 1)
  assert.equal(dirty.token.value, 'tok')
  assert.equal(dirty.token.source, 'file')
  assert.equal(hydrateDoc(null).daily.size, 0)
})

test('清空只删数据行, 凭证与同步状态保留', () => {
  const doc = seed()
  doc.token = { value: 'tok', savedAt: 1, source: 'paste' }
  doc.meta.lastSyncMessage = 'ok'
  doc.meta.autoSyncMinutes = 15
  const counts = clearRows(doc)
  assert.deepEqual(counts, { daily: 8, dailyCost: 2, hourly: 3, hourlyCost: 1 })
  assert.equal(doc.daily.size, 0)
  assert.equal(doc.hourlyCost.size, 0)
  assert.equal(doc.meta.earliest, null)
  assert.equal(doc.token.value, 'tok')
  assert.equal(doc.meta.lastSyncMessage, 'ok')
  assert.equal(doc.meta.autoSyncMinutes, 15) // 清空数据不动自动同步设置
})

test('自动同步间隔: 默认 30 分钟, 非数字回落, 越界夹取', () => {
  assert.equal(createDoc().meta.autoSyncMinutes, 30)
  assert.equal(normalizeAutoSyncMinutes(60), 60)
  assert.equal(normalizeAutoSyncMinutes('15'), 15)
  assert.equal(normalizeAutoSyncMinutes(-5), 0)
  assert.equal(normalizeAutoSyncMinutes(99999), 1440)
  assert.equal(normalizeAutoSyncMinutes('abc'), 30)
  assert.equal(normalizeAutoSyncMinutes(undefined, 0), 0)
  // 落盘后恢复
  assert.equal(hydrateDoc({ meta: { autoSyncMinutes: 15 } }).meta.autoSyncMinutes, 15)
  assert.equal(hydrateDoc({ meta: { autoSyncMinutes: 'x' } }).meta.autoSyncMinutes, 30)
  assert.equal(hydrateDoc({}).meta.autoSyncMinutes, 30)
  // 序列化往返保留
  const doc = createDoc()
  doc.meta.autoSyncMinutes = 0
  assert.equal(hydrateDoc(serializeDoc(doc)).meta.autoSyncMinutes, 0)
})
