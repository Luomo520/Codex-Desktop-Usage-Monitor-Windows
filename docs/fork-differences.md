# 本 Fork 与上游主线的区别

本文说明 `Luomo520/Codex-Desktop-Usage-Monitor-Windows` Fork 相对于上游
`JiaYang-BUAA/Codex-Desktop-Usage-Monitor-Windows` 的新增功能和行为差异。

## 对比基准

| 项目 | 内容 |
| --- | --- |
| 上游仓库 | `JiaYang-BUAA/Codex-Desktop-Usage-Monitor-Windows` |
| 对比基准 | 上游正式版本 `v3.1.2` |
| 本 Fork 仓库 | `Luomo520/Codex-Desktop-Usage-Monitor-Windows` |
| 本 Fork 候选版本 | `v3.1.3` |
| 本地候选分支 | `fork/v3.1.3-custom` |
| 文档日期 | 2026-09-25 |

本 Fork 保留上游项目的安装方式、CDP 注入架构、官方订阅监控、API
账户/API Key、额度恢复续跑、重置概率预测、自动更新安全校验及 Windows
用户级安装结构。在这些能力之上，增加以下功能。

## 新增功能总览

| 功能 | 上游 `v3.1.2` | 本 Fork `v3.1.3` |
| --- | --- | --- |
| CC Switch 当前供应商联动 | 无 | 有；自动读取当前 Codex 供应商 |
| CC Switch 余额查询 | 无 | 复用供应商的 `usage_script`，只允许受限 GET 请求 |
| CC Switch Token 与请求统计 | 无 | 读取代理汇总和最近请求日志 |
| CC Switch 今日 Token 单位 | 不适用 | 固定使用百万 Token 的 `M` 单位 |
| 最近 X 次回答缓存 | 无 | 有；X 可设为 1–20，默认 5 |
| 近期缓存折叠值 | 无 | 最近 X 次有效命中率的算术平均值 |
| 缓存低命中率告警 | 无 | 阈值可设为 0–100，默认 90% |
| 监视栏位置 | 输入区域附近 | 优先显示在当前会话标题栏右侧 |

## 1. CC Switch 当前供应商联动

本 Fork 检测 `%USERPROFILE%\.cc-switch\cc-switch.db`，并读取 CC Switch
当前选中的 Codex 供应商。原“API 账户”栏会在可用时显示为：

```text
CC Switch · <当前供应商名称>
```

新增显示内容包括：

- 当前供应商账户余额；
- 累计已用额度；
- 今日 Token；
- 累计 Token；
- 上次消耗额度；
- 上次响应模型；
- 上次请求时间；
- 上次响应耗时。

切换 CC Switch 供应商后，监视器在下一次刷新时自动跟随，不需要重启
Codex 或重新填写 API Key。

### 今日 Token 的单位差异

CC Switch 栏的“今日 Token”固定使用百万 Token 的 `M` 单位：

| 原始 Token | 显示 |
| ---: | ---: |
| `12,340,000` | `12.34M` |
| `420,000` | `0.42M` |
| `420` | `0.00042M` |

此规则只用于 CC Switch 的“今日 Token”。官方订阅、API 账户及其他 Token
指标继续使用各自原有的本地化单位规则。

### CC Switch 安全边界

- SQLite 数据库以只读模式打开，不修改供应商、脚本或日志；
- 不把 CC Switch API Key 复制到监视器配置目录；
- 余额脚本在受限 VM 中执行，不能访问 `process`、文件系统或任意模块；
- 只允许 HTTPS GET；仅回环地址允许 HTTP；
- 禁止请求正文、URL 内凭据、未替换模板变量和危险请求头；
- 请求超时限制为 1–60 秒；
- 余额失败时保留 Token 和日志指标，并显示错误或过期状态。

详细实现见 [CC Switch 联动开发说明](ccswitch-integration.md)。

## 2. 最近 X 次回答缓存命中率

本 Fork 在“本会话”栏新增“最近回答缓存”：

- 按回答完成时间从新到旧排列；
- X 默认为 5，可设置为 1–20；
- 设置写入 `ui-settings.json`，重启后保留；
- 未完成的回答不进入历史列表；
- 跨恢复日志、轮转日志及重叠扫描会合并和去重；
- 缺少有效输入 Token 时显示 `--`，但不参与平均值计算。

单次回答的缓存命中率口径为：

```text
cached_input_tokens / input_tokens × 100%
```

折叠栏中的“近期缓存”不是某一次、最高值或最低值，而是最近 X 次记录中
所有有效百分比的算术平均值。

详细数据结构和恢复规则见
[最近 X 次回答缓存开发说明](recent-cache-history.md)。

## 3. 缓存低命中率标红

新增设置“低于此命中率标红”：

- 默认值为 `90%`；
- 范围为 `0–100`，支持一位小数；
- 只有严格低于阈值时标红；
- 等于阈值时不标红；
- `--` 不标红；
- 设置为 `0` 时关闭标红。

告警覆盖：

- 总缓存命中率；
- 上次回答缓存命中率；
- 最近 X 次平均缓存命中率；
- 最近 X 次逐条缓存明细；
- 标题栏折叠状态中已勾选的对应缓存指标。

## 4. 标题栏显示位置

本 Fork 优先把折叠监视栏放到当前会话标题栏右侧，详细面板从标题栏下方
展开。这样缓存、余额和 Token 指标不会继续占用输入框底部位置。

如果当前 Codex 版本无法可靠识别标题栏，监视器会自动回退到上游使用的
输入框工具栏位置，不会因为定位失败而隐藏全部监控信息。

## 5. 设置和数据结构变化

本 Fork 的 UI 设置 schema 从 `3` 升级到 `4`，新增：

```json
{
  "recentCacheTurns": 5,
  "cacheAlertThreshold": 90
}
```

旧设置文件会自动归一化并补充默认值，无需手动删除或重建配置。

## 6. 主要新增或修改文件

| 文件 | 作用 |
| --- | --- |
| `scripts/ccswitch-client.mjs` | CC Switch SQLite 只读查询、脚本沙箱和余额请求 |
| `scripts/usage-client.mjs` | CC Switch 数据源、近期缓存历史及 `M` 单位格式化 |
| `assets/usage-inject.js` | 近期缓存 UI、平均值和低命中率标红 |
| `assets/usage-placement.js` | 标题栏右侧定位和回退策略 |
| `scripts/ui-settings.mjs` | X 次数与标红阈值持久化 |
| `tests/ccswitch-client.mjs` | CC Switch 数据库、安全限制和余额脚本测试 |
| `tests/usage-client.mjs` | 日志恢复、去重、平均值和 `M` 单位测试 |
| `tests/usage-monitor-lifecycle.mjs` | UI、标题栏、阈值和颜色生命周期测试 |

## 7. 保持不变的上游能力

本 Fork 没有改变以下重要边界：

- 不修改 `WindowsApps`、`app.asar`、Codex 登录文件或模型配置；
- CDP 仍只绑定 `127.0.0.1`；
- 安装仍位于当前用户的 `%LOCALAPPDATA%\Programs\CodexUsageMonitor`；
- API 凭据继续使用 Windows DPAPI；
- 不强制终止或重启当前 Codex；
- 自动更新仍要求 GitHub Release、精确文件名、大小限制和 SHA-256；
- 官方订阅、API 账户、API Key 和自动续跑的原有数据口径保持不变。

## 8. 与未来上游版本同步

上游在 `v3.1.2` 之后的改动不属于本差异说明。后续同步上游时应重点检查：

1. `assets/usage-inject.js` 的面板 DOM 和设置迁移；
2. `assets/usage-placement.js` 的 Codex 标题栏选择器；
3. `scripts/usage-client.mjs` 的日志解析和数据源合并；
4. `config/package-files.json` 是否继续包含 Fork 新增文件；
5. 自动更新仓库地址与 Release 下载白名单是否指向本 Fork；
6. 合并后重新运行完整测试和正式发布构建。

## 9. 发布状态

`v3.1.3` 当前为候选版本。发布 ZIP、SHA-256 和 Release 说明已经在本地生成，
但尚未创建 `v3.1.3` Git 标签，也尚未创建 GitHub Release。
