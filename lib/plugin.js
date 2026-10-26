/**
 * dsh-deepseek-platform-usage — host half.
 *
 * 把 DeepSeek 开放平台「用量信息」页面的私有数据搬进 DSH: 用 userToken 按 30 天
 * 窗口逐段回溯 by_api_key 的日用量与费用, 再抓今天/昨天的分时数据, 全部落在插件
 * 自己的本地存储里, 由设置页的「平台用量」面板消费。
 *
 * 设计要点:
 *  - 数据是**平台侧账单口径**: 按 API Key 计费的真实 tokens 与金额, 覆盖该账号在
 *    平台上的全部调用, 不是按本机会话日志或价格表推算出来的。
 *  - 归一化行（见 store.js）按复合主键覆盖写入, 因此重跑任意窗口都幂等, 平台删除
 *    久远数据也不会抹掉本地历史。
 *  - 凭证只存在本机插件存储里; 路由只服务回环地址, 写操作还要求本次启动随机生成的
 *    capability token, 跨源页面读不到它。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import {
  PlatformError,
  accountsConflict,
  addDays,
  backfillWindows,
  createPlatformClient,
  dayStartSec,
  todayLocal,
} from './platform.js'
import {
  AUTO_SYNC_CHOICES,
  DEFAULT_AUTO_SYNC_MINUTES,
  breakdown,
  clearRows,
  createDoc,
  dailySeries,
  hydrateDoc,
  hourlySeries,
  mergeRows,
  normalizeAutoSyncMinutes,
  serializeDoc,
  summarize,
} from './store.js'

export const name = 'dsh-deepseek-platform-usage'
export const inject = ['webServer', 'storage', 'timer']

const KV_NAME = 'dsh_platform_usage'
const KV_VERSION = 1
const ROUTE_PREFIX = '/api/dsh-platform-usage'
const TOKEN_HEADER = 'x-dsh-platform-usage-token'
/** 自动同步的心跳粒度: 每分钟检查一次是否到了间隔。 */
const AUTO_SYNC_TICK_MS = 60_000
/** 自动同步关闭时, 启动仍会补一次的门槛。 */
const STARTUP_FALLBACK_MS = 12 * 3600_000
/** 回溯过程中每写 N 个窗口落一次盘。 */
const PERSIST_EVERY_WINDOWS = 5
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 某张表里最新的日期 (没有行时为 null)。 */
function latestDayOf(table) {
  let latest = null
  for (const row of table.values()) {
    if (latest === null || row.d > latest) latest = row.d
  }
  return latest
}

class AccountChangedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AccountChangedError'
    this.code = 'account-changed'
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error ?? 'unknown error')
}

function syncErrorCode(error) {
  if (error instanceof AccountChangedError) return 'account-changed'
  if (error instanceof PlatformError) return error.kind
  return 'error'
}

// ---------------------------------------------------------------------------
// 回环守卫: 路由只暴露本机数据, DNS rebinding 或跨源页面都读不到。
// ---------------------------------------------------------------------------

function requestHeader(req, header) {
  const headers = isRecord(req) ? req.headers : null
  if (!isRecord(headers)) return undefined
  const value = headers[header]
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined
  return typeof value === 'string' ? value : undefined
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const value = address.trim().toLowerCase()
  if (value === '::1' || value === 'localhost') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true
  return /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
}

function isTrustedLocalRequest(req) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false
  const host = requestHeader(req, 'host')
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!(hostUrl.hostname === 'localhost' || isLoopbackAddress(hostUrl.hostname))) return false
  if (requestHeader(req, 'sec-fetch-site') === 'cross-site') return false
  const origin = requestHeader(req, 'origin')
  // 桌面壳转发请求时会剥掉 Origin, 因此缺省允许; 存在时必须同源。
  if (origin === undefined || origin === '') return true
  if (origin.startsWith('dsh-app://')) return true
  try {
    const originUrl = new URL(origin)
    return originUrl.protocol === 'http:' && originUrl.host === host
  } catch {
    return false
  }
}

function tokenEquals(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return { tooLarge: true }
    chunks.push(chunk)
  }
  try {
    return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { invalid: true }
  }
}

// ---------------------------------------------------------------------------
// 凭证解析: 支持 Python 版的 token.json、浏览器 localStorage 包装和裸串。
// ---------------------------------------------------------------------------

function cleanToken(raw) {
  let value = String(raw ?? '').trim()
  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) value = value.slice(1, -1)
  if (value.toLowerCase().startsWith('bearer ')) value = value.slice(7).trim()
  return value
}

/** 从 token 文件内容里取出 userToken。返回 { token, error }。 */
export function parseTokenFile(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return { token: '', error: '文件为空' }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 不是 JSON: 当作裸 token 文本 (可能带换行)
    const token = cleanToken(raw.split(/\r?\n/).find((line) => line.trim()) ?? '')
    return token ? { token, error: null } : { token: '', error: '文件里没有可用的 token' }
  }
  if (typeof parsed === 'string') {
    const token = cleanToken(parsed)
    return token ? { token, error: null } : { token: '', error: '文件里没有可用的 token' }
  }
  if (!isRecord(parsed)) return { token: '', error: '无法识别的 token 文件格式' }
  // Python 版: {"user_token": "...", "saved_at": "..."}
  // localStorage: {"value": "...", "__version": "0"}
  const candidates = [parsed.user_token, parsed.userToken, parsed.value, parsed.token]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const token = cleanToken(candidate)
    if (token.length >= 10) return { token, error: null }
  }
  return { token: '', error: '文件里没有可用的 token' }
}

// ---------------------------------------------------------------------------
// 路由作用域
// ---------------------------------------------------------------------------

function pickGroup(raw) {
  return raw === 'type' || raw === 'key' ? raw : 'model'
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  const storage = ctx.get('storage')
  const writeToken = randomBytes(32).toString('base64url')

  let doc = createDoc()
  let kvUnit = null
  let persistent = false
  let disposed = false
  let loaded = false
  let loadPromise = null
  let persistChain = Promise.resolve()
  let syncState = {
    running: false,
    stage: null,
    windows: 0,
    startedAt: null,
    lastError: null,
  }

  // --- 持久化 --------------------------------------------------------------

  function persist() {
    if (!kvUnit) return Promise.resolve()
    const payload = { doc: serializeDoc(doc) }
    persistChain = persistChain
      .then(() => kvUnit?.setGlobal(payload))
      .catch((error) => console.error('[dsh-platform-usage] 存储写入失败:', error))
    return persistChain
  }

  async function openStore() {
    try {
      const backend = storage?.backend?.get?.('json')
      if (!backend?.kv) {
        console.warn('[dsh-platform-usage] 没有可用的 json 存储后端, 本次运行只在内存里保存数据')
        return
      }
      const unit = await backend.kv.open({ name: KV_NAME, version: KV_VERSION, tables: [], hasGlobal: true })
      if (disposed) {
        await unit.close().catch(() => {})
        return
      }
      kvUnit = unit
      const snapshot = await unit.loadAll()
      const raw = snapshot?.global?.doc
      if (raw) doc = hydrateDoc(raw)
      persistent = true
    } catch (error) {
      console.error('[dsh-platform-usage] 插件存储不可用:', error)
      persistent = false
    } finally {
      loaded = true
    }
  }

  function ready() {
    if (!loadPromise) loadPromise = openStore()
    return loadPromise
  }

  // --- 同步 ----------------------------------------------------------------

  function resetSyncState() {
    syncState = { running: false, stage: null, windows: 0, startedAt: null, lastError: null }
  }

  async function runSync(trigger = 'manual') {
    if (syncState.running) return
    const token = doc.token?.value
    if (!token) throw new PlatformError('尚未配置登录凭证, 请先导入 token', 'expired')

    syncState = { running: true, stage: 'amount', windows: 0, startedAt: Date.now(), lastError: null }
    const client = createPlatformClient({ token })
    const today = todayLocal()
    let amountWindows = 0
    let costWindows = 0
    let amountRows = 0
    let costRows = 0
    let hourlyRows = 0
    let hourlyNote = ''

    try {
      // ---- 日用量回溯 (首窗兼作账号一致性门禁)
      let zeroStreak = 0
      let firstWindow = true
      // 以同步前的已有数据为界: 已经覆盖的窗口直接停, 于是重复同步只花一个窗口。
      // 用基线而不是实时最新值, 否则空库第一次同步会在首个窗口后立刻停下。
      const knownAmountLatest = latestDayOf(doc.daily)
      for (const window of backfillWindows(today)) {
        if (disposed) throw new Error('插件已卸载')
        if (knownAmountLatest !== null && window.endDate <= knownAmountLatest) break
        const { rows, keys } = await client.fetchAmount(window.start, window.end)
        if (firstWindow) {
          firstWindow = false
          if (accountsConflict(doc.meta.accountKeys, keys)) {
            throw new AccountChangedError(
              '登录账号与本地数据所属账号不一致 (API Key 集合不同)。本地历史未改动; '
              + '如需切换到新账号, 请先「清空数据」再同步。',
            )
          }
          if (keys.length > 0) doc.meta.accountKeys = keys
        }
        const written = mergeRows(doc, 'daily', rows)
        amountRows += written
        if (written === 0) {
          zeroStreak += 1
          if (zeroStreak >= 2) break
        } else {
          zeroStreak = 0
          amountWindows += 1
        }
        syncState.windows = amountWindows + costWindows
        if (amountWindows > 0 && amountWindows % PERSIST_EVERY_WINDOWS === 0) await persist()
      }

      // ---- 日费用回溯
      zeroStreak = 0
      const knownCostLatest = latestDayOf(doc.dailyCost)
      for (const window of backfillWindows(today)) {
        if (disposed) throw new Error('插件已卸载')
        if (knownCostLatest !== null && window.endDate <= knownCostLatest) break
        syncState.stage = 'cost'
        const { rows } = await client.fetchCost(window.start, window.end)
        const written = mergeRows(doc, 'dailyCost', rows)
        costRows += written
        if (written === 0) {
          zeroStreak += 1
          if (zeroStreak >= 2) break
        } else {
          zeroStreak = 0
          costWindows += 1
        }
        syncState.windows = amountWindows + costWindows
        if (costWindows > 0 && costWindows % PERSIST_EVERY_WINDOWS === 0) await persist()
      }
      await persist()

      // ---- 分时 (平台只保留最近两天; 失败只降级)
      syncState.stage = 'hourly'
      try {
        for (const day of [today, addDays(today, -1)]) {
          const start = dayStartSec(day)
          const end = dayStartSec(addDays(day, 1))
          const amount = await client.fetchHourlyAmount(start, end)
          hourlyRows += mergeRows(doc, 'hourly', amount.rows)
          const cost = await client.fetchHourlyCost(start, end)
          hourlyRows += mergeRows(doc, 'hourlyCost', cost.rows)
        }
        hourlyNote = `; 分时 2 天 ${hourlyRows} 行`
      } catch (error) {
        hourlyNote = `; 分时数据跳过 (${errorMessage(error)})`
      }

      // ---- 账号汇总 (尽力而为)
      syncState.stage = 'summary'
      try {
        const summary = await client.getSummary()
        if (summary) doc.meta.summary = summary
      } catch {
        // 汇总失败不影响用量同步
      }

      doc.meta.lastSyncAt = Date.now()
      doc.meta.lastSyncStatus = 'ok'
      doc.meta.lastSyncMessage = `用量回溯 ${amountWindows} 个窗口 (${amountRows} 行), `
        + `费用 ${costWindows} 个窗口 (${costRows} 行)${hourlyNote}`
      await persist()
      return { ok: true, message: doc.meta.lastSyncMessage, trigger }
    } catch (error) {
      doc.meta.lastSyncStatus = syncErrorCode(error)
      doc.meta.lastSyncMessage = errorMessage(error)
      syncState.lastError = doc.meta.lastSyncMessage
      await persist()
      throw error
    } finally {
      const lastError = syncState.lastError
      const startedAt = syncState.startedAt
      resetSyncState()
      // 保留最后一次失败信息与耗时, 让 UI 在同步结束后仍能显示
      if (lastError) syncState.lastError = lastError
      if (startedAt) syncState.finishedAt = Date.now()
    }
  }

  // --- 作用域与响应 ---------------------------------------------------------

  function defaultEnd() {
    const today = todayLocal()
    return today
  }

  function scopeFromParams(params = {}) {
    const group = pickGroup(params.group)
    const end = DATE_PATTERN.test(String(params.end ?? '')) ? String(params.end) : defaultEnd()
    const days = String(params.days ?? '')
    let start = ''
    if (DATE_PATTERN.test(String(params.start ?? ''))) start = String(params.start)
    else if (days === 'all') start = doc.meta.earliest ?? addDays(end, -29)
    else {
      const n = Number(days)
      start = addDays(end, -(Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 3660) - 1 : 29))
    }
    if (start > end) [start, end] = [end, start]
    return { start, end, group }
  }

  function statusPayload() {
    const today = todayLocal()
    const summary = summarize(doc, { today })
    return {
      ok: true,
      configured: Boolean(doc.token?.value),
      token: writeToken,
      tokenState: doc.token
        ? { source: doc.token.source, savedAt: doc.token.savedAt }
        : null,
      persistent,
      sync: {
        running: syncState.running,
        stage: syncState.stage,
        windows: syncState.windows,
        startedAt: syncState.startedAt,
        lastError: syncState.lastError,
      },
      meta: {
        lastSyncAt: doc.meta.lastSyncAt,
        lastSyncStatus: doc.meta.lastSyncStatus,
        lastSyncMessage: doc.meta.lastSyncMessage,
        earliest: doc.meta.earliest,
        latest: doc.meta.latest,
        accountKeyCount: doc.meta.accountKeys.length,
        summary: doc.meta.summary,
        autoSyncMinutes: doc.meta.autoSyncMinutes,
        autoSyncChoices: AUTO_SYNC_CHOICES,
        nextAutoSyncAt: nextAutoSyncAt(),
      },
      summary,
      server: { today, tzOffsetSec: 8 * 3600 },
    }
  }

  function requireWrite(req, res) {
    if (!isTrustedLocalRequest(req)) {
      sendJson(res, 403, { ok: false, code: 'untrusted', message: '请求来源不受信任' })
      return false
    }
    if (!tokenEquals(requestHeader(req, TOKEN_HEADER), writeToken)) {
      sendJson(res, 403, { ok: false, code: 'bad-token', message: '缺少写入令牌' })
      return false
    }
    return true
  }

  /** 下一次自动同步的预计时刻; 关闭、未登录或正在同步时为 null。 */
  function nextAutoSyncAt() {
    const minutes = doc.meta.autoSyncMinutes
    if (!(minutes > 0)) return null
    if (syncState.running) return null
    const last = doc.meta.lastSyncAt
    if (typeof last !== 'number') return Date.now()
    return last + minutes * 60_000
  }

  /** 心跳: 到点且没有在同步时补一次。失败只记录, 不抛。 */
  async function autoSyncTick() {
    await ready()
    if (disposed || syncState.running) return
    if (!doc.token?.value) return
    const minutes = doc.meta.autoSyncMinutes
    if (!(minutes > 0)) return
    const last = doc.meta.lastSyncAt
    if (typeof last === 'number' && Date.now() - last < minutes * 60_000) return
    try {
      await runSync('auto')
    } catch (error) {
      console.warn('[dsh-platform-usage] 自动同步失败:', errorMessage(error))
    }
  }

  // --- 路由 ----------------------------------------------------------------

  function register(path, handler) {
    return ctx.effect(() => webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}${path}`, handler }))
  }

  register('/status', async (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end()
      return
    }
    if (!isTrustedLocalRequest(req)) {
      sendJson(res, 403, { ok: false, code: 'untrusted', message: '请求来源不受信任' })
      return
    }
    await ready()
    sendJson(res, 200, statusPayload())
  })

  register('/token', async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    if (!requireWrite(req, res)) return
    await ready()
    const parsed = await readJsonBody(req)
    if (parsed.tooLarge === true) {
      sendJson(res, 413, { ok: false, code: 'too-large', message: '请求体过大' })
      return
    }
    if (parsed.invalid === true) {
      sendJson(res, 400, { ok: false, code: 'bad-body', message: '请求体不是合法 JSON' })
      return
    }
    const body = isRecord(parsed.body) ? parsed.body : {}

    let candidate = ''
    let source = 'paste'
    if (typeof body.path === 'string' && body.path.trim()) {
      let text
      try {
        text = await readFile(body.path.trim(), 'utf8')
      } catch (error) {
        sendJson(res, 400, { ok: false, code: 'read-failed', message: `读取文件失败: ${errorMessage(error)}` })
        return
      }
      const parsedFile = parseTokenFile(text)
      if (parsedFile.error) {
        sendJson(res, 400, { ok: false, code: 'bad-file', message: parsedFile.error })
        return
      }
      candidate = parsedFile.token
      source = 'file'
    } else if (typeof body.token === 'string') {
      candidate = cleanToken(body.token)
    }

    if (!candidate) {
      sendJson(res, 400, { ok: false, code: 'no-token', message: '没有提供 token 或 token 文件路径' })
      return
    }

    // 先用账号汇总接口验证一次, 无效凭证不落盘。
    try {
      const client = createPlatformClient({ token: candidate })
      await client.getSummary()
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        code: syncErrorCode(error),
        message: errorMessage(error),
      })
      return
    }

    doc.token = { value: candidate, savedAt: Date.now(), source }
    doc.meta.lastSyncStatus = 'never'
    doc.meta.lastSyncMessage = null
    await persist()
    sendJson(res, 200, statusPayload())
  })

  register('/logout', async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    if (!requireWrite(req, res)) return
    await ready()
    doc.token = null
    doc.meta.lastSyncStatus = 'never'
    doc.meta.lastSyncMessage = null
    await persist()
    sendJson(res, 200, statusPayload())
  })

  register('/sync', async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    if (!requireWrite(req, res)) return
    await ready()
    if (syncState.running) {
      sendJson(res, 409, { ok: false, code: 'busy', message: '同步正在进行中' })
      return
    }
    if (!doc.token?.value) {
      sendJson(res, 400, { ok: false, code: 'no-token', message: '尚未配置登录凭证' })
      return
    }
    void runSync('manual').catch((error) => {
      console.warn('[dsh-platform-usage] 同步失败:', errorMessage(error))
    })
    sendJson(res, 202, { ok: true, started: true })
  })

  register('/clear', async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    if (!requireWrite(req, res)) return
    await ready()
    const counts = clearRows(doc)
    await persist()
    sendJson(res, 200, { ok: true, cleared: counts, status: statusPayload() })
  })

  register('/config', async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    if (!requireWrite(req, res)) return
    await ready()
    const parsed = await readJsonBody(req)
    if (parsed.tooLarge === true) {
      sendJson(res, 413, { ok: false, code: 'too-large', message: '请求体过大' })
      return
    }
    if (parsed.invalid === true || !isRecord(parsed.body)) {
      sendJson(res, 400, { ok: false, code: 'bad-body', message: '请求体不是合法 JSON' })
      return
    }
    const raw = parsed.body.autoSyncMinutes
    if (raw === undefined || !Number.isFinite(Number(raw))) {
      sendJson(res, 400, { ok: false, code: 'bad-config', message: 'autoSyncMinutes 必须是数字' })
      return
    }
    const minutes = normalizeAutoSyncMinutes(raw)
    doc.meta.autoSyncMinutes = minutes
    await persist()
    sendJson(res, 200, { ok: true, autoSyncMinutes: minutes, status: statusPayload() })
  })

  register('/series', async (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end()
      return
    }
    if (!isTrustedLocalRequest(req)) {
      sendJson(res, 403, { ok: false, code: 'untrusted', message: '请求来源不受信任' })
      return
    }
    await ready()
    const params = Object.fromEntries(new URL(req.url ?? '/', 'http://x').searchParams)
    const scope = scopeFromParams(params)
    sendJson(res, 200, { ok: true, ...dailySeries(doc, scope) })
  })

  register('/hourly', async (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end()
      return
    }
    if (!isTrustedLocalRequest(req)) {
      sendJson(res, 403, { ok: false, code: 'untrusted', message: '请求来源不受信任' })
      return
    }
    await ready()
    const params = Object.fromEntries(new URL(req.url ?? '/', 'http://x').searchParams)
    const date = DATE_PATTERN.test(String(params.date ?? '')) ? String(params.date) : todayLocal()
    sendJson(res, 200, { ok: true, ...hourlySeries(doc, { date, group: pickGroup(params.group) }) })
  })

  register('/breakdown', async (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end()
      return
    }
    if (!isTrustedLocalRequest(req)) {
      sendJson(res, 403, { ok: false, code: 'untrusted', message: '请求来源不受信任' })
      return
    }
    await ready()
    const params = Object.fromEntries(new URL(req.url ?? '/', 'http://x').searchParams)
    const scope = scopeFromParams(params)
    sendJson(res, 200, { ok: true, ...breakdown(doc, scope) })
  })

  // --- 生命周期 ------------------------------------------------------------

  ctx.effect(() => () => {
    disposed = true
    const unit = kvUnit
    kvUnit = null
    void persistChain.catch(() => {})
    void unit?.close?.().catch(() => {})
  })

  // 自动同步心跳: 每分钟看一眼是否到点 (间隔可关, 关闭后不会发起任何请求)
  ctx.effect(() => {
    const stop = ctx.interval(() => { void autoSyncTick() }, AUTO_SYNC_TICK_MS)
    return stop
  })

  // 启动后补齐一次数据: 到点就同步; 自动同步关闭时退回 12 小时门槛
  ctx.timeout(() => {
    void (async () => {
      await ready()
      if (disposed || !doc.token?.value) return
      const minutes = doc.meta.autoSyncMinutes
      const threshold = minutes > 0 ? minutes * 60_000 : STARTUP_FALLBACK_MS
      const last = doc.meta.lastSyncAt
      if (typeof last === 'number' && Date.now() - last < threshold) return
      try {
        await runSync('startup')
      } catch (error) {
        // 失败信息已写进 meta, UI 会显示
        console.warn('[dsh-platform-usage] 启动同步失败:', errorMessage(error))
      }
    })()
  }, 5000)

  void ready()
}

export default { name, inject, apply }
