# 最近 X 次回答缓存：开发说明

本文说明“本会话”栏中“最近回答缓存”功能的数据模型、计算口径、设置持久化和测试要求。

## 功能行为

- 展示当前逻辑会话中最近完成的回答，按完成时间从新到旧排列。
- 每条记录显示该回答的缓存命中率：`cached_input_tokens / input_tokens`。
- 折叠栏和指标主值显示最近 X 次中有效缓存命中率的算术平均值；不使用加权平均、最高值、最低值或某一条记录代替。
- X 默认为 `5`，用户可在展开面板中设置为 `1`–`20`。
- 未完成回答不进入列表；缺少有效输入 Token 的已完成回答保留并显示 `--`。
- `--` 记录占用最近 X 次的时间序列位置，但不参与算术平均；X 条均无有效值时主值显示 `--`。
- “上次回答缓存命中率”继续保留，与列表第一条采用相同计算口径。

## 后端数据流

`scripts/usage-client.mjs` 中的 `LocalCodexTokenTracker.turnCacheStats` 是唯一的回合缓存统计状态：

1. `observeTurnCache()` 按逻辑会话 ID 保存去重后的 Token 事件和回合完成事件。
2. `taskTokenView()` 按事件时间合并同一回答跨日志文件的用量，并按完成时间构造 `recentCacheRates`。
3. 后端最多返回 50 条记录，避免无限增长；界面再根据 X 截取。
4. `mergeOfficialLocalUsage()` 对跨进程传递的数据做范围和类型归一化。
5. `toSessionUsageSource()` 将数组附加到 `recentTurnCacheRates` 指标的 `recentRates` 字段。

同一回答使用 `turnId` 作为唯一键。恢复日志、重叠日志、同一会话的多个运行实例文件以及程序重启后的完整重扫，都复用现有事件身份与回合去重机制，不创建第二套缓存状态。

## 界面与设置

`assets/usage-inject.js` 对 `recentRates` 做只读归一化并渲染列表。数字输入框使用设置字段：

```json
{
  "recentCacheTurns": 5,
  "cacheAlertThreshold": 90
}
```

`scripts/ui-settings.mjs` 将 `recentCacheTurns` 截断为整数并限制在 `1`–`20`；无效或缺失值回退为 `5`。`cacheAlertThreshold` 限制在 `0`–`100` 并保留一位小数，无效或缺失值回退为 `90`。设置 schema 为 `4`，文件仍位于：

```text
%LOCALAPPDATA%\CodexUsageMonitor\ui-settings.json
```

中英文文案位于 `assets/usage-i18n.js`。

缓存告警使用严格小于判断。阈值为 `90` 时，`89.9%` 标红、`90.0%` 保持原色；阈值为 `0` 时关闭标红。总缓存、上次回答、近期平均值、近期逐次明细和折叠栏中的对应指标使用同一设置；无有效数据的 `--` 不标红。

折叠栏优先锚定到当前会话标题栏：以 `document.title` 对应的标题按钮确定左边界，以标题栏右侧第一个操作按钮确定右边界，并把监视栏靠右放置。展开面板从标题栏下方向下展开。若标题栏结构不可识别，则继续使用输入框工具栏锚点作为兼容回退。

## 回归测试

- `tests/usage-client.mjs`：未完成回答、顺序、重复快照、恢复日志、跨文件合并、重启重扫。
- `tests/ui-settings.mjs`：默认值、上下限、非法值、写入和重启恢复。
- `tests/usage-monitor-lifecycle.mjs`：中文和英文渲染、X 修改、持久化及按 X 截取。
- `tests/run-tests.ps1`：发布运行时必须同时包含 `recentTurnCacheRates` 与 `recentCacheTurns`。

运行完整源码测试：

```powershell
pwsh -NoProfile -File .\tests\run-tests.ps1 -SkipPackageTest
```
