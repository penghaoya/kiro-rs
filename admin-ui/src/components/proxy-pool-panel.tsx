import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Trash2,
  Plus,
  Upload,
  Globe,
  Activity,
  Shuffle,
  Settings2,
  Search,
  Copy,
  MoreHorizontal,
  Loader2,
  Power,
  CheckCircle2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { useConfirm } from '@/components/ui/confirm-dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getProxyPool,
  getCredentials,
  addProxy,
  deleteProxy,
  setProxyEnabled,
  getGlobalProxy,
  setGlobalProxy,
  checkProxy,
  checkAllProxies,
  assignProxiesRoundRobin,
} from '@/api/credentials'
import { extractErrorMessage, maskProxyUrl, cn } from '@/lib/utils'
import {
  sortProxyPoolEntries,
  getLatencyTier,
  latencyTierClass,
  fraudScoreClass,
  countryCodeToFlag,
  formatRelativeTime,
  splitProxyDisplay,
} from '@/lib/proxy-display'
import {
  loadDefaultScheme,
  loadImportFormat,
  SCHEME_OPTIONS,
} from '@/lib/proxy-import'
import { ProxyBatchImportDialog } from '@/components/proxy-batch-import-dialog'
import type { ProxyImportFormat, ProxyPoolEntry, ProxyEgressInfo, ProxyScheme } from '@/types/api'

type HealthFilter = 'all' | 'healthy' | 'unhealthy' | 'unchecked' | 'disabled'

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function formatEgressSummary(egress: ProxyEgressInfo): string {
  const loc = [egress.city, egress.region, egress.countryCode || egress.country]
    .filter(Boolean)
    .join(', ')
  const parts = [egress.ip, loc].filter(Boolean)
  if (egress.fraudScore != null) parts.push(`风险 ${egress.fraudScore}`)
  if (egress.isResidential === true) parts.push('住宅')
  else if (egress.isResidential === false) parts.push('非住宅')
  if (egress.isBroadcast === true) parts.push('机房')
  if (egress.asOrganization) parts.push(egress.asOrganization)
  return parts.join(' · ')
}

function HealthDot({ proxy }: { proxy: ProxyPoolEntry }) {
  const { color, label } = (() => {
    if (!proxy.enabled)
      return { color: 'bg-muted-foreground/40', label: proxy.autoDisabled ? '自动禁用' : '已禁用' }
    if (proxy.health === 'healthy') return { color: 'bg-emerald-500', label: '健康' }
    if (proxy.health === 'unhealthy')
      return {
        color: 'bg-destructive',
        label: `异常${proxy.consecutiveFailures > 0 ? ` ×${proxy.consecutiveFailures}` : ''}`,
      }
    return { color: 'bg-muted-foreground/40', label: '未检测' }
  })()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          {proxy.enabled && proxy.health === 'healthy' && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" />
          )}
          <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', color)} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function LatencyPill({ ms }: { ms: number | null | undefined }) {
  if (ms == null) return null
  const tier = getLatencyTier(ms)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 font-mono text-[11px] tabular-nums',
        latencyTierClass(tier),
      )}
    >
      {ms}ms
    </span>
  )
}

/** 出口 IP 元信息行：风险分 · 住宅/机房 · 运营商。无 egress 时不渲染。 */
function EgressMeta({ egress }: { egress: ProxyEgressInfo }) {
  return (
    <>
      {egress.fraudScore != null && (
        <span className={cn('inline-flex items-center gap-0.5', fraudScoreClass(egress.fraudScore))}>
          风险 {egress.fraudScore}
        </span>
      )}
      {egress.isResidential === true && (
        <span className="text-emerald-600 dark:text-emerald-400">住宅</span>
      )}
      {egress.isResidential === false && egress.isBroadcast !== true && (
        <span className="text-muted-foreground">非住宅</span>
      )}
      {egress.isBroadcast === true && (
        <span className="text-amber-600 dark:text-amber-400">机房</span>
      )}
      {egress.asOrganization && (
        <span className="truncate max-w-[180px]" title={egress.asOrganization}>
          {egress.asOrganization}
        </span>
      )}
    </>
  )
}

interface ProxyPoolPanelProps {
  enabled?: boolean
  onSelectProxy?: (url: string) => void
}

export function ProxyPoolPanel({ enabled = true, onSelectProxy }: ProxyPoolPanelProps) {
  const [newUrl, setNewUrl] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [batchOpen, setBatchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [healthFilter, setHealthFilter] = useState<HealthFilter>('all')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [importPrefs, setImportPrefs] = useState(() => ({
    scheme: loadDefaultScheme(),
    format: loadImportFormat(),
  }))
  const confirm = useConfirm()
  const queryClient = useQueryClient()

  const schemeLabel =
    SCHEME_OPTIONS.find((o) => o.value === importPrefs.scheme)?.label ?? importPrefs.scheme

  const { data, isLoading } = useQuery({
    queryKey: ['proxy-pool'],
    queryFn: getProxyPool,
    enabled,
  })

  const { data: credentialsData } = useQuery({
    queryKey: ['credentials'],
    queryFn: getCredentials,
    enabled,
  })

  const { data: globalProxyData } = useQuery({
    queryKey: ['global-proxy'],
    queryFn: getGlobalProxy,
    enabled,
  })

  const setGlobalProxyMutation = useMutation({
    mutationFn: (url: string | null) => setGlobalProxy({ proxyUrl: url }),
    onSuccess: (_, url) => {
      toast.success(url ? `已设置全局代理: ${maskProxyUrl(url)}` : '已清除全局代理')
      queryClient.invalidateQueries({ queryKey: ['global-proxy'] })
    },
    onError: (err) => toast.error(`操作失败: ${extractErrorMessage(err)}`),
  })

  const currentGlobalProxy = globalProxyData?.proxyUrl ?? null

  const addMutation = useMutation({
    mutationFn: () =>
      addProxy({
        url: newUrl.trim(),
        label: newLabel.trim() || undefined,
        defaultScheme: importPrefs.scheme,
        importFormat: importPrefs.format,
      }),
    onSuccess: (entry) => {
      toast.success(`代理已添加：${maskProxyUrl(entry.url)}`)
      setNewUrl('')
      setNewLabel('')
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
    },
    onError: (err) => toast.error(`添加失败: ${extractErrorMessage(err)}`),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteProxy(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
      queryClient.invalidateQueries({ queryKey: ['credentials'] })
    },
    onError: (err) => toast.error(`删除失败: ${extractErrorMessage(err)}`),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled: en }: { id: number; enabled: boolean }) =>
      setProxyEnabled(id, en),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['proxy-pool'] }),
    onError: (err) => toast.error(`操作失败: ${extractErrorMessage(err)}`),
  })

  const [batchRunning, setBatchRunning] = useState(false)

  const [checkingIds, setCheckingIds] = useState<Set<number>>(new Set())
  const checkMutation = useMutation({
    mutationFn: (id: number) => checkProxy(id),
    onMutate: (id) =>
      setCheckingIds((prev) => {
        const next = new Set(prev)
        next.add(id)
        return next
      }),
    onSuccess: (res) => {
      if (res.health === 'healthy') {
        const egressHint = res.egress ? ` · ${formatEgressSummary(res.egress)}` : ''
        toast.success(`代理可用，延迟 ${res.latencyMs ?? '-'} ms${egressHint}`)
      } else {
        toast.error(res.autoDisabled ? '代理探测失败，已自动禁用' : '代理探测失败')
      }
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
    },
    onError: (err) => toast.error(`探测失败: ${extractErrorMessage(err)}`),
    onSettled: (_d, _e, id) =>
      setCheckingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      }),
  })

  const checkAllMutation = useMutation({
    mutationFn: () => checkAllProxies(),
    onSuccess: (res) => {
      const healed = res.selfHealed > 0 ? `，自愈恢复 ${res.selfHealed}` : ''
      toast.success(
        `健康检查完成：健康 ${res.healthy}，异常 ${res.unhealthy}，自动禁用 ${res.autoDisabled}${healed}`
      )
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
    },
    onError: (err) => toast.error(`检查失败: ${extractErrorMessage(err)}`),
  })

  const assignRoundRobinMutation = useMutation({
    mutationFn: () => assignProxiesRoundRobin(null),
    onSuccess: (res) => {
      toast.success(`已用 ${res.proxyCount} 个代理轮询分配给 ${res.assigned} 个凭据`)
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
      queryClient.invalidateQueries({ queryKey: ['credentials'] })
    },
    onError: (err) => toast.error(`分配失败: ${extractErrorMessage(err)}`),
  })

  const handleAssignRoundRobin = async () => {
    const alreadyBound = credentialsData?.credentials.filter((c) => c.hasProxy).length ?? 0
    const ok = await confirm({
      title: '轮询分配代理',
      description:
        alreadyBound > 0
          ? `将用 ${assignableCount} 个可用代理轮询覆盖全部 ${credentialTotal} 个凭据的代理设置，其中 ${alreadyBound} 个凭据已手动绑定代理，会被一并覆盖。此操作无法撤销。`
          : `将用 ${assignableCount} 个可用代理轮询分配给全部 ${credentialTotal} 个凭据。`,
      confirmText: '分配',
      destructive: alreadyBound > 0,
    })
    if (!ok) return
    assignRoundRobinMutation.mutate()
  }

  const handleDelete = async (proxy: ProxyPoolEntry) => {
    const ok = await confirm({
      title: '删除代理',
      description:
        proxy.credentialCount > 0
          ? `代理 ${maskProxyUrl(proxy.url)} 正被 ${proxy.credentialCount} 个凭据使用。删除后这些凭据仍会按原地址直连，但将无法在此查看其健康状态。此操作无法撤销。`
          : `确认删除代理 ${maskProxyUrl(proxy.url)}？此操作无法撤销。`,
      confirmText: '删除',
      destructive: true,
    })
    if (!ok) return
    deleteMutation.mutate(proxy.id)
  }

  const handleToggle = async (proxy: ProxyPoolEntry) => {
    // 禁用一个仍被凭据使用的代理时提示：禁用只影响新分配与健康检查，不会让已绑定凭据停用它。
    if (proxy.enabled && proxy.credentialCount > 0) {
      const ok = await confirm({
        title: '禁用代理',
        description: `代理 ${maskProxyUrl(proxy.url)} 正被 ${proxy.credentialCount} 个凭据使用。禁用只会让它退出健康检查与轮询分配，已绑定的凭据仍会继续走它。如需让凭据停用，请到凭据管理改其代理设置。`,
        confirmText: '仍要禁用',
      })
      if (!ok) return
    }
    toggleMutation.mutate({ id: proxy.id, enabled: !proxy.enabled })
  }

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newUrl.trim()) return
    addMutation.mutate()
  }

  const proxies = data?.proxies ?? []
  const total = data?.total ?? 0
  const healthyCount = proxies.filter((p) => p.health === 'healthy').length
  const unhealthyCount = proxies.filter((p) => p.health === 'unhealthy').length
  const uncheckedCount = proxies.filter((p) => p.health === 'unknown').length
  const disabledCount = proxies.filter((p) => !p.enabled).length
  const credentialTotal = credentialsData?.credentials.length ?? 0
  const assignableCount = proxies.filter((p) => p.enabled && p.health !== 'unhealthy').length

  const FILTERS: { key: HealthFilter; label: string; count: number }[] = [
    { key: 'all', label: '全部', count: total },
    { key: 'healthy', label: '健康', count: healthyCount },
    { key: 'unhealthy', label: '异常', count: unhealthyCount },
    { key: 'unchecked', label: '未检测', count: uncheckedCount },
    { key: 'disabled', label: '已禁用', count: disabledCount },
  ]

  const filteredProxies = useMemo(() => {
    const q = search.trim().toLowerCase()
    const matched = proxies.filter((p) => {
      if (healthFilter === 'healthy' && p.health !== 'healthy') return false
      if (healthFilter === 'unhealthy' && p.health !== 'unhealthy') return false
      if (healthFilter === 'unchecked' && p.health !== 'unknown') return false
      if (healthFilter === 'disabled' && p.enabled) return false
      if (!q) return true
      const haystack = [
        p.url,
        p.label ?? '',
        p.egress?.ip ?? '',
        p.egress?.city ?? '',
        p.egress?.country ?? '',
        p.egress?.countryCode ?? '',
        p.egress?.asOrganization ?? '',
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
    return sortProxyPoolEntries(matched)
  }, [proxies, search, healthFilter])

  const filteredIds = useMemo(() => filteredProxies.map((p) => p.id), [filteredProxies])
  const selectedVisible = filteredIds.filter((id) => selectedIds.has(id))
  const allVisibleSelected = filteredIds.length > 0 && selectedVisible.length === filteredIds.length

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        filteredIds.forEach((id) => next.delete(id))
      } else {
        filteredIds.forEach((id) => next.add(id))
      }
      return next
    })
  }

  const toggleSelectOne = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSelection = () => setSelectedIds(new Set())

  const runBatch = async (
    action: 'delete' | 'enable' | 'disable',
    ids: number[],
  ) => {
    setBatchRunning(true)
    let ok = 0
    let failed = 0
    try {
      for (const id of ids) {
        try {
          if (action === 'delete') await deleteProxy(id)
          else await setProxyEnabled(id, action === 'enable')
          ok++
        } catch {
          failed++
        }
      }
    } finally {
      setBatchRunning(false)
      clearSelection()
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
      queryClient.invalidateQueries({ queryKey: ['credentials'] })
    }
    const verb = action === 'delete' ? '删除' : action === 'enable' ? '启用' : '禁用'
    if (failed === 0) toast.success(`已${verb} ${ok} 个代理`)
    else toast.warning(`${verb}完成：成功 ${ok} 个，失败 ${failed} 个`)
  }

  const handleBatchDelete = async () => {
    const ids = selectedVisible
    if (ids.length === 0) return
    const boundCount = filteredProxies
      .filter((p) => ids.includes(p.id))
      .reduce((sum, p) => sum + (p.credentialCount > 0 ? 1 : 0), 0)
    const ok = await confirm({
      title: '批量删除代理',
      description:
        boundCount > 0
          ? `将删除选中的 ${ids.length} 个代理，其中 ${boundCount} 个正被凭据使用。删除后相关凭据仍按原地址直连。此操作无法撤销。`
          : `将删除选中的 ${ids.length} 个代理。此操作无法撤销。`,
      confirmText: '删除',
      destructive: true,
    })
    if (!ok) return
    runBatch('delete', ids)
  }

  const handleBatchToggle = (enable: boolean) => {
    const ids = selectedVisible
    if (ids.length === 0) return
    runBatch(enable ? 'enable' : 'disable', ids)
  }

  const handleCopyUrl = async (url: string) => {
    const ok = await copyToClipboard(url)
    if (ok) toast.success('完整代理地址已复制')
    else toast.error('复制失败，请手动选择复制')
  }

  return (
    <TooltipProvider delayDuration={200}>
    <div className="space-y-3">
      {/* 添加 + 导入 工具栏 */}
      <div className="flex flex-col gap-2.5 rounded-2xl border border-border/60 bg-card/60 p-2.5 shadow-apple-sm backdrop-blur-xl sm:flex-row sm:items-center">
        <form onSubmit={handleAdd} className="flex flex-1 flex-wrap gap-2 min-w-0">
          <Input
            placeholder="粘贴完整 URL，或无协议简写一键添加"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            className="flex-1 min-w-[200px] font-mono text-sm"
          />
          <Input
            placeholder="备注（可选）"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            className="w-24 sm:w-28"
          />
          <Button type="submit" size="sm" disabled={addMutation.isPending || !newUrl.trim()}>
            <Plus className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">添加</span>
          </Button>
        </form>
        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden h-5 w-px bg-border/60 sm:block" />
          <Button type="button" size="sm" variant="outline" onClick={() => setBatchOpen(true)}>
            <Upload className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">批量导入</span>
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-xs text-muted-foreground"
                onClick={() => setBatchOpen(true)}
              >
                <Settings2 className="h-3.5 w-3.5 mr-1" />
                {schemeLabel}
              </Button>
            </TooltipTrigger>
            <TooltipContent>简写导入沿用的默认协议与行格式，点击调整</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* 全局代理 + 池级动作 */}
      <div className="flex flex-col gap-2 rounded-2xl border border-border/50 bg-muted/20 px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
              currentGlobalProxy ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
            )}
          >
            <Globe className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              全局代理
              {!currentGlobalProxy && (
                <span className="text-xs font-normal text-muted-foreground">未配置 · 直连</span>
              )}
            </div>
            {currentGlobalProxy && (
              <div className="font-mono text-xs text-muted-foreground truncate">
                {maskProxyUrl(currentGlobalProxy)}
              </div>
            )}
          </div>
          {currentGlobalProxy && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground hover:text-destructive shrink-0"
              onClick={() => setGlobalProxyMutation.mutate(null)}
              disabled={setGlobalProxyMutation.isPending}
            >
              清除
            </Button>
          )}
        </div>
        {total > 0 && (
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              onClick={() => checkAllMutation.mutate()}
              disabled={checkAllMutation.isPending}
            >
              {checkAllMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin sm:mr-1" />
              ) : (
                <Activity className="h-3.5 w-3.5 sm:mr-1" />
              )}
              <span className="hidden sm:inline">{checkAllMutation.isPending ? '检测中…' : '全部检测'}</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleAssignRoundRobin}
              disabled={assignRoundRobinMutation.isPending}
            >
              <Shuffle className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden sm:inline">轮询分配</span>
            </Button>
          </div>
        )}
      </div>

      {/* 搜索 + 分段筛选（合并原先重复的统计行与筛选行） */}
      {total > 0 && (
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative flex-1 min-w-0 lg:max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="搜索 URL / 备注 / 出口 IP / 地区"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-9 text-sm rounded-full"
            />
          </div>
          <div className="flex items-center gap-0.5 rounded-full border border-border/60 bg-muted/30 p-0.5">
            {FILTERS.map((f) => {
              const active = healthFilter === f.key
              const tone =
                f.key === 'healthy'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : f.key === 'unhealthy'
                    ? 'text-destructive'
                    : ''
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setHealthFilter(f.key)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-150 ease-apple',
                    active
                      ? 'bg-card text-foreground shadow-apple-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span className={cn(active && tone)}>{f.label}</span>
                  <span
                    className={cn(
                      'tabular-nums',
                      active ? 'text-muted-foreground' : 'text-muted-foreground/60',
                    )}
                  >
                    {f.count}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {selectedVisible.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="font-medium text-primary">已选 {selectedVisible.length} 个</span>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => handleBatchToggle(true)}
            disabled={batchRunning}
          >
            <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
            启用
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => handleBatchToggle(false)}
            disabled={batchRunning}
          >
            <Power className="h-3.5 w-3.5 mr-1" />
            禁用
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs text-destructive hover:text-destructive"
            onClick={handleBatchDelete}
            disabled={batchRunning}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1" />
            删除
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={clearSelection}
            disabled={batchRunning}
          >
            取消选择
          </Button>
        </div>
      )}

      {isLoading && (
        <div className="text-sm text-muted-foreground py-8 text-center">加载中…</div>
      )}

      {!isLoading && total === 0 && (
        <div className="rounded-2xl border border-dashed border-border/70 bg-muted/10 py-14 px-6 text-center space-y-3">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted/60">
            <Globe className="h-6 w-6 text-muted-foreground/60" />
          </div>
          <div>
            <p className="text-sm font-medium">还没有代理</p>
            <p className="text-xs text-muted-foreground mt-1">
              推荐通过批量导入粘贴供应商提供的代理列表，导入后自动健康检测
            </p>
          </div>
          <Button size="sm" onClick={() => setBatchOpen(true)}>
            <Upload className="h-4 w-4 mr-1" />
            打开批量导入
          </Button>
        </div>
      )}

      {total > 0 && (
        <div className="overflow-hidden rounded-2xl border border-border/60 bg-card/40 shadow-apple-sm">
          <div className="flex items-center gap-3 px-4 py-2.5 bg-muted/40 sticky top-0 z-10 text-xs text-muted-foreground backdrop-blur-xl">
            <Checkbox
              checked={allVisibleSelected}
              onCheckedChange={toggleSelectAll}
              aria-label="全选"
            />
            <span className="font-medium">
              {filteredProxies.length === total
                ? `全部 ${total} 个`
                : `筛选出 ${filteredProxies.length} / ${total} 个`}
            </span>
          </div>
          <div className="max-h-[520px] overflow-y-auto divide-y divide-border/50">
            {filteredProxies.length === 0 && (
              <div className="px-3 py-12 text-center text-sm text-muted-foreground">
                没有符合条件的代理
              </div>
            )}
            {filteredProxies.map((proxy: ProxyPoolEntry) => {
              const isGlobal = proxy.url === currentGlobalProxy
              const selected = selectedIds.has(proxy.id)
              const checking = checkingIds.has(proxy.id)
              const { hostPort } = splitProxyDisplay(maskProxyUrl(proxy.url))
              const flag = countryCodeToFlag(proxy.egress?.countryCode)
              const location = [proxy.egress?.city, proxy.egress?.countryCode]
                .filter(Boolean)
                .join(', ')
              return (
                <div
                  key={proxy.id}
                  className={cn(
                    'group flex items-center gap-3 px-4 py-3 transition-colors',
                    selected ? 'bg-primary/5' : 'hover:bg-muted/30',
                    !proxy.enabled && 'opacity-60',
                  )}
                >
                  <Checkbox
                    checked={selected}
                    onCheckedChange={() => toggleSelectOne(proxy.id)}
                    aria-label={`选择代理 #${proxy.id}`}
                  />
                  <HealthDot proxy={proxy} />

                  {/* 主信息：出口 IP 主位，URL 降级为副信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {proxy.egress?.ip ? (
                        <span className="font-mono text-sm font-medium text-foreground tabular-nums">
                          {flag && <span className="mr-1">{flag}</span>}
                          {proxy.egress.ip}
                        </span>
                      ) : (
                        <span className="font-mono text-sm text-muted-foreground">
                          {hostPort}
                        </span>
                      )}
                      {location && (
                        <span className="text-xs text-muted-foreground">{location}</span>
                      )}
                      <LatencyPill ms={proxy.health === 'healthy' ? proxy.latencyMs : null} />
                      {proxy.label && (
                        <Badge variant="secondary" className="text-[11px]">
                          {proxy.label}
                        </Badge>
                      )}
                      {isGlobal && (
                        <Badge variant="default" className="gap-1 text-[11px]">
                          <Globe className="h-3 w-3" />
                          全局
                        </Badge>
                      )}
                      {!proxy.enabled && (
                        <Badge variant="outline" className="text-[11px] text-muted-foreground">
                          {proxy.autoDisabled ? '自动禁用' : '已禁用'}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-x-2 gap-y-0.5 mt-1 flex-wrap text-[11px] text-muted-foreground">
                      {proxy.egress?.ip && (
                        <span className="font-mono truncate max-w-[260px]" title={maskProxyUrl(proxy.url)}>
                          {hostPort}
                        </span>
                      )}
                      {proxy.egress && (
                        <>
                          {proxy.egress.ip && <span className="text-border">·</span>}
                          <EgressMeta egress={proxy.egress} />
                        </>
                      )}
                      {proxy.credentialCount > 0 && (
                        <>
                          <span className="text-border">·</span>
                          <span>{proxy.credentialCount} 个凭据使用中</span>
                        </>
                      )}
                      {proxy.lastCheckedAt && (
                        <>
                          <span className="text-border">·</span>
                          <span title={new Date(proxy.lastCheckedAt).toLocaleString()}>
                            {formatRelativeTime(proxy.lastCheckedAt)}检测
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* 动作：测试（主）+ 开关 + 溢出菜单 */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {onSelectProxy && proxy.enabled && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        onClick={() => onSelectProxy(proxy.url)}
                      >
                        选用
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2.5 text-xs"
                      onClick={() => checkMutation.mutate(proxy.id)}
                      disabled={checking}
                    >
                      {checking ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin sm:mr-1" />
                      ) : (
                        <Activity className="h-3.5 w-3.5 sm:mr-1" />
                      )}
                      <span className="hidden sm:inline">{checking ? '测试中' : '测试'}</span>
                    </Button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <Switch
                            size="sm"
                            checked={proxy.enabled}
                            onCheckedChange={() => handleToggle(proxy)}
                            aria-label={proxy.enabled ? '禁用代理' : '启用代理'}
                          />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{proxy.enabled ? '点击禁用' : '点击启用'}</TooltipContent>
                    </Tooltip>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 text-muted-foreground"
                          aria-label="更多操作"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleCopyUrl(proxy.url)}>
                          <Copy className="h-4 w-4" />
                          复制完整地址
                        </DropdownMenuItem>
                        {proxy.enabled && !isGlobal && (
                          <DropdownMenuItem
                            onClick={() => setGlobalProxyMutation.mutate(proxy.url)}
                            disabled={setGlobalProxyMutation.isPending}
                          >
                            <Globe className="h-4 w-4" />
                            设为全局代理
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem destructive onClick={() => handleDelete(proxy)}>
                          <Trash2 className="h-4 w-4" />
                          删除代理
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <ProxyBatchImportDialog
        open={batchOpen}
        onOpenChange={setBatchOpen}
        onPrefsChange={(prefs) =>
          setImportPrefs(prefs as { scheme: ProxyScheme; format: ProxyImportFormat })
        }
      />
    </div>
    </TooltipProvider>
  )
}

// 兼容旧引用
export type { ProxyScheme } from '@/types/api'
