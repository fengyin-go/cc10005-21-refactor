/**
 * 列表读取的意图生命周期。
 *
 * 每次浏览（切换筛选、点查询、重置条件、动作完成后的补读）都新建一个独立意图：
 * - 新浏览意图会取消旧请求，并把旧意图标记为「已作废」；
 * - 响应是否落地只看发起时的意图编号，迟到的乱序响应直接丢弃；
 * - 动作补读必须持有发起动作时的上下文（generation + 筛选快照），
 *   期间用户换了条件就视为旧上下文，既不刷新也不提示；
 * - 离开页面后不再写任何状态，离页后的错误按兼容场景静默处理。
 *
 * 这里只负责「读取」的调度，不承载任何模块的业务动作与文案。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { isAbortError } from '@/api/client'

const MAX_INTENT_HISTORY = 6

export type IntentOrigin = 'browse' | 'action'
export type IntentPhase = 'fetching' | 'settled' | 'failed' | 'superseded'

export type IntentRecord = {
  id: number
  generation: number
  origin: IntentOrigin
  filters: Record<string, string>
  label: string
  phase: IntentPhase
  startedAt: number
}

/** 动作发起时冻结的浏览上下文；动作完成后的补读只认它。 */
export type ActionContext = {
  generation: number
  filters: Record<string, string>
}

export type LoadResult<Row> = {
  items: Row[]
  total: number
}

export type ListLoader<Row> = (
  filters: Record<string, string>,
  signal: AbortSignal,
) => Promise<LoadResult<Row>>

export const INTENT_PHASE_LABELS: Record<IntentPhase, string> = {
  fetching: '取数中',
  settled: '已返回',
  failed: '读取失败',
  superseded: '已作废',
}

export const INTENT_ORIGIN_LABELS: Record<IntentOrigin, string> = {
  browse: '浏览筛选',
  action: '动作后刷新',
}

function describeFilters(filters: Record<string, string>): string {
  const entries = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  return entries.length
    ? entries.map(([field, value]) => `${field}=${value}`).join(' · ')
    : '全部记录'
}

type Options<Row> = {
  load: ListLoader<Row>
  initialFilters?: Record<string, string>
  fallbackError?: string
}

export function useIntentBrowser<Row>({
  load,
  initialFilters,
  fallbackError = '列表读取失败',
}: Options<Row>) {
  const initialFiltersRef = useRef<Record<string, string>>({ ...(initialFilters ?? {}) })
  const [filters, setFilters] = useState<Record<string, string>>(initialFiltersRef.current)
  const filtersRef = useRef(filters)

  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [listError, setListError] = useState('')
  const [intents, setIntents] = useState<IntentRecord[]>([])
  const [currentIntentId, setCurrentIntentId] = useState<number | null>(null)
  const [generation, setGeneration] = useState(0)

  const mountedRef = useRef(false)
  const sequenceRef = useRef(0)
  const latestIntentRef = useRef(0)
  const generationRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const loadRef = useRef(load)
  const fallbackRef = useRef(fallbackError)
  loadRef.current = load
  fallbackRef.current = fallbackError

  const patchIntent = useCallback((intentId: number, phase: IntentPhase) => {
    setIntents((prev) =>
      prev.map((intent) => (intent.id === intentId ? { ...intent, phase } : intent)),
    )
  }, [])

  const beginIntent = useCallback(
    (nextFilters: Record<string, string>, origin: IntentOrigin, preserveRows = false) => {
      if (!mountedRef.current) return

      // 旧请求能取消就取消；即便取消不生效，下面还会用意图编号兜底。
      controllerRef.current?.abort()
      const controller = new AbortController()
      controllerRef.current = controller

      const id = sequenceRef.current + 1
      sequenceRef.current = id
      latestIntentRef.current = id

      const record: IntentRecord = {
        id,
        generation: generationRef.current,
        origin,
        filters: { ...nextFilters },
        label: describeFilters(nextFilters),
        phase: 'fetching',
        startedAt: Date.now(),
      }

      setCurrentIntentId(id)
      setIntents((prev) => {
        // 新意图一旦发起，所有旧意图的结果都不再是页面依据，统一记为已作废。
        const retired = prev.map((intent) =>
          intent.phase === 'superseded' ? intent : { ...intent, phase: 'superseded' as const },
        )
        return [record, ...retired].slice(0, MAX_INTENT_HISTORY)
      })
      setListError('')
      // 浏览意图换了条件，旧列表不再代表当前条件，先清掉；
      // 动作后的补读保留列表，避免动作完成时表格闪空。
      if (!preserveRows) {
        setRows([])
        setTotal(0)
      }

      void loadRef.current({ ...nextFilters }, controller.signal)
        .then((result) => {
          if (!mountedRef.current) return
          if (latestIntentRef.current !== id) {
            // 乱序响应：属于早已被取代的意图，兼容处理为作废。
            patchIntent(id, 'superseded')
            return
          }
          if (controllerRef.current === controller) controllerRef.current = null
          setRows(result.items ?? [])
          setTotal(result.total ?? 0)
          setListError('')
          patchIntent(id, 'settled')
        })
        .catch((error: unknown) => {
          if (!mountedRef.current) return
          if (latestIntentRef.current !== id) {
            patchIntent(id, 'superseded')
            return
          }
          if (controllerRef.current === controller) controllerRef.current = null
          if (isAbortError(error)) {
            patchIntent(id, 'superseded')
            return
          }
          setListError(error instanceof Error ? error.message : fallbackRef.current)
          patchIntent(id, 'failed')
        })
    },
    [patchIntent],
  )

  const browseWith = useCallback(
    (nextFilters: Record<string, string>, origin: IntentOrigin) => {
      // 用户主动浏览才推进 generation；动作后的补读仍留在原上下文里。
      generationRef.current += 1
      setGeneration(generationRef.current)
      filtersRef.current = nextFilters
      setFilters(nextFilters)
      beginIntent(nextFilters, origin)
    },
    [beginIntent],
  )

  useEffect(() => {
    mountedRef.current = true
    browseWith(initialFiltersRef.current, 'browse')
    return () => {
      // 离页：取消在途读取并关闭状态写入通道。
      mountedRef.current = false
      controllerRef.current?.abort()
      controllerRef.current = null
    }
  }, [browseWith])

  const setFilter = useCallback(
    (field: string, value: string) => {
      browseWith({ ...filtersRef.current, [field]: value }, 'browse')
    },
    [browseWith],
  )

  const resetFilters = useCallback(() => {
    browseWith({}, 'browse')
  }, [browseWith])

  const reload = useCallback(() => {
    browseWith({ ...filtersRef.current }, 'browse')
  }, [browseWith])

  const captureActionContext = useCallback((): ActionContext => ({
    generation: generationRef.current,
    filters: { ...filtersRef.current },
  }), [])

  const isActionContextCurrent = useCallback(
    (context: ActionContext) =>
      mountedRef.current && context.generation === generationRef.current,
    [],
  )

  /** 动作完成后的补读：只认发起动作时的筛选快照，上下文失效就返回 false。 */
  const refreshForAction = useCallback(
    (context: ActionContext): boolean => {
      if (!mountedRef.current || context.generation !== generationRef.current) {
        return false
      }
      beginIntent({ ...context.filters }, 'action', true)
      return true
    },
    [beginIntent],
  )

  const isMounted = useCallback(() => mountedRef.current, [])

  const currentIntent = intents.find((intent) => intent.id === currentIntentId) ?? null

  return {
    rows,
    total,
    listError,
    filters,
    setFilter,
    resetFilters,
    reload,
    intents,
    currentIntent,
    currentIntentId,
    isFetching: currentIntent?.phase === 'fetching',
    generation,
    captureActionContext,
    isActionContextCurrent,
    refreshForAction,
    isMounted,
  }
}
