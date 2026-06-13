import { useState } from 'react'
import { toast } from 'sonner'
import {
  Trash2,
  Plus,
  Upload,
  ToggleLeft,
  ToggleRight,
  Globe,
  Activity,
  Shuffle,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Settings2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getProxyPool,
  addProxy,
  deleteProxy,
  setProxyEnabled,
  getGlobalProxy,
  setGlobalProxy,
  checkProxy,
  checkAllProxies,
  assignProxiesRoundRobin,
} from '@/api/credentials'
import { extractErrorMessage, maskProxyUrl } from '@/lib/utils'
import {
  loadDefaultScheme,
  loadImportFormat,
  SCHEME_OPTIONS,
} from '@/lib/proxy-import'
import { ProxyBatchImportDialog } from '@/components/proxy-batch-import-dialog'
import type { ProxyImportFormat, ProxyPoolEntry, ProxyEgressInfo, ProxyScheme } from '@/types/api'

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

function EgressBadges({ egress }: { egress: ProxyEgressInfo }) {
  return (
    <div className="flex flex-wrap items-center gap-1 mt-1">
      <span className="text-xs text-foreground/90 font-mono">{egress.ip}</span>
      {(egress.city || egress.countryCode) && (
        <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
          {[egress.city, egress.countryCode].filter(Boolean).join(', ')}
        </Badge>
      )}
      {egress.fraudScore != null && (
        <Badge
          variant="outline"
          className={`h-5 px-1.5 text-[10px] font-normal ${
            egress.fraudScore >= 70
              ? 'border-destructive/40 text-destructive'
              : egress.fraudScore >= 40
                ? 'border-amber-500/40 text-amber-600 dark:text-amber-400'
                : 'border-green-500/40 text-green-600 dark:text-green-400'
          }`}
        >
          风险 {egress.fraudScore}
        </Badge>
      )}
      {egress.isResidential === true && (
        <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal border-green-500/40 text-green-600 dark:text-green-400">
          住宅
        </Badge>
      )}
      {egress.isResidential === false && (
        <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
          非住宅
        </Badge>
      )}
      {egress.isBroadcast === true && (
        <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal border-amber-500/40 text-amber-600 dark:text-amber-400">
          机房
        </Badge>
      )}
      {egress.asOrganization && (
        <span className="text-[10px] text-muted-foreground truncate max-w-[180px]" title={egress.asOrganization}>
          {egress.asOrganization}
        </span>
      )}
    </div>
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
  const [importPrefs, setImportPrefs] = useState(() => ({
    scheme: loadDefaultScheme(),
    format: loadImportFormat(),
  }))
  const queryClient = useQueryClient()

  const schemeLabel =
    SCHEME_OPTIONS.find((o) => o.value === importPrefs.scheme)?.label ?? importPrefs.scheme

  const { data, isLoading } = useQuery({
    queryKey: ['proxy-pool'],
    queryFn: getProxyPool,
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['proxy-pool'] }),
    onError: (err) => toast.error(`删除失败: ${extractErrorMessage(err)}`),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled: en }: { id: number; enabled: boolean }) =>
      setProxyEnabled(id, en),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['proxy-pool'] }),
    onError: (err) => toast.error(`操作失败: ${extractErrorMessage(err)}`),
  })

  const [checkingId, setCheckingId] = useState<number | null>(null)
  const checkMutation = useMutation({
    mutationFn: (id: number) => checkProxy(id),
    onMutate: (id) => setCheckingId(id),
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
    onSettled: () => setCheckingId(null),
  })

  const checkAllMutation = useMutation({
    mutationFn: () => checkAllProxies(),
    onSuccess: (res) => {
      toast.success(
        `健康检查完成：健康 ${res.healthy}，异常 ${res.unhealthy}，自动禁用 ${res.autoDisabled}`
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

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newUrl.trim()) return
    addMutation.mutate()
  }

  const renderHealthBadge = (proxy: ProxyPoolEntry) => {
    if (proxy.health === 'healthy') {
      return (
        <Badge variant="outline" className="text-xs gap-1 border-green-500/50 text-green-600 dark:text-green-400">
          <CheckCircle2 className="h-3 w-3" />
          {proxy.latencyMs != null ? `${proxy.latencyMs}ms` : '可用'}
        </Badge>
      )
    }
    if (proxy.health === 'unhealthy') {
      return (
        <Badge variant="outline" className="text-xs gap-1 border-destructive/50 text-destructive">
          <XCircle className="h-3 w-3" />
          异常{proxy.consecutiveFailures > 0 ? ` ×${proxy.consecutiveFailures}` : ''}
        </Badge>
      )
    }
    return (
      <Badge variant="outline" className="text-xs gap-1 text-muted-foreground">
        <HelpCircle className="h-3 w-3" />
        未检测
      </Badge>
    )
  }

  const total = data?.total ?? 0
  const healthyCount = data?.proxies.filter((p) => p.health === 'healthy').length ?? 0

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <form onSubmit={handleAdd} className="flex flex-1 flex-wrap gap-2 min-w-0">
          <Input
            placeholder="单条添加：完整 URL 或无协议简写"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            className="flex-1 min-w-[200px] font-mono text-sm"
          />
          <Input
            placeholder="备注"
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
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setBatchOpen(true)}
          >
            <Upload className="h-4 w-4 mr-1" />
            批量导入
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-xs text-muted-foreground"
            onClick={() => setBatchOpen(true)}
            title="简写导入时使用：协议与行格式"
          >
            <Settings2 className="h-3.5 w-3.5 mr-1" />
            {schemeLabel}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground -mt-1">
        无协议简写沿用批量导入中的协议与格式设置；完整 URL 可直接粘贴添加。
      </p>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Card className="shadow-none">
          <CardContent className="p-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium">全局代理</div>
                <div className="text-xs font-mono text-muted-foreground truncate">
                  {currentGlobalProxy ? maskProxyUrl(currentGlobalProxy) : '未配置（直连）'}
                </div>
              </div>
            </div>
            {currentGlobalProxy && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-destructive hover:text-destructive shrink-0"
                onClick={() => setGlobalProxyMutation.mutate(null)}
                disabled={setGlobalProxyMutation.isPending}
              >
                清除
              </Button>
            )}
          </CardContent>
        </Card>

        {total > 0 && (
          <div className="flex items-center gap-1 sm:justify-end">
            <Button
              size="sm"
              variant="outline"
              className="h-9 text-xs"
              onClick={() => checkAllMutation.mutate()}
              disabled={checkAllMutation.isPending}
            >
              <Activity className="h-3 w-3 mr-1" />
              {checkAllMutation.isPending ? '检测中…' : '全部检测'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-9 text-xs"
              onClick={() => assignRoundRobinMutation.mutate()}
              disabled={assignRoundRobinMutation.isPending}
            >
              <Shuffle className="h-3 w-3 mr-1" />
              轮询分配
            </Button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-sm">
        <div className="text-muted-foreground">
          共 {total} 个
          {total > 0 && (
            <span className="ml-2 text-green-600 dark:text-green-400">
              健康 {healthyCount}
            </span>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="text-sm text-muted-foreground py-8 text-center">加载中…</div>
      )}

      {!isLoading && total === 0 && (
        <div className="rounded-2xl border border-dashed py-12 px-6 text-center space-y-3">
          <Upload className="h-8 w-8 text-muted-foreground/50 mx-auto" />
          <div>
            <p className="text-sm font-medium">还没有代理</p>
            <p className="text-xs text-muted-foreground mt-1">
              推荐通过批量导入粘贴供应商提供的代理列表
            </p>
          </div>
          <Button size="sm" onClick={() => setBatchOpen(true)}>
            <Upload className="h-4 w-4 mr-1" />
            打开批量导入
          </Button>
        </div>
      )}

      {total > 0 && (
        <div className="border rounded-xl divide-y max-h-[480px] overflow-y-auto">
          {data?.proxies.map((proxy: ProxyPoolEntry) => (
            <div key={proxy.id} className="flex items-center gap-3 p-3 hover:bg-muted/20 transition-colors">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs truncate">{maskProxyUrl(proxy.url)}</span>
                  {proxy.label && (
                    <Badge variant="secondary" className="text-xs">
                      {proxy.label}
                    </Badge>
                  )}
                  {renderHealthBadge(proxy)}
                  {!proxy.enabled && (
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      {proxy.autoDisabled ? '自动禁用' : '已禁用'}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                  {proxy.egress && <EgressBadges egress={proxy.egress} />}
                  {proxy.credentialCount > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {proxy.credentialCount} 个凭据使用中
                    </span>
                  )}
                  {proxy.lastCheckedAt && (
                    <span className="text-xs text-muted-foreground">
                      检测于 {new Date(proxy.lastCheckedAt).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => checkMutation.mutate(proxy.id)}
                  disabled={checkingId === proxy.id}
                >
                  <Activity className="h-3 w-3 mr-1" />
                  {checkingId === proxy.id ? '测试中' : '测试'}
                </Button>
                {onSelectProxy && proxy.enabled && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => onSelectProxy(proxy.url)}
                  >
                    选用
                  </Button>
                )}
                {proxy.enabled && proxy.url !== currentGlobalProxy && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setGlobalProxyMutation.mutate(proxy.url)}
                    disabled={setGlobalProxyMutation.isPending}
                  >
                    <Globe className="h-3 w-3 mr-1" />
                    全局
                  </Button>
                )}
                {proxy.url === currentGlobalProxy && (
                  <Badge variant="secondary" className="text-xs h-7">
                    全局
                  </Badge>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  onClick={() => toggleMutation.mutate({ id: proxy.id, enabled: !proxy.enabled })}
                >
                  {proxy.enabled ? (
                    <ToggleRight className="h-4 w-4 text-green-500" />
                  ) : (
                    <ToggleLeft className="h-4 w-4 text-muted-foreground" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                  onClick={() => deleteMutation.mutate(proxy.id)}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
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
  )
}

// 兼容旧引用
export type { ProxyScheme } from '@/types/api'
