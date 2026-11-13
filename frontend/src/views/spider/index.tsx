import { useMemo, useState } from 'react'

import { request } from '@/api/client'
import { useRowActionGuard } from '@/hooks/useRowActionGuard'
import {
  INTENT_ORIGIN_LABELS,
  INTENT_PHASE_LABELS,
  useIntentBrowser,
  type IntentRecord,
} from '@/hooks/useIntentBrowser'

const ENDPOINT = '/api/spider'
const columns = [
  "作业编号",
  "目标站点",
  "抽取模板",
  "起始地址",
  "并发线程数",
  "请求间隔秒",
  "每日上限条数",
  "超时秒数"
]
const actions = [
  "提交执行",
  "启动采集",
  "终止采集",
  "归档结果"
]
const statuses = [
  "草稿",
  "待执行",
  "运行中",
  "已完成",
  "已失败"
]
const stats = [
  {
    "label": "采集作业总数",
    "value": 0
  },
  {
    "label": "运行中作业",
    "value": 0
  },
  {
    "label": "已完成作业",
    "value": 0
  }
]

type Row = Record<string, string | number | null>
type ActionNotice = { tone: 'success' | 'error' | 'info'; text: string }

export default function SpiderView() {
  const { busyRows, begin, end, busyActionOf } = useRowActionGuard()
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null)
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const browser = useIntentBrowser<Row>({
    load: async (nextFilters, signal) => {
      const query = new URLSearchParams(nextFilters).toString()
      const response = await request(`${ENDPOINT}?${query}`, { signal })
      if (!response.ok) {
        throw new Error('采集作业列表读取失败')
      }
      const payload = await response.json()
      return { items: payload.items ?? [], total: payload.total ?? 0 }
    },
    fallbackError: '采集任务列表读取失败',
  })

  async function runAction(action: string, row: Row) {
    const rowId = String(row.id)
    if (!begin(rowId, action)) {
      const busyAction = busyActionOf(rowId)
      // 同一作业不并发：重复点击给出明确去向，其他作业仍可继续操作。
      setActionNotice({
        tone: 'info',
        text: `采集作业 ${row['作业编号'] ?? rowId} 正在执行「${busyAction}」，本次点击已忽略，可继续操作其他行`,
      })
      return
    }

    // 动作完成后的补读必须仍属于发起时的上下文，因此先冻结当前浏览意图。
    const context = browser.captureActionContext()
    setActionNotice(null)
    try {
      const response = await request(`${ENDPOINT}/${row.id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ values: { action } }),
      })
      const payload = response.ok ? await response.json() : null
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.message || '采集任务动作未生效，请稍后重试')
      }
      // 条件已切换或已离页：动作结果属于旧上下文，不再触发列表补读。
      if (!browser.isActionContextCurrent(context)) return
      browser.refreshForAction(context)
      setActionNotice({
        tone: 'success',
        text: `采集作业 ${row['作业编号'] ?? rowId} 已${action}，列表已按当前条件刷新`,
      })
    } catch (error) {
      // 旧上下文的错误不能覆盖新页面：仅在发起时的上下仍有效时展示。
      if (!browser.isMounted() || !browser.isActionContextCurrent(context)) return
      setActionNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : '采集任务操作失败',
      })
    } finally {
      end(rowId)
    }
  }

  const { currentIntent, intents, currentIntentId, isFetching } = browser

  return (
    <section className="page" data-module="spider">
      <header className="page-head">
        <div>
          <h2>采集任务管理</h2>
          <p className="page-desc">维护采集作业的输入、执行约束与结果记录，为采集任务提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setActionNotice({ tone: 'info', text: '采集作业登记入口尚未接入审批流' })}>
            登记采集作业
          </button>
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>
            导出采集任务清单
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
                {isFetching ? '正在读取采集任务列表…' : '暂无采集任务数据，可先登记采集作业'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>
          共 {browser.total} 条采集任务记录
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
