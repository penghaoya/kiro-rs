import { useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ScrollText,
  RefreshCw,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  AlertTriangle,
  CheckCircle2,
  Unplug,
  Settings2,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import { useTraces } from '@/hooks/use-traces'
import {
  useLogGovernanceConfig,
  useSetLogGovernanceConfig,
} from '@/hooks/use-credentials'
import { extractErrorMessage } from '@/lib/utils'
import type { TraceAttempt, TraceQuery, TraceRecord } from '@/types/api'

/** 失败分类 → 中文标签 + Badge 颜色 */
function outcomeStyle(outcome: string): {
  label: string
  variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'
} {
  switch (outcome) {
    case 'success':
      return { label: '成功', variant: 'success' }
    case 'quota_exhausted':
      return { label: '额度耗尽', variant: 'warning' }
    case 'account_throttled':
      return { label: '账号风控', variant: 'warning' }
    case 'auth_failed':
      return { label: '鉴权失败', variant: 'destructive' }
    case 'transient':
      return { label: '瞬态错误', variant: 'outline' }
    case 'network_error':
      return { label: '网络错误', variant: 'destructive' }
    case 'bad_request':
      return { label: '请求错误', variant: 'destructive' }
    case 'stream_interrupted':
      return { label: '流中断', variant: 'warning' }
    default:
      return { label: outcome || '未知', variant: 'secondary' }
  }
}

/** 状态徽章（紧凑） */
function StatusBadge({ status }: { status: string }) {
  if (status === 'success')
    return (
      <Badge variant="success" className="h-6 px-2 text-[11px] font-normal">
        <CheckCircle2 className="mr-1 h-3 w-3" />
        成功
      </Badge>
    )
  if (status === 'interrupted')
    return (
      <Badge variant="warning" className="h-6 px-2 text-[11px] font-normal">
        <Unplug className="mr-1 h-3 w-3" />
        中断
      </Badge>
    )
  return (
    <Badge variant="destructive" className="h-6 px-2 text-[11px] font-normal">
      <AlertTriangle className="mr-1 h-3 w-3" />
      失败
    </Badge>
  )
}

function formatTime(ts: string): string {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  return d.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function formatTimeFull(ts: string): string {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  return d.toLocaleString('zh-CN', { hour12: false })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function credLabel(id: number, email?: string | null): string {
  if (id === 0) return '—'
  return email ? email : `#${id}`
}

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'success', label: '成功' },
  { value: 'error', label: '失败' },
  { value: 'interrupted', label: '中断' },
]

const ERROR_TYPE_OPTIONS = [
  { value: '', label: '全部错误类型' },
  { value: 'quota_exhausted', label: '额度耗尽' },
  { value: 'account_throttled', label: '账号风控' },
  { value: 'auth_failed', label: '鉴权失败' },
  { value: 'transient', label: '瞬态错误' },
  { value: 'network_error', label: '网络错误' },
  { value: 'bad_request', label: '请求错误' },
  { value: 'stream_interrupted', label: '流中断' },
  { value: 'unknown', label: '未知' },
]

/** 单跳明细行 */
function AttemptRow({ a }: { a: TraceAttempt }) {
  const style = outcomeStyle(a.outcome)
  return (
    <div className="rounded-lg border border-border/50 bg-secondary/30 p-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-mono text-muted-foreground">#{a.attempt}</span>
        <Badge variant={style.variant}>{style.label}</Badge>
        <span className="text-muted-foreground">凭据</span>
        <span className="font-medium">{credLabel(a.credentialId, a.email)}</span>
        {a.endpoint && <Badge variant="outline">{a.endpoint}</Badge>}
        <span className="text-muted-foreground">HTTP</span>
        <span className="font-mono">{a.httpStatus ?? '—'}</span>
        <span className="ml-auto font-mono text-muted-foreground">
          {formatDuration(a.durationMs)}
        </span>
      </div>
      {a.errorSnippet && (
        <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background/60 p-2 font-mono text-[11px] text-muted-foreground">
          {a.errorSnippet}
        </pre>
      )}
    </div>
  )
}

/** 可展开的链路行 */
function TraceRow({
  rec,
  open,
  onToggle,
}: {
  rec: TraceRecord
  open: boolean
  onToggle: () => void
}) {
  const errStyle = rec.errorType ? outcomeStyle(rec.errorType) : null
  return (
    <>
      <tr
        className={`cursor-pointer border-b border-border/40 transition-colors ${
          open ? 'bg-accent/30' : 'hover:bg-accent/40'
        }`}
        onClick={onToggle}
      >
        <td className="w-8 py-2 pl-2 pr-0 text-center">
          {open ? (
            <ChevronDown className="mx-auto h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="mx-auto h-3.5 w-3.5 text-muted-foreground" />
          )}
        </td>
        <td
          className="py-2 pr-2 text-xs tabular-nums text-muted-foreground whitespace-nowrap"
          title={formatTimeFull(rec.ts)}
        >
          {formatTime(rec.ts)}
        </td>
        <td className="py-2 pr-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-1 overflow-hidden">
            <span className="truncate font-medium" title={rec.model}>
              {rec.model}
            </span>
            {rec.isStream && (
              <Badge variant="outline" className="shrink-0 h-5 px-1.5 text-[10px]">
                流
              </Badge>
            )}
          </div>
        </td>
        <td className="py-2 pr-2 whitespace-nowrap">
          <StatusBadge status={rec.finalStatus} />
        </td>
        <td
          className="py-2 pr-2 text-xs text-foreground/90 whitespace-nowrap"
          title={credLabel(rec.finalCredentialId, rec.finalEmail)}
        >
          {credLabel(rec.finalCredentialId, rec.finalEmail)}
        </td>
        <td className="py-2 pr-2 whitespace-nowrap hidden lg:table-cell">
          {errStyle ? (
            <Badge variant={errStyle.variant} className="h-6 px-2 text-[11px] font-normal">
              {errStyle.label}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground/60">—</span>
          )}
        </td>
        <td className="py-2 pr-2 text-xs tabular-nums text-center text-muted-foreground">
          {Math.max(0, rec.totalAttempts - 1)}
        </td>
        <td className="py-2 pr-3 text-xs tabular-nums text-muted-foreground whitespace-nowrap text-right">
          {formatDuration(rec.durationMs)}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border/40 bg-secondary/20">
          <td colSpan={8} className="px-3 py-3">
            <ExpandedDetail rec={rec} />
          </td>
        </tr>
      )}
    </>
  )
}

/** 展开后的链路详情：错误摘要 + 每跳时间线 */
function ExpandedDetail({ rec }: { rec: TraceRecord }) {
  return (
    <div className="space-y-3">
      {rec.errorMessage && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-[13px] text-destructive">
          {rec.errorMessage}
        </div>
      )}
      {rec.interruptedAfterBytes != null && (
        <div className="text-[12px] text-muted-foreground">
          中断前已发送 {rec.interruptedAfterBytes} 字节
        </div>
      )}
      <div className="text-[12px] font-medium text-muted-foreground">
        尝试链路（{rec.attempts.length} 次
        {rec.attempts.length > 1 ? `，含 ${rec.attempts.length - 1} 次重试` : "，未重试"}）
      </div>
      <div className="space-y-2">
        {rec.attempts.length === 0 ? (
          <div className="text-[13px] text-muted-foreground">无尝试记录（请求未到达上游）</div>
        ) : (
          rec.attempts.map((a) => <AttemptRow key={a.attempt} a={a} />)
        )}
      </div>
    </div>
  )
}

/** 下拉筛选器 */
function FilterSelect({
  value,
  onChange,
  options,
  className,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  className?: string
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={
        className ??
        'h-8 min-w-0 rounded-md border border-border/70 bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring'
      }
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/** 日志治理设置下拉：trace 启用开关 + trace 保留天数 + usage 保留天数 */
function GovernanceButton() {
  const [open, setOpen] = useState(false)
  const { data: cfg, isLoading } = useLogGovernanceConfig()
  const { mutate, isPending } = useSetLogGovernanceConfig()
  const [traceDays, setTraceDays] = useState('')
  const [usageDays, setUsageDays] = useState('')

  const enabled = cfg?.traceEnabled ?? true

  const save = (patch: Record<string, unknown>, ok: string) => {
    mutate(patch, {
      onSuccess: () => toast.success(ok),
      onError: (err) => toast.error('保存失败：' + extractErrorMessage(err)),
    })
  }

  const submitDays = (
    e: React.FormEvent,
    field: 'traceRetentionDays' | 'usageLogRetentionDays',
    raw: string,
    reset: () => void,
  ) => {
    e.preventDefault()
    const n = parseInt(raw, 10)
    if (isNaN(n) || n < 1 || n > 365) {
      toast.error('保留天数需在 1..=365')
      return
    }
    save({ [field]: n }, '保留天数已更新')
    reset()
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Settings2 className="h-3.5 w-3.5" />
          治理设置
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>请求链路追踪</DropdownMenuLabel>
        <div className="px-2 pb-2">
          <div className="flex items-center justify-between gap-2 rounded-md bg-secondary/40 px-2.5 py-2">
            <div className="text-xs">
              <div className="font-medium text-foreground">
                {enabled ? '已启用' : '已关闭'}
              </div>
              <div className="leading-snug text-muted-foreground">
                {enabled
                  ? '记录每次请求的完整重试链路到 traces.db'
                  : '不再写入新链路（历史记录仍可查询）'}
              </div>
            </div>
            <Switch
              checked={enabled}
              disabled={isLoading || isPending}
              onCheckedChange={(v) =>
                save({ traceEnabled: v }, v ? '已开启链路追踪' : '已关闭链路追踪')
              }
            />
          </div>
        </div>
        <DropdownMenuLabel className="pt-1">
          trace 保留天数（当前 {cfg?.traceRetentionDays ?? '—'}）
        </DropdownMenuLabel>
        <form
          onSubmit={(e) => submitDays(e, 'traceRetentionDays', traceDays, () => setTraceDays(''))}
          className="flex items-center gap-1.5 px-2 pb-2"
        >
          <Input
            type="number"
            min={1}
            max={365}
            placeholder="天数"
            value={traceDays}
            onChange={(e) => setTraceDays(e.target.value)}
            disabled={isPending}
            className="h-7 text-xs"
          />
          <Button type="submit" size="sm" variant="outline" className="h-7 text-xs" disabled={isPending || !traceDays.trim()}>
            保存
          </Button>
        </form>
        <DropdownMenuLabel className="pt-1">
          usage 日志保留天数（当前 {cfg?.usageLogRetentionDays ?? '—'}）
        </DropdownMenuLabel>
        <form
          onSubmit={(e) => submitDays(e, 'usageLogRetentionDays', usageDays, () => setUsageDays(''))}
          className="flex items-center gap-1.5 px-2 pb-2"
        >
          <Input
            type="number"
            min={1}
            max={365}
            placeholder="天数"
            value={usageDays}
            onChange={(e) => setUsageDays(e.target.value)}
            disabled={isPending}
            className="h-7 text-xs"
          />
          <Button type="submit" size="sm" variant="outline" className="h-7 text-xs" disabled={isPending || !usageDays.trim()}>
            保存
          </Button>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}


const PAGE_SIZE_OPTIONS = [10, 15, 20, 30] as const
const DEFAULT_PAGE_SIZE = 15
const STORAGE_KEY = 'tracesPageSize'

function readPageSize(): number {
  const saved = Number(localStorage.getItem(STORAGE_KEY))
  return PAGE_SIZE_OPTIONS.includes(saved as (typeof PAGE_SIZE_OPTIONS)[number])
    ? saved
    : DEFAULT_PAGE_SIZE
}

function TracePaginationBar({
  page,
  totalPages,
  total,
  pageSize,
  isFetching,
  onPageChange,
  onPageSizeChange,
}: {
  page: number
  totalPages: number
  total: number
  pageSize: number
  isFetching: boolean
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}) {
  const from = total === 0 ? 0 : page * pageSize + 1
  const to = Math.min(total, (page + 1) * pageSize)

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-muted/20 px-4 py-2.5">
      <div className="text-xs text-muted-foreground tabular-nums">
        {total > 0 ? (
          <>
            显示 <span className="font-medium text-foreground">{from}–{to}</span>
            <span className="mx-1.5 text-muted-foreground/40">/</span>
            共 {total} 条
          </>
        ) : (
          '暂无数据'
        )}
        {isFetching && (
          <span className="ml-2 inline-flex items-center gap-1 text-muted-foreground/80">
            <RefreshCw className="h-3 w-3 animate-spin" />
            更新中
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          title="每页条数"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n} 条/页
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => onPageChange(Math.max(0, page - 1))}
            disabled={page === 0 || isFetching}
            title="上一页"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[4.5rem] text-center text-xs tabular-nums text-muted-foreground">
            {page + 1} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
            disabled={page >= totalPages - 1 || isFetching}
            title="下一页"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

export function TraceLogPage() {
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('')
  const [errorType, setErrorType] = useState('')
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(readPageSize)
  const [expandedTraceId, setExpandedTraceId] = useState<string | null>(null)

  // 筛选条件变化时回到第一页
  const resetTo = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v)
    setPage(0)
    setExpandedTraceId(null)
  }

  const query: TraceQuery = {
    status: status || undefined,
    errorType: errorType || undefined,
    onlyFailed: onlyFailed || undefined,
    limit: pageSize,
    offset: page * pageSize,
  }
  const { data, isLoading, isFetching, refetch } = useTraces(query)
  const records = data?.records ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const goToPage = (next: number) => {
    setPage(next)
    setExpandedTraceId(null)
    tableScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handlePageSizeChange = (size: number) => {
    setPageSize(size)
    setPage(0)
    setExpandedTraceId(null)
    localStorage.setItem(STORAGE_KEY, String(size))
    tableScrollRef.current?.scrollTo({ top: 0 })
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* 页头：与其它 Tab 一致 */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <ScrollText className="mt-0.5 h-5 w-5 text-muted-foreground" />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">请求日志</h1>
              {total > 0 && (
                <Badge variant="secondary" className="h-5 px-2 text-[11px] font-normal">
                  {total} 条
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              查看每次 API 调用的重试链路与失败原因，每 5 秒自动刷新
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <GovernanceButton />
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>
      </div>

      {/* 单卡片：筛选 + 表格 + 底部分页 */}
      <Card className="overflow-hidden border-border/60 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/10 px-3 py-2.5 sm:px-4">
          <FilterSelect
            value={status}
            onChange={resetTo(setStatus)}
            options={STATUS_OPTIONS}
            className="h-8 w-[108px] rounded-md border border-border/70 bg-background px-2 text-xs"
          />
          <FilterSelect
            value={errorType}
            onChange={resetTo(setErrorType)}
            options={ERROR_TYPE_OPTIONS}
            className="h-8 min-w-[120px] max-w-[140px] rounded-md border border-border/70 bg-background px-2 text-xs"
          />
          <Button
            size="sm"
            variant={onlyFailed ? 'default' : 'outline'}
            className="h-8 text-xs"
            onClick={() => {
              setOnlyFailed((v) => !v)
              setPage(0)
              setExpandedTraceId(null)
            }}
          >
            只看失败
          </Button>
          {(status || errorType || onlyFailed) && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-xs text-muted-foreground"
              onClick={() => {
                setStatus('')
                setErrorType('')
                setOnlyFailed(false)
                setPage(0)
                setExpandedTraceId(null)
              }}
            >
              清除筛选
            </Button>
          )}
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">加载中…</div>
        ) : records.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            暂无记录。发起几次 /v1/messages 请求后即可看到链路。
          </div>
        ) : (
          <>
            <div
              ref={tableScrollRef}
              className="max-h-[min(480px,calc(100vh-16.5rem))] overflow-auto"
            >
              <table className="w-full min-w-[920px] table-fixed text-left">
                <colgroup>
                  <col style={{ width: 28 }} />
                  <col style={{ width: 104 }} />
                  <col style={{ width: '20%' }} />
                  <col style={{ width: 68 }} />
                  <col style={{ width: '36%' }} />
                  <col style={{ width: 76 }} />
                  <col style={{ width: 36 }} />
                  <col style={{ width: 48 }} />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                  <tr className="border-b border-border/60 text-[11px] text-muted-foreground">
                    <th className="py-2 pl-2 font-medium" />
                    <th className="py-2 pr-2 font-medium">时间</th>
                    <th className="py-2 pr-2 font-medium">模型</th>
                    <th className="py-2 pr-2 font-medium">状态</th>
                    <th className="py-2 pr-2 font-medium">凭据</th>
                    <th className="py-2 pr-2 font-medium hidden lg:table-cell">错误</th>
                    <th className="py-2 pr-2 font-medium text-center">重试</th>
                    <th className="py-2 pr-3 font-medium text-right">耗时</th>
                  </tr>
                </thead>
                <tbody className={isFetching ? 'opacity-60 transition-opacity' : undefined}>
                  {records.map((rec) => (
                    <TraceRow
                      key={rec.traceId}
                      rec={rec}
                      open={expandedTraceId === rec.traceId}
                      onToggle={() =>
                        setExpandedTraceId((id) =>
                          id === rec.traceId ? null : rec.traceId,
                        )
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <TracePaginationBar
              page={page}
              totalPages={totalPages}
              total={total}
              pageSize={pageSize}
              isFetching={isFetching}
              onPageChange={goToPage}
              onPageSizeChange={handlePageSizeChange}
            />
          </>
        )}

        {!isLoading && records.length === 0 && total > 0 && (
          <TracePaginationBar
            page={page}
            totalPages={totalPages}
            total={total}
            pageSize={pageSize}
            isFetching={isFetching}
            onPageChange={goToPage}
            onPageSizeChange={handlePageSizeChange}
          />
        )}
      </Card>
    </div>
  )
}




