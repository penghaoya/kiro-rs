import type { ProxyImportFormat, ProxyScheme } from '@/types/api'

export const PROXY_IMPORT_FORMAT_KEY = 'proxyImportFormat'
export const PROXY_DEFAULT_SCHEME_KEY = 'proxyDefaultScheme'
export const PROXY_AUTO_CHECK_KEY = 'proxyAutoCheckAfterImport'

export const SCHEME_OPTIONS: { value: ProxyScheme; label: string; hint?: string }[] = [
  { value: 'socks5h', label: 'SOCKS5H', hint: '代理解析 DNS，住宅代理推荐' },
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'socks4', label: 'SOCKS4' },
]

export const IMPORT_FORMAT_OPTIONS: {
  value: ProxyImportFormat
  label: string
  example: string
  recommended?: boolean
}[] = [
  {
    value: 'host_port_user_pass',
    label: '主机:端口:用户:密码',
    example: 'host.example.com:10000:user:pass',
  },
  {
    value: 'user_pass_host_port',
    label: '用户:密码:主机:端口',
    example: 'USER-zone-GB:pass:host.example.com:10000',
    recommended: true,
  },
  {
    value: 'user_pass_at_host_port',
    label: '用户:密码@主机:端口',
    example: 'user:pass@host.example.com:10000',
  },
  {
    value: 'host_port_at_user_pass',
    label: '主机:端口@用户:密码',
    example: 'host.example.com:10000@user:pass',
  },
]

const SCHEME_VALUES: ProxyScheme[] = ['http', 'https', 'socks5', 'socks5h', 'socks4']

export function loadDefaultScheme(): ProxyScheme {
  if (typeof window === 'undefined') return 'socks5h'
  const saved = localStorage.getItem(PROXY_DEFAULT_SCHEME_KEY) as ProxyScheme | null
  return saved && SCHEME_VALUES.includes(saved) ? saved : 'socks5h'
}

export function saveDefaultScheme(scheme: ProxyScheme) {
  localStorage.setItem(PROXY_DEFAULT_SCHEME_KEY, scheme)
}

export function loadImportFormat(): ProxyImportFormat {
  if (typeof window === 'undefined') return 'user_pass_host_port'
  const saved = localStorage.getItem(PROXY_IMPORT_FORMAT_KEY) as ProxyImportFormat | null
  return IMPORT_FORMAT_OPTIONS.some((o) => o.value === saved) ? saved! : 'user_pass_host_port'
}

export function saveImportFormat(format: ProxyImportFormat) {
  localStorage.setItem(PROXY_IMPORT_FORMAT_KEY, format)
}

export function loadAutoCheckAfterImport(): boolean {
  if (typeof window === 'undefined') return true
  return localStorage.getItem(PROXY_AUTO_CHECK_KEY) !== 'false'
}

export function saveAutoCheckAfterImport(enabled: boolean) {
  localStorage.setItem(PROXY_AUTO_CHECK_KEY, enabled ? 'true' : 'false')
}

export function parseProxyImportLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

export function summarizeProxyImportLines(text: string) {
  const lines = text.split('\n')
  let comments = 0
  let empty = 0
  let valid = 0

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      empty++
      continue
    }
    if (line.startsWith('#')) {
      comments++
      continue
    }
    valid++
  }

  return { total: lines.length, valid, comments, empty }
}
