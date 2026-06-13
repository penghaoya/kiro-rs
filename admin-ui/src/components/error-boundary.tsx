import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ErrorBoundaryProps {
  children: ReactNode
  /** 自定义降级 UI；不传则使用默认错误卡片 */
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * 捕获子树渲染期抛出的异常，避免整个面板白屏。
 * Suspense 只兜 lazy 加载，渲染错误得靠 ErrorBoundary。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI 渲染异常被 ErrorBoundary 捕获:', error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset)
      return (
        <div className="mx-auto max-w-md py-20 px-6 text-center space-y-4">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">页面出错了</p>
            <p className="text-xs text-muted-foreground break-words">
              {error.message || '渲染时发生未知错误'}
            </p>
          </div>
          <div className="flex items-center justify-center gap-2">
            <Button size="sm" variant="outline" onClick={this.reset}>
              <RotateCcw className="h-3.5 w-3.5 mr-1" />
              重试
            </Button>
            <Button size="sm" onClick={() => window.location.reload()}>
              刷新页面
            </Button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
