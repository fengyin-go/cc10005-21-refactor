import { useMemo, useState } from 'react'

import { request } from '@/api/client'
import { useRowActionGuard } from '@/hooks/useRowActionGuard'
import {
  INTENT_ORIGIN_LABELS,
  INTENT_PHASE_LABELS,
  useIntentBrowser,
  type IntentRecord,
} from '@/hooks/useIntentBrowser'

const ENDPOINT = '/api/schedule'
const columns = [
  "规则编号",
  "关联站点",
  "调度表达式",
  "最大并发",
  "优先级",
  "生效时段",
  "执行超时",
  "漏触发补偿"
]
const actions = [
  "提交校验",
  "启用调度",
  "停用调度"
]
const statuses = [
  "草稿",
  "待校验",
  "已启用",
  "已停用"
]
const stats = [
  {
    "label": "调度规则总数",
    "value": 0
  },
  {
    "label": "已启用规则",
    "value": 0
  },
  {
    "label": "待校验规则",
    "value": 0
  }
]

type Row = Record<string, string | number | null>
type ActionNotice = { tone: 'success' | 'error' | 'info'; text: string }

export default function ScheduleView() {
  const { busyRows, begin, end, busyActionOf } = useRowActionGuard()
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null)
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const browser = useIntentBrowser<Row>({
    load: async (nextFilters, signal) => {
      const query = new URLSearchParams(nextFilters).toString()
      const response = await request(`${ENDPOINT}?${query}`, { signal })
      if (!response.ok) {
        throw new Error('调度规则列表读取失败')
      }
      const payload = await response.json()
      return { items: payload.items ?? [], total: payload.total ?? 0 }
    },
    fallbackError: '调度策略列表读取失败',
  })

  async function runAction(action: string, row: Row) {
    const rowId = String(row.id)
    if (!begin(rowId, action)) {
      const busyAction = busyActionOf(rowId)
      // 同一行不并发：第二次点击明确落到「已忽略」的提示上，另一行不受影响。
      setActionNotice({
        tone: 'info',
        text: `调度规则 ${row['规则编号'] ?? rowId} 正在执行「${busyAction}」，本次点击已忽略，可继续操作其他行`,
      })
      return
    }

    // 冻结发起动作时的浏览上下文：动作完成后的补读只认这个快照。
    const context = browser.captureActionContext()
    setActionNotice(null)
    try {
      const response = await request(`${ENDPOINT}/${row.id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ values: { action } }),
      })
      const payload = response.ok ? await response.json() : null
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.message || '调度策略动作未生效，请稍后重试')
      }
      // 筛选已经换过：这次动作属于旧页面，不再刷新、也不再提示。
      if (!browser.isActionContextCurrent(context)) return
      browser.refreshForAction(context)
      setActionNotice({
        tone: 'success',
        text: `调度规则 ${row['规则编号'] ?? rowId} 已${action}，列表已按当前条件刷新`,
      })
    } catch (error) {
      // 离页或筛选已切换时，旧动作的错误只留在旧意图里，不覆盖新页面。
      if (!browser.isMounted() || !browser.isActionContextCurrent(context)) return
      setActionNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : '调度策略操作失败',
      })
    } finally {
      end(rowId)
    }
  }

  const { currentIntent, intents, currentIntentId, isFetching } = browser

  return (
    <section className="page" data-module="schedule">
      <header className="page-head">
        <div>
          <h2>调度策略管理</h2>
          <p className="page-desc">维护调度策略的输入、执行约束与结果记录，为调度策略提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setActionNotice({ tone: 'info', text: '调度规则登记入口尚未接入审批流' })}>
            登记调度规则
          </button>
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>
            导出调度策略清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <div className="intent-strip" aria-live="polite">
        {currentIntent ? (
          <div className="intent-current">
            <span className="intent-tag">当前意图 #{currentIntent.id}</span>
            <span>{INTENT_ORIGIN_LABELS[currentIntent.origin]}</span>
            <span className="intent-filter">{currentIntent.label}</span>
            <span className={`intent-phase phase-${currentIntent.phase}`}>
              {INTENT_PHASE_LABELS[currentIntent.phase]}
            </span>
            {isFetching && <span className="intent-spinner">正在取数…</span>}
          </div>
        ) : (
          <div className="intent-current">
            <span className="intent-tag">尚未发起读取</span>
          </div>
        )}
        {intents.length > 0 && (
          <div className="intent-history">
            <span className="intent-history-label">读取轨迹</span>
            {intents.map((intent) => (
              <IntentChip
                key={intent.id}
                intent={intent}
                current={intent.id === currentIntentId}
              />
            ))}
          </div>
        )}
      </div>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); browser.reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={browser.filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => browser.setFilter(field, event.target.value)}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => browser.resetFilters()}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {browser.rows.map((row) => {
            const rowId = String(row.id)
            const busyAction = busyRows[rowId]
            return (
              <tr key={rowId} className={busyAction ? 'row-pending' : undefined}>
                {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                <td className="row-actions">
                  {busyAction && <span className="row-busy">正在执行：{busyAction}</span>}
                  {actions.map((action) => (
                    <button
                      key={action}
                      className={busyAction ? 'link is-busy' : 'link'}
                      type="button"
                      aria-disabled={busyAction ? true : undefined}
                      title={busyAction ? '该行正在处理，再次点击会说明去向且不会重复提交' : undefined}
                      onClick={() => void runAction(action, row)}
                    >
                      {action}
                    </button>
                  ))}
                </td>
              </tr>
            )
          })}
          {browser.rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 1}>
                {isFetching ? '正在读取调度策略列表…' : '暂无调度策略数据，可先登记调度规则'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>
          共 {browser.total} 条调度策略记录
          {isFetching && <span className="intent-inline">· 正在取数</span>}
        </span>
        <span className="foot-notes">
          {browser.listError && <span className="error-text">{browser.listError}</span>}
          {actionNotice && (
            <span className={noticeClass(actionNotice.tone)}>{actionNotice.text}</span>
          )}
        </span>
      </footer>
    </section>
  )
}

function IntentChip({ intent, current }: { intent: IntentRecord; current: boolean }) {
  return (
    <span
      className={`intent-chip phase-${intent.phase}${current ? ' is-current' : ''}`}
      title={`发起于意图 #${intent.id} · ${INTENT_ORIGIN_LABELS[intent.origin]}`}
    >
      #{intent.id} {INTENT_ORIGIN_LABELS[intent.origin]} · {intent.label} · {INTENT_PHASE_LABELS[intent.phase]}
    </span>
  )
}

function noticeClass(tone: ActionNotice['tone']): string {
  if (tone === 'error') return 'error-text'
  if (tone === 'success') return 'success-text'
  return 'muted-text'
}
