//! HTTP Client 构建模块
//!
//! 提供统一的 HTTP Client 构建功能，支持代理配置

use reqwest::{Client, Proxy};
use std::time::Duration;

use crate::model::config::TlsBackend;

/// 代理配置
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct ProxyConfig {
    /// 代理地址，支持 http/https/socks5/socks5h
    pub url: String,
    /// 代理认证用户名
    pub username: Option<String>,
    /// 代理认证密码
    pub password: Option<String>,
}

impl ProxyConfig {
    /// 从 url 创建代理配置
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            username: None,
            password: None,
        }
    }

    /// 从完整代理 URL 解析（含 `user:pass@host:port` 嵌入认证时自动拆出）
    pub fn from_url(url: impl Into<String>) -> Self {
        let url = url.into();
        let (base, username, password) = split_proxy_url_auth(&url);
        Self {
            url: base,
            username,
            password,
        }
    }

    /// 设置认证信息
    pub fn with_auth(mut self, username: impl Into<String>, password: impl Into<String>) -> Self {
        self.username = Some(username.into());
        self.password = Some(password.into());
        self
    }
}

/// 将 `scheme://user:pass@host:port` 拆成无认证 base URL + 凭据（供 reqwest Proxy 使用）
fn split_proxy_url_auth(raw: &str) -> (String, Option<String>, Option<String>) {
    let Some(scheme_end) = raw.find("://") else {
        return (raw.to_string(), None, None);
    };
    let scheme = &raw[..scheme_end + 3];
    let rest = &raw[scheme_end + 3..];
    let Some(at) = rest.rfind('@') else {
        return (raw.to_string(), None, None);
    };
    let userinfo = &rest[..at];
    let hostport = &rest[at + 1..];
    if userinfo.is_empty() || hostport.is_empty() {
        return (raw.to_string(), None, None);
    }
    let (username, password) = match userinfo.rsplit_once(':') {
        Some((u, p)) if !u.is_empty() => (Some(u.to_string()), Some(p.to_string())),
        _ => return (raw.to_string(), None, None),
    };
    (
        format!("{scheme}{hostport}"),
        username,
        password,
    )
}

fn build_reqwest_proxy(config: &ProxyConfig) -> anyhow::Result<Proxy> {
    let mut base_url = config.url.clone();
    let mut username = config.username.clone();
    let mut password = config.password.clone();

    if username.is_none() {
        let (parsed_base, u, p) = split_proxy_url_auth(&base_url);
        base_url = parsed_base;
        username = u;
        password = p;
    }

    // reqwest 的 socks5 在本地解析 DNS，多数住宅代理需 socks5h（代理解析 DNS，同 curl）
    base_url = upgrade_socks5_to_socks5h(&base_url);

    let mut proxy = Proxy::all(&base_url)?;
    if let (Some(u), Some(p)) = (&username, &password) {
        proxy = proxy.basic_auth(u, p);
    }
    Ok(proxy)
}

/// 将 `socks5://` 升级为 `socks5h://`（仅用于 reqwest 连接，不改变持久化 URL）
fn upgrade_socks5_to_socks5h(url: &str) -> String {
    if url.starts_with("socks5://") && !url.starts_with("socks5h://") {
        url.replacen("socks5://", "socks5h://", 1)
    } else {
        url.to_string()
    }
}

/// 构建 HTTP Client
///
/// # Arguments
/// * `proxy` - 可选的代理配置
/// * `timeout_secs` - 超时时间（秒）
///
/// # Returns
/// 配置好的 reqwest::Client
pub fn build_client(
    proxy: Option<&ProxyConfig>,
    timeout_secs: u64,
    tls_backend: TlsBackend,
) -> anyhow::Result<Client> {
    let mut builder = Client::builder().timeout(Duration::from_secs(timeout_secs));

    match tls_backend {
        TlsBackend::Rustls => {
            builder = builder.use_rustls_tls();
        }
        TlsBackend::NativeTls => {
            #[cfg(feature = "native-tls")]
            {
                builder = builder.use_native_tls();
            }
            #[cfg(not(feature = "native-tls"))]
            {
                anyhow::bail!("此构建版本未包含 native-tls 后端，请在配置中改用 rustls");
            }
        }
    }

    if let Some(proxy_config) = proxy {
        let proxy = build_reqwest_proxy(proxy_config)?;

        builder = builder.proxy(proxy);
        tracing::debug!(
            "HTTP Client 使用代理: {}",
            crate::security::redact_proxy_url(&proxy_config.url)
        );
    }

    Ok(builder.build()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_proxy_config_new() {
        let config = ProxyConfig::new("http://127.0.0.1:7890");
        assert_eq!(config.url, "http://127.0.0.1:7890");
        assert!(config.username.is_none());
        assert!(config.password.is_none());
    }

    #[test]
    fn test_proxy_config_with_auth() {
        let config = ProxyConfig::new("socks5://127.0.0.1:1080").with_auth("user", "pass");
        assert_eq!(config.url, "socks5://127.0.0.1:1080");
        assert_eq!(config.username, Some("user".to_string()));
        assert_eq!(config.password, Some("pass".to_string()));
    }

    #[test]
    fn test_build_client_without_proxy() {
        let client = build_client(None, 30, TlsBackend::Rustls);
        assert!(client.is_ok());
    }

    #[test]
    fn test_build_client_with_proxy() {
        let config = ProxyConfig::new("http://127.0.0.1:7890");
        let client = build_client(Some(&config), 30, TlsBackend::Rustls);
        assert!(client.is_ok());
    }

    #[test]
    fn upgrade_socks5_to_socks5h_for_residential_proxies() {
        assert_eq!(
            upgrade_socks5_to_socks5h("socks5://127.0.0.1:1080"),
            "socks5h://127.0.0.1:1080"
        );
        assert_eq!(
            upgrade_socks5_to_socks5h("socks5h://127.0.0.1:1080"),
            "socks5h://127.0.0.1:1080"
        );
        assert_eq!(
            upgrade_socks5_to_socks5h("http://127.0.0.1:7890"),
            "http://127.0.0.1:7890"
        );
    }

    #[test]
    fn split_proxy_url_auth_extracts_long_session_user() {
        let raw = "http://USER318898-zone-custom-region-GB-session-123:9038b6@us.rrp.bestgo.work:10000";
        let (base, user, pass) = split_proxy_url_auth(raw);
        assert_eq!(base, "http://us.rrp.bestgo.work:10000");
        assert_eq!(
            user.as_deref(),
            Some("USER318898-zone-custom-region-GB-session-123")
        );
        assert_eq!(pass.as_deref(), Some("9038b6"));
        let client = build_client(
            Some(&ProxyConfig::from_url(raw)),
            30,
            TlsBackend::Rustls,
        );
        assert!(client.is_ok());
    }
}
