//! 代理 IP 池管理
//!
//! 独立于凭据管理，存储为 proxy_pool.json
//!
//! 除增删改查外，还提供主动健康检查：周期性（或按需）通过每个代理请求一个
//! 轻量公网探测端点，记录连通性与延迟；连续探测失败达阈值的代理会被自动禁用。

use crate::admin::types::ProxyEgressInfo;
use crate::http_client::{ProxyConfig, build_client};
use crate::model::config::TlsBackend;
use crate::proxy_url::{normalize_proxy_url, validate_proxy_url as validate_normalized_url};
use futures::{StreamExt, stream};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

/// 健康检查连通性探测（HTTPS CONNECT，兼容 HTTP 代理）
const PROXY_HEALTH_CHECK_URL: &str = "https://cp.cloudflare.com/generate_204";
/// 出口 IP 信息（IPPure 公开 API，测试阶段可能有变动）
const PROXY_EGRESS_INFO_URL: &str = "https://my.ippure.com/v1/info";
/// 单次探测超时（秒）；住宅代理握手较慢，适当放宽
const PROXY_PROBE_TIMEOUT_SECS: u64 = 15;
/// 连续探测失败阈值：达到后自动禁用（与凭据的 MAX_FAILURES_PER_CREDENTIAL 对齐）
const MAX_PROXY_PROBE_FAILURES: u32 = 3;
/// 全量健康检查的最大并发探测数（避免大池子一次性打开过多连接、触发 fd 上限或被限流）
const MAX_CONCURRENT_PROBES: usize = 20;
/// 自动禁用的代理在冷却这么久后，允许健康检查重新探测一次（探测成功即自愈恢复启用）
const AUTO_DISABLED_RETRY_COOLDOWN_SECS: i64 = 30 * 60;

/// 代理健康状态
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyHealth {
    /// 尚未探测
    #[default]
    Unknown,
    /// 最近一次探测成功
    Healthy,
    /// 最近一次探测失败
    Unhealthy,
}

/// 持久化的代理条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyEntry {
    pub id: u64,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 健康状态（健康检查结果）
    #[serde(default)]
    pub health: ProxyHealth,
    /// 最近一次成功探测的延迟（毫秒）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u32>,
    /// 最近一次探测时间（RFC3339）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<String>,
    /// 连续探测失败计数（成功后清零）
    #[serde(default)]
    pub consecutive_failures: u32,
    /// 是否由健康检查自动禁用（区别于用户手动禁用）
    #[serde(default)]
    pub auto_disabled: bool,
    /// 最近一次成功探测的出口 IP 信息
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub egress: Option<ProxyEgressInfo>,
}

fn default_true() -> bool {
    true
}

/// 代理分配结果
pub enum GetUrlResult {
    /// 代理存在且已启用，返回 URL
    Ok(String),
    /// 代理不存在
    NotFound,
    /// 代理存在但已被禁用
    Disabled,
}

/// 一次全量健康检查的摘要
#[derive(Debug, Clone, Default)]
pub struct CheckSummary {
    /// 探测成功数
    pub healthy: usize,
    /// 探测失败数
    pub unhealthy: usize,
    /// 本轮新增的自动禁用数
    pub auto_disabled: usize,
    /// 本轮自愈（冷却后重探成功、自动恢复启用）数
    pub self_healed: usize,
}

/// 单个代理探测结果
enum ProbeResult {
    Ok {
        latency_ms: u32,
        egress: Option<ProxyEgressInfo>,
    },
    Err {
        error: String,
    },
}

pub struct ProxyPoolManager {
    entries: Mutex<Vec<ProxyEntry>>,
    // 仅需原子自增，不需要与 entries 联锁；约定独立使用，无锁顺序问题
    next_id: AtomicU64,
    path: Option<PathBuf>,
    /// TLS 后端，构建探测用 HTTP client 时需要
    tls_backend: TlsBackend,
}

impl ProxyPoolManager {
    pub fn new(path: Option<PathBuf>, tls_backend: TlsBackend) -> Self {
        let entries = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Vec<ProxyEntry>>(&s).ok())
            .unwrap_or_default();

        let next_id = entries.iter().map(|e| e.id).max().unwrap_or(0) + 1;

        Self {
            entries: Mutex::new(entries),
            next_id: AtomicU64::new(next_id),
            path,
            tls_backend,
        }
    }

    pub fn list(&self) -> Vec<ProxyEntry> {
        self.entries.lock().clone()
    }

    pub fn add(
        &self,
        url: String,
        label: Option<String>,
        default_scheme: Option<&str>,
        import_format: crate::proxy_url::ProxyImportFormat,
    ) -> anyhow::Result<ProxyEntry> {
        let url = normalize_proxy_url(&url, default_scheme, import_format)?;
        if url.eq_ignore_ascii_case("direct") {
            anyhow::bail!("代理池不支持 direct，请填写真实代理地址");
        }
        validate_normalized_url(&url)?;

        let mut entries = self.entries.lock();

        if entries.iter().any(|e| e.url == url) {
            anyhow::bail!("代理 URL 已存在: {}", url);
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let entry = ProxyEntry {
            id,
            url,
            label,
            enabled: true,
            health: ProxyHealth::Unknown,
            latency_ms: None,
            last_checked_at: None,
            consecutive_failures: 0,
            auto_disabled: false,
            egress: None,
        };
        entries.push(entry.clone());
        drop(entries);

        self.persist()?;
        Ok(entry)
    }

    /// 批量添加：在单次加锁内完成所有插入，最后统一持久化一次
    pub fn batch_add(
        &self,
        urls: Vec<String>,
        default_scheme: Option<&str>,
        import_format: crate::proxy_url::ProxyImportFormat,
    ) -> (Vec<ProxyEntry>, Vec<String>) {
        let mut added = vec![];
        let mut errors = vec![];

        let mut entries = self.entries.lock();
        for url in urls {
            let url = url.trim();
            if url.is_empty() || url.starts_with('#') {
                continue;
            }
            let url = match normalize_proxy_url(url, default_scheme, import_format) {
                Ok(u) => u,
                Err(e) => {
                    errors.push(e.to_string());
                    continue;
                }
            };
            if url.eq_ignore_ascii_case("direct") {
                errors.push("代理池不支持 direct".to_string());
                continue;
            }
            if let Err(e) = validate_normalized_url(&url) {
                errors.push(e.to_string());
                continue;
            }
            if entries.iter().any(|e| e.url == url) {
                errors.push(format!("代理 URL 已存在: {}", url));
                continue;
            }
            let id = self.next_id.fetch_add(1, Ordering::Relaxed);
            let entry = ProxyEntry {
                id,
                url,
                label: None,
                enabled: true,
                health: ProxyHealth::Unknown,
                latency_ms: None,
                last_checked_at: None,
                consecutive_failures: 0,
                auto_disabled: false,
                egress: None,
            };
            entries.push(entry.clone());
            added.push(entry);
        }
        drop(entries);

        if !added.is_empty() {
            if let Err(e) = self.persist() {
                tracing::warn!("批量添加代理后持久化失败: {}", e);
            }
        }

        (added, errors)
    }

    pub fn delete(&self, id: u64) -> anyhow::Result<()> {
        let mut entries = self.entries.lock();
        let len_before = entries.len();
        entries.retain(|e| e.id != id);
        if entries.len() == len_before {
            anyhow::bail!("代理不存在: {}", id);
        }
        drop(entries);
        self.persist()?;
        Ok(())
    }

    /// 设置代理启用/禁用状态
    ///
    /// 用户手动启用时清除「健康检查自动禁用」标记与连续失败计数，
    /// 让该代理重新参与健康检查与分配。
    pub fn set_enabled(&self, id: u64, enabled: bool) -> anyhow::Result<()> {
        let mut entries = self.entries.lock();
        let entry = entries
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| anyhow::anyhow!("代理不存在: {}", id))?;
        entry.enabled = enabled;
        if enabled {
            entry.auto_disabled = false;
            entry.consecutive_failures = 0;
        }
        drop(entries);
        self.persist()?;
        Ok(())
    }

    /// 获取代理 URL，区分"不存在"和"已禁用"两种情况
    pub fn get_url(&self, id: u64) -> GetUrlResult {
        match self.entries.lock().iter().find(|e| e.id == id) {
            None => GetUrlResult::NotFound,
            Some(e) if !e.enabled => GetUrlResult::Disabled,
            Some(e) => GetUrlResult::Ok(e.url.clone()),
        }
    }

    /// 获取所有「可用于分配」的代理 URL：已启用且非 Unhealthy
    pub fn assignable_urls(&self) -> Vec<String> {
        self.entries
            .lock()
            .iter()
            .filter(|e| e.enabled && e.health != ProxyHealth::Unhealthy)
            .map(|e| e.url.clone())
            .collect()
    }

    fn persist(&self) -> anyhow::Result<()> {
        let path = match &self.path {
            Some(p) => p,
            None => return Ok(()),
        };
        let entries = self.entries.lock();
        let json = serde_json::to_string_pretty(&*entries)?;
        std::fs::write(path, json)?;
        Ok(())
    }
}

// ============ 健康检查 ============

impl ProxyPoolManager {
    /// 探测单个代理：先验证连通性，再查询 IPPure 出口信息。
    async fn probe_one(&self, url: &str) -> ProbeResult {
        let proxy = ProxyConfig::from_url(url);
        let client = match build_client(Some(&proxy), PROXY_PROBE_TIMEOUT_SECS, self.tls_backend) {
            Ok(c) => c,
            Err(e) => {
                return ProbeResult::Err {
                    error: format!("构建探测 client 失败: {}", e),
                };
            }
        };

        tracing::debug!(
            "探测代理: {}",
            crate::security::redact_proxy_url(url)
        );

        let started = Instant::now();

        // 优先 IPPure（HTTPS）：连通性 + 出口信息一次完成
        if let Some(egress) = self.fetch_egress_info(&client).await {
            return ProbeResult::Ok {
                latency_ms: started.elapsed().as_millis().min(u32::MAX as u128) as u32,
                egress: Some(egress),
            };
        }

        // 回退：HTTPS 204 探测连通性
        match client.get(PROXY_HEALTH_CHECK_URL).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.as_u16() == 204 || status.is_success() || status.is_redirection() {
                    ProbeResult::Ok {
                        latency_ms: started.elapsed().as_millis().min(u32::MAX as u128) as u32,
                        egress: None,
                    }
                } else {
                    ProbeResult::Err {
                        error: format!(
                            "连通性探测 {} 返回非预期状态: {}",
                            PROXY_HEALTH_CHECK_URL,
                            status
                        ),
                    }
                }
            }
            Err(e) => ProbeResult::Err {
                error: format!(
                    "连通性探测 {} 失败: {}（请确认导入格式与协议类型）",
                    PROXY_HEALTH_CHECK_URL,
                    e
                ),
            },
        }
    }

    /// 通过 IPPure 查询代理出口 IP 信息；失败时不影响连通性判定。
    async fn fetch_egress_info(&self, client: &reqwest::Client) -> Option<ProxyEgressInfo> {
        match client.get(PROXY_EGRESS_INFO_URL).send().await {
            Ok(resp) if resp.status().is_success() => match resp.json::<ProxyEgressInfo>().await {
                Ok(info) if !info.ip.trim().is_empty() => Some(info),
                Ok(_) => {
                    tracing::warn!("IPPure 返回空 IP");
                    None
                }
                Err(e) => {
                    tracing::warn!("IPPure 响应解析失败: {}", e);
                    None
                }
            },
            Ok(resp) => {
                tracing::warn!("IPPure 返回非成功状态: {}", resp.status());
                None
            }
            Err(e) => {
                tracing::warn!("IPPure 查询失败: {}", e);
                None
            }
        }
    }

    /// 将一次探测结果回写到指定条目，并按需触发自动禁用 / 自愈恢复。
    ///
    /// 返回 `(变为不健康, 本次新自动禁用, 本次自愈恢复)` 供摘要统计。
    fn apply_probe_result(entry: &mut ProxyEntry, result: &ProbeResult) -> (bool, bool, bool) {
        entry.last_checked_at = Some(chrono::Utc::now().to_rfc3339());
        match result {
            ProbeResult::Ok {
                latency_ms,
                egress,
            } => {
                entry.health = ProxyHealth::Healthy;
                entry.latency_ms = Some(*latency_ms);
                entry.consecutive_failures = 0;
                entry.egress = egress.clone();
                // 自愈：此前被健康检查自动禁用的代理，重探成功后自动恢复启用。
                // 用户手动禁用（auto_disabled == false）的不在此恢复，尊重用户意图。
                let mut self_healed = false;
                if entry.auto_disabled {
                    entry.enabled = true;
                    entry.auto_disabled = false;
                    self_healed = true;
                    tracing::info!("代理 #{} 重探成功，已自动恢复启用", entry.id);
                }
                (false, false, self_healed)
            }
            ProbeResult::Err { error } => {
                entry.health = ProxyHealth::Unhealthy;
                entry.latency_ms = None;
                entry.egress = None;
                entry.consecutive_failures += 1;
                tracing::warn!(
                    "代理 #{} 探测失败（{}/{}）: {}",
                    entry.id,
                    entry.consecutive_failures,
                    MAX_PROXY_PROBE_FAILURES,
                    error
                );
                let mut newly_disabled = false;
                if entry.consecutive_failures >= MAX_PROXY_PROBE_FAILURES && entry.enabled {
                    entry.enabled = false;
                    entry.auto_disabled = true;
                    newly_disabled = true;
                    tracing::error!(
                        "代理 #{} 连续探测失败 {} 次，已自动禁用",
                        entry.id,
                        entry.consecutive_failures
                    );
                }
                (true, newly_disabled, false)
            }
        }
    }

    /// 全量健康检查：并发探测「已启用」代理 + 冷却期满的自动禁用代理，回写并持久化一次。
    ///
    /// 探测目标：
    /// - 所有 `enabled` 条目；
    /// - 以及 `auto_disabled` 且距上次探测已超过 `AUTO_DISABLED_RETRY_COOLDOWN_SECS`
    ///   的条目（给被自动禁用的代理一次重探自愈机会，成功即恢复启用）。
    ///
    /// 用户手动禁用（`enabled == false` 且 `auto_disabled == false`）的条目始终跳过。
    /// 并发度由 `MAX_CONCURRENT_PROBES` 限流，避免大池子一次性打开过多连接。
    pub async fn check_all(&self) -> CheckSummary {
        // 快照待探测的 (id, url)，避免长时间持锁
        let now = chrono::Utc::now();
        let targets: Vec<(u64, String)> = self
            .entries
            .lock()
            .iter()
            .filter(|e| e.enabled || Self::auto_disabled_cooldown_elapsed(e, now))
            .map(|e| (e.id, e.url.clone()))
            .collect();

        if targets.is_empty() {
            return CheckSummary::default();
        }

        // 限流并发：最多 MAX_CONCURRENT_PROBES 个探测同时在飞
        let results: Vec<(u64, ProbeResult)> = stream::iter(targets)
            .map(|(id, url)| async move { (id, self.probe_one(&url).await) })
            .buffer_unordered(MAX_CONCURRENT_PROBES)
            .collect()
            .await;

        let mut summary = CheckSummary::default();
        {
            let mut entries = self.entries.lock();
            for (id, result) in &results {
                if let Some(entry) = entries.iter_mut().find(|e| e.id == *id) {
                    let (unhealthy, newly_disabled, self_healed) =
                        Self::apply_probe_result(entry, result);
                    if unhealthy {
                        summary.unhealthy += 1;
                    } else {
                        summary.healthy += 1;
                    }
                    if newly_disabled {
                        summary.auto_disabled += 1;
                    }
                    if self_healed {
                        summary.self_healed += 1;
                    }
                }
            }
        }

        if let Err(e) = self.persist() {
            tracing::warn!("健康检查后持久化失败: {}", e);
        }
        summary
    }

    /// 判断一个自动禁用的条目是否已过重探冷却期（可被纳入下一轮健康检查）。
    ///
    /// 仅对 `auto_disabled` 条目生效；从未探测过（无 `last_checked_at`）的视为已过冷却。
    fn auto_disabled_cooldown_elapsed(entry: &ProxyEntry, now: chrono::DateTime<chrono::Utc>) -> bool {
        if !entry.auto_disabled {
            return false;
        }
        match entry
            .last_checked_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        {
            Some(last) => {
                (now - last.with_timezone(&chrono::Utc)).num_seconds()
                    >= AUTO_DISABLED_RETRY_COOLDOWN_SECS
            }
            None => true,
        }
    }

    /// 单个代理即时探测（供 UI「测试」按钮调用），回写结果并持久化。
    pub async fn check_one(&self, id: u64) -> anyhow::Result<ProxyEntry> {
        let url = self
            .entries
            .lock()
            .iter()
            .find(|e| e.id == id)
            .map(|e| e.url.clone())
            .ok_or_else(|| anyhow::anyhow!("代理不存在: {}", id))?;

        let result = self.probe_one(&url).await;

        let entry = {
            let mut entries = self.entries.lock();
            let entry = entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or_else(|| anyhow::anyhow!("代理不存在: {}", id))?;
            Self::apply_probe_result(entry, &result);
            entry.clone()
        };

        self.persist()?;
        Ok(entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_entry(url: &str) -> ProxyEntry {
        ProxyEntry {
            id: 1,
            url: url.to_string(),
            label: None,
            enabled: true,
            health: ProxyHealth::Unknown,
            latency_ms: None,
            last_checked_at: None,
            consecutive_failures: 0,
            auto_disabled: false,
            egress: None,
        }
    }

    #[test]
    fn ippure_egress_json_deserializes() {
        let json = r#"{
            "ip": "104.28.123.123",
            "asn": 13335,
            "asOrganization": "Cloudflare, Inc.",
            "country": "United States",
            "countryCode": "US",
            "region": "California",
            "city": "Los Angeles",
            "fraudScore": 75,
            "isResidential": false,
            "isBroadcast": false
        }"#;
        let info: ProxyEgressInfo = serde_json::from_str(json).unwrap();
        assert_eq!(info.ip, "104.28.123.123");
        assert_eq!(info.asn, Some(13335));
        assert_eq!(info.country_code.as_deref(), Some("US"));
        assert_eq!(info.fraud_score, Some(75));
        assert_eq!(info.is_residential, Some(false));
    }

    #[test]
    fn old_json_without_new_fields_deserializes() {
        // 旧格式 JSON 只有 id/url/label/enabled，新字段应由 serde default 补全
        let json = r#"[{"id":1,"url":"socks5://127.0.0.1:1080","enabled":true}]"#;
        let entries: Vec<ProxyEntry> = serde_json::from_str(json).unwrap();
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e.health, ProxyHealth::Unknown);
        assert_eq!(e.latency_ms, None);
        assert_eq!(e.consecutive_failures, 0);
        assert!(!e.auto_disabled);
    }

    #[test]
    fn probe_failure_increments_and_auto_disables_at_threshold() {
        let mut entry = make_entry("socks5://127.0.0.1:1080");
        let err = ProbeResult::Err {
            error: "connection refused".to_string(),
        };
        // 前两次失败：计数累加，仍启用
        for n in 1..MAX_PROXY_PROBE_FAILURES {
            let (unhealthy, disabled, healed) = ProxyPoolManager::apply_probe_result(&mut entry, &err);
            assert!(unhealthy);
            assert!(!disabled);
            assert!(!healed);
            assert_eq!(entry.consecutive_failures, n);
            assert!(entry.enabled);
            assert!(!entry.auto_disabled);
        }
        // 第 N 次失败：自动禁用
        let (_, disabled, _) = ProxyPoolManager::apply_probe_result(&mut entry, &err);
        assert!(disabled);
        assert_eq!(entry.consecutive_failures, MAX_PROXY_PROBE_FAILURES);
        assert!(!entry.enabled);
        assert!(entry.auto_disabled);
    }

    #[test]
    fn probe_success_clears_failures_and_marks_healthy() {
        let mut entry = make_entry("socks5://127.0.0.1:1080");
        entry.consecutive_failures = 2;
        entry.health = ProxyHealth::Unhealthy;
        let ok = ProbeResult::Ok {
            latency_ms: 123,
            egress: None,
        };
        let (unhealthy, disabled, healed) = ProxyPoolManager::apply_probe_result(&mut entry, &ok);
        assert!(!unhealthy);
        assert!(!disabled);
        assert!(!healed);
        assert_eq!(entry.consecutive_failures, 0);
        assert_eq!(entry.health, ProxyHealth::Healthy);
        assert_eq!(entry.latency_ms, Some(123));
    }

    #[test]
    fn probe_success_self_heals_auto_disabled_entry() {
        // 自动禁用的代理重探成功后应自动恢复启用并清除 auto_disabled
        let mut entry = make_entry("socks5://127.0.0.1:1080");
        entry.enabled = false;
        entry.auto_disabled = true;
        entry.consecutive_failures = MAX_PROXY_PROBE_FAILURES;
        let ok = ProbeResult::Ok {
            latency_ms: 50,
            egress: None,
        };
        let (unhealthy, disabled, healed) = ProxyPoolManager::apply_probe_result(&mut entry, &ok);
        assert!(!unhealthy);
        assert!(!disabled);
        assert!(healed);
        assert!(entry.enabled);
        assert!(!entry.auto_disabled);
        assert_eq!(entry.consecutive_failures, 0);
    }

    #[test]
    fn cooldown_elapsed_only_for_auto_disabled_past_window() {
        let now = chrono::Utc::now();
        // 用户手动禁用（非 auto_disabled）：永不纳入重探
        let mut manual = make_entry("socks5://127.0.0.1:1080");
        manual.enabled = false;
        manual.auto_disabled = false;
        manual.last_checked_at = Some((now - chrono::Duration::hours(2)).to_rfc3339());
        assert!(!ProxyPoolManager::auto_disabled_cooldown_elapsed(&manual, now));

        // 自动禁用但刚探测过：仍在冷却期内
        let mut fresh = make_entry("socks5://127.0.0.1:1080");
        fresh.enabled = false;
        fresh.auto_disabled = true;
        fresh.last_checked_at = Some((now - chrono::Duration::seconds(60)).to_rfc3339());
        assert!(!ProxyPoolManager::auto_disabled_cooldown_elapsed(&fresh, now));

        // 自动禁用且已过冷却：纳入重探
        let mut stale = make_entry("socks5://127.0.0.1:1080");
        stale.enabled = false;
        stale.auto_disabled = true;
        stale.last_checked_at = Some(
            (now - chrono::Duration::seconds(AUTO_DISABLED_RETRY_COOLDOWN_SECS + 1)).to_rfc3339(),
        );
        assert!(ProxyPoolManager::auto_disabled_cooldown_elapsed(&stale, now));

        // 自动禁用但从未探测过：视为已过冷却
        let mut never = make_entry("socks5://127.0.0.1:1080");
        never.enabled = false;
        never.auto_disabled = true;
        never.last_checked_at = None;
        assert!(ProxyPoolManager::auto_disabled_cooldown_elapsed(&never, now));
    }

    #[test]
    fn set_enabled_true_clears_auto_disable_state() {
        let mgr = ProxyPoolManager::new(None, TlsBackend::Rustls);
        let entry = mgr
            .add("socks5://127.0.0.1:1080".to_string(), None, None, Default::default())
            .unwrap();
        // 模拟自动禁用状态
        {
            let mut entries = mgr.entries.lock();
            let e = entries.iter_mut().find(|e| e.id == entry.id).unwrap();
            e.enabled = false;
            e.auto_disabled = true;
            e.consecutive_failures = MAX_PROXY_PROBE_FAILURES;
        }
        mgr.set_enabled(entry.id, true).unwrap();
        let list = mgr.list();
        let e = list.iter().find(|e| e.id == entry.id).unwrap();
        assert!(e.enabled);
        assert!(!e.auto_disabled);
        assert_eq!(e.consecutive_failures, 0);
    }
}
