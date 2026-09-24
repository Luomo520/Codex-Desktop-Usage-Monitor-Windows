# CC Switch 当前供应商联动开发说明

本文说明 Codex Usage Monitor 如何只读接入 CC Switch，并让 API 栏自动跟随 CC Switch 当前 Codex 供应商。

## 目标

- 不要求用户在监视器中重复填写供应商 Base URL 或 API Key。
- CC Switch 切换 Codex 供应商后，监视器在下一次刷新时自动切换。
- 余额复用 CC Switch 已保存的 `usage_script`。
- 今日/累计 Token、最近模型、请求时间和响应耗时复用 CC Switch 的代理日志。
- 不修改 CC Switch 数据库，不复制凭据到 CodexUsageMonitor 配置目录。

## 数据源

默认数据库位置：

```text
%USERPROFILE%\.cc-switch\cc-switch.db
```

测试或定制部署可通过构造参数 `databasePath` 指定其他数据库。运行时使用 Node.js `node:sqlite` 的 `DatabaseSync`，并设置：

```js
new DatabaseSync(databasePath, {
  open: true,
  readOnly: true,
  timeout: 2500,
})
```

读取的表与字段：

| 表 | 用途 | 主要字段 |
| --- | --- | --- |
| `providers` | 定位当前 Codex 供应商及余额规则 | `id`、`name`、`settings_config`、`meta`、`is_current` |
| `usage_daily_rollups` | 今日与累计 Token、成本 | `provider_id`、`date`、各类 Token、`total_cost_usd` |
| `proxy_request_logs` | 最近请求详情 | `model`、`request_model`、`latency_ms`、`created_at`、`total_cost_usd` |

当前供应商查询：

```sql
SELECT id, name, settings_config, meta
FROM providers
WHERE app_type = 'codex' AND is_current = 1
ORDER BY sort_index, created_at
LIMIT 1
```

## 凭据与 Base URL

`settings_config` 是 JSON，其中 Codex 供应商通常使用：

```json
{
  "auth": {
    "OPENAI_API_KEY": "..."
  },
  "config": "base_url = \"https://api.example.com\""
}
```

监视器只在当前余额请求期间把凭据保存在进程内存中。它不会：

- 把 Key 写入 `%LOCALAPPDATA%\CodexUsageMonitor`；
- 输出 Key 到日志或 UI；
- 修改 `cc-switch.db`；
- 读取 Codex 的 `auth.json` 或 `config.toml` 获取 Key。

DeepSeek 官方等特殊供应商可以在 `usage_script` 对象里保存独立的 `accessToken` 和 `baseUrl`。变量支持：

```text
{{baseUrl}}
{{apiKey}}
{{accessToken}}
{{userId}}
```

## 余额脚本执行模型

CC Switch 的 `meta.usage_script.code` 通常返回：

```js
({
  request: {
    url: "{{baseUrl}}/v1/usage",
    method: "GET",
    headers: { Authorization: "Bearer {{apiKey}}" }
  },
  extractor: function (response) {
    return {
      isValid: true,
      remaining: response.remaining,
      unit: response.unit || "USD"
    };
  }
})
```

监视器不会使用 `eval` 在主运行环境执行该代码。`request` 和 `extractor` 在单独的 Node `vm` 上下文中运行，并应用以下限制：

- 禁止字符串代码生成和 WebAssembly；
- 沙箱中没有 `process`、`require`、`fetch`、文件系统或模块加载器；
- 脚本求值和 extractor 各有 100 ms CPU 超时；
- 只允许 `GET`；
- 远程地址必须使用 HTTPS，本机回环地址才允许 HTTP；
- 禁止重定向；
- 响应体最大 2 MiB；
- 凭据和请求头禁止换行与空字节；
- 请求超时由 CC Switch 脚本的 `timeout` 决定，并限制在 1 至 60 秒。

如果脚本需要 POST、Cookie 会话、浏览器登录状态或其他复杂行为，联动源会显示错误，不会降低安全限制。

## 刷新与供应商切换

`CcSwitchUsageClient` 由统一的使用量客户端管理：

1. 每 30 或 60 秒重新只读打开数据库；
2. 查询 `providers.is_current`；
3. 读取当前供应商余额脚本和运行配置；
4. 请求余额接口；
5. 查询当前供应商的汇总日志；
6. 生成 ID 为 `ccswitch` 的数据源；
7. 关闭 SQLite 连接。

因此供应商切换不需要重启监视器。数据库暂时被占用或余额接口失败时，数据源标记为 `stale` 或 `error`，不写数据库，也不改变 CC Switch 当前供应商。

## UI 行为

当 `ccswitch` 数据源可用时，原“API 账户”栏位替换为：

```text
CC Switch · <当前供应商名称>
```

该栏没有“配置”按钮，因为配置权归 CC Switch。CC Switch 不存在或没有当前 Codex 供应商时，界面回退到原有 API 账户模式。

显示字段：

| 字段 | 首选来源 | 回退来源 |
| --- | --- | --- |
| 账户余额 | `usage_script.extractor().remaining` | `balance` |
| 累计已用额度 | extractor 的 `used` / `usedQuota` | `usage_daily_rollups.total_cost_usd` |
| 今日 Token | `usage_daily_rollups` | extractor `extra` 中的 `N tokens` |
| 累计 Token | `usage_daily_rollups` | `0` |
| 上次消耗额度 | 最近 `proxy_request_logs.total_cost_usd` | `--` |
| 上次响应模型 | 最近 `request_model` / `model` | `--` |
| 上次请求时间 | 最近 `created_at` | `--` |
| 上次响应耗时 | 最近 `latency_ms` | `--` |

只有经过 CC Switch 代理且启用日志的请求才会写入日志表。余额查询不依赖代理日志。

“今日 Token”固定以百万 Token 的 `M` 为单位显示，例如 `12,340,000` 显示为 `12.34M`；该规则只作用于 CC Switch 栏，不改变官方订阅和 API 账户的既有单位格式。

## 文件结构

```text
scripts/ccswitch-client.mjs     SQLite、沙箱、余额请求与统计读取
scripts/usage-client.mjs        数据源生命周期和 UI 指标归一化
assets/usage-inject.js          CC Switch 栏位选择和展示
tests/ccswitch-client.mjs       合成数据库与安全回归测试
docs/ccswitch-integration.md    本文
```

## 测试

单独运行：

```powershell
node .\tests\ccswitch-client.mjs
```

完整测试：

```powershell
pwsh -NoProfile -File .\tests\run-tests.ps1
```

测试覆盖：

- 当前供应商识别；
- Base URL 与 API Key 变量替换；
- 今日/累计 Token 聚合；
- 最近模型与耗时；
- GET/HTTPS 限制；
- 未解析变量拒绝；
- 沙箱无法访问 `process`；
- 安装包白名单包含联动模块。

## 已知限制

- CC Switch 数据库表结构升级时，需要同步更新查询和测试 fixture。
- `usage_script.extractor` 必须是同步函数，不能返回 Promise。
- `extra` 的 Token/金额回退解析只识别常见的 `123 tokens` 和 `$1.23` 文本。
- 供应商余额接口字段完全取决于 CC Switch 中的脚本；脚本错误应先在 CC Switch 的“测试”功能里修复。
- CC Switch 仍使用 SQLite `journal_mode=delete` 时，极短时间的锁竞争可能导致单次刷新失败；下一轮会重试。
