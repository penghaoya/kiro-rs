## Kiro-RS-Tool v2026.1.8

本版本基于 `v2026.1.7`，补齐 Admin 批量导入和 KAM 导入的验活稳定性修复，避免上游瞬态故障导致刚导入的凭据被误删。

### 主要更新

- 修复 Admin 导入验活：
  - 502、429、网络错误、DNS/代理/超时等瞬态失败会保留凭据，并标记为“已导入（待验活）”。
  - 仅对明确永久错误执行回滚，例如 400、invalid_request、InvalidCredential 等。
  - 新增凭据后清理旧余额缓存，避免前端延迟验活命中旧状态。
- 增强余额查询韧性：
  - 对 429、401/403 传播延迟、5xx、网络/超时/代理/DNS 类错误做短退避重试。
  - 永久错误不重试，保持失败原因清晰。
- 延续 `v2026.1.7` 的 Claude Code / CCH 兼容修复：
  - 工具调用、流式 thinking、缓存统计、CCH TOKS/TTFB 统计和 Admin 请求日志保持可用。
  - 敏感信息脱敏、图片请求体保护和客户端 Key 管理能力保持同步。

### 资产说明

- `kiro-rs-tool-v2026.1.8-linux-x86_64.tar.gz`
  - Linux x86_64 二进制包，包含 `kiro-rs` 和配置示例。
- `kiro-rs-tool-v2026.1.8-docker-image.tar.gz`
  - Docker 镜像导出包，镜像名：`kiro-rs-tool:v2026.1.8`。
- `kiro-rs-tool-v2026.1.8-sha256.txt`
  - SHA256 校验和。

### Docker 使用

```bash
docker load -i kiro-rs-tool-v2026.1.8-docker-image.tar.gz
mkdir -p ./data
cp config.example.json ./data/config.json
# 按需创建或放入 credentials.json
docker run -d \
  --name kiro-rs-tool \
  -p 8990:8990 \
  -v "$PWD/data:/app/config" \
  --restart unless-stopped \
  kiro-rs-tool:v2026.1.8
```

### 二进制使用

```bash
tar -xzf kiro-rs-tool-v2026.1.8-linux-x86_64.tar.gz -C ./kiro-rs-tool
cd ./kiro-rs-tool
chmod +x ./kiro-rs
cp config.example.json config.json
# 按需创建或放入 credentials.json
./kiro-rs -c ./config.json --credentials ./credentials.json
```

### Claude Code / CCH 配置

将客户端的 Anthropic Base URL 指向服务地址：

```text
http://<host>:8990
```

API Key 使用 `config.json` 里的 `apiKey`，Admin UI 使用：

```text
http://<host>:8990/admin
```

Admin Key 使用 `config.json` 里的 `adminApiKey`。

### 建议配置

```json
{
  "defaultEndpoint": "ide",
  "toolCompatibilityMode": "claude-code",
  "traceEnabled": true,
  "retryMode": "fast"
}
```

`toolCompatibilityMode` 默认为 `claude-code`。排障时可临时改为 `raw`，但日常使用建议保持 `claude-code`。

### 校验

发布前已执行：

- `npx tsc -b --pretty false`
- `npm run build`
- `rustfmt --edition 2024 --check src/admin/service.rs`
- `cargo check --locked`
- `cargo build --release --locked --no-default-features`
