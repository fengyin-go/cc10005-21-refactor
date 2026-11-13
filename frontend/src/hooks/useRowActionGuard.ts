/**
 * 行级动作并发护栏：只负责「同一行同时只允许一个动作」，不掺业务语义。
 * 用 ref 兜底，确保同一行在极短时间内的重复点击也会落到「已忽略」分支，
 * 而不是两次都拿到未更新的旧状态。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export function useRowActionGuard() {
  const [busyRows, setBusyRows] = useState<Record<string, string>>({})
  const busyRef = useRef<Record<string, string>>({})
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const sync = useCallback(() => {
    if (mountedRef.current) setBusyRows({ ...busyRef.current })
  }, [])

  /** 返回 false 表示该行已有动作在处理，调用方应给出「已忽略」的去向说明。 */
  const begin = useCallback(
    (rowId: string, action: string): boolean => {
      if (busyRef.current[rowId]) return false
      busyRef.current[rowId] = action
      sync()
      return true
    },
    [sync],
  )

  const end = useCallback(
    (rowId: string) => {
      // 离页后只清理内部登记，不再触发渲染。
      delete busyRef.current[rowId]
      sync()
    },
    [sync],
  )

  const busyActionOf = useCallback((rowId: string) => busyRef.current[rowId], [])

  return { busyRows, begin, end, busyActionOf }
}
