import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ProxyPoolPanel } from '@/components/proxy-pool-panel'

interface ProxyPoolDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectProxy?: (url: string) => void
}

export function ProxyPoolDialog({ open, onOpenChange, onSelectProxy }: ProxyPoolDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>代理 IP 池管理</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto py-2">
          <ProxyPoolPanel
            enabled={open}
            onSelectProxy={
              onSelectProxy
                ? (url) => {
                    onSelectProxy(url)
                    onOpenChange(false)
                  }
                : undefined
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
