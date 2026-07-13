# kepler-free-gate

[![Docker Image](https://img.shields.io/badge/ghcr.io-kepler--free--gate-blue?logo=docker)](https://github.com/GuJi08233/kepler-free-gate/pkgs/container/kepler-free-gate)

Kepler AI 免费模型的**自动代理反代网关**。

从公共代理池自动获取 S 级代理，多 IP 轮换使用，失败自动切换，解除免费模型的额度/频率限制。  
兼容 **OpenAI** API 格式，任何客户端只需改 `base_url` 即可接入。

---

## 支持的端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/models` | GET | 获取可用模型列表 |
| `/v1/chat/completions` | POST | 聊天补全（支持流式） |

---

## 快速开始

### 方式一：Docker（推荐）

```bash
docker run -d --name kepler-gate \
  -p 13339:13339 \
  --restart unless-stopped \
  ghcr.io/guji08233/kepler-free-gate:latest
```

### 方式二：从源码运行

```bash
# 安装 Bun（如未安装）
curl -fsSL https://bun.sh/install | bash

# 克隆
git clone https://github.com/GuJi08233/kepler-free-gate.git
cd kepler-free-gate
bun install
bun run gate.ts

# 指定端口
PORT=8080 bun run gate.ts
```

服务默认在 `http://localhost:13339` 启动。

### docker-compose

```yaml
services:
  kepler-gate:
    image: ghcr.io/guji08233/kepler-free-gate:latest
    container_name: kepler-gate
    restart: unless-stopped
    ports:
      - "13339:13339"
    environment:
      - PORT=13339
      # - GATEWAY_KEY=your-secret-key
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://127.0.0.1:13339/v1/models"]
      interval: 30s
      timeout: 10s
      retries: 3
```

```bash
docker compose up -d
```

---

## 客户端配置

### OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:13339/v1",
    api_key="any"  # 任意值即可
)

response = client.chat.completions.create(
    model="your-model",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

### curl

```bash
# 获取模型列表
curl http://localhost:13339/v1/models

# 聊天补全
curl http://localhost:13339/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "your-model",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'

# 流式请求
curl http://localhost:13339/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{
    "model": "your-model",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### 任何 OpenAI 兼容客户端

设置 `base_url = http://localhost:13339/v1` 即可。

---

## 部署到海外 VPS

中国大陆访问代理池不稳定，建议部署到海外（香港/日本/美国）VPS。

```bash
# 1. 在 VPS 上拉镜像
docker pull ghcr.io/guji08233/kepler-free-gate:latest

# 2. 后台运行
docker run -d --name kepler-gate \
  -p 13339:13339 \
  --restart unless-stopped \
  ghcr.io/guji08233/kepler-free-gate:latest

# 3. 验证
curl http://your-vps-ip:13339/v1/models

# 4. 更新镜像
docker pull ghcr.io/guji08233/kepler-free-gate:latest && \
docker restart kepler-gate
```

---

## 架构

```
客户端 ──→ gate.ts (:13339) ──→ 代理池 ──→ oai.endpoints.kepler.ai.cloud.ovh.net
                │
                ├── /v1/models            → GET 模型列表
                ├── /v1/chat/completions  → POST 聊天补全
                ├── 多 IP 轮换            → round-robin 轮询
                ├── 失败重试              → 3 次重试，换 IP 再试
                └── 直连回退              → 全部失败直连上游
```

### 核心流程

1. **启动时**从 `proxy.amux.ai/api/proxies` 拉取 S 级免费代理（候选池），按延迟排序
2. **选 3-5 个**延迟最低的代理，探活后放入 slot
3. **轮询分发**：每个请求 round-robin 选一个 slot
4. **失败处理**：
   - 代理连不上 / 超时 → 丢弃该 slot，异步补位
   - 重试最多 3 次（换不同 slot）
   - 全部失败 → 直连上游
   - 上游 5xx 不算代理失败，直接返回给客户端
5. **每 5 分钟**自动刷新候选池，补位 slot
6. **流式支持**：自动识别 `Accept: text/event-stream` 或 body 中的 `stream: true`，直接透传原始 SSE 流

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `13339` | 监听端口 |
| `GATEWAY_KEY` | 空 | 网关访问密钥（设置后需要 Bearer 认证） |
| `SLOT_COUNT` | `3` | S级代理槽位数（范围 3-5） |
| `CUSTOM_PROXIES` | 空 | 自定义代理列表，逗号分隔，作为兜底备用 |
| `ZENPROXY_KEY` | 空 | 启用 ZenProxy 备用通道（[申请 Key](https://zenproxy.top)） |
| `ZENPROXY_RELAY` | `https://zenproxy.top/api/relay` | 自定义 relay 端点 |
| `FORCE_RELAY` | `0` | 设为 `1` 跳过代理池强制走 ZenProxy（调试用） |
| `PROXY_PROBE_TIMEOUT` | `8000` | 新代理探活超时（ms） |
| `PROXY_REFRESH_MS` | `300000` | 候选池刷新间隔（ms，默认 5 分钟） |

### 代理回退策略

```
S级免费代理（3-5个槽位轮换）
    ↓ 失败重试3次
ZenProxy（需配置 ZENPROXY_KEY）
    ↓ 未配置或失败
自定义代理兜底（需配置 CUSTOM_PROXIES）
```

**优先级**：S级代理 → ZenProxy（可选） → 自定义代理（兜底）

### 网关认证

设置 `GATEWAY_KEY` 后，客户端需要提供 Bearer Token：

```bash
# 未设置 GATEWAY_KEY - 无需认证
curl http://localhost:13339/v1/models

# 设置 GATEWAY_KEY=my-secret-key 后
curl http://localhost:13339/v1/models \
  -H 'Authorization: Bearer my-secret-key'
```

---

## 依赖

- [hpagent](https://github.com/delvedor/hpagent) — HTTP CONNECT 代理隧道
- [socks-proxy-agent](https://github.com/TooTallNate/proxy-agents) — SOCKS5 代理

Bun 会自动安装。

---

## 许可证

MIT
