## Kiro-RS-Tool v2026.1.7

本版本重点修复 Claude Code 客户端兼容性，尤其是工具调用、流式 thinking、缓存统计、CCH TOKS/TTFB 统计和 Admin 请求日志。

### 主要更新

- 修复 Claude Code 工具调用兼容：
  - `Write` / `Edit` / `Read` / `Bash` / `Glob` / `Grep` / `LS` / `WebSearch` 与 Kiro 工具 schema 双向映射。
  - 修复流式半截 JSON 导致的 `Invalid tool parameters`。
  - 修复大文件 Write/Edit 和工具 XML 泄漏相关问题。
- 增强 thinking 兼容：
  - 支持 Kiro CLI/IDE 侧的 thinking/effort 请求字段。
  - 支持 Anthropic SSE thinking block / redacted thinking block 输出。
- 修复缓存与统计：
  - 兼容 Claude Code Hub 的缓存字段显示。
  - 修复 CCH TOKS/TTFB 统计因过早 ping 导致失真的问题。
- 修复 Admin 请求日志：
  - WebSearch agentic loop 接入请求链路追踪。
  - 成功、失败、流中断、转换错误路径都会写入 `traces.db`。
  - 请求日志页刷新更及时，便于排障。
- 管理与安全补充：
  - 增强敏感信息脱敏。
  - 增加图片请求体保护。
  - 补充客户端 Key、日志治理、端点设置等管理能力。

### 资产说明

- `kiro-rs-tool-v2026.1.7-linux-x86_64.tar.gz`
  - Linux x86_64 二进制包，包含 `kiro-rs` 和配置示例。
- `kiro-rs-tool-v2026.1.7-docker-image.tar.gz`
  - Docker 镜像导出包，镜像名：`kiro-rs-tool:v2026.1.7`。
- `kiro-rs-tool-v2026.1.7-sha256.txt`
  - SHA256 校验和。

### Docker 使用

```bash
docker load -i kiro-rs-tool-v2026.1.7-docker-image.tar.gz
mkdir -p ./data
cp config.example.json ./data/config.json
# 按需创建或放入 credentials.json
docker run -d \
  --name kiro-rs-tool \
  -p 8990:8990 \
  -v "$PWD/data:/app/config" \
  --restart unless-stopped \
  kiro-rs-tool:v2026.1.7
```

### 二进制使用

```bash
tar -xzf kiro-rs-tool-v2026.1.7-linux-x86_64.tar.gz -C ./kiro-rs-tool
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

- `cargo fmt --check`
- `cargo check --locked`
- `cargo test anthropic::websearch_loop::tests --locked`
- `cargo test anthropic::handlers::tests --locked`
- `cargo test anthropic::stream::tests --locked`
- `cargo test anthropic::cache_metering::tests --locked`
- `pnpm run build`
- `cargo build --release --no-default-features`
