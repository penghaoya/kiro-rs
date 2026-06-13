import { maskProxyUrl } from '@/lib/utils'
import type { ProxyEgressInfo, ProxyPoolEntry } from '@/types/api'

/** 延迟分级：住宅代理普遍偏慢，按相对档位上色，避免 5000ms 也显示为「健康绿」。 */
export type LatencyTier = 'fast' | 'ok' | 'slow' | 'verySlow'

export function getLatencyTier(ms: number | null | undefined): LatencyTier {
  if (ms == null) return 'ok'
  if (ms < 1000) return 'fast'
  if (ms < 3000) return 'ok'
  if (ms < 5000) return 'slow'
  return 'verySlow'
}

/** 延迟档位对应的文字色（用于延迟药丸）。 */
export function latencyTierClass(tier: LatencyTier): string {
  switch (tier) {
    case 'fast':
      return 'text-emerald-600 dark:text-emerald-400'
    case 'ok':
      return 'text-foreground/70'
    case 'slow':
      return 'text-amber-600 dark:text-amber-400'
    case 'verySlow':
      return 'text-orange-600 dark:text-orange-400'
  }
}

/** 风险分（IPPure fraudScore）对应文字色：≥70 红，≥40 琥珀，否则绿。 */
export function fraudScoreClass(score: number): string {
  if (score >= 70) return 'text-destructive'
  if (score >= 40) return 'text-amber-600 dark:text-amber-400'
  return 'text-emerald-600 dark:text-emerald-400'
}

/** 国家码 → 区域指示符 emoji（🇬🇧 等）；非两位字母返回空串。 */
export function countryCodeToFlag(code: string | undefined | null): string {
  if (!code || code.length !== 2 || !/^[a-zA-Z]{2}$/.test(code)) return ''
  const base = 0x1f1e6
  const cc = code.toUpperCase()
  return String.fromCodePoint(base + cc.charCodeAt(0) - 65, base + cc.charCodeAt(1) - 65)
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，超过 7 天回退为本地日期。 */
export function formatRelativeTime(iso: string | undefined | null): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 0) return '刚刚'
  if (diffSec < 60) return '刚刚'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)} 天前`
  return new Date(iso).toLocaleDateString()
}

/** 拆分代理 URL 为「协议 + host:port」，用于列表行展示（脱敏后认证段已去除）。 */
export function splitProxyDisplay(url: string): { scheme: string; hostPort: string } {
  const m = url.match(/^(\w+):\/\/(.*)$/)
  if (!m) return { scheme: '', hostPort: url }
  const scheme = m[1]
  const rest = m[2]
  const at = rest.lastIndexOf('@')
  const hostPort = at >= 0 ? rest.slice(at + 1) : rest
  return { scheme, hostPort }
}

/** 出口 IP 摘要（用于下拉、卡面等） */
export function formatProxyEgressSummary(egress: ProxyEgressInfo): string {
  const loc = [egress.city, egress.countryCode || egress.country].filter(Boolean).join(', ')
  const parts = [egress.ip]
  if (loc) parts.push(loc)
  if (egress.fraudScore != null) parts.push(`风险${egress.fraudScore}`)
  if (egress.isResidential === true) parts.push('住宅')
  else if (egress.isBroadcast === true) parts.push('机房')
  return parts.join(' · ')
}

/** 代理池下拉选项文案（优先展示出口 IP，便于区分同 host 不同 session） */
export function formatProxyPoolOptionLabel(entry: ProxyPoolEntry): string {
  const parts: string[] = []
  if (entry.label) parts.push(entry.label)
  parts.push(`#${entry.id}`)

  if (entry.egress?.ip) {
    parts.push(formatProxyEgressSummary(entry.egress))
  } else if (entry.health === 'unhealthy') {
    parts.push('不可用')
  } else {
    parts.push('未检测')
  }

  if (entry.latencyMs != null) {
    parts.push(`${entry.latencyMs}ms`)
  }

  return parts.join(' · ')
}

export function findProxyPoolEntry(
  proxyUrl: string | undefined | null,
  pool: ProxyPoolEntry[] | undefined,
): ProxyPoolEntry | undefined {
  if (!proxyUrl || proxyUrl === 'direct') return undefined
  return pool?.find((p) => p.url === proxyUrl)
}

/** 凭据卡 / 列表上展示的代理文案 */
export function formatCredentialProxyDisplay(
  proxyUrl: string | undefined | null,
  pool: ProxyPoolEntry[] | undefined,
): { text: string; title: string } {
  if (!proxyUrl) {
    return { text: '全局', title: '使用全局代理配置' }
  }
  if (proxyUrl === 'direct') {
    return { text: '直连', title: '不使用代理' }
  }

  const entry = findProxyPoolEntry(proxyUrl, pool)
  const masked = maskProxyUrl(proxyUrl)

  if (entry?.egress?.ip) {
    const text = formatProxyEgressSummary(entry.egress)
    return {
      text,
      title: [text, masked, entry.label].filter(Boolean).join('\n'),
    }
  }

  if (entry) {
    const text = entry.label ? `${entry.label} · #${entry.id}` : `#${entry.id} · 未检测`
    return { text, title: masked }
  }

  return { text: masked, title: proxyUrl }
}

/** 按出口 IP 排序，便于在下拉中快速对比 */
export function sortProxyPoolEntries(entries: ProxyPoolEntry[]): ProxyPoolEntry[] {
  return [...entries].sort((a, b) => {
    const ipA = a.egress?.ip ?? ''
    const ipB = b.egress?.ip ?? ''
    if (ipA && ipB && ipA !== ipB) return ipA.localeCompare(ipB)
    if (ipA && !ipB) return -1
    if (!ipA && ipB) return 1
    return a.id - b.id
  })
}
