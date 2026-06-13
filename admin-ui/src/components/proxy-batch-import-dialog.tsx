import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  CheckCircle2,
  FileText,
  Loader2,
  Upload,
  XCircle,
  AlertCircle,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { batchAddProxies, checkAllProxies } from '@/api/credentials'
import { extractErrorMessage } from '@/lib/utils'
import type { BatchAddProxyResponse, ProxyImportFormat, ProxyScheme } from '@/types/api'
import {
  IMPORT_FORMAT_OPTIONS,
  SCHEME_OPTIONS,
  loadAutoCheckAfterImport,
  loadDefaultScheme,
  loadImportFormat,
  parseProxyImportLines,
  saveAutoCheckAfterImport,
  saveDefaultScheme,
  saveImportFormat,
  summarizeProxyImportLines,
} from '@/lib/proxy-import'

interface ProxyBatchImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPrefsChange?: (prefs: { scheme: ProxyScheme; format: ProxyImportFormat }) => void
}

type DialogPhase = 'input' | 'result'

export function ProxyBatchImportDialog({
  open,
  onOpenChange,
  onPrefsChange,
}: ProxyBatchImportDialogProps) {
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [phase, setPhase] = useState<DialogPhase>('input')
  const [text, setText] = useState('')
  const [defaultScheme, setDefaultScheme] = useState<ProxyScheme>(loadDefaultScheme)
  const [importFormat, setImportFormat] = useState<ProxyImportFormat>(loadImportFormat)
  const [autoCheck, setAutoCheck] = useState(loadAutoCheckAfterImport)
  const [result, setResult] = useState<BatchAddProxyResponse | null>(null)
  const [checking, setChecking] = useState(false)

  const lineStats = useMemo(() => summarizeProxyImportLines(text), [text])
  const previewLines = useMemo(() => parseProxyImportLines(text).slice(0, 3), [text])

  useEffect(() => {
    if (open) {
      setDefaultScheme(loadDefaultScheme())
      setImportFormat(loadImportFormat())
      setAutoCheck(loadAutoCheckAfterImport())
    }
  }, [open])

  const reset = () => {
    setPhase('input')
    setText('')
    setResult(null)
    setChecking(false)
  }

  const importMutation = useMutation({
    mutationFn: () => {
      const urls = parseProxyImportLines(text)
      if (urls.length === 0) {
        throw new Error('没有可导入的代理行（# 开头为注释）')
      }
      return batchAddProxies({ urls, defaultScheme, importFormat })
    },
    onSuccess: async (res) => {
      setResult(res)
      setPhase('result')
      queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })

      if (res.added === 0 && res.errors > 0) {
        toast.error(`导入失败：${res.errors} 条均被跳过`)
        return
      }
      if (res.errors === 0) {
        toast.success(`成功导入 ${res.added} 个代理`)
      } else {
        toast.info(`导入完成：成功 ${res.added} 个，跳过 ${res.errors} 个`)
      }

      if (autoCheck && res.added > 0) {
        setChecking(true)
        try {
          const checkRes = await checkAllProxies()
          const healed = checkRes.selfHealed > 0 ? `，自愈恢复 ${checkRes.selfHealed}` : ''
          toast.success(
            `健康检查完成：健康 ${checkRes.healthy}，异常 ${checkRes.unhealthy}，自动禁用 ${checkRes.autoDisabled}${healed}`
          )
          queryClient.invalidateQueries({ queryKey: ['proxy-pool'] })
        } catch (err) {
          toast.error(`导入成功，但检测失败: ${extractErrorMessage(err)}`)
        } finally {
          setChecking(false)
        }
      }
    },
    onError: (err) => toast.error(`批量导入失败: ${extractErrorMessage(err)}`),
  })

  const handleOpenChange = (next: boolean) => {
    if (!next && !importMutation.isPending && !checking) {
      reset()
    }
    onOpenChange(next)
  }

  const updateScheme = (scheme: ProxyScheme) => {
    setDefaultScheme(scheme)
    saveDefaultScheme(scheme)
    onPrefsChange?.({ scheme, format: importFormat })
  }

  const updateFormat = (format: ProxyImportFormat) => {
    setImportFormat(format)
    saveImportFormat(format)
    onPrefsChange?.({ scheme: defaultScheme, format })
  }

  const handleFilePick = (file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const content = String(reader.result ?? '')
      setText((prev) => (prev.trim() ? `${prev.trim()}\n${content.trim()}` : content.trim()))
    }
    reader.readAsText(file)
  }

  const placeholder = `# 每行一条，支持注释
USER318898-zone-GB-session-123:9038b6:us.rrp.bestgo.work:10000
USER318898-zone-GB-session-456:9038b6:us.rrp.bestgo.work:10000`

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[88vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>批量导入代理</DialogTitle>
          <DialogDescription>
            粘贴或上传代理列表，选择格式与协议后一键导入
            {autoCheck && phase === 'input' ? '，导入后将自动健康检测' : ''}。
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {phase === 'input' ? (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <div className="text-sm font-medium">默认协议</div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {SCHEME_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => updateScheme(opt.value)}
                        className={`rounded-lg border px-2 py-2 text-center text-xs font-medium transition-colors ${
                          defaultScheme === opt.value
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border/60 text-foreground/80 hover:border-border hover:bg-muted/40'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed min-h-[1.25rem]">
                    {SCHEME_OPTIONS.find((o) => o.value === defaultScheme)?.hint ??
                      '用于无协议简写行；完整 URL 会忽略此设置。'}
                  </p>
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-medium">导入选项</div>
                  <label className="flex items-center gap-2.5 rounded-lg border border-border/60 px-3 py-2.5 cursor-pointer transition-colors hover:bg-muted/30">
                    <Checkbox
                      checked={autoCheck}
                      onCheckedChange={(v) => {
                        const next = v === true
                        setAutoCheck(next)
                        saveAutoCheckAfterImport(next)
                      }}
                    />
                    <div className="text-sm">导入完成后自动健康检测</div>
                  </label>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    完整 URL（含 <code className="rounded bg-muted px-1 text-[10px]">socks5h://</code> 等）会忽略格式设置；
                    已存的 <code className="rounded bg-muted px-1 text-[10px]">socks5://</code> 探测时自动按 SOCKS5H 连接。
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">行格式</div>
                  <Badge variant="outline" className="text-[10px] font-normal">
                    有效 {lineStats.valid} 行
                    {lineStats.comments > 0 ? ` · 注释 ${lineStats.comments}` : ''}
                  </Badge>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {IMPORT_FORMAT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => updateFormat(opt.value)}
                      className={`rounded-xl border px-3 py-2.5 text-left transition-all duration-150 ease-apple ${
                        importFormat === opt.value
                          ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                          : 'border-border/60 hover:border-border hover:bg-muted/30'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{opt.label}</span>
                        {opt.recommended && (
                          <Badge variant="secondary" className="h-4 px-1.5 text-[9px]">
                            常用
                          </Badge>
                        )}
                      </div>
                      <code className="mt-1 block text-[10px] text-muted-foreground truncate">
                        {opt.example}
                      </code>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">代理列表</div>
                  <div className="flex items-center gap-1">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".txt,text/plain"
                      className="hidden"
                      onChange={(e) => {
                        handleFilePick(e.target.files?.[0])
                        e.target.value = ''
                      }}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="h-3 w-3 mr-1" />
                      上传 .txt
                    </Button>
                    {text.trim() && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => setText('')}
                      >
                        清空
                      </Button>
                    )}
                  </div>
                </div>
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={placeholder}
                  disabled={importMutation.isPending}
                  className="min-h-[180px] font-mono text-xs leading-relaxed resize-y"
                />
                {previewLines.length > 0 && (
                  <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
                    <div className="font-medium text-foreground/80 mb-1">预览（前 3 行）</div>
                    {previewLines.map((line, i) => (
                      <div key={i} className="truncate font-mono">
                        {line}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            result && (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-4 text-center">
                    <CheckCircle2 className="h-5 w-5 text-green-600 mx-auto mb-1" />
                    <div className="text-2xl font-semibold text-green-600">{result.added}</div>
                    <div className="text-xs text-muted-foreground">成功导入</div>
                  </div>
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-center">
                    <AlertCircle className="h-5 w-5 text-amber-600 mx-auto mb-1" />
                    <div className="text-2xl font-semibold text-amber-600">{result.errors}</div>
                    <div className="text-xs text-muted-foreground">跳过</div>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-muted/20 p-4 text-center">
                    <FileText className="h-5 w-5 text-muted-foreground mx-auto mb-1" />
                    <div className="text-2xl font-semibold">{result.added + result.errors}</div>
                    <div className="text-xs text-muted-foreground">总计处理</div>
                  </div>
                </div>

                {checking && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground rounded-lg border px-3 py-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在对健康代理执行检测…
                  </div>
                )}

                {result.errorMessages.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
                      <XCircle className="h-4 w-4" />
                      跳过明细
                    </div>
                    <div className="max-h-[220px] overflow-y-auto rounded-xl border divide-y text-xs">
                      {result.errorMessages.map((msg, i) => (
                        <div key={i} className="px-3 py-2 text-muted-foreground font-mono">
                          {msg}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {result.added > 0 && result.proxies.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">已添加</div>
                    <div className="max-h-[160px] overflow-y-auto rounded-xl border divide-y text-xs">
                      {result.proxies.map((p) => (
                        <div key={p.id} className="px-3 py-2 flex items-center justify-between gap-2">
                          <span className="font-mono truncate">#{p.id}</span>
                          <span className="text-muted-foreground truncate flex-1 text-right">
                            {p.url.replace(/^[^:]+:\/\//, '…://')}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          )}
        </div>

        <DialogFooter className="px-6 py-4 border-t border-border/60 bg-muted/10">
          {phase === 'input' ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={importMutation.isPending}
              >
                取消
              </Button>
              <Button
                type="button"
                onClick={() => importMutation.mutate()}
                disabled={importMutation.isPending || lineStats.valid === 0}
              >
                {importMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    导入中…
                  </>
                ) : (
                  <>导入 {lineStats.valid > 0 ? `${lineStats.valid} 条` : ''}</>
                )}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setPhase('input')
                  setText('')
                  setResult(null)
                }}
                disabled={checking}
              >
                继续导入
              </Button>
              <Button type="button" onClick={() => handleOpenChange(false)} disabled={checking}>
                完成
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
