import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { getTraces, getFailureStats } from '@/api/traces'
import type { TraceQuery } from '@/types/api'

/**
 * 请求链路查询 hook
 *
 * 请求日志用于排障，刷新要比仪表盘更积极：进入页面、窗口重新聚焦、
 * 网络恢复时都重新拉取，并保持短轮询，避免新请求看起来“不更新”。
 * - `enabled=false` 时完全不发请求（弹框未打开时懒加载）。
 * - `poll=false` 时停掉 5s 轮询但保留手动刷新：用于 Tab 隐藏 / 翻到历史页 /
 *   展开某行时，避免 offset 分页下新数据插入导致同页行错位、读到一半被刷新。
 */
export function useTraces(query: TraceQuery, enabled = true, poll = true) {
  return useQuery({
    queryKey: ['traces', query],
    queryFn: () => getTraces(query),
    enabled,
    refetchInterval: enabled && poll ? 5_000 : false,
    staleTime: 1_000,
    placeholderData: keepPreviousData,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  })
}

/** 按凭据的失败分类计数（鉴权/风控/其他），用于卡片分色展示 */
export function useFailureStats() {
  return useQuery({
    queryKey: ['traces', 'failure-stats'],
    queryFn: getFailureStats,
    refetchInterval: 30_000,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  })
}
