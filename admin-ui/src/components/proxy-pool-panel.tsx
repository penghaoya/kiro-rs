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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getProxyPool,
  addProxy,
  batchAddProxies,
  deleteProxy,
  setProxyEnabled,
  getGlobalProxy,
  setGlobalProxy,
  checkProxy,
  checkAllProxies,
  assignProxiesRoundRobin,
} from '@/api/credentials'
import { extractErrorMessage, maskProxyUrl } from '@/lib/utils'
import type { ProxyPoolEntry } from '@/types/api'

export type ProxyScheme = 'http' | 'https' | 'socks5' | 'socks4'

const SCHEME_OPTIONS: { value: ProxyScheme; label: string }[] = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'socks4', label: 'SOCKS4' },
]

interface ProxyPoolPanelProps {
  /** Dialog 模式下仅在打开时拉取；页面模式始终为 true */
  enabled?: boolean
  /** 凭据编辑里「选用」代理 */
  onSelectProxy?: (url: string) => void
}

export function ProxyPoolPanel({ enabled = true, onSelectProxy }: ProxyPoolPanelProps) {
  const [newUrl, setNewUrl] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [defaultScheme, setDefaultScheme] = useState<ProxyScheme>('http')
  const [batchText, setBatchText] = useState('')
  const [showBatch, setShowBatch] = useState(false)
  const [batchErrors, setBatchErrors] = useState<string[]>([])
  const queryClient = useQueryClient()

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
        defaultScheme,
      }),
    onSuccess: (entry) => {
      toast.success(`代理已添加：${maskProxyUrl(entry.url)}`)
      setNewUrl('')
      setNewLabel('')
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
    },
    onError: (err) => toast.error(`添加失败: ${extractErrorMessage(err)}`),
  })

  const batchMutation = useMutation({
    mutationFn: () =>
      batchAddProxies({
        urls: batchText.split('\n').map((l) => l.trim()).filter(Boolean),
        defaultScheme,
      }),
    onSuccess: (res) => {
      if (res.errors === 0) {
        toast.success(`批量导入完成：成功 ${res.added} 个`)
      } else {
        toast.info(`批量导入完成：成功 ${res.added} 个，跳过 ${res.errors} 个`)
      }
      setBatchErrors(res.errorMessages)
      setBatchText('')
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
    },
    onError: (err) => toast.error(`批量导入失败: ${extractErrorMessage(err)}`),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteProxy(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
    },
    onError: (err) => toast.error(`删除失败: ${extractErrorMessage(err)}`),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled: en }: { id: number; enabled: boolean }) =>
      setProxyEnabled(id, en),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
    },
    onError: (err) => toast.error(`操作失败: ${extractErrorMessage(err)}`),
  })

  const [checkingId, setCheckingId] = useState<number | null>(null)
  const checkMutation = useMutation({
    mutationFn: (id: number) => checkProxy(id),
    onMutate: (id) => setCheckingId(id),
    onSuccess: (res) => {
      if (res.health === 'healthy') {
        toast.success(`代理可用，延迟 ${res.latencyMs ?? '-'} ms`)
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

  const schemeSelect = (
    <select
      value={defaultScheme}
      onChange={(e) => setDefaultScheme(e.target.value as ProxyScheme)}
      className="h-9 rounded-md border border-input bg-background px-2 text-xs"
      title="无协议简写时使用的默认协议"
    >
      {SCHEME_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        支持完整 URL（如 <code className="text-xs">socks5://user:pass@host:port</code>）或无协议简写：
        <code className="text-xs">user:pass:host:port</code>、
        <code className="text-xs">host:port</code>、
        <code className="text-xs">user:pass@host:port</code>。
        简写格式通过下方「默认协议」补全 scheme。
      </div>

      {!showBatch && (
        <form onSubmit={handleAdd} className="flex flex-wrap gap-2">
          <Input
            placeholder="代理地址（可不带协议）"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            className="flex-1 min-w-[220px] font-mono text-sm"
          />
          <Input
            placeholder="备注（可选）"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            className="w-32"
          />
          {schemeSelect}
          <Button type="submit" size="sm" disabled={addMutation.isPending || !newUrl.trim()}>
            <Plus className="h-4 w-4 mr-1" />
            添加
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setShowBatch(true)}>
            <Upload className="h-4 w-4 mr-1" />
            批量
          </Button>
        </form>
      )}

      {showBatch && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm font-medium">
              批量导入（每行一个，# 开头为注释）
            </label>
            <span className="text-xs text-muted-foreground">默认协议</span>
            {schemeSelect}
          </div>
          <textarea
            placeholder={'# 每行一个，无需写协议\nUSERxxx-zone-GB-session-123:password:host.example.com:10000\nhost2.example.com:8080'}
            value={batchText}
            onChange={(e) => setBatchText(e.target.value)}
            className="flex min-h-[140px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => batchMutation.mutate()}
              disabled={batchMutation.isPending || !batchText.trim()}
            >
              导入
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setShowBatch(false)
                setBatchText('')
                setBatchErrors([])
              }}
            >
              {batchMutation.isSuccess ? '关闭' : '取消'}
            </Button>
          </div>
          {batchErrors.length > 0 && (
            <div className="text-xs text-muted-foreground space-y-1 max-h-24 overflow-y-auto border rounded-md p-2">
              <div className="font-medium text-yellow-600 dark:text-yellow-400">跳过的条目：</div>
              {batchErrors.map((msg, i) => (
                <div key={i}>{msg}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="rounded-md border p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">全局代理</span>
          </div>
          {currentGlobalProxy && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs text-destructive hover:text-destructive"
              onClick={() => setGlobalProxyMutation.mutate(null)}
              disabled={setGlobalProxyMutation.isPending}
            >
              清除
            </Button>
          )}
        </div>
        <div className="text-xs font-mono text-muted-foreground">
          {currentGlobalProxy ? maskProxyUrl(currentGlobalProxy) : '未配置（直连）'}
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">共 {data?.total ?? 0} 个代理</div>
          {(data?.total ?? 0) > 0 && (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => checkAllMutation.mutate()}
                disabled={checkAllMutation.isPending}
              >
                <Activity className="h-3 w-3 mr-1" />
                {checkAllMutation.isPending ? '检测中...' : '全部检测'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => assignRoundRobinMutation.mutate()}
                disabled={assignRoundRobinMutation.isPending}
              >
                <Shuffle className="h-3 w-3 mr-1" />
                轮询分配
              </Button>
            </div>
          )}
        </div>

        {isLoading && (
          <div className="text-sm text-muted-foreground py-4 text-center">加载中...</div>
        )}

        {data?.proxies.length === 0 && !isLoading && (
          <div className="text-sm text-muted-foreground py-8 text-center border rounded-md">
            暂无代理，请添加或批量导入
          </div>
        )}

        <div className="border rounded-md divide-y max-h-[480px] overflow-y-auto">
          {data?.proxies.map((proxy: ProxyPoolEntry) => (
            <div key={proxy.id} className="flex items-center gap-3 p-3">
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
                <div className="flex items-center gap-3 mt-0.5">
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
      </div>
    </div>
  )
}
