/**
 * DeepSeek 开放平台私有 Dashboard 接口客户端与归一化层。
 *
 * 数据来源: platform.deepseek.com 的「用量信息」页面所调用的私有接口, 认证方式
 * 是浏览器登录会话里的 userToken, 以 `Authorization: Bearer <token>` 发送。
 *
 * 接口形状 (2026-08 实测, 与原 Python 版 deepseek-api-usage-statistics 一致):
 *
 *   GET /api/v0/usage/by_api_key/amount?start=<unix秒>&end=<unix秒>&tz=<偏移秒>
 *   GET /api/v0/usage/by_api_key/cost?start=<unix秒>&end=<unix秒>&tz=<偏移秒>
 *   GET /api/v0/users/get_user_summary
 *
 *   包络: { code, msg, data: { biz_code, biz_msg, biz_data } }
 *   amount.biz_data: { start, end, bucket, models, series: [{
 *       api_key: { tracking_id, name, sensitive_id, valid },
 *       model, buckets: [{ time, usage: { PROMPT_CACHE_HIT_TOKEN, ... } }] }] }
 *   cost.biz_data:   { data: [{ currency, series: [{ api_key, model,
 *       buckets: [{ time, cost: "0.123" }] }] }] }
 *
 * 约束: start/end 必须按 tz 的日边界对齐; 单次范围上限 30 天 (31 天返回
 * INVALID_PARAM); `bucket=3600` 把日桶换成整点小时桶, 平台只保留最近两天。
 *
 * 本模块只做协议与归一化, 不认识存储与 HTTP 路由; 所有函数都是纯函数
 * (createPlatformClient 注入 fetch), 因此可以用样本 payload 离线测试。
 */

/** 平台域名。 */
export const PLATFORM_BASE = 'https://platform.deepseek.com'

export const USER_SUMMARY_PATH = '/api/v0/users/get_user_summary'
export const AMOUNT_PATH = '/api/v0/usage/by_api_key/amount'
export const COST_PATH = '/api/v0/usage/by_api_key/cost'

/** 统计时区固定 GMT+8 (与平台页面默认口径一致)。 */
export const SYNC_TZ_OFFSET_SEC = 8 * 3600

/** by_api_key 接口单次请求的范围上限 (天)。 */
export const MAX_WINDOW_DAYS = 30
/** 逐窗回溯的安全上限 (10 年), 防止异常接口返回永不停止。 */
export const MAX_BACKFILL_WINDOWS = 120
export const HTTP_TIMEOUT_MS = 30_000
/** 请求间隔, 避免对平台造成压力。 */
export const REQUEST_DELAY_MS = 300

/** 平台错误码: token 过期/无效。 */
const SESSION_EXPIRED_CODES = new Set(['40002', '40003'])

/** 平台计费类型枚举 → 存储里统一的小写类型。 */
const PLATFORM_TYPE_MAP = {
  PROMPT_TOKEN: 'prompt_tokens',
  PROMPT_CACHE_HIT_TOKEN: 'input_cache_hit_tokens',
  PROMPT_CACHE_MISS_TOKEN: 'input_cache_miss_tokens',
  RESPONSE_TOKEN: 'output_tokens',
  REQUEST: 'request_count',
}

/**
 * 计入 token 的类型。平台同时返回 prompt_tokens 汇总桶与它的拆分桶
 * (cache hit / cache miss), 两者相加会重复计数, 所以统一口径是
 * tokens = cache_hit + cache_miss + output, 与原 Python 版 db.py 一致。
 */
export const TOKEN_TYPES = [
  'input_cache_hit_tokens',
  'input_cache_miss_tokens',
  'output_tokens',
]

/** 分时接口只保留的四类 (prompt_tokens 等冗余类型跳过, 避免重复计)。 */
const HOURLY_TYPES = new Set([...TOKEN_TYPES, 'request_count'])

/** 计费类型 → 展示名。 */
export const TYPE_LABELS = {
  input_cache_hit_tokens: '输入·缓存命中',
  input_cache_miss_tokens: '输入·缓存未命中',
  output_tokens: '输出',
  request_count: '请求次数',
  prompt_tokens: '输入(汇总)',
  total_tokens: '总计',
}

export class PlatformError extends Error {
  /**
   * @param {string} message 面向用户的消息
   * @param {'expired'|'network'|'platform'|'shape'} kind
   */
  constructor(message, kind = 'platform') {
    super(message)
    this.name = 'PlatformError'
    this.kind = kind
  }
}

// ---------------------------------------------------------------------------
// 时间: 全部按 UTC+8 的日历日计算, 与运行机器时区无关。
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

function toUtcMs(date) {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/** 'YYYY-MM-DD' 加减天数。 */
export function addDays(date, days) {
  return new Date(toUtcMs(date) + days * DAY_MS).toISOString().slice(0, 10)
}

/** 本地 (GMT+8) 日 00:00 的 Unix 秒。 */
export function dayStartSec(date) {
  return toUtcMs(date) / 1000 - SYNC_TZ_OFFSET_SEC
}

/** Unix 秒 → 本地 (GMT+8) 日期 'YYYY-MM-DD'。 */
export function localDay(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n)) return ''
  return new Date(n * 1000 + SYNC_TZ_OFFSET_SEC * 1000).toISOString().slice(0, 10)
}

/** Unix 秒 → 本地 (GMT+8) 整点小时 0-23。 */
export function localHour(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n)) return -1
  return new Date(n * 1000 + SYNC_TZ_OFFSET_SEC * 1000).getUTCHours()
}

/** 当前本地 (GMT+8) 日期。 */
export function todayLocal(nowMs = Date.now()) {
  return new Date(nowMs + SYNC_TZ_OFFSET_SEC * 1000).toISOString().slice(0, 10)
}

/** 某个本地日所在月份的 'YYYY-MM'。 */
export function localMonth(date) {
  return date.slice(0, 7)
}

/**
 * 从 today (含) 往前逐段回溯, 每段 30 天, 端点按日边界对齐。
 * 产出 { start, end, begin, endDate } (start/end 为 Unix 秒, end 不含)。
 */
export function* backfillWindows(today, options = {}) {
  const days = options.days ?? MAX_WINDOW_DAYS
  const maxWindows = options.maxWindows ?? MAX_BACKFILL_WINDOWS
  let end = addDays(today, 1)
  for (let i = 0; i < maxWindows; i += 1) {
    const begin = addDays(end, -days)
    yield { start: dayStartSec(begin), end: dayStartSec(end), begin, endDate: end }
    if (begin <= '2020-01-01') return
    end = begin
  }
}

// ---------------------------------------------------------------------------
// 响应归一化
// ---------------------------------------------------------------------------

/** 取真实负载: {code,msg,data:{biz_code,biz_msg,biz_data}} → biz_data。 */
export function bizPayload(json) {
  if (!json || typeof json !== 'object') return null
  const inner = json.data
  if (inner && typeof inner === 'object' && 'biz_data' in inner) return inner.biz_data
  return json.biz_data ?? null
}

function toNum(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function mapType(raw) {
  const name = String(raw ?? '')
  if (!name) return ''
  return PLATFORM_TYPE_MAP[name.toUpperCase()] ?? name.toLowerCase()
}

function keyNameOf(series) {
  const apiKey = series?.api_key
  return String(apiKey?.name ?? '')
}

/**
 * by_api_key/amount → 日用量行 [{ d, m, k, t, n }]。
 * 全零行跳过 (0 用量不影响任何统计)。
 */
export function normalizeAmountWindow(json) {
  const payload = bizPayload(json)
  if (!payload || !Array.isArray(payload.series)) return []
  const rows = []
  for (const series of payload.series) {
    if (!series || typeof series !== 'object') continue
    const keyName = keyNameOf(series)
    const model = String(series.model ?? 'unknown')
    for (const bucket of series.buckets ?? []) {
      const day = localDay(bucket?.time)
      if (!day) continue
      const usage = bucket?.usage ?? {}
      for (const [rawType, amount] of Object.entries(usage)) {
        const n = Math.round(toNum(amount))
        if (n === 0) continue
        rows.push({ d: day, m: model, k: keyName, t: mapType(rawType), n })
      }
    }
  }
  return rows
}

/**
 * by_api_key/cost → 日费用行 [{ d, m, k, c, u }] (u = 币种)。
 */
export function normalizeCostWindow(json) {
  const payload = bizPayload(json)
  if (!payload || !Array.isArray(payload.data)) return []
  const rows = []
  for (const entry of payload.data) {
    if (!entry || typeof entry !== 'object') continue
    const currency = String(entry.currency ?? 'CNY')
    for (const series of entry.series ?? []) {
      if (!series || typeof series !== 'object') continue
      const keyName = keyNameOf(series)
      const model = String(series.model ?? 'unknown')
      for (const bucket of series.buckets ?? []) {
        const cost = toNum(bucket?.cost)
        if (cost === 0) continue
        const day = localDay(bucket?.time)
        if (!day) continue
        rows.push({ d: day, m: model, k: keyName, c: cost, u: currency })
      }
    }
  }
  return rows
}

/** bucket=3600 的 amount → 小时用量行 [{ d, h, m, k, t, n }]。 */
export function normalizeHourlyAmount(json) {
  const payload = bizPayload(json)
  if (!payload || !Array.isArray(payload.series)) return []
  const rows = []
  for (const series of payload.series) {
    if (!series || typeof series !== 'object') continue
    const keyName = keyNameOf(series)
    const model = String(series.model ?? 'unknown')
    for (const bucket of series.buckets ?? []) {
      const day = localDay(bucket?.time)
      if (!day) continue
      const hour = localHour(bucket?.time)
      if (hour < 0) continue
      const usage = bucket?.usage ?? {}
      for (const [rawType, amount] of Object.entries(usage)) {
        const type = mapType(rawType)
        if (!HOURLY_TYPES.has(type)) continue
        const n = Math.round(toNum(amount))
        if (n === 0) continue
        rows.push({ d: day, h: hour, m: model, k: keyName, t: type, n })
      }
    }
  }
  return rows
}

/** bucket=3600 的 cost → 小时费用行 [{ d, h, m, k, c, u }]。 */
export function normalizeHourlyCost(json) {
  const payload = bizPayload(json)
  if (!payload || !Array.isArray(payload.data)) return []
  const rows = []
  for (const entry of payload.data) {
    if (!entry || typeof entry !== 'object') continue
    const currency = String(entry.currency ?? 'CNY')
    for (const series of entry.series ?? []) {
      if (!series || typeof series !== 'object') continue
      const keyName = keyNameOf(series)
      const model = String(series.model ?? 'unknown')
      for (const bucket of series.buckets ?? []) {
        const cost = toNum(bucket?.cost)
        if (cost === 0) continue
        const day = localDay(bucket?.time)
        if (!day) continue
        const hour = localHour(bucket?.time)
        if (hour < 0) continue
        rows.push({ d: day, h: hour, m: model, k: keyName, c: cost, u: currency })
      }
    }
  }
  return rows
}

/**
 * 响应里出现的 API Key 集合 ("tracking_id|name"), 用于判断「登录账号是否与
 * 本地数据同一账号」。同一账号的 Key 集合会随活跃度增减, 所以只有双方非空且
 * 完全不相交才判为冲突 (见 accountsConflict)。
 */
export function accountKeysOf(json) {
  const payload = bizPayload(json)
  if (!payload || typeof payload !== 'object') return []
  const keys = new Set()
  for (const series of payload.series ?? []) {
    const apiKey = series?.api_key
    const tracking = String(apiKey?.tracking_id ?? '')
    const name = String(apiKey?.name ?? '')
    if (tracking || name) keys.add(`${tracking}|${name}`)
  }
  return [...keys].sort()
}

/** 本地已存 Key 集合与当前响应 Key 集合是否冲突 (疑似不同账号)。 */
export function accountsConflict(stored, current) {
  const a = Array.isArray(stored) ? stored.filter(Boolean) : []
  const b = Array.isArray(current) ? current.filter(Boolean) : []
  if (a.length === 0 || b.length === 0) return false
  const set = new Set(a)
  return b.every((key) => !set.has(key))
}

/** 用户汇总接口里值得保留的字段 (余额 / 累计花费)。 */
export function normalizeSummary(json) {
  const payload = bizPayload(json)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const pick = {}
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      pick[key] = value
    }
  }
  return Object.keys(pick).length > 0 ? pick : null
}

// ---------------------------------------------------------------------------
// HTTP 客户端
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildUrl(base, path, params) {
  const url = new URL(path, base)
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url
}

/**
 * 平台客户端。所有方法在失败时抛 PlatformError:
 *  - kind 'expired'  → token 失效, 需要重新登录
 *  - kind 'network'  → 网络不可达 / 超时
 *  - kind 'shape'    → 返回不是 JSON (接口可能已改)
 *  - kind 'platform' → 平台业务错误
 */
export function createPlatformClient(options) {
  const token = String(options?.token ?? '').trim()
  const base = options?.base ?? PLATFORM_BASE
  const fetchImpl = options?.fetch ?? globalThis.fetch
  const timeoutMs = options?.timeoutMs ?? HTTP_TIMEOUT_MS
  const delayMs = options?.delayMs ?? REQUEST_DELAY_MS
  const now = options?.now ?? (() => Date.now())

  if (!token) throw new PlatformError('尚未配置登录凭证', 'expired')
  if (typeof fetchImpl !== 'function') throw new PlatformError('当前运行时不支持 fetch', 'network')

  async function get(path, params) {
    const url = buildUrl(base, path, params)
    let response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const message = error?.name === 'TimeoutError'
        ? `请求超时 (${Math.round(timeoutMs / 1000)}s): ${url.pathname}`
        : `网络请求失败: ${error?.message ?? error}`
      throw new PlatformError(message, 'network')
    }

    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new PlatformError(`接口返回非 JSON (HTTP ${response.status})`, 'shape')
    }

    if (response.status === 401 || response.status === 403) {
      throw new PlatformError('登录已过期或无效, 请重新登录', 'expired')
    }
    const code = String(json?.code ?? '')
    if (SESSION_EXPIRED_CODES.has(code)) {
      throw new PlatformError('登录已过期或无效, 请重新登录', 'expired')
    }
    if (code && !['0', '200', 'success'].includes(code)) {
      throw new PlatformError(`平台接口错误 (code=${code}): ${json?.msg ?? json?.message ?? ''}`, 'platform')
    }
    const bizCode = String(json?.data?.biz_code ?? '0')
    if (!['0', '200'].includes(bizCode)) {
      throw new PlatformError(`平台接口错误: ${json?.data?.biz_msg ?? bizCode}`, 'platform')
    }
    return json
  }

  async function afterRequest() {
    if (delayMs > 0) await sleep(delayMs)
  }

  return {
    token,
    /** 用户汇总 (余额 / 累计花费)。 */
    async getSummary() {
      return normalizeSummary(await get(USER_SUMMARY_PATH, {}))
    },
    /** 日桶用量 (30 天以内窗口)。 */
    async fetchAmount(start, end) {
      const json = await get(AMOUNT_PATH, { start, end, tz: SYNC_TZ_OFFSET_SEC })
      const rows = normalizeAmountWindow(json)
      const keys = accountKeysOf(json)
      await afterRequest()
      return { rows, keys }
    },
    /** 日桶费用。 */
    async fetchCost(start, end) {
      const json = await get(COST_PATH, { start, end, tz: SYNC_TZ_OFFSET_SEC })
      const rows = normalizeCostWindow(json)
      await afterRequest()
      return { rows }
    },
    /** 小时桶用量 (单日窗口)。 */
    async fetchHourlyAmount(start, end) {
      const json = await get(AMOUNT_PATH, { start, end, tz: SYNC_TZ_OFFSET_SEC, bucket: 3600 })
      const rows = normalizeHourlyAmount(json)
      await afterRequest()
      return { rows }
    },
    /** 小时桶费用。 */
    async fetchHourlyCost(start, end) {
      const json = await get(COST_PATH, { start, end, tz: SYNC_TZ_OFFSET_SEC, bucket: 3600 })
      const rows = normalizeHourlyCost(json)
      await afterRequest()
      return { rows }
    },
    /** 供日志/诊断使用的时间戳。 */
    now,
  }
}
