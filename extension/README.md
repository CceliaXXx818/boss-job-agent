# BOSS Job Agent — Chrome 扩展使用说明（v0.5.0）

> 个人求职助手。自动化操作可能违反平台服务条款并带来账号风险，**使用即风险自担**。
> 本扩展不含任何验证码绕过 / 反检测 / 指纹伪装能力，也不会尝试规避平台风控。

## 它做什么

| 能力 | 说明 |
|---|---|
| **Goal-driven 搜索** | 一句话目标 → 搜索计划（城市跟随你当前 BOSS 页面）→ 搜索 → 硬过滤 → 抓详情 → AI 打分 |
| **Review Mode（默认）** | 只做推荐；是否打招呼由你勾选 + 确认 |
| **Autopilot** | 在阈值 / 每日上限 / 候选目标 / 工作时间内自动搜索与联系；可 Pause / Resume / Stop |
| **动作队列与幂等** | 每个岗位只联系一次（创建时 / 执行前 / 写入时 / 中断恢复四道闸门） |
| **每日求职执行日报** | 18:00（可配）自动生成，可随时预览、导出 Markdown |
| **本地存储** | 数据都在 `chrome.storage.local`，不出本机；AI 调用只发往你自己跑的 `127.0.0.1:8799` |

## 安装（本地加载）

1. 打开 `chrome://extensions` → 开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选择本目录 `extension/`
3. 用 Chrome 打开 `www.zhipin.com` 并**手动登录**
4. 点扩展图标 →「打开 Job Agent」（Side Panel）

> 升级后请务必点一次「重新加载」，否则 Service Worker 与界面可能仍是旧版本。

## 智能打分（可选，但 Autopilot 需要）

```bash
cd 项目根目录
echo 'DEEPSEEK_API_KEY=你的key' > .env   # 不入 Git
npm ci
npm run score:serve   # http://127.0.0.1:8799（只监听本机）
```

服务没启动时，Review 仍可搜索与筛选，但规划/打分/Autopilot 会暂停并明确提示原因。

Autopilot 的运行前提（缺一不可）：模式 = Autopilot、已完成授权、话术有效、能识别当前 BOSS 城市、
在当前工作时间、今日未达上限、平台无风险页面、本机 AI 服务可用。

## 设置放在哪

| 配置 | 位置 |
|---|---|
| 阈值 / 每日上限 / 候选目标 / 轮次 / 工作时间 / 监测间隔 / 日报时间 | Side Panel →「Autopilot 设置」（切到 Autopilot 模式才显示） |
| 打招呼话术（Review 与 Autopilot 共用，发送前固化进 Action） | Side Panel →「打招呼话术」 |
| 岗位硬排除 / 加分词 等规则 | `extension/core-logic.js`（系统级硬排除 + 画像排除词合并） |
| AI 打分用的候选人画像 | 项目根 `config/candidate.json`（由 `npm run score:serve` 读取） |
| DeepSeek API Key | 项目根 `.env`（服务端读取，扩展不接触） |

## 数据与权限

- **存储**：`jobAgentEvents:<日期>`（事件）、`jobAgentJobStates`（岗位状态）、`jobAgentActions`（动作队列）、
  `jobAgentAutopilotRuntime`（运行时状态）、`jobAgentSettings`（设置）、`jobAgentDailyReport:<日期>`（日报快照）
- **权限**：`storage / tabs / sidePanel / alarms / downloads` + `*.zhipin.com`、`127.0.0.1`、`localhost`
- **没有**：notifications、unlimitedStorage、scripting、webRequest、cookies、history

## 出问题时先看这三处

1. Side Panel 顶部徽标：`BOSS 已连接` / `AI 服务已连接`
2. 「运行状态」面板：Action Queue 状态、岗位状态、今日事件计数、最近 Action 的失败原因
3. 「Autopilot Activity」：每一轮的搜索词、候选数、Policy 决策、停止原因

常见情况：
- `AI 服务未连接` → 先 `npm run score:serve`，再点 Resume
- `已达到今日联系上限` → 当天不再自动联系（这是设计，不是故障）
- `执行中断…需人工确认` → 到 BOSS 消息列表确认是否已发出，再决定是否重试（不会自动重发）
- 端口 8799 被占用 → `lsof -ti :8799 | xargs kill` 后重启服务

## 免责声明

- 仅供个人学习与求职使用；请遵守你所在地区法律与平台规则。
- 自动化操作（自动打招呼等）存在账号受限风险，使用即视为接受。
- 作者不承担因使用本项目产生的任何账号损失或其他后果。Apache-2.0，详见项目根 `LICENSE`。
