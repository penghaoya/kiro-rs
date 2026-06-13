import { maskProxyUrl } from '@/lib/utils'
import type { ProxyEgressInfo, ProxyPoolEntry } from '@/types/api'

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
