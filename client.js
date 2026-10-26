/**
 * dsh-deepseek-platform-usage — browser half.
 *
 * 设置页「平台用量」分区: DeepSeek 开放平台账单口径的 token / 费用面板。
 * 数据全部来自同源 `GET /api/dsh-platform-usage/*` (宿主半区从平台同步并落库),
 * 这里不联网、不推导口径, 只做取数与渲染。
 *
 * 图表是纯 CSS 堆叠柱, 没有图表库依赖: 每个柱子是一列 flex, 段按数值分配
 * flex-grow, 因此 365 天与 24 小时共用同一套渲染与悬浮提示。
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-platform-usage',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useMemo, useCallback, useRef } = React
    const h = React.createElement

    const API = '/api/dsh-platform-usage'
    const WRITE_HEADER = 'x-dsh-platform-usage-token'
    /** 上次用过的 token.json 路径 (本机记住, 不预置任何机器相关路径)。 */
    const TOKEN_PATH_KEY = 'dsh-platform-usage.token-path'

    function readStoredPath() {
      try {
        return localStorage.getItem(TOKEN_PATH_KEY) ?? ''
      } catch {
        return ''
      }
    }

    function storePath(value) {
      try {
        localStorage.setItem(TOKEN_PATH_KEY, value)
      } catch {
        // 隐私模式 / 存储被禁时不记住路径, 不影响导入
      }
    }

    const PALETTE = ['#4176e6', '#2fa3a0', '#e9a23b', '#9b6be0', '#df5b73', '#4f9d69', '#8a7fd6', '#7b8a99']

    // ---------------------------------------------------------------- 格式化

    const finite = (value) => {
      if (value === null || value === undefined || value === '') return null
      const number = Number(value)
      return Number.isFinite(number) ? number : null
    }

    const num = (value) => {
      const n = finite(value)
      return n === null ? '—' : Math.round(n).toLocaleString('zh-CN')
    }

    /** 万 / 亿 紧凑写法, 卡片和大数字用。 */
    const compact = (value) => {
      const n = finite(value)
      if (n === null) return '—'
      const abs = Math.abs(n)
      if (abs < 10000) return num(n)
      const divisor = abs >= 1e8 ? 1e8 : 1e4
      const suffix = divisor === 1e8 ? '亿' : '万'
      return `${(n / divisor).toFixed(2).replace(/\.?0+$/, '')}${suffix}`
    }

    const currencySymbol = (currencies) => (Array.isArray(currencies) && currencies[0] === 'USD' ? '$' : '¥')

    const money = (value, currencies) => {
      const n = finite(value)
      if (n === null) return '—'
      if (n === 0) return `${currencySymbol(currencies)}0.00`
      const abs = Math.abs(n)
      // 钱只按两位小数为准; 只有不足一元时才多给两位, 免得 ¥0.0042 显示成 ¥0.00
      const digits = abs >= 1 ? 2 : 4
      return `${currencySymbol(currencies)}${n.toLocaleString('zh-CN', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })}`
    }

    const percent = (value) => {
      const n = finite(value)
      return n === null ? '—' : `${(n * 100).toFixed(1).replace(/\.0$/, '')}%`
    }

    const two = (n) => String(n).padStart(2, '0')

    const stamp = (ms) => {
      if (!Number.isFinite(ms)) return ''
      const d = new Date(ms)
      return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
    }

    const dayLabel = (date) => (typeof date === 'string' && date.length === 10 ? date : '')
    const shortDay = (date) => (date.length === 10 ? `${date.slice(5, 7)}-${date.slice(8, 10)}` : date)
    const hourLabel = (hour) => `${two(hour)}:00`

    const colorOf = (index) => PALETTE[index % PALETTE.length]

    // ------------------------------------------------------------------ 取数

    async function request(path, options = {}) {
      let response
      try {
        response = await fetch(API + path, { cache: 'no-store', ...options })
      } catch (error) {
        throw new Error(`本地服务不可达: ${error?.message ?? error}`)
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || !payload || payload.ok !== true) {
        const error = new Error(payload?.message || `HTTP ${response.status}`)
        error.code = payload?.code
        throw error
      }
      return payload
    }

    const writeHeaders = (token) => ({ 'content-type': 'application/json', [WRITE_HEADER]: token })

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    // ------------------------------------------------------------ 纯展示组件

    function Section({ title, extra, children, className }) {
      return h('section', { className: `pu-panel${className ? ` ${className}` : ''}` },
        h('div', { className: 'pu-panel-head' },
          h('div', { className: 'pu-panel-title' }, title),
          extra ? h('div', { className: 'pu-panel-extra' }, extra) : null),
        children)
    }

    function Segmented({ options, value, onChange, ariaLabel }) {
      return h('div', { className: 'pu-segment', role: 'group', 'aria-label': ariaLabel },
        options.map(([key, label]) => h('button', {
          key,
          type: 'button',
          className: value === key ? 'active' : '',
          'aria-pressed': value === key,
          onClick: () => onChange(key),
        }, label)))
    }

    function Metric({ label, value, sub }) {
      return h('div', { className: 'pu-card' },
        h('div', { className: 'pu-card-label' }, label),
        h('div', { className: 'pu-card-value' }, value),
        sub ? h('div', { className: 'pu-card-sub' }, sub) : null)
    }

    /**
     * 堆叠柱状图。points: [{ key, label, tokens, requests, cost, values }]。
     */
    function StackedBars({ points, segments, onSelect, selectedKey, axisEvery, ariaLabel }) {
      const [hover, setHover] = useState(null)
      const max = useMemo(() => {
        let peak = 0
        for (const point of points) peak = Math.max(peak, point.tokens || 0)
        return peak > 0 ? peak : 1
      }, [points])

      const ticks = useMemo(() => {
        const count = points.length
        if (count === 0) return []
        const step = axisEvery ?? Math.max(1, Math.ceil(count / 8))
        const indexes = []
        for (let i = 0; i < count; i += step) indexes.push(i)
        const last = count - 1
        if (indexes[indexes.length - 1] !== last) {
          // 最后一个刻度必须存在, 但它和上一个挨得太近时宁可让位给"最后一天",
          // 否则 30 天区间末尾会出现重叠的 "10-25 10-26"。
          if (last - indexes[indexes.length - 1] < step * 0.6) indexes.pop()
          indexes.push(last)
        }
        return indexes
      }, [points.length, axisEvery])

      const tipAlign = (index) => {
        if (index <= 2) return ' pu-tip-start'
        if (index >= points.length - 3) return ' pu-tip-end'
        return ''
      }

      const topSegments = (point) => segments
        .map((segment) => ({ segment, value: point.values[segment.id] || 0 }))
        .filter((entry) => entry.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 4)

      return h('div', { className: 'pu-bars' },
        h('div', { className: 'pu-bars-body' },
          h('div', { className: 'pu-axis', 'aria-hidden': 'true' },
            h('span', null, compact(max)),
            h('span', null, compact(max / 2)),
            h('span', null, '0')),
          h('div', { className: 'pu-plot', role: 'group', 'aria-label': ariaLabel },
            h('div', { className: 'pu-grid', 'aria-hidden': 'true' },
              h('span', null), h('span', null), h('span', null)),
            points.map((point, index) => {
              const height = Math.max(0, Math.min(1, (point.tokens || 0) / max))
              const isHover = hover === index
              const isSelected = selectedKey === point.key
              const interactive = typeof onSelect === 'function'
              return h('div', {
                key: point.key,
                className: `pu-slot${isSelected ? ' pu-on' : ''}${isHover ? ' pu-hover' : ''}`,
                role: interactive ? 'button' : undefined,
                tabIndex: interactive ? 0 : undefined,
                'aria-label': `${point.label}: ${num(point.tokens)} tokens, ${num(point.requests)} 次请求, ${money(point.cost)}`,
                onClick: interactive ? () => onSelect(point.key) : undefined,
                onKeyDown: interactive
                  ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelect(point.key)
                    }
                  }
                  : undefined,
                onMouseEnter: () => setHover(index),
                onMouseLeave: () => setHover((current) => (current === index ? null : current)),
                onFocus: () => setHover(index),
                onBlur: () => setHover((current) => (current === index ? null : current)),
              },
              h('div', { className: `pu-col${height === 0 ? ' pu-col-empty' : ''}`, style: { height: `${height * 100}%` } },
                segments.map((segment, segmentIndex) => {
                  const value = point.values[segment.id] || 0
                  if (value <= 0) return null
                  return h('div', {
                    key: segment.id,
                    className: 'pu-seg',
                    style: { flexGrow: value, background: colorOf(segmentIndex) },
                  })
                })),
              isHover
                ? h('div', { className: `pu-tip${tipAlign(index)}`, role: 'tooltip' },
                  h('div', { className: 'pu-tip-title' }, point.label),
                  h('div', { className: 'pu-tip-row' },
                    h('span', { className: 'pu-tip-label' }, 'Tokens'),
                    h('span', { className: 'pu-tip-value' }, num(point.tokens))),
                  h('div', { className: 'pu-tip-row' },
                    h('span', { className: 'pu-tip-label' }, '请求'),
                    h('span', { className: 'pu-tip-value' }, num(point.requests))),
                  h('div', { className: 'pu-tip-row' },
                    h('span', { className: 'pu-tip-label' }, '费用'),
                    h('span', { className: 'pu-tip-value' }, money(point.cost))),
                  topSegments(point).map((entry) => h('div', { key: entry.segment.id, className: 'pu-tip-row pu-tip-sub' },
                    h('span', { className: 'pu-tip-dot', style: { background: colorOf(segments.indexOf(entry.segment)) } }),
                    h('span', { className: 'pu-tip-label' }, entry.segment.label),
                    h('span', { className: 'pu-tip-value' }, num(entry.value)))))
                : null)
            }))),
        h('div', { className: 'pu-xaxis', 'aria-hidden': 'true' },
          points.map((point, index) => h('span', {
            key: point.key,
            className: `pu-x-tick${ticks.includes(index) ? '' : ' pu-x-hidden'}${index === 0 ? ' pu-x-first' : ''}${index === points.length - 1 ? ' pu-x-last' : ''}`,
          }, ticks.includes(index) ? point.shortLabel ?? point.label : ''))))
    }

    function Legend({ segments }) {
      if (!segments || segments.length === 0) return null
      const shown = segments.slice(0, 8)
      return h('div', { className: 'pu-legend' },
        shown.map((segment, index) => h('span', { key: segment.id, className: 'pu-legend-item' },
          h('span', { className: 'pu-legend-dot', style: { background: colorOf(index) } }),
          segment.label,
          h('span', { className: 'pu-legend-num' }, compact(segment.total)))),
        segments.length > shown.length
          ? h('span', { className: 'pu-legend-item pu-legend-more' }, `另 ${segments.length - shown.length} 项`)
          : null)
    }

    // -------------------------------------------------------------- 主要区域

    function AuthPanel({ status, busy, error, onSave }) {
      const [mode, setMode] = useState('file')
      const [path, setPath] = useState(readStoredPath)
      const [token, setToken] = useState('')
      const saving = busy === 'save'

      const submit = () => {
        if (mode === 'file') {
          if (!path.trim()) return
          storePath(path.trim())
          onSave({ path: path.trim() })
        } else if (token.trim()) {
          onSave({ token: token.trim() })
        }
      }

      return h(Section, { title: '绑定平台凭证', className: 'pu-auth' },
        h('p', { className: 'pu-muted pu-auth-lead' },
          '平台登录页在 platform.deepseek.com, 它不是 OAuth, 插件读不到浏览器里的登录态 —— 所以需要你提供一次 userToken。'
          + '拿到之后, 同步、统计、历史全部在 DSH 里完成, 不再需要外部程序。'),
        h(Segmented, {
          ariaLabel: '凭证来源',
          value: mode,
          onChange: setMode,
          options: [['file', '从 token.json 导入'], ['paste', '粘贴 userToken']],
        }),
        mode === 'file'
          ? h('div', { className: 'pu-form' },
            h('label', { className: 'pu-label', htmlFor: 'pu-path' }, 'token.json 路径'),
            h('div', { className: 'pu-row' },
              h('input', {
                id: 'pu-path',
                className: 'pu-input',
                value: path,
                spellCheck: false,
                onChange: (event) => setPath(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') submit() },
                placeholder: 'C:\\path\\to\\token.json',
              }),
              h('button', {
                className: 'pu-button pu-primary',
                type: 'button',
                disabled: saving || !path.trim(),
                onClick: submit,
              }, saving ? '验证中…' : '导入并验证')),
            h('p', { className: 'pu-hint' },
              '文件内容形如 {"user_token":"..."}; deepseek-api-usage-statistics 登录后会在它的 data/token.json 写出这一份。路径会记在本机, 下次自动填好。'))
          : h('div', { className: 'pu-form' },
            h('label', { className: 'pu-label', htmlFor: 'pu-token' }, 'userToken'),
            h('textarea', {
              id: 'pu-token',
              className: 'pu-input pu-textarea',
              value: token,
              spellCheck: false,
              rows: 3,
              onChange: (event) => setToken(event.target.value),
              placeholder: '{"value":"...","__version":"0"} 或直接粘贴 token 文本',
            }),
            h('div', { className: 'pu-row pu-row-end' },
              h('button', {
                className: 'pu-button pu-primary',
                type: 'button',
                disabled: saving || !token.trim(),
                onClick: submit,
              }, saving ? '验证中…' : '校验并保存'))),
        h('details', { className: 'pu-help' },
          h('summary', null, '怎么自己拿到 userToken？'),
          h('ol', null,
            h('li', null, '浏览器打开并登录 platform.deepseek.com。'),
            h('li', null, 'F12 → Application / 存储 → Local Storage → https://platform.deepseek.com。'),
            h('li', null, '找到 userToken, 复制它的值 (形如 {"value":"...","__version":"0"})。'),
            h('li', null, '粘到上面, 或把这段 JSON 存成 token.json 用第一种方式导入。'))),
        h('p', { className: 'pu-hint' },
          '凭证明文保存在本机的插件存储里, 只用于设置页这一个面板; 路由只服务 127.0.0.1, 写操作还要求本次启动生成的令牌。'),
        error ? h('div', { className: 'pu-error', role: 'alert' }, error) : null)
    }

    function Overview({ status }) {
      const summary = status.summary
      const currencies = summary?.currencies ?? []
      const { total, monthScope, todayScope } = summary
      return h('div', { className: 'pu-metrics' },
        h(Metric, {
          label: '累计 Tokens',
          value: compact(total.tokens),
          sub: `${num(total.requests)} 次请求 · ${summary.days || 0} 天`,
        }),
        h(Metric, {
          label: '累计花费',
          value: money(total.cost, currencies),
          sub: summary.earliest ? `${summary.earliest} 起, 按平台账单` : '暂无费用数据',
        }),
        h(Metric, {
          label: '本月 Tokens',
          value: compact(monthScope.tokens),
          sub: `${money(monthScope.cost, currencies)} · 请求 ${num(monthScope.requests)}`,
        }),
        h(Metric, {
          label: '今日 Tokens',
          value: compact(todayScope.tokens),
          sub: `${money(todayScope.cost, currencies)} · 请求 ${num(todayScope.requests)}`,
        }))
    }

    function TrendSection({ state, group, range, onGroup, onRange, onPickDay, onBack, hourly, hourlyLoading }) {
      const daily = state.series
      const view = state.selectedDay ? hourly : daily
      const isHourly = Boolean(state.selectedDay)
      const points = useMemo(() => {
        if (!view) return []
        if (isHourly) {
          return (view.hours ?? []).map((entry) => ({
            key: String(entry.hour),
            label: `${dayLabel(state.selectedDay)} ${hourLabel(entry.hour)}`,
            shortLabel: hourLabel(entry.hour),
            tokens: entry.tokens,
            requests: entry.requests,
            cost: entry.cost,
            values: entry.values,
          }))
        }
        return (view.days ?? []).map((entry) => ({
          key: entry.date,
          label: dayLabel(entry.date),
          shortLabel: shortDay(entry.date),
          tokens: entry.tokens,
          requests: entry.requests,
          cost: entry.cost,
          values: entry.values,
        }))
      }, [view, isHourly, state.selectedDay])

      const totals = view?.totals ?? { tokens: 0, requests: 0, cost: 0 }
      const rangeText = isHourly
        ? `${state.selectedDay} 每小时`
        : daily
          ? `${daily.scope.start} 至 ${daily.scope.end}`
          : ''

      const extra = isHourly
        ? h('button', { className: 'pu-button pu-back', type: 'button', onClick: onBack }, '← 返回按天')
        : h('div', { className: 'pu-controls' },
          h(Segmented, {
            ariaLabel: '分组方式',
            value: group,
            onChange: onGroup,
            options: [['model', '按模型'], ['type', '按计费类型'], ['key', '按 API Key']],
          }),
          h(Segmented, {
            ariaLabel: '时间范围',
            value: range,
            onChange: onRange,
            options: [['7', '7 天'], ['30', '30 天'], ['90', '90 天'], ['365', '365 天'], ['all', '全部']],
          }))

      return h(Section, {
        title: isHourly ? `分时用量 · ${state.selectedDay}` : '每日用量',
        extra,
        className: 'pu-trend',
      },
      h('div', { className: 'pu-sub' }, rangeText,
        h('span', { className: 'pu-sep' }, '·'),
        `区间合计 ${compact(totals.tokens)} tokens`,
        h('span', { className: 'pu-sep' }, '·'),
        `${money(totals.cost, view?.totals?.currencies)}`,
        h('span', { className: 'pu-sep' }, '·'),
        `请求 ${num(totals.requests)}`),
      hourlyLoading
        ? h('div', { className: 'pu-loading' }, '正在读取分时数据…')
        : points.length === 0 || (isHourly && (view?.totals?.tokens || 0) === 0 && (view?.totals?.requests || 0) === 0)
          ? h('div', { className: 'pu-empty' },
            isHourly
              ? '这一天没有分时数据。平台只保留最近两天的小时明细, 更早的日期只有按天汇总。'
              : '这个区间还没有数据, 点右上角「立即同步」从平台拉取。')
          : h(React.Fragment, null,
            h(StackedBars, {
              points,
              segments: view?.segments ?? [],
              onSelect: isHourly ? undefined : onPickDay,
              selectedKey: isHourly ? null : state.selectedDay,
              ariaLabel: isHourly ? '分时用量' : '每日用量',
            }),
            h(Legend, { segments: view?.segments ?? [] })),
      !isHourly && daily
        ? h('p', { className: 'pu-hint' }, '点任意一天看当天的 24 小时明细。')
        : null)
    }

    function BreakdownSection({ breakdown }) {
      const [tab, setTab] = useState('models')
      if (!breakdown) return null
      const isModels = tab === 'models'
      const rows = isModels ? breakdown.models : breakdown.keys
      const totalTokens = rows.reduce((sum, row) => sum + (row.tokens || 0), 0)
      const rowLabel = isModels ? '模型' : 'API Key'
      if (rows.length === 0) return null
      return h(Section, {
        title: '用量构成',
        extra: h(Segmented, {
          ariaLabel: '构成维度',
          value: tab,
          onChange: setTab,
          options: [['models', '模型'], ['keys', 'API Key']],
        }),
      },
      h('div', { className: 'pu-table-wrap' },
        h('table', { className: 'pu-table' },
          h('thead', null,
            h('tr', null,
              h('th', null, rowLabel),
              h('th', { className: 'pu-num' }, 'Tokens'),
              h('th', { className: 'pu-num' }, '占比'),
              h('th', { className: 'pu-num' }, '请求'),
              h('th', { className: 'pu-num' }, '费用'))),
          h('tbody', null,
            rows.map((row, index) => h('tr', { key: row.id || index },
              h('td', null, h('span', { className: 'pu-dot', style: { background: colorOf(index) } }), row.label),
              h('td', { className: 'pu-num' }, num(row.tokens)),
              h('td', { className: 'pu-num' }, percent(totalTokens > 0 ? row.tokens / totalTokens : null)),
              h('td', { className: 'pu-num' }, num(row.requests)),
              h('td', { className: 'pu-num' }, money(row.cost, breakdown.currencies))))))))
    }

    /** 自动同步间隔的展示文案 (0 = 关闭)。 */
    const intervalLabel = (minutes) => {
      if (!(minutes > 0)) return '关闭'
      if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`
      return `每 ${minutes} 分钟`
    }

    function AccountFooter({ status, busy, onLogout, onClear, onConfig, error }) {
      const [confirming, setConfirming] = useState(false)
      const tokenState = status.tokenState
      const source = tokenState?.source === 'file' ? 'token.json 导入' : '手动粘贴'
      const autoMinutes = status.meta.autoSyncMinutes ?? 0
      const choices = Array.isArray(status.meta.autoSyncChoices) ? status.meta.autoSyncChoices : [0, 15, 30, 60, 180]
      const nextAt = status.meta.nextAutoSyncAt
      return h(Section, { title: '凭证与数据' },
        h('div', { className: 'pu-meta-grid' },
          h('div', null, h('span', { className: 'pu-label' }, '凭证'), h('div', null, source, tokenState?.savedAt ? ` · 保存于 ${stamp(tokenState.savedAt)}` : '')),
          h('div', null, h('span', { className: 'pu-label' }, '上次同步'),
            h('div', null, status.meta.lastSyncAt ? stamp(status.meta.lastSyncAt) : '从未同步')),
          h('div', null, h('span', { className: 'pu-label' }, '数据范围'),
            h('div', null, status.meta.earliest ? `${status.meta.earliest} ~ ${status.meta.latest ?? '—'}` : '空')),
          h('div', null, h('span', { className: 'pu-label' }, '本地存储'),
            h('div', null, status.persistent ? 'DSH 插件存储' : '仅内存 (存储后端不可用)'))),
        status.meta.lastSyncMessage
          ? h('p', { className: 'pu-hint' }, `上次结果: ${status.meta.lastSyncMessage}`)
          : null,
        h('div', { className: 'pu-config-row' },
          h('label', { className: 'pu-label', htmlFor: 'pu-auto-sync' }, '自动同步'),
          h('select', {
            id: 'pu-auto-sync',
            className: 'pu-select',
            value: String(autoMinutes),
            disabled: busy === 'config',
            onChange: (event) => onConfig(Number(event.target.value)),
          }, choices.map((value) => h('option', { key: value, value: String(value) }, intervalLabel(value)))),
          h('span', { className: 'pu-hint pu-inline' },
            busy === 'config'
              ? '保存中…'
              : autoMinutes > 0
                ? (nextAt && nextAt > Date.now() ? `下次约 ${stamp(nextAt)}` : '下一分钟内会补一次')
                : '只在启动和手动点「立即同步」时更新')),
        error ? h('div', { className: 'pu-error', role: 'alert' }, error) : null,
        h('div', { className: 'pu-actions' },
          h('button', { className: 'pu-button', type: 'button', disabled: busy === 'logout', onClick: onLogout },
            busy === 'logout' ? '处理中…' : '退出登录'),
          confirming
            ? h(React.Fragment, null,
              h('button', { className: 'pu-button pu-danger', type: 'button', disabled: busy === 'clear', onClick: () => { setConfirming(false); onClear() } },
                busy === 'clear' ? '清空中…' : '确认清空'),
              h('button', { className: 'pu-button', type: 'button', onClick: () => setConfirming(false) }, '取消'))
            : h('button', { className: 'pu-button', type: 'button', onClick: () => setConfirming(true) }, '清空数据')))
    }

    // ------------------------------------------------------------------ 主体

    function PlatformUsageSection() {
      const [status, setStatus] = useState(null)
      const [statusError, setStatusError] = useState(null)
      const [actionError, setActionError] = useState(null)
      const [busy, setBusy] = useState('')
      const [group, setGroup] = useState('model')
      const [range, setRange] = useState('30')
      const [series, setSeries] = useState(null)
      const [breakdown, setBreakdown] = useState(null)
      const [seriesError, setSeriesError] = useState(null)
      const [selectedDay, setSelectedDay] = useState(null)
      const [hourly, setHourly] = useState(null)
      const [hourlyLoading, setHourlyLoading] = useState(false)
      const [reloadKey, setReloadKey] = useState(0)
      const mounted = useRef(true)

      useEffect(() => () => { mounted.current = false }, [])

      const loadStatus = useCallback(async () => {
        try {
          const next = await request('/status')
          if (mounted.current) {
            setStatus(next)
            setStatusError(null)
          }
          return next
        } catch (error) {
          if (mounted.current) setStatusError(error.message)
          return null
        }
      }, [])

      useEffect(() => { void loadStatus() }, [loadStatus])

      const configured = Boolean(status?.configured)
      const lastSyncAt = status?.meta?.lastSyncAt ?? null

      useEffect(() => {
        if (!configured) return undefined
        let cancelled = false
        void (async () => {
          try {
            const query = new URLSearchParams({ days: range, group })
            const [nextSeries, nextBreakdown] = await Promise.all([
              request(`/series?${query.toString()}`),
              request(`/breakdown?${query.toString()}`),
            ])
            if (cancelled) return
            setSeries(nextSeries)
            setBreakdown(nextBreakdown)
            setSeriesError(null)
          } catch (error) {
            if (!cancelled) setSeriesError(error.message)
          }
        })()
        return () => { cancelled = true }
      }, [configured, range, group, lastSyncAt, reloadKey])

      useEffect(() => {
        if (!selectedDay) {
          setHourly(null)
          return undefined
        }
        let cancelled = false
        setHourlyLoading(true)
        void (async () => {
          try {
            const next = await request(`/hourly?date=${selectedDay}&group=${group}`)
            if (!cancelled) setHourly(next)
          } catch (error) {
            if (!cancelled) setHourly({ hours: [], segments: [], totals: { tokens: 0, requests: 0, cost: 0 }, error: error.message })
          } finally {
            if (!cancelled) setHourlyLoading(false)
          }
        })()
        return () => { cancelled = true }
      }, [selectedDay, group])

      const watchSync = useCallback(async () => {
        for (let i = 0; i < 400; i += 1) {
          await delay(1200)
          if (!mounted.current) return
          const next = await loadStatus()
          if (!next || !next.sync.running) break
        }
        await loadStatus()
        if (mounted.current) setBusy('')
      }, [loadStatus])

      // 面板开着时每 30 秒读一次状态: 后台自动同步完成后, 数字和图会自己更新
      useEffect(() => {
        const timer = setInterval(() => { void loadStatus() }, 30_000)
        return () => clearInterval(timer)
      }, [loadStatus])

      const startSync = useCallback(async (token) => {
        if (!token) return
        setBusy('sync')
        setActionError(null)
        try {
          await request('/sync', { method: 'POST', headers: writeHeaders(token), body: '{}' })
          await watchSync()
        } catch (error) {
          setActionError(error.message)
          setBusy('')
          await loadStatus()
        }
      }, [watchSync, loadStatus])

      const saveToken = useCallback(async (body) => {
        if (!status?.token) return
        let next = null
        setBusy('save')
        setActionError(null)
        try {
          next = await request('/token', {
            method: 'POST',
            headers: writeHeaders(status.token),
            body: JSON.stringify(body),
          })
          setStatus(next)
        } catch (error) {
          setActionError(error.message)
        }
        if (mounted.current) setBusy('')
        // 凭证刚绑定好: 直接补一次历史, 省得用户还要再点一次「立即同步」
        if (next) void startSync(next.token)
      }, [status?.token, startSync])

      const logout = useCallback(async () => {
        if (!status?.token) return
        setBusy('logout')
        setActionError(null)
        try {
          const next = await request('/logout', { method: 'POST', headers: writeHeaders(status.token), body: '{}' })
          setStatus(next)
          setSeries(null)
          setBreakdown(null)
          setSelectedDay(null)
        } catch (error) {
          setActionError(error.message)
        } finally {
          if (mounted.current) setBusy('')
        }
      }, [status?.token])

      const clearData = useCallback(async () => {
        if (!status?.token) return
        setBusy('clear')
        setActionError(null)
        try {
          const next = await request('/clear', { method: 'POST', headers: writeHeaders(status.token), body: '{}' })
          setStatus(next.status)
          setSeries(null)
          setBreakdown(null)
          setSelectedDay(null)
        } catch (error) {
          setActionError(error.message)
        } finally {
          if (mounted.current) setBusy('')
        }
      }, [status?.token])

      const saveConfig = useCallback(async (minutes) => {
        if (!status?.token) return
        setBusy('config')
        setActionError(null)
        try {
          const next = await request('/config', {
            method: 'POST',
            headers: writeHeaders(status.token),
            body: JSON.stringify({ autoSyncMinutes: minutes }),
          })
          setStatus(next.status)
        } catch (error) {
          setActionError(error.message)
        } finally {
          if (mounted.current) setBusy('')
        }
      }, [status?.token])

      const syncing = busy === 'sync' || Boolean(status?.sync?.running)

      const header = h('header', { className: 'pu-head' },
        h('div', null,
          h('div', { className: 'pu-title' }, '平台用量'),
          h('div', { className: 'pu-sub' },
            'DeepSeek 开放平台账单口径',
            status?.meta?.lastSyncAt
              ? h('span', null, h('span', { className: 'pu-sep' }, '·'), `数据更新于 ${stamp(status.meta.lastSyncAt)}`)
              : null,
            status?.meta?.earliest
              ? h('span', null, h('span', { className: 'pu-sep' }, '·'), `覆盖 ${status.meta.earliest} ~ ${status.meta.latest ?? '—'}`)
              : null)),
        h('div', { className: 'pu-actions' },
          h('button', { className: 'pu-button', type: 'button', onClick: () => { void loadStatus(); setReloadKey((n) => n + 1) }, disabled: syncing }, '刷新'),
          configured
            ? h('button', { className: 'pu-button pu-primary', type: 'button', onClick: () => { void startSync(status?.token) }, disabled: syncing },
              syncing
                ? (status?.sync?.stage === 'cost' ? '同步费用…' : status?.sync?.stage === 'hourly' ? '同步分时…' : '同步中…')
                : '立即同步')
            : null))

      const body = statusError
        ? h('div', { className: 'pu-error', role: 'alert' }, `读取插件状态失败: ${statusError}`)
        : !status
          ? h('div', { className: 'pu-loading' }, '正在读取插件状态…')
          : !configured
            ? h(AuthPanel, { status, busy, error: actionError, onSave: (body) => void saveToken(body) })
            : h(React.Fragment, null,
              status.meta.lastSyncStatus === 'expired'
                ? h('div', { className: 'pu-banner pu-banner-warn', role: 'status' },
                  '登录已过期: 重新导入一次 token 即可继续同步 (本地历史不受影响)。')
                : null,
              status.meta.lastSyncStatus === 'account-changed'
                ? h('div', { className: 'pu-banner pu-banner-warn', role: 'status' },
                  '当前 token 属于另一个账号: 本地历史已保留。要换成新账号, 先「清空数据」再同步。')
                : null,
              actionError && !seriesError ? h('div', { className: 'pu-error', role: 'alert' }, actionError) : null,
              h(Overview, { status }),
              seriesError
                ? h('div', { className: 'pu-error', role: 'alert' }, `读取用量失败: ${seriesError}`)
                : h(TrendSection, {
                  state: { series, selectedDay, hourly },
                  group,
                  range,
                  onGroup: setGroup,
                  onRange: setRange,
                  onPickDay: (day) => setSelectedDay(day),
                  onBack: () => setSelectedDay(null),
                  hourly,
                  hourlyLoading,
                }),
              h(BreakdownSection, { breakdown }),
              h(AccountFooter, {
                status,
                busy,
                onLogout: () => void logout(),
                onClear: () => void clearData(),
                onConfig: (minutes) => void saveConfig(minutes),
                error: actionError,
              }))

      return h('div', { className: 'pu-root' },
        h('style', null, CSS),
        header,
        body)
    }

    // ------------------------------------------------------------------- 样式

    const CSS = `
.pu-root{position:relative;max-width:1180px;margin:0 auto;padding:24px;color:var(--dsw-alias-label-primary,#25252a);background:var(--dsw-alias-bg-base,#f7f7f8);font:13px/1.45 var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);min-width:0}
.pu-root *{box-sizing:border-box}
.pu-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:20px}
.pu-title{font-size:22px;font-weight:650;letter-spacing:-.3px}
.pu-sub{margin-top:3px;color:var(--dsw-alias-label-secondary,#74747c)}
.pu-sep{padding:0 6px;opacity:.6}
.pu-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pu-button{height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l4,#d4d6db);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s}
.pu-button:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,#f1f1f3)}
.pu-button[disabled]{opacity:.55;cursor:default}
.pu-button.pu-primary{background:var(--dsw-alias-state-business-primary,#4176e6);border-color:transparent;color:#fff}
.pu-button.pu-primary:hover:not([disabled]){filter:brightness(1.06);background:var(--dsw-alias-state-business-primary,#4176e6)}
.pu-button.pu-danger{color:var(--dsw-alias-state-error-primary,#bd4747);border-color:var(--dsw-alias-state-error-primary,#bd4747)}
.pu-button.pu-back{height:28px;padding:0 10px;font-size:12px}
.pu-panel{border:1px solid var(--dsw-alias-border-l2,#dedee3);border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-layer-1,#fff);padding:16px;margin-bottom:16px;min-width:0}
.pu-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.pu-panel-title{font-weight:600;font-size:14px}
.pu-panel-extra{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pu-segment{display:inline-flex;gap:2px;padding:3px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-interactive-bg-hover,#f1f1f3)}
.pu-segment button{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#74747c);border-radius:var(--dsw-radius-sm,6px);padding:5px 10px;font:inherit;font-size:12px;cursor:pointer}
.pu-segment button:hover{color:inherit}
.pu-segment button.active{background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.pu-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}
.pu-card{padding:18px 20px;border:.5px solid var(--dsw-alias-border-l2,#dedee3);border-radius:20px;min-width:0;background:transparent}
.pu-card-label{color:var(--dsw-alias-label-secondary,#74747c);font-size:13px}
.pu-card-value{margin-top:6px;font-size:23px;font-weight:650;line-height:1.2;letter-spacing:-.4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pu-card-sub{margin-top:4px;color:var(--dsw-alias-label-tertiary,#9a9aa3);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pu-bars{display:flex;flex-direction:column;gap:6px;min-height:200px}
.pu-bars-body{display:flex;align-items:stretch;gap:8px;padding-top:4px}
.pu-axis{flex:none;width:52px;height:170px;position:relative;color:var(--dsw-alias-label-tertiary,#9a9aa3);font-size:11px;line-height:1}
.pu-axis span{position:absolute;right:0;white-space:nowrap}
.pu-axis span:nth-child(1){top:0}
.pu-axis span:nth-child(2){top:50%;transform:translateY(-50%)}
.pu-axis span:nth-child(3){top:100%;transform:translateY(-100%)}
.pu-plot{position:relative;flex:1;min-width:0;display:flex;align-items:flex-end;gap:var(--pu-bar-gap,2px);height:170px}
.pu-grid{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:space-between;pointer-events:none}
.pu-grid span{border-top:1px solid var(--dsw-alias-border-l1,#0000000a);height:0}
.pu-grid span:last-child{border-top-color:var(--dsw-alias-border-l2,#dedee3)}
.pu-slot{flex:1 1 0;min-width:0;height:100%;display:flex;align-items:flex-end;position:relative;padding:0;border:0;background:transparent;cursor:pointer;outline:none}
.pu-slot:not([role=button]){cursor:default}
.pu-col{width:100%;display:flex;flex-direction:column-reverse;border-radius:3px 3px 0 0;overflow:hidden;opacity:.88;transition:opacity .12s ease,filter .12s ease}
.pu-slot:hover .pu-col,.pu-slot.pu-on .pu-col{opacity:1;filter:brightness(1.04)}
.pu-col-empty{min-height:1px;background:var(--dsw-alias-border-l2,#dedee3);opacity:.5}
.pu-seg{width:100%;min-height:1px}
.pu-slot:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:2px;border-radius:3px}
.pu-tip{position:absolute;z-index:8;left:50%;bottom:calc(100% + 6px);transform:translateX(-50%);min-width:150px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l2,#dedee3);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 8px 24px rgba(0,0,0,.12);pointer-events:none;white-space:nowrap}
.pu-tip.pu-tip-start{left:0;transform:none}
.pu-tip.pu-tip-end{left:auto;right:0;transform:none}
.pu-tip-title{font-weight:650;margin-bottom:5px;font-size:12px}
.pu-tip-row{display:flex;align-items:center;gap:8px;font-size:12px;line-height:1.6}
.pu-tip-label{color:var(--dsw-alias-label-secondary,#74747c)}
.pu-tip-value{margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums}
.pu-tip-sub .pu-tip-value{font-weight:500;color:var(--dsw-alias-label-secondary,#74747c)}
.pu-tip-dot{width:7px;height:7px;border-radius:2px;flex:none}
.pu-xaxis{display:flex;gap:var(--pu-bar-gap,2px);padding-left:60px;font-size:11px;color:var(--dsw-alias-label-secondary,#74747c)}
.pu-x-tick{flex:1 1 0;min-width:0;text-align:center;white-space:nowrap;overflow:visible}
.pu-x-tick.pu-x-hidden{color:transparent}
.pu-x-tick.pu-x-first{text-align:left}
.pu-x-tick.pu-x-last{text-align:right}
.pu-legend{display:flex;flex-wrap:wrap;gap:10px 16px;margin-top:14px;font-size:12px;color:var(--dsw-alias-label-secondary,#74747c)}
.pu-legend-item{display:inline-flex;align-items:center;gap:6px;min-width:0}
.pu-legend-dot{width:8px;height:8px;border-radius:2px;flex:none}
.pu-legend-num{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#9a9aa3)}
.pu-legend-more{opacity:.75}
.pu-table-wrap{overflow-x:auto;max-width:100%}
.pu-table{width:100%;border-collapse:collapse;table-layout:fixed}
.pu-table th{padding:0 8px 8px;text-align:left;font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary,#74747c)}
.pu-table td{padding:9px 8px;border-top:1px solid var(--dsw-alias-border-l2,#dedee3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}
.pu-table th:first-child,.pu-table td:first-child{padding-left:0}
.pu-table th:last-child,.pu-table td:last-child{padding-right:0}
.pu-num{text-align:right;font-variant-numeric:tabular-nums}
.pu-dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:7px;vertical-align:middle}
.pu-form{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}
.pu-label{font-size:12px;color:var(--dsw-alias-label-secondary,#74747c)}
.pu-row{display:flex;gap:8px;align-items:center}
.pu-row-end{justify-content:flex-end}
.pu-input{flex:1;min-width:0;height:34px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4,#d4d6db);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:13px}
.pu-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary,#4176e6);box-shadow:0 0 0 2px rgba(65,118,230,.15)}
.pu-textarea{height:auto;padding:8px 10px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5}
.pu-hint{margin:8px 0 0;color:var(--dsw-alias-label-tertiary,#9a9aa3);font-size:12px}
.pu-hint.pu-inline{margin:0}
.pu-config-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:14px 0 4px}
.pu-select{height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4,#d4d6db);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:13px;cursor:pointer}
.pu-select:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary,#4176e6);box-shadow:0 0 0 2px rgba(65,118,230,.15)}
.pu-muted{color:var(--dsw-alias-label-secondary,#74747c)}
.pu-auth-lead{margin:0 0 14px;max-width:760px;font-size:13px;line-height:1.6}
.pu-auth .pu-segment{margin-bottom:12px}
.pu-help{margin:14px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary,#74747c)}
.pu-help summary{cursor:pointer;color:var(--dsw-alias-label-primary,#25252a)}
.pu-help ol{margin:8px 0 0;padding-left:20px;line-height:1.8}
.pu-error{margin-top:10px;padding:9px 12px;border-radius:8px;background:rgba(189,71,71,.08);color:var(--dsw-alias-state-error-primary,#bd4747);font-size:12px}
.pu-banner{margin-bottom:12px;padding:10px 14px;border-radius:10px;font-size:12px}
.pu-banner-warn{background:rgba(233,162,59,.12);color:#8a5a12}
.pu-empty,.pu-loading{padding:36px 12px;text-align:center;color:var(--dsw-alias-label-secondary,#74747c)}
.pu-meta-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:12px}
.pu-meta-grid .pu-label{display:block;margin-bottom:2px}
.pu-root .pu-hint+.pu-actions{margin-top:8px}
@media(max-width:900px){.pu-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.pu-meta-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:560px){.pu-root{padding:16px}.pu-metrics{grid-template-columns:1fr}.pu-head{display:block}.pu-actions{margin-top:12px}}
@media(prefers-reduced-motion:reduce){.pu-root *{transition:none!important}}
`

    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-deepseek-platform-usage',
        order: 66,
        label: () => (typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '') ? '平台用量' : 'Platform Usage'),
        inject: () => ({}),
      }, PlatformUsageSection))
    }

    return { inject, apply }
  },
})
