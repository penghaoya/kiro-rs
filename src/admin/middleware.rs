//! Admin API 中间件

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::OnceLock;

use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Json, Response},
};

use super::client_keys::SharedClientKeyManager;
use super::service::AdminService;
use super::trace_db::SharedTraceStore;
use super::types::AdminErrorResponse;
use super::usage_stats::SharedAggregator;
use crate::common::auth;

const ADMIN_RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);
const ADMIN_AUTH_LIMIT: u32 = 20;
const ADMIN_SENSITIVE_LIMIT: u32 = 60;

static ADMIN_RATE_LIMITER: OnceLock<parking_lot::Mutex<HashMap<String, RateBucket>>> =
    OnceLock::new();

#[derive(Clone, Copy)]
struct RateBucket {
    window_start: Instant,
    count: u32,
}

/// Admin API 共享状态
#[derive(Clone)]
pub struct AdminState {
    /// Admin API 密钥（运行时可修改）
    pub admin_api_key: Arc<RwLock<String>>,
    /// 业务 API 密钥（运行时可修改，与 anthropic 路由共享）
    pub api_key: Arc<RwLock<String>>,
    /// Admin 服务
    pub service: Arc<AdminService>,
    /// 客户端 Key 管理器（与 anthropic 路由共享）
    pub client_keys: SharedClientKeyManager,
    /// 用量聚合器（与 anthropic 路由共享）
    pub usage_aggregator: SharedAggregator,
    /// 请求链路追踪存储（与 anthropic 路由共享）
    pub trace_store: SharedTraceStore,
}

impl AdminState {
    pub fn new(
        admin_api_key: impl Into<String>,
        api_key: Arc<RwLock<String>>,
        service: AdminService,
        client_keys: SharedClientKeyManager,
        usage_aggregator: SharedAggregator,
        trace_store: SharedTraceStore,
    ) -> Self {
        Self {
            admin_api_key: Arc::new(RwLock::new(admin_api_key.into())),
            api_key,
            service: Arc::new(service),
            client_keys,
            usage_aggregator,
            trace_store,
        }
    }
}

/// Admin API 认证中间件
pub async fn admin_auth_middleware(
    State(state): State<AdminState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let rate_key = admin_rate_key(&request);
    let path = request.uri().path().to_string();
    if admin_route_is_sensitive(&path) && admin_rate_limited(&rate_key, ADMIN_SENSITIVE_LIMIT) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(AdminErrorResponse::invalid_request(
                "Admin API rate limit exceeded",
            )),
        )
            .into_response();
    }
    let auth_rate_key = format!("auth:{rate_key}");
    if admin_rate_is_exceeded(&auth_rate_key, ADMIN_AUTH_LIMIT) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(AdminErrorResponse::invalid_request(
                "Admin auth rate limit exceeded",
            )),
        )
            .into_response();
    }

    let api_key = auth::extract_api_key(&request);

    let current_key = state.admin_api_key.read().clone();
    match api_key {
        Some(key) if auth::constant_time_eq(&key, &current_key) => next.run(request).await,
        _ => {
            let _ = admin_rate_limited(&auth_rate_key, ADMIN_AUTH_LIMIT);
            let error = AdminErrorResponse::authentication_error();
            (StatusCode::UNAUTHORIZED, Json(error)).into_response()
        }
    }
}

fn admin_rate_key(request: &Request<Body>) -> String {
    request
        .headers()
        .get("x-forwarded-for")
        .or_else(|| request.headers().get("x-real-ip"))
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn admin_route_is_sensitive(path: &str) -> bool {
    path.contains("/client-keys")
        || path.contains("/config")
        || path.contains("/credentials")
        || path.contains("/system/update")
        || path.contains("/traces")
        || path.contains("/auth/")
}

fn admin_rate_limited(key: &str, limit: u32) -> bool {
    let now = Instant::now();
    let map = ADMIN_RATE_LIMITER.get_or_init(|| parking_lot::Mutex::new(HashMap::new()));
    let mut map = map.lock();
    let bucket = map.entry(key.to_string()).or_insert(RateBucket {
        window_start: now,
        count: 0,
    });
    if now.duration_since(bucket.window_start) >= ADMIN_RATE_LIMIT_WINDOW {
        bucket.window_start = now;
        bucket.count = 0;
    }
    bucket.count = bucket.count.saturating_add(1);
    bucket.count > limit
}

fn admin_rate_is_exceeded(key: &str, limit: u32) -> bool {
    let now = Instant::now();
    let map = ADMIN_RATE_LIMITER.get_or_init(|| parking_lot::Mutex::new(HashMap::new()));
    let mut map = map.lock();
    let Some(bucket) = map.get_mut(key) else {
        return false;
    };
    if now.duration_since(bucket.window_start) >= ADMIN_RATE_LIMIT_WINDOW {
        bucket.window_start = now;
        bucket.count = 0;
        return false;
    }
    bucket.count >= limit
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_cors_and_rate_limit_are_enforced() {
        assert!(admin_route_is_sensitive("/api/admin/client-keys"));
        let key = format!("test-{}", crate::security::secure_token_urlsafe(8));
        assert!(!admin_rate_limited(&key, 2));
        assert!(!admin_rate_limited(&key, 2));
        assert!(admin_rate_limited(&key, 2));
    }

    #[test]
    fn admin_auth_rate_limit_uses_auth_bucket() {
        let key = format!("auth-test-{}", crate::security::secure_token_urlsafe(8));
        assert!(!admin_rate_is_exceeded(&key, 2));
        assert!(!admin_rate_limited(&key, 2));
        assert!(!admin_rate_is_exceeded(&key, 2));
        assert!(!admin_rate_limited(&key, 2));
        assert!(admin_rate_is_exceeded(&key, 2));
    }
}
