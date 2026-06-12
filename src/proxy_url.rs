//! 代理 URL 解析与规范化
//!
//! 支持带 scheme 的标准 URL，以及常见的无协议简写：
//! - `user:pass:host:port`（用户名可含冒号，从右侧解析）
//! - `host:port`
//! - `user:pass@host:port`

use urlencoding::encode;

pub const DEFAULT_PROXY_SCHEME: &str = "http";

const VALID_SCHEMES: &[&str] = &["http://", "https://", "socks5://", "socks4://"];

/// 将用户输入规范化为带 scheme 的代理 URL。
pub fn normalize_proxy_url(raw: &str, default_scheme: Option<&str>) -> anyhow::Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        anyhow::bail!("代理 URL 不能为空");
    }

    if trimmed.eq_ignore_ascii_case("direct") {
        return Ok(trimmed.to_string());
    }

    if has_known_scheme(trimmed) {
        validate_proxy_url(trimmed)?;
        return Ok(trimmed.to_string());
    }

    let scheme_prefix = resolve_scheme_prefix(default_scheme)?;

    if trimmed.contains('@') {
        let url = format!("{scheme_prefix}{trimmed}");
        validate_proxy_url(&url)?;
        return Ok(url);
    }

    let parts: Vec<&str> = trimmed.split(':').collect();

    // host:port
    if parts.len() == 2 {
        if is_valid_port(parts[1]) && is_valid_host(parts[0]) {
            let url = format!("{scheme_prefix}{}:{}", parts[0], parts[1]);
            validate_proxy_url(&url)?;
            return Ok(url);
        }
    }

    // user:pass:host:port — 从右侧取 port / host / password，其余为 username
    if parts.len() >= 4 && is_valid_port(parts[parts.len() - 1]) {
        let port = parts[parts.len() - 1];
        let host = parts[parts.len() - 2];
        let password = parts[parts.len() - 3];
        let username = parts[..parts.len() - 3].join(":");
        if is_valid_host(host) && !username.is_empty() && !password.is_empty() {
            let url = format!(
                "{}{}:{}@{}:{}",
                scheme_prefix,
                encode(&username),
                encode(password),
                host,
                port
            );
            validate_proxy_url(&url)?;
            return Ok(url);
        }
    }

    // host:port:user:pass — 部分供应商使用的另一种顺序
    if parts.len() >= 4 && is_valid_port(parts[1]) {
        let host = parts[0];
        let port = parts[1];
        let username = parts[2];
        let password = parts[parts.len() - 1];
        if is_valid_host(host) && !username.is_empty() && !password.is_empty() {
            let url = format!(
                "{}{}:{}@{}:{}",
                scheme_prefix,
                encode(&username),
                encode(password),
                host,
                port
            );
            validate_proxy_url(&url)?;
            return Ok(url);
        }
    }

    anyhow::bail!(
        "无法解析代理格式（支持 http(s)/socks4/socks5://… 或 user:pass:host:port / host:port）: {trimmed}"
    )
}

/// 校验代理 URL 的 scheme 与 host:port 结构。
pub fn validate_proxy_url(url: &str) -> anyhow::Result<()> {
    if url.eq_ignore_ascii_case("direct") {
        return Ok(());
    }

    if !has_known_scheme(url) {
        anyhow::bail!(
            "代理 URL scheme 无效，支持: http/https/socks4/socks5（收到: {url}）"
        );
    }

    let after_scheme = VALID_SCHEMES
        .iter()
        .find(|s| url.starts_with(*s))
        .map(|s| &url[s.len()..])
        .unwrap_or(url);
    let host_part = after_scheme.rsplit('@').next().unwrap_or(after_scheme);
    if !host_part.contains(':') {
        anyhow::bail!("代理 URL 缺少端口号: {url}");
    }

    let port_str = host_part.rsplit(':').next().unwrap_or("");
    if !is_valid_port(port_str) {
        anyhow::bail!("代理 URL 端口号无效: {url}");
    }

    Ok(())
}

fn has_known_scheme(url: &str) -> bool {
    VALID_SCHEMES.iter().any(|s| url.starts_with(s))
}

fn resolve_scheme_prefix(default_scheme: Option<&str>) -> anyhow::Result<String> {
    let scheme = default_scheme
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_PROXY_SCHEME)
        .trim_end_matches("://")
        .to_ascii_lowercase();

    match scheme.as_str() {
        "http" | "https" | "socks5" | "socks4" => Ok(format!("{scheme}://")),
        other => anyhow::bail!("不支持的代理协议: {other}（可选 http/https/socks5/socks4）"),
    }
}

fn is_valid_port(port: &str) -> bool {
    !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) && port.parse::<u16>().is_ok()
}

fn is_valid_host(host: &str) -> bool {
    !host.is_empty()
        && (host.contains('.') || host.eq_ignore_ascii_case("localhost") || host.contains(':'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_full_url_unchanged() {
        let url = "socks5://user:pass@127.0.0.1:1080";
        assert_eq!(normalize_proxy_url(url, None).unwrap(), url);
    }

    #[test]
    fn parses_user_pass_host_port_shorthand() {
        let raw = "USER318898-zone-custom-region-GB-session-78471546-sessTime-180-sessAuto-1:9038b6:us.rrp.bestgo.work:10000";
        let normalized = normalize_proxy_url(raw, None).unwrap();
        assert!(normalized.starts_with("http://"));
        assert!(normalized.contains("us.rrp.bestgo.work:10000"));
        assert!(normalized.contains("9038b6"));
    }

    #[test]
    fn parses_host_port_with_default_http() {
        let url = normalize_proxy_url("proxy.example.com:8080", None).unwrap();
        assert_eq!(url, "http://proxy.example.com:8080");
    }

    #[test]
    fn parses_user_at_host_with_socks5_default() {
        let url = normalize_proxy_url("alice:secret@1.2.3.4:1080", Some("socks5")).unwrap();
        assert_eq!(url, "socks5://alice:secret@1.2.3.4:1080");
    }

    #[test]
    fn parses_host_port_user_pass_variant() {
        let url = normalize_proxy_url("1.2.3.4:10000:alice:secret", Some("http")).unwrap();
        assert_eq!(url, "http://alice:secret@1.2.3.4:10000");
    }

    #[test]
    fn rejects_invalid_shorthand() {
        assert!(normalize_proxy_url("not-a-proxy", None).is_err());
    }
}
