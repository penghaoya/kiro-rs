//! 客户端 API Key 管理
//!
//! 中转站对外分发的"客户端 Key"层。客户端调用 `/v1/messages` 时携带 `csk_*`
//! 格式的 Key，由本模块校验并按 Key 维度记录调用次数与累计 Token。
//!
//! 与上游 Kiro 凭据（`KiroCredentials`，`ksk_*`）相互独立：
//! - 上游凭据池：服务对接 Kiro 的"出口"
//! - 客户端 Key：中转站对外的"入口"
//!
//! 持久化为 `client_api_keys.json`（与 `credentials.json` 同目录）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use hmac::{Hmac, Mac};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// 客户端 Key 前缀（区分上游 `ksk_`）
pub const CLIENT_KEY_PREFIX: &str = "csk_";
const KEY_HASH_SCHEME: &str = "hmac-sha256";
const HASH_SECRET_ENV: &str = "KIRO_RS_CLIENT_KEY_HASH_SECRET";

/// 单条客户端 Key
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientKey {
    pub id: u64,
    /// 明文 Key。出于"列表二次复制"需求，现持久化保存。
    #[serde(default)]
    pub key: String,
    /// Key 的 SHA-256 哈希（hex）。旧明文文件加载时自动迁移。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub key_hash: String,
    /// 展示用前缀，不能用于鉴权。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub key_prefix: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub disabled: bool,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    #[serde(default)]
    pub total_calls: u64,
    #[serde(default)]
    pub total_input_tokens: u64,
    #[serde(default)]
    pub total_output_tokens: u64,
    #[serde(default)]
    pub total_cache_creation_tokens: u64,
    #[serde(default)]
    pub total_cache_read_tokens: u64,
    /// 累计 credit 计费量（meteringEvent.usage 累加）
    #[serde(default)]
    pub total_credits: f64,
}

/// 客户端 Key 管理器
///
/// 内部双索引：
/// - `by_key: HashMap<String, u64>` —— 用于 `/v1` 鉴权时 O(1) 查询命中
/// - `entries: HashMap<u64, ClientKey>` —— 用于按 id 读写明细
///
/// 校验比对仍使用 `subtle::ConstantTimeEq` 防止时序攻击。
pub struct ClientKeyManager {
    inner: RwLock<Inner>,
    path: Option<PathBuf>,
    hash_secret: Vec<u8>,
}

struct Inner {
    entries: HashMap<u64, ClientKey>,
    by_hash: HashMap<String, u64>,
    next_id: u64,
    dirty_usage: bool,
}

impl ClientKeyManager {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(Inner {
                entries: HashMap::new(),
                by_hash: HashMap::new(),
                next_id: 1,
                dirty_usage: false,
            }),
            path: None,
            hash_secret: hash_secret_from_env()
                .unwrap_or_else(|| crate::security::secure_token_urlsafe(32).into_bytes()),
        }
    }

    /// 从文件加载（不存在时返回空管理器）
    pub fn load<P: AsRef<Path>>(path: P) -> anyhow::Result<Self> {
        let path = path.as_ref().to_path_buf();
        let entries: Vec<ClientKey> = if path.exists() {
            let content = std::fs::read_to_string(&path)?;
            if content.trim().is_empty() {
                Vec::new()
            } else {
                serde_json::from_str(&content)?
            }
        } else {
            Vec::new()
        };

        let hash_secret = load_hash_secret_for_path(&path)?;
        let mut by_hash = HashMap::with_capacity(entries.len());
        let mut by_id = HashMap::with_capacity(entries.len());
        let mut max_id = 0u64;
        let mut needs_rewrite = false;
        for mut ck in entries {
            max_id = max_id.max(ck.id);
            if !ck.key.is_empty() {
                let new_hash = hash_key_with_secret(&hash_secret, &ck.key);
                if ck.key_hash != new_hash {
                    ck.key_hash = new_hash;
                    needs_rewrite = true;
                }
            } else if is_legacy_sha256_hash(&ck.key_hash) {
                tracing::warn!(
                    key_id = ck.id,
                    "client key entry has legacy unsalted hash and cannot be upgraded without plaintext; recreate this key"
                );
            }
            if ck.key_prefix.is_empty() && !ck.key.is_empty() {
                ck.key_prefix = key_prefix(&ck.key);
                needs_rewrite = true;
            }
            if !ck.key_hash.is_empty() {
                by_hash.insert(ck.key_hash.clone(), ck.id);
            }
            by_id.insert(ck.id, ck);
        }

        let manager = Self {
            inner: RwLock::new(Inner {
                entries: by_id,
                by_hash,
                next_id: max_id + 1,
                dirty_usage: false,
            }),
            path: Some(path),
            hash_secret,
        };
        if needs_rewrite {
            let mut inner = manager.inner.write();
            manager.save_locked(&mut inner);
        }
        Ok(manager)
    }

    fn save_locked(&self, inner: &mut Inner) {
        let path = match &self.path {
            Some(p) => p,
            None => return,
        };
        let mut list: Vec<&ClientKey> = inner.entries.values().collect();
        list.sort_by_key(|k| k.id);
        match serde_json::to_string_pretty(&list) {
            Ok(json) => {
                if let Err(e) = atomic_write(path, json.as_bytes()) {
                    tracing::warn!("写入客户端 Key 文件失败: {}", e);
                }
                inner.dirty_usage = false;
            }
            Err(e) => tracing::warn!("序列化客户端 Key 失败: {}", e),
        }
    }

    /// 列表（按 id 升序）
    pub fn list(&self) -> Vec<ClientKey> {
        let inner = self.inner.read();
        let mut list: Vec<ClientKey> = inner.entries.values().cloned().collect();
        list.sort_by_key(|k| k.id);
        list
    }

    /// 创建新 Key（生成明文随机串），返回新建条目
    pub fn create(&self, name: String, description: Option<String>) -> ClientKey {
        let key = generate_client_key();
        let mut inner = self.inner.write();
        let id = inner.next_id;
        inner.next_id += 1;
        let entry = ClientKey {
            id,
            key: key.clone(),
            key_hash: self.hash_key(&key),
            key_prefix: key_prefix(&key),
            name,
            description,
            disabled: false,
            created_at: Utc::now().to_rfc3339(),
            last_used_at: None,
            total_calls: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cache_creation_tokens: 0,
            total_cache_read_tokens: 0,
            total_credits: 0.0,
        };
        inner.by_hash.insert(entry.key_hash.clone(), id);
        inner.entries.insert(id, entry.clone());
        self.save_locked(&mut inner);
        entry
    }

    pub fn delete(&self, id: u64) -> bool {
        let mut inner = self.inner.write();
        let removed = match inner.entries.remove(&id) {
            Some(e) => {
                inner.by_hash.remove(&e.key_hash);
                true
            }
            None => false,
        };
        if removed {
            self.save_locked(&mut inner);
        }
        removed
    }

    pub fn set_disabled(&self, id: u64, disabled: bool) -> bool {
        let mut inner = self.inner.write();
        let updated = match inner.entries.get_mut(&id) {
            Some(e) => {
                e.disabled = disabled;
                true
            }
            None => false,
        };
        if updated {
            self.save_locked(&mut inner);
        }
        updated
    }

    pub fn update_meta(
        &self,
        id: u64,
        name: Option<String>,
        description: Option<Option<String>>,
    ) -> bool {
        let mut inner = self.inner.write();
        let updated = match inner.entries.get_mut(&id) {
            Some(e) => {
                if let Some(n) = name {
                    e.name = n;
                }
                if let Some(d) = description {
                    e.description = d;
                }
                true
            }
            None => false,
        };
        if updated {
            self.save_locked(&mut inner);
        }
        updated
    }

    /// 重置计数（保留 Key 与名称）
    pub fn reset_stats(&self, id: u64) -> bool {
        let mut inner = self.inner.write();
        let updated = match inner.entries.get_mut(&id) {
            Some(e) => {
                e.total_calls = 0;
                e.total_input_tokens = 0;
                e.total_output_tokens = 0;
                e.total_cache_creation_tokens = 0;
                e.total_cache_read_tokens = 0;
                e.total_credits = 0.0;
                true
            }
            None => false,
        };
        if updated {
            self.save_locked(&mut inner);
        }
        updated
    }

    /// 校验 Key，命中且未禁用则返回 id；同时更新 `last_used_at`/`total_calls`
    ///
    /// 用 `ConstantTimeEq` 对所有 active Key 做常量时间比对，防止时序攻击；
    /// 之前的 HashMap 直接 lookup 仅作快速短路（命中后还会再做一次常量时间比较）。
    pub fn verify_and_touch(&self, presented: &str) -> Option<u64> {
        if !presented.starts_with(CLIENT_KEY_PREFIX) {
            return None;
        }
        let mut inner = self.inner.write();
        // 第一遍：扫描所有 entry 做常量时间比较，避免 HashMap 短路泄露
        let mut hit_id: Option<u64> = None;
        let presented_hash = self.hash_key(presented);
        let legacy_hash = legacy_sha256_hash(presented);
        let mut legacy_hit_hash: Option<String> = None;
        for (id, ck) in inner.entries.iter() {
            if ck.disabled {
                continue;
            }
            if ck
                .key_hash
                .as_bytes()
                .ct_eq(presented_hash.as_bytes())
                .into()
                || ck.key_hash.as_bytes().ct_eq(legacy_hash.as_bytes()).into()
            {
                hit_id = Some(*id);
                if ck.key_hash == legacy_hash {
                    legacy_hit_hash = Some(ck.key_hash.clone());
                }
                // 不 break，继续完整扫描以保持常量时间
            }
        }
        let id = hit_id?;
        if let Some(entry) = inner.entries.get_mut(&id) {
            if legacy_hit_hash.is_some() {
                entry.key_hash = presented_hash.clone();
            }
            entry.total_calls += 1;
            entry.last_used_at = Some(Utc::now().to_rfc3339());
        }
        if let Some(old_hash) = legacy_hit_hash {
            inner.by_hash.remove(&old_hash);
            inner.by_hash.insert(presented_hash, id);
            self.save_locked(&mut inner);
        }
        // 不在每次请求都落盘（高频写入），由 record_usage / 定期 flush 持久化
        Some(id)
    }

    /// 在请求结束时累计 Token 用量；文件持久化由后台 flush 批量完成。
    pub fn record_usage(
        &self,
        id: u64,
        input_tokens: u64,
        output_tokens: u64,
        cache_creation_tokens: u64,
        cache_read_tokens: u64,
        credits: f64,
    ) {
        let mut inner = self.inner.write();
        if let Some(entry) = inner.entries.get_mut(&id) {
            entry.total_input_tokens += input_tokens;
            entry.total_output_tokens += output_tokens;
            entry.total_cache_creation_tokens += cache_creation_tokens;
            entry.total_cache_read_tokens += cache_read_tokens;
            if credits.is_finite() && credits > 0.0 {
                entry.total_credits += credits;
            }
            entry.last_used_at = Some(Utc::now().to_rfc3339());
        }
        inner.dirty_usage = true;
    }

    /// 获取统计后的 active Key 数（未禁用）
    pub fn active_count(&self) -> usize {
        self.inner
            .read()
            .entries
            .values()
            .filter(|e| !e.disabled)
            .count()
    }

    pub fn flush_to_disk(&self) {
        let mut inner = self.inner.write();
        if !inner.dirty_usage {
            return;
        }
        self.save_locked(&mut inner);
    }

    pub fn spawn_background_flush(self: Arc<Self>) {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                self.flush_to_disk();
            }
        });
    }

    fn hash_key(&self, key: &str) -> String {
        hash_key_with_secret(&self.hash_secret, key)
    }
}

impl Default for ClientKeyManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 生成 `csk_` 前缀 + 32 位 base62 随机字符串
pub fn generate_client_key() -> String {
    let body = crate::security::secure_token_urlsafe(32);
    format!("{}{}", CLIENT_KEY_PREFIX, body)
}

fn hash_key_with_secret(secret: &[u8], key: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret).expect("HMAC-SHA256 accepts keys of any length");
    mac.update(key.as_bytes());
    format!(
        "{}:{}",
        KEY_HASH_SCHEME,
        hex::encode(mac.finalize().into_bytes())
    )
}

fn legacy_sha256_hash(key: &str) -> String {
    hex::encode(Sha256::digest(key.as_bytes()))
}

fn hash_secret_from_env() -> Option<Vec<u8>> {
    let value = std::env::var(HASH_SECRET_ENV).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.as_bytes().to_vec())
    }
}

fn load_hash_secret_for_path(path: &Path) -> anyhow::Result<Vec<u8>> {
    if let Some(secret) = hash_secret_from_env() {
        return Ok(secret);
    }
    let secret_path = hash_secret_path(path);
    if secret_path.exists() {
        let secret = std::fs::read_to_string(&secret_path)?;
        let trimmed = secret.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.as_bytes().to_vec());
        }
    }
    let secret = crate::security::secure_token_urlsafe(32);
    atomic_write(&secret_path, secret.as_bytes())?;
    Ok(secret.into_bytes())
}

fn hash_secret_path(path: &Path) -> PathBuf {
    path.with_extension("secret")
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!(
        "tmp-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    std::fs::write(&tmp, bytes)?;
    #[cfg(windows)]
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&tmp, path)
}

fn is_legacy_sha256_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn key_prefix(key: &str) -> String {
    key.chars().take(8).collect()
}

/// 脱敏展示：保留前 8 位（含前缀）和后 4 位
pub fn mask_client_key(key: &str) -> String {
    if key.is_empty() {
        return String::new();
    }
    if key.len() <= 12 {
        return key.to_string();
    }
    format!("{}...{}", &key[..8], &key[key.len() - 4..])
}

pub fn display_client_key(record: &ClientKey) -> String {
    if !record.key.is_empty() {
        return mask_client_key(&record.key);
    }
    if !record.key_prefix.is_empty() && record.key_hash.len() >= 12 {
        return format!("{}...{}", record.key_prefix, &record.key_hash[..12]);
    }
    String::new()
}

/// 默认管理器路径（相对凭据目录）
pub fn default_path_in(dir: &Path) -> PathBuf {
    dir.join("client_api_keys.json")
}

/// Arc 包装，便于注入 axum State
pub type SharedClientKeyManager = Arc<ClientKeyManager>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_and_verify() {
        let mgr = ClientKeyManager::new();
        let entry = mgr.create("test".to_string(), None);
        assert!(entry.key.starts_with(CLIENT_KEY_PREFIX));
        assert_eq!(mgr.verify_and_touch(&entry.key), Some(entry.id));
        // 不带前缀的拒绝
        assert_eq!(mgr.verify_and_touch("nope"), None);
    }

    #[test]
    fn disabled_key_rejected() {
        let mgr = ClientKeyManager::new();
        let entry = mgr.create("test".to_string(), None);
        mgr.set_disabled(entry.id, true);
        assert_eq!(mgr.verify_and_touch(&entry.key), None);
        mgr.set_disabled(entry.id, false);
        assert_eq!(mgr.verify_and_touch(&entry.key), Some(entry.id));
    }

    #[test]
    fn record_usage_accumulates() {
        let mgr = ClientKeyManager::new();
        let entry = mgr.create("test".to_string(), None);
        mgr.record_usage(entry.id, 100, 50, 0, 0, 0.0);
        mgr.record_usage(entry.id, 200, 30, 5, 10, 1.5);
        let list = mgr.list();
        let e = list.iter().find(|x| x.id == entry.id).unwrap();
        assert_eq!(e.total_input_tokens, 300);
        assert_eq!(e.total_output_tokens, 80);
        assert_eq!(e.total_cache_creation_tokens, 5);
        assert_eq!(e.total_cache_read_tokens, 10);
    }

    #[test]
    fn mask_format() {
        assert_eq!(mask_client_key("csk_abcdefghijklmnop"), "csk_abcd...mnop");
        assert_eq!(mask_client_key("short"), "short");
    }

    #[test]
    fn client_keys_file_persists_plaintext_key() {
        let path = std::env::temp_dir().join(format!(
            "kiro-client-keys-{}.json",
            crate::security::secure_token_urlsafe(8)
        ));
        let mgr = ClientKeyManager::load(&path).unwrap();
        let entry = mgr.create("test".to_string(), None);
        let persisted = std::fs::read_to_string(&path).unwrap();
        assert!(
            persisted.contains(&entry.key),
            "client key persistence now retains the plaintext key for re-copy"
        );
        assert!(persisted.contains("keyHash"));
        assert!(persisted.contains(KEY_HASH_SCHEME));
        assert!(hash_secret_path(&path).exists());
        let loaded = ClientKeyManager::load(&path).unwrap();
        // 重新加载后明文仍可读取，列表项可携带完整 Key
        assert!(loaded.list().iter().any(|k| k.key == entry.key));
        assert_eq!(loaded.verify_and_touch(&entry.key), Some(entry.id));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(hash_secret_path(&path));
    }

    #[test]
    fn legacy_plaintext_client_key_is_retained_on_load() {
        let path = std::env::temp_dir().join(format!(
            "kiro-client-keys-legacy-{}.json",
            crate::security::secure_token_urlsafe(8)
        ));
        let plaintext = "csk_legacy_plaintext_key_1234567890";
        std::fs::write(
            &path,
            format!(
                r#"[{{
                    "id": 1,
                    "key": "{plaintext}",
                    "name": "legacy",
                    "createdAt": "2026-01-01T00:00:00Z"
                }}]"#
            ),
        )
        .unwrap();
        let loaded = ClientKeyManager::load(&path).unwrap();
        assert_eq!(loaded.verify_and_touch(plaintext), Some(1));
        let persisted = std::fs::read_to_string(&path).unwrap();
        assert!(persisted.contains(plaintext));
        assert!(persisted.contains(KEY_HASH_SCHEME));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(hash_secret_path(&path));
    }

    #[test]
    fn legacy_sha256_client_key_upgrades_after_successful_verify() {
        let path = std::env::temp_dir().join(format!(
            "kiro-client-keys-sha-{}.json",
            crate::security::secure_token_urlsafe(8)
        ));
        let plaintext = "csk_legacy_sha256_key_1234567890";
        let legacy_hash = legacy_sha256_hash(plaintext);
        std::fs::write(
            &path,
            format!(
                r#"[{{
                    "id": 1,
                    "keyHash": "{legacy_hash}",
                    "keyPrefix": "csk_lega",
                    "name": "legacy",
                    "createdAt": "2026-01-01T00:00:00Z"
                }}]"#
            ),
        )
        .unwrap();
        let loaded = ClientKeyManager::load(&path).unwrap();
        assert_eq!(loaded.verify_and_touch(plaintext), Some(1));
        let persisted = std::fs::read_to_string(&path).unwrap();
        assert!(!persisted.contains(&legacy_hash));
        assert!(persisted.contains(KEY_HASH_SCHEME));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(hash_secret_path(&path));
    }
}
