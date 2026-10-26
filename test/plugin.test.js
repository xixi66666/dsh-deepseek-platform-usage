import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../lib/plugin.js'
import { addDays, dayStartSec, todayLocal } from '../lib/platform.js'

const HOST = '127.0.0.1:43129'

function makeReq({ method = 'GET', url = '/status', headers = {}, body = null } = {}) {
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { host: HOST, ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(chunk) { if (chunk !== undefined) this.body += chunk },
  }
}

/** 最小 ctx: 只实现插件用到的 get / effect / timeout。 */
function createHarness(options = {}) {
  const routes = new Map()
  const disposers = []
  const timers = []
  const storageWrites = []
  let storedDoc = options.storedDoc ?? null

  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        }
      }
      if (name === 'storage') {
        return {
          backend: {
            get(backendName) {
              if (backendName !== 'json') return undefined
              return {
                kv: {
                  async open() {
                    return {
                      async loadAll() { return { global: storedDoc === null ? {} : { doc: storedDoc } } },
                      async setGlobal(payload) { storedDoc = payload.doc; storageWrites.push(payload.doc) },
                      async close() {},
                    }
                  },
                }
              }
            },
          },
        }
      }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    timeout(fn, ms) { timers.push({ fn, ms }); return () => {} },
    interval() { return () => {} },
  }

  apply(ctx)

  async function call(method, path, { headers = {}, body = null } = {}) {
    const [pathname, search] = path.split('?')
    const handler = routes.get(`/api/dsh-platform-usage${pathname}`)
    assert.ok(handler, `route ${pathname} 未注册`)
    const url = `/api/dsh-platform-usage${pathname}${search ? `?${search}` : ''}`
    const res = makeRes()
    await handler(makeReq({ method, url, headers, body }), res)
    return { status: res.statusCode, payload: res.body ? JSON.parse(res.body) : null }
  }

  return { ctx, routes, call, timers, disposers, get storedDoc() { return storedDoc } }
}

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) }
}

function amountEnvelope(series) {
  return { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { series } } }
}

function costEnvelope(currency, series) {
  return { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { data: [{ currency, series }] } } }
}

/** 假平台: 只在包含今天的窗口返回数据, 其余窗口为空 (触发两个空窗即停)。 */
function createFakePlatform(today) {
  const dayStart = dayStartSec(today)
  const stats = { amount: 0, cost: 0, hourly: 0, summary: 0 }
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url))
    const start = Number(parsed.searchParams.get('start'))
    const end = Number(parsed.searchParams.get('end'))
    const bucket = parsed.searchParams.get('bucket')
    const includesToday = start <= dayStart && dayStart < end
    const seriesBase = { api_key: { tracking_id: 'tk1', name: 'prod', sensitive_id: 'sk-***', valid: true }, model: 'deepseek-chat' }

    if (parsed.pathname.endsWith('/users/get_user_summary')) {
      stats.summary += 1
      return jsonResponse({ code: 0, data: { biz_code: 0, biz_msg: '', biz_data: { balance: 12.5, currency: 'CNY' } } })
    }

    if (parsed.pathname.endsWith('/amount')) {
      if (bucket === '3600') {
        stats.hourly += 1
        if (!includesToday) return jsonResponse(amountEnvelope([]))
        return jsonResponse(amountEnvelope([{
          ...seriesBase,
          buckets: [{ time: dayStart + 9 * 3600, usage: { RESPONSE_TOKEN: 100, REQUEST: 1, PROMPT_TOKEN: 999 } }],
        }]))
      }
      stats.amount += 1
      if (!includesToday) return jsonResponse(amountEnvelope([]))
      return jsonResponse(amountEnvelope([{
        ...seriesBase,
        buckets: [{
          time: dayStart + 12 * 3600,
          usage: { PROMPT_CACHE_HIT_TOKEN: 1000, RESPONSE_TOKEN: 500, REQUEST: 10, PROMPT_TOKEN: 999 },
        }],
      }]))
    }

    if (parsed.pathname.endsWith('/cost')) {
      if (bucket === '3600') {
        stats.hourly += 1
        if (!includesToday) return jsonResponse(costEnvelope('CNY', []))
        return jsonResponse(costEnvelope('CNY', [{
          ...seriesBase,
          buckets: [{ time: dayStart + 9 * 3600, cost: '0.25' }],
        }]))
      }
      stats.cost += 1
      if (!includesToday) return jsonResponse(costEnvelope('CNY', []))
      return jsonResponse(costEnvelope('CNY', [{
        ...seriesBase,
        buckets: [{ time: dayStart + 12 * 3600, cost: '2.5' }],
      }]))
    }

    throw new Error(`unexpected request ${parsed.pathname}`)
  }
  return { fetchImpl, stats }
}

async function waitForSync(call, limitMs = 20_000) {
  const started = Date.now()
  for (;;) {
    const { payload } = await call('GET', '/status')
    if (!payload.sync.running) return payload
    if (Date.now() - started > limitMs) throw new Error('同步超时')
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
}

test('未配置时只暴露状态, 写接口要求 capability token', async () => {
  const harness = createHarness()
  const status = await harness.call('GET', '/status')
  assert.equal(status.status, 200)
  assert.equal(status.payload.configured, false)
  assert.equal(typeof status.payload.token, 'string')
  assert.equal(status.payload.persistent, true)
  assert.equal(status.payload.summary.total.tokens, 0)

  const rejected = await harness.call('POST', '/token', { body: { token: 'x' } })
  assert.equal(rejected.status, 403)
  assert.equal(rejected.payload.code, 'bad-token')

  const crossOrigin = await harness.call('GET', '/status', { headers: { origin: 'https://evil.example' } })
  assert.equal(crossOrigin.status, 403)

  const noTokenSync = await harness.call('POST', '/sync', { headers: { 'x-dsh-platform-usage-token': status.payload.token }, body: {} })
  assert.equal(noTokenSync.status, 400)
  assert.equal(noTokenSync.payload.code, 'no-token')
})

test('完整流程: 导入 token → 同步 → 面板数据 → 退出登录', async () => {
  const today = todayLocal()
  const { fetchImpl, stats } = createFakePlatform(today)
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const harness = createHarness()
    const initial = await harness.call('GET', '/status')
    const writeToken = initial.payload.token

    const saved = await harness.call('POST', '/token', {
      headers: { 'x-dsh-platform-usage-token': writeToken },
      body: { token: 'user-token-123456' },
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.payload.configured, true)
    assert.equal(saved.payload.tokenState.source, 'paste')

    const startedAt = Date.now()
    const started = await harness.call('POST', '/sync', { headers: { 'x-dsh-platform-usage-token': writeToken }, body: {} })
    assert.equal(started.status, 202)
    const after = await waitForSync(harness.call)
    assert.equal(after.meta.lastSyncStatus, 'ok', after.meta.lastSyncMessage)
    assert.ok(Date.now() - startedAt < 20_000)

    // 1 个有数据的窗口 + 2 个空窗口, amount/cost 各一轮; 分时 2 天 × 2 接口; 汇总 1 次
    assert.equal(stats.amount, 3)
    assert.equal(stats.cost, 3)
    assert.equal(stats.hourly, 4)
    assert.equal(stats.summary, 2) // 校验凭证一次 + 同步收尾一次

    // 第二次同步: 数据已覆盖到今天, 日窗口只需 1 个 (30 天窗口整体早于已有数据即停)
    const beforeSecond = { ...stats }
    const second = await harness.call('POST', '/sync', { headers: { 'x-dsh-platform-usage-token': writeToken }, body: {} })
    assert.equal(second.status, 202)
    const afterSecond = await waitForSync(harness.call)
    assert.equal(afterSecond.meta.lastSyncStatus, 'ok')
    assert.equal(stats.amount - beforeSecond.amount, 1)
    assert.equal(stats.cost - beforeSecond.cost, 1)
    assert.equal(stats.hourly - beforeSecond.hourly, 4) // 今天 + 昨天各 2 个接口
    assert.equal(stats.summary - beforeSecond.summary, 1)
    // 幂等: 重复同步不会改变合计
    const again = await harness.call('GET', '/series?days=30')
    assert.equal(again.payload.totals.tokens, 1500)
    assert.equal(again.payload.totals.cost, 2.5)

    // 面板数据: 今天的 1500 tokens (prompt 汇总桶不计) / 10 次请求 / ¥2.50
    const series = await harness.call('GET', `/series?days=30&group=model`)
    assert.equal(series.status, 200)
    assert.equal(series.payload.totals.tokens, 1500)
    assert.equal(series.payload.totals.requests, 10)
    assert.equal(series.payload.totals.cost, 2.5)
    assert.deepEqual(series.payload.segments.map((segment) => segment.id), ['deepseek-chat'])
    const todayPoint = series.payload.days.find((day) => day.date === today)
    assert.equal(todayPoint.tokens, 1500)

    const hourly = await harness.call('GET', `/hourly?date=${today}&group=model`)
    assert.equal(hourly.payload.hours[9].tokens, 100)
    assert.equal(hourly.payload.hours[9].cost, 0.25)
    assert.equal(hourly.payload.hours.length, 24)

    const breakdown = await harness.call('GET', '/breakdown?days=30')
    assert.deepEqual(breakdown.payload.models.map((row) => row.id), ['deepseek-chat'])
    assert.equal(breakdown.payload.models[0].cost, 2.5)

    // 存储已落盘 (hydrate 后行数一致)
    assert.ok(harness.storedDoc.daily.length > 0)
    assert.equal(harness.storedDoc.token.value, 'user-token-123456')

    // 清空数据保留凭证
    const cleared = await harness.call('POST', '/clear', { headers: { 'x-dsh-platform-usage-token': writeToken }, body: {} })
    assert.equal(cleared.status, 200)
    assert.equal(cleared.payload.status.configured, true)
    const emptySeries = await harness.call('GET', '/series?days=30')
    assert.equal(emptySeries.payload.totals.tokens, 0)

    // 退出登录
    const loggedOut = await harness.call('POST', '/logout', { headers: { 'x-dsh-platform-usage-token': writeToken }, body: {} })
    assert.equal(loggedOut.payload.configured, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('凭证无效时不落盘', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({ code: '40002', msg: 'expired' })
  try {
    const harness = createHarness()
    const initial = await harness.call('GET', '/status')
    const result = await harness.call('POST', '/token', {
      headers: { 'x-dsh-platform-usage-token': initial.payload.token },
      body: { token: 'bad-token-123456' },
    })
    assert.equal(result.status, 400)
    assert.equal(result.payload.code, 'expired')
    const status = await harness.call('GET', '/status')
    assert.equal(status.payload.configured, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('切换账号时中止同步且不写入数据', async () => {
  const today = todayLocal()
  const dayStart = dayStartSec(today)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url))
    if (parsed.pathname.endsWith('/users/get_user_summary')) {
      return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { balance: 1 } } })
    }
    return jsonResponse(amountEnvelope([{
      api_key: { tracking_id: 'other', name: 'other-key' },
      model: 'deepseek-chat',
      buckets: [{
        time: dayStart + 3600,
        usage: { RESPONSE_TOKEN: 1, REQUEST: 1 },
      }],
    }]))
  }
  try {
    const harness = createHarness({
      storedDoc: {
        schema: 1,
        token: { value: 'tok', savedAt: 1, source: 'paste' },
        meta: { lastSyncAt: null, lastSyncStatus: 'never', lastSyncMessage: null, accountKeys: ['tk1|prod'], earliest: null, latest: null, summary: null },
        daily: [],
        dailyCost: [],
        hourly: [],
        hourlyCost: [],
      },
    })
    const status = await harness.call('GET', '/status')
    const writeToken = status.payload.token
    const started = await harness.call('POST', '/sync', { headers: { 'x-dsh-platform-usage-token': writeToken }, body: {} })
    assert.equal(started.status, 202)
    const after = await waitForSync(harness.call)
    assert.equal(after.meta.lastSyncStatus, 'account-changed')
    assert.match(after.meta.lastSyncMessage, /不一致/)
    const series = await harness.call('GET', '/series?days=30')
    assert.equal(series.payload.totals.tokens, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('回溯窗口首尾相接且不超过 30 天', async () => {
  assert.equal(addDays('2026-10-26', 1), '2026-10-27')
  const today = todayLocal()
  const start = dayStartSec(today) - 29 * 86_400
  assert.equal(dayStartSec(addDays(today, -29)), start)
})

test('自动同步间隔: 鉴权、夹取与状态回显', async () => {
  const harness = createHarness()
  const status = await harness.call('GET', '/status')
  assert.equal(status.payload.meta.autoSyncMinutes, 30)
  assert.deepEqual(status.payload.meta.autoSyncChoices, [0, 15, 30, 60, 180])
  const writeToken = status.payload.token

  const noAuth = await harness.call('POST', '/config', { body: { autoSyncMinutes: 60 } })
  assert.equal(noAuth.status, 403)

  const ok = await harness.call('POST', '/config', {
    headers: { 'x-dsh-platform-usage-token': writeToken },
    body: { autoSyncMinutes: 60 },
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.payload.autoSyncMinutes, 60)
  assert.equal(ok.payload.status.meta.autoSyncMinutes, 60)
  assert.equal(harness.storedDoc.meta.autoSyncMinutes, 60)

  const clamped = await harness.call('POST', '/config', {
    headers: { 'x-dsh-platform-usage-token': writeToken },
    body: { autoSyncMinutes: 99999 },
  })
  assert.equal(clamped.payload.autoSyncMinutes, 1440)

  const off = await harness.call('POST', '/config', {
    headers: { 'x-dsh-platform-usage-token': writeToken },
    body: { autoSyncMinutes: 0 },
  })
  assert.equal(off.payload.status.meta.nextAutoSyncAt, null)

  const bad = await harness.call('POST', '/config', {
    headers: { 'x-dsh-platform-usage-token': writeToken },
    body: { autoSyncMinutes: 'abc' },
  })
  assert.equal(bad.status, 400)
})
