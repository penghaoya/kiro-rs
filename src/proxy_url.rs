//! 代理 URL 解析与规范化
//!
//! 支持带 scheme 的标准 URL，以及供应商常见的无协议简写（可选导入格式）。

use urlencoding::encode;

pub const DEFAULT_PROXY_SCHEME: &str = "http";

const VALID_SCHEMES: &[&str] = &[
    "http://",
    "https://",
    "socks5://",
    "socks5h://",
    "socks4://",
];

/// 批量/单条导入时的代理字符串格式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ProxyImportFormat {
    /// 自动识别（默认）
    #[default]
    Auto,
    /// `username:password:hostname:port`
    UserPassHostPort,
    /// `hostname:port:username:password`
    HostPortUserPass,
    /// `username:password@hostname:port`
    UserPassAtHostPort,
    /// `hostname:port@username:password`
    HostPortAtUserPass,
}

impl ProxyImportFormat {
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim).unwrap_or("auto") {
            "user_pass_host_port" => Self::UserPassHostPort,
            "host_port_user_pass" => Self::HostPortUserPass,
            "user_pass_at_host_port" => Self::UserPassAtHostPort,
            "host_port_at_user_pass" => Self::HostPortAtUserPass,
            _ => Self::Auto,
        }
    }
}

/// 将用户输入规范化为带 scheme 的代理 URL。
pub fn normalize_proxy_url(
    raw: &str,
    default_scheme: Option<&str>,
    import_format: ProxyImportFormat,
) -> anyhow::Result<String> {
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

    let url = match import_format {
        ProxyImportFormat::Auto => parse_auto(trimmed, &scheme_prefix)?,
        ProxyImportFormat::UserPassHostPort => {
            parse_user_pass_host_port_colon(trimmed, &scheme_prefix)?
        }
        ProxyImportFormat::HostPortUserPass => {
            parse_host_port_user_pass_colon(trimmed, &scheme_prefix)?
        }
        ProxyImportFormat::UserPassAtHostPort => {
            parse_user_pass_at_host_port(trimmed, &scheme_prefix)?
        }
        ProxyImportFormat::HostPortAtUserPass => {
            parse_host_port_at_user_pass(trimmed, &scheme_prefix)?
        }
    };

    validate_proxy_url(&url)?;
    Ok(url)
}

fn parse_auto(trimmed: &str, scheme_prefix: &str) -> anyhow::Result<String> {
    if trimmed.contains('@') {
        if let Ok(url) = parse_host_port_at_user_pass(trimmed, scheme_prefix) {
            return Ok(url);
        }
        return parse_user_pass_at_host_port(trimmed, scheme_prefix);
    }

    let parts: Vec<&str> = trimmed.split(':').collect();
    if parts.len() == 2 && is_valid_port(parts[1]) && is_valid_host(parts[0]) {
        return Ok(format!("{scheme_prefix}{}:{}", parts[0], parts[1]));
    }

    // 优先：第二段是端口 → host:port:user:pass
    if parts.len() >= 4 && is_valid_port(parts[1]) && is_valid_host(parts[0]) {
        if let Ok(url) = parse_host_port_user_pass_colon(trimmed, scheme_prefix) {
            return Ok(url);
        }
    }

    parse_user_pass_host_port_colon(trimmed, scheme_prefix)
}

fn parse_user_pass_host_port_colon(raw: &str, scheme_prefix: &str) -> anyhow::Result<String> {
    let parts: Vec<&str> = raw.split(':').collect();
    if parts.len() < 4 {
        anyhow::bail!("user:pass:host:port 格式至少需要 4 段");
    }
    let port = parts[parts.len() - 1];
    let host = parts[parts.len() - 2];
    let password = parts[parts.len() - 3];
    let username = parts[..parts.len() - 3].join(":");
    if !is_valid_port(port) || !is_valid_host(host) || username.is_empty() || password.is_empty() {
        anyhow::bail!("无法按 username:password:hostname:port 解析: {raw}");
    }
    Ok(build_auth_url(
        scheme_prefix, &username, password, host, port,
    ))
}

fn parse_host_port_user_pass_colon(raw: &str, scheme_prefix: &str) -> anyhow::Result<String> {
    let parts: Vec<&str> = raw.split(':').collect();
    if parts.len() < 4 {
        anyhow::bail!("host:port:user:pass 格式至少需要 4 段");
    }
    let host = parts[0];
    let port = parts[1];
    let password = parts[parts.len() - 1];
    let username = parts[2..parts.len() - 1].join(":");
    if !is_valid_port(port) || !is_valid_host(host) || username.is_empty() || password.is_empty() {
        anyhow::bail!("无法按 hostname:port:username:password 解析: {raw}");
    }
    Ok(build_auth_url(
        scheme_prefix, &username, password, host, port,
    ))
}

fn parse_user_pass_at_host_port(raw: &str, scheme_prefix: &str) -> anyhow::Result<String> {
    let Some((userinfo, hostport)) = raw.rsplit_once('@') else {
        anyhow::bail!("缺少 @ 分隔符");
    };
    let Some((username, password)) = userinfo.rsplit_once(':') else {
        anyhow::bail!("@ 前需为 username:password");
    };
    let Some((host, port)) = hostport.rsplit_once(':') else {
        anyhow::bail!("@ 后需为 hostname:port");
    };
    if username.is_empty() || password.is_empty() || !is_valid_port(port) || !is_valid_host(host) {
        anyhow::bail!("无法按 username:password@hostname:port 解析: {raw}");
    }
    Ok(build_auth_url(
        scheme_prefix, username, password, host, port,
    ))
}

fn parse_host_port_at_user_pass(raw: &str, scheme_prefix: &str) -> anyhow::Result<String> {
    let Some((hostport, userinfo)) = raw.split_once('@') else {
        anyhow::bail!("缺少 @ 分隔符");
    };
    let Some((host, port)) = hostport.rsplit_once(':') else {
        anyhow::bail!("@ 前需为 hostname:port");
    };
    let Some((username, password)) = userinfo.rsplit_once(':') else {
        anyhow::bail!("@ 后需为 username:password");
    };
    if username.is_empty() || password.is_empty() || !is_valid_port(port) || !is_valid_host(host) {
        anyhow::bail!("无法按 hostname:port@username:password 解析: {raw}");
    }
    Ok(build_auth_url(
        scheme_prefix, username, password, host, port,
    ))
}

fn build_auth_url(
    scheme_prefix: &str,
    username: &str,
    password: &str,
    host: &str,
    port: &str,
) -> String {
    format!(
        "{}{}:{}@{}:{}",
        scheme_prefix,
        encode_proxy_userinfo(username),
        encode_proxy_userinfo(password),
        host,
        port
    )
}

fn encode_proxy_userinfo(s: &str) -> String {
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~'))
    {
        s.to_string()
    } else {
        encode(s).into_owned()
    }
}

/// 校验代理 URL 的 scheme 与 host:port 结构。
pub fn validate_proxy_url(url: &str) -> anyhow::Result<()> {
    if url.eq_ignore_ascii_case("direct") {
        return Ok(());
    }

    if !has_known_scheme(url) {
        anyhow::bail!(
            "代理 URL scheme 无效，支持: http/https/socks4/socks5/socks5h（收到: {url}）"
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
        "http" | "https" | "socks5" | "socks5h" | "socks4" => Ok(format!("{scheme}://")),
        other => anyhow::bail!("不支持的代理协议: {other}（可选 http/https/socks5/socks5h/socks4）"),
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

    const BESTGO: &str = "USER318898-zone-custom-region-GB-session-78471546-sessTime-180-sessAuto-1:9038b6:us.rrp.bestgo.work:10000";

    #[test]
    fn parses_user_pass_host_port_explicit() {
        let url = normalize_proxy_url(
            BESTGO,
            None,
            ProxyImportFormat::UserPassHostPort,
        )
        .unwrap();
        assert_eq!(
            url,
            "http://USER318898-zone-custom-region-GB-session-78471546-sessTime-180-sessAuto-1:9038b6@us.rrp.bestgo.work:10000"
        );
    }

    #[test]
    fn parses_host_port_user_pass_explicit() {
        let raw = "us.rrp.bestgo.work:10000:USER318898:9038b6";
        let url = normalize_proxy_url(
            raw,
            None,
            ProxyImportFormat::HostPortUserPass,
        )
        .unwrap();
        assert!(url.contains("@us.rrp.bestgo.work:10000"));
        assert!(url.contains("USER318898:9038b6@"));
    }

    #[test]
    fn parses_user_pass_at_host_port_explicit() {
        let raw = "USER318898:9038b6@us.rrp.bestgo.work:10000";
        let url = normalize_proxy_url(
            raw,
            None,
            ProxyImportFormat::UserPassAtHostPort,
        )
        .unwrap();
        assert_eq!(url, "http://USER318898:9038b6@us.rrp.bestgo.work:10000");
    }

    #[test]
    fn parses_host_port_at_user_pass_explicit() {
        let raw = "us.rrp.bestgo.work:10000@USER318898:9038b6";
        let url = normalize_proxy_url(
            raw,
            None,
            ProxyImportFormat::HostPortAtUserPass,
        )
        .unwrap();
        assert_eq!(url, "http://USER318898:9038b6@us.rrp.bestgo.work:10000");
    }

    #[test]
    fn auto_detects_bestgo_format() {
        let url = normalize_proxy_url(BESTGO, None, ProxyImportFormat::Auto).unwrap();
        assert!(url.contains("us.rrp.bestgo.work:10000"));
    }
}
