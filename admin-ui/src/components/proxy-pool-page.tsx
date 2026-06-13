import { Globe } from 'lucide-react'
import { ProxyPoolPanel } from '@/components/proxy-pool-panel'

export function ProxyPoolPage() {
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <Globe className="h-5 w-5 text-muted-foreground" />
        <div>
          <h1 className="text-lg font-semibold tracking-tight">代理池管理</h1>
          <p className="text-sm text-muted-foreground">
            管理代理池、健康检测与凭据分配；支持弹窗批量导入与 SOCKS5H 住宅代理。
          </p>
        </div>
      </div>
      <ProxyPoolPanel />
    </div>
  )
}
