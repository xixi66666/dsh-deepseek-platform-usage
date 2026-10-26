import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PlatformError,
  SYNC_TZ_OFFSET_SEC,
  accountsConflict,
  accountKeysOf,
  addDays,
  backfillWindows,
  bizPayload,
  createPlatformClient,
  dayStartSec,
  localDay,
  localHour,
  normalizeAmountWindow,
  normalizeCostWindow,
  normalizeHourlyAmount,
  normalizeHourlyCost,
  normalizeSummary,
  todayLocal,
} from '../lib/platform.js'

const DAY = 86_400_000

/** 平台真实包络 (见 app/sync.py 顶部注释)。 */
function amountEnvelope(series) {
  return {
    code: 0,
    msg: '',
    data: { biz_code: 0, biz_msg: '', biz_data: { start: 0, end: 0, bucket: 86400, series } },
  }
}

function costEnvelope(currency, series) {
  return {
    code: 0,
    msg: '',
    data: { biz_code: 0, biz_msg: '', biz_data: { data: [{ currency, series }] } },
  }
}

const AT_NOON = dayStartSec('2026-10-26') + 12 * 3600

test('本地日按 GMT+8 切分, 与运行机器时区无关', () => {
  assert.equal(SYNC_TZ_OFFSET_SEC, 28800)
  assert.equal(localDay(dayStartSec('2026-10-26')), '2026-10-26')
  assert.equal(localDay(dayStartSec('2026-10-26') - 1), '2026-10-25')
  assert.equal(localHour(AT_NOON), 12)
  assert.equal(dayStartSec('2026-10-26'), Date.UTC(2026, 9, 26) / 1000 - 8 * 3600)
  assert.equal(addDays('2026-02-28', 1), '2026-03-01')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
  assert.equal(todayLocal(Date.UTC(2026, 9, 26, 17, 0, 0)), '2026-10-27')
})

test('回溯窗口: 30 天一段, 端点日对齐, 首窗含今天', () => {
  const windows = [...backfillWindows('2026-10-26', { maxWindows: 3 })]
  assert.equal(windows.length, 3)
  assert.equal(windows[0].endDate, '2026-10-27')
  assert.equal(windows[0].begin, '2026-09-27')
  assert.equal(windows[0].end, dayStartSec('2026-10-27'))
  assert.equal(windows[1].endDate, windows[0].begin)
  assert.equal(windows[1].begin, '2026-08-28')
  // 相邻窗口首尾相接, 不重不漏
  assert.equal(windows[2].end, windows[1].start)
})

test('回溯窗口在 2020-01-01 之前停下', () => {
  const windows = [...backfillWindows('2020-01-05', { maxWindows: 50 })]
  const last = windows[windows.length - 1]
  assert.ok(last.begin <= '2020-01-01')
  assert.ok(windows.length < 50)
})

test('amount 归一化: 类型映射、本地日、零值跳过', () => {
  const rows = normalizeAmountWindow(amountEnvelope([
    {
      api_key: { tracking_id: 'tk1', name: 'prod', sensitive_id: 'x', valid: true },
      model: 'deepseek-chat',
      buckets: [{
        time: AT_NOON,
        usage: {
          PROMPT_CACHE_HIT_TOKEN: 100,
          PROMPT_CACHE_MISS_TOKEN: '200',
          RESPONSE_TOKEN: 50,
          REQUEST: 3,
          PROMPT_TOKEN: 300,
          SOMETHING_NEW: 7,
        },
      }],
    },
    {
      api_key: { tracking_id: 'tk2', name: 'dev' },
      model: 'deepseek-reasoner',
      buckets: [{ time: AT_NOON - DAY, usage: { RESPONSE_TOKEN: 0, REQUEST: 0 } }],
    },
  ]))

  const byType = Object.fromEntries(rows.map((row) => [row.t, row.n]))
  assert.equal(byType.input_cache_hit_tokens, 100)
  assert.equal(byType.input_cache_miss_tokens, 200)
  assert.equal(byType.output_tokens, 50)
  assert.equal(byType.request_count, 3)
  assert.equal(byType.prompt_tokens, 300)
  assert.equal(byType.something_new, 7)
  assert.equal(rows[0].d, '2026-10-26')
  assert.equal(rows[0].m, 'deepseek-chat')
  assert.equal(rows[0].k, 'prod')
  // 全零的第二个系列不产生任何行
  assert.equal(rows.filter((row) => row.m === 'deepseek-reasoner').length, 0)
})

test('cost 归一化: 保留币种并跳过零值', () => {
  const rows = normalizeCostWindow(costEnvelope('CNY', [
    {
      api_key: { tracking_id: 'tk1', name: 'prod' },
      model: 'deepseek-chat',
      buckets: [{ time: AT_NOON, cost: '0.123456' }, { time: AT_NOON - DAY, cost: 0 }],
    },
  ]))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].d, '2026-10-26')
  assert.equal(rows[0].c, 0.123456)
  assert.equal(rows[0].u, 'CNY')
})

test('分时归一化: 只保留四类, 带上小时', () => {
  const rows = normalizeHourlyAmount(amountEnvelope([
    {
      api_key: { tracking_id: 'tk1', name: 'prod' },
      model: 'deepseek-chat',
      buckets: [{
        time: AT_NOON,
        usage: { PROMPT_CACHE_HIT_TOKEN: 10, PROMPT_TOKEN: 999, RESPONSE_TOKEN: 5, REQUEST: 1 },
      }],
    },
  ]))
  assert.deepEqual(rows.map((row) => row.t).sort(), ['input_cache_hit_tokens', 'output_tokens', 'request_count'])
  assert.equal(rows[0].h, 12)
  assert.equal(rows[0].d, '2026-10-26')

  const costRows = normalizeHourlyCost(costEnvelope('CNY', [
    {
      api_key: { tracking_id: 'tk1', name: 'prod' },
      model: 'deepseek-chat',
      buckets: [{ time: AT_NOON, cost: '0.5' }],
    },
  ]))
  assert.equal(costRows.length, 1)
  assert.equal(costRows[0].h, 12)
})

test('账号一致性: 只有双方非空且完全不相交才算换号', () => {
  const json = amountEnvelope([
    { api_key: { tracking_id: 'tk1', name: 'prod' }, model: 'm', buckets: [] },
    { api_key: { tracking_id: 'tk2', name: 'dev' }, model: 'm', buckets: [] },
  ])
  const keys = accountKeysOf(json)
  assert.deepEqual(keys, ['tk1|prod', 'tk2|dev'])

  assert.equal(accountsConflict(keys, [keys[0]]), false)
  assert.equal(accountsConflict(keys, []), false)
  assert.equal(accountsConflict([], keys), false)
  assert.equal(accountsConflict(keys, ['tk9|other']), true)
})

test('biz_data / summary 提取容错', () => {
  assert.equal(bizPayload({ data: { biz_data: { a: 1 } } }).a, 1)
  assert.equal(bizPayload({ biz_data: { b: 2 } }).b, 2)
  assert.equal(bizPayload(null), null)
  assert.deepEqual(normalizeSummary({ data: { biz_data: { balance: 12.5, name: 'me', nested: { x: 1 } } } }), { balance: 12.5, name: 'me' })
  assert.equal(normalizeSummary({ data: { biz_data: null } }), null)
})

function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  impl.calls = calls
  return impl
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  }
}

test('客户端: 带 Bearer、tz 与 bucket 参数', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(amountEnvelope([])))
  const client = createPlatformClient({ token: 'tok', fetch: fetchImpl, delayMs: 0, base: 'https://example.test' })
  await client.fetchHourlyAmount(1000, 2000)
  const call = fetchImpl.calls[0]
  const url = new URL(call.url)
  assert.equal(url.pathname, '/api/v0/usage/by_api_key/amount')
  assert.equal(url.searchParams.get('start'), '1000')
  assert.equal(url.searchParams.get('end'), '2000')
  assert.equal(url.searchParams.get('tz'), '28800')
  assert.equal(url.searchParams.get('bucket'), '3600')
  assert.equal(call.init.headers.authorization, 'Bearer tok')
})

test('客户端错误映射: 401 / 40002 / 非 JSON / 网络', async () => {
  const expired = createPlatformClient({
    token: 'tok',
    delayMs: 0,
    fetch: fakeFetch(() => jsonResponse({ code: 0 }, 401)),
  })
  await assert.rejects(() => expired.getSummary(), (error) => {
    assert.equal(error instanceof PlatformError, true)
    assert.equal(error.kind, 'expired')
    return true
  })

  const coded = createPlatformClient({
    token: 'tok',
    delayMs: 0,
    fetch: fakeFetch(() => jsonResponse({ code: '40002', msg: 'expired' })),
  })
  await assert.rejects(() => coded.getSummary(), (error) => error.kind === 'expired')

  const shape = createPlatformClient({
    token: 'tok',
    delayMs: 0,
    fetch: fakeFetch(() => ({ ok: true, status: 200, text: async () => '<html>oops</html>' })),
  })
  await assert.rejects(() => shape.getSummary(), (error) => error.kind === 'shape')

  const network = createPlatformClient({
    token: 'tok',
    delayMs: 0,
    fetch: async () => { throw new Error('ECONNREFUSED') },
  })
  await assert.rejects(() => network.getSummary(), (error) => error.kind === 'network')

  const biz = createPlatformClient({
    token: 'tok',
    delayMs: 0,
    fetch: fakeFetch(() => jsonResponse({ code: 0, data: { biz_code: 40001, biz_msg: 'bad range' } })),
  })
  await assert.rejects(() => biz.getSummary(), (error) => error.kind === 'platform' && /bad range/.test(error.message))
})

test('客户端不接受空 token', () => {
  assert.throws(() => createPlatformClient({ token: '   ' }), (error) => error.kind === 'expired')
})
