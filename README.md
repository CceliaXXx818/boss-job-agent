# BOSS Job Agent

**在你自己已登录的浏览器里跑的求职 Agent：一句话目标 → 自动搜索/打分/打招呼，每天 18:00 交一份求职执行日报。**

> **v0.5.0** ｜ 个人作品集项目，非官方工具、与 BOSS 直聘无关。自动化操作存在平台账号风险，**使用即风险自担**。
> 项目不含也不接受：验证码绕过、反检测/指纹伪装、代理池、多账号。

---

## 两种模式（V0.5 核心）

| 模式 | 谁决定"发不发" | 适合谁 |
|---|---|---|
| **Review Mode**（默认） | **你**：Agent 只搜索+打分+推荐，你勾选并确认后才打招呼 | 想逐条把关、或第一次使用 |
| **Autopilot** | **Policy 规则**：在阈值 / 每日上限 / 工作时间 / 授权范围内自动联系，可随时 Pause / Resume / Stop | 想让 Agent 按纪律自己跑一天 |

切换模式后才会显示 Autopilot 的设置、话术、Policy 试算、运行面板与运行状态；Review 模式界面保持干净。

**三层分工（整个项目的主线）**

> **LLM 决定 WHAT**（目标理解、搜索策略、匹配打分） → **确定性浏览器代码决定 HOW**（点击、填写、发送） → **Policy 决定 WHETHER**（阈值、上限、工作时间、平台风险、幂等）

---

## 快速开始

```bash
# 1) 环境：Chrome + Node 20+ + DeepSeek API Key
git clone https://github.com/CceliaXXx818/boss-job-agent.git && cd boss-job-agent
npm ci
echo 'DEEPSEEK_API_KEY=你的key' > .env

# 2) 启动本机 AI 服务（只监听 127.0.0.1:8799）
npm run score:serve

# 3) 配置 AI 打分依据（你的画像）
cp config/candidate.example.json config/candidate.json   # 然后编辑它

# 4) 安装扩展
# chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择 extension/ 目录
# 用 Chrome 打开 www.zhipin.com 并【手动登录】
```

**用 Review Mode 跑第一轮**

1. 点扩展图标 →「打开 Job Agent」（Side Panel）
2. 输入目标，例如：`上海 AI 产品经理，优先 Agent / 大模型应用方向，30K 以上，不要外包、售前、纯运营`
3. 点「开始找工作」→ Agent 自己 Plan → 搜索 → 硬过滤 → 抓详情 → AI 打分 →（不足时）Replan 一次
4. 在 Shortlist 里勾选想投的岗位 →「联系选中岗位」→ 确认 → 发送

**用 Autopilot 跑一天**

1. 顶部切到 **Autopilot** → 首次会弹授权页（说明会做什么、不会做什么、以及将自动发送的完整话术）
2. 在「Autopilot 设置」里定阈值 / 每日上限 / 候选目标 / 轮次 / 工作时间（**首次建议：上限 1、阈值 85**）
3. 填目标 → 点 **Start Autopilot** → 可以关掉 Side Panel，Background 会按 bounded step 继续推进
4. 想停下就 **Pause**；处理完 BOSS 页面再 **Resume**；**Stop** 结束今天这次会话
5. 18:00（可配）自动生成**每日求职执行日报**；也可以在 Side Panel 里随时「查看今日日报 / 导出 Markdown」

---

## 它一天在做什么

```
Goal（自然语言）
   ↓  /plan（LLM）                       ← 只产出结构化计划，不产出动作
搜索计划（城市来自当前 BOSS 页面；查询 ≤6 个）
   ↓  Search → 硬过滤（规则优先于分数）→ 抓详情（预算随目标缩放）
   ↓  /score（LLM）→ 推荐（≥75）→ Autopilot Eligible（≥阈值 + 未硬排除 + 未联系过 + 信息完整 + 话术可用）
   ↓  Eligible ≥ 候选目标 → 跳过 Replan 直接 Outreach；否则 /replan 补一次搜索词（不允许改城市/硬约束/薪资）
Policy（阈值 / 每日上限 / 工作时间 / 暂停 / 平台健康 / 幂等）
   ↓  创建 GREETING Action（pending）→ 执行前二次校验 → approved → executing
Greeting（确定性 DOM 代码，复用已验证的发送链路）
   ↓  成功：GREETING_SENT 事件 + 岗位状态 GREETED；失败：GREETING_FAILED，绝不误标成功
Round 结束 → 判断是否继续下一轮（上限 / 上限额 / 无新结果 / 超出工作时间）
   ↓
OUTREACH_COMPLETE → MONITORING（"今天主动联系结束"）
   ↓  18:00（或下次唤醒 catch-up）
每日求职执行日报（Event Store 聚合，不靠 LLM）
```

- **不会长驻循环**：Background Service Worker 每次唤醒最多推进 3 个 bounded step，每步立即落盘；关掉浏览器就停，重开后从持久化 runtime 续跑。
- **不会重复发送**：四道幂等闸门（创建时 / 执行前 / 写入时 / 中断恢复），Side Panel 关闭、页面刷新、SW 被回收都不会重复打招呼。
- **中断保守处理**：发送中途被打断的 Action 标记为 `requires_manual`，绝不自动重发。

---

## 每日求职执行日报（V0.5 Phase 4）

每天 18:00（`dailyReportTime` 可配）自动生成，写入 `jobAgentDailyReport:YYYY-MM-DD`；Chrome 那时没开着，会在下次唤醒（启动 / 打开面板 / 启动 Autopilot）补生成，同一天只有一份正式日报。

内容全部来自 Event Store / Job State / Runtime 的结构化字段（**不解析日志文本、不调用 LLM**）：

- 今日汇总：发现 / AI 分析 / AI 推荐 / 已联系 / 联系失败 / 轮次 / 搜索词 / 补充搜索
- Outreach：今日上限、已联系 x/y、目标是否达成、**机器原因翻译过的停止原因**、Autopilot vs Review 来源拆分
- 每轮表现：搜索词、发现数、过滤后、分析数、推荐数、可自动联系候选 / 目标、本轮联系数、是否补充搜索（含"判定无需补充"）
- 搜索策略、高分岗位（可点开）、**今日未联系的高质量候选**（明确标注"未联系 ≠ 明天一定联系"）
- 今日已联系岗位明细（含话术策略）、异常与暂停（失败 / 暂停 / 平台风险 / 需人工）
- 「尚未监测」一节：**HR 回复、简历请求、简历发送、面试在本版本没有监测能力，因此不显示这些数字（不是 0）**

---

## 架构

| 层 | 位置 | 职责 |
|---|---|---|
| **Eyes + Hands** | `extension/content.js` | 只读页面 / 点击 / 填写：搜索、抓列表、抓详情、打招呼、页面健康信号 |
| **Orchestrator** | `extension/background.js` | Autopilot 编排、alarms 调度、执行标签管理、风险处理、日报 alarm |
| **Step Machine** | `extension/autopilot-engine.js` | 11 个 bounded step（PLAN→SEARCH→FILTER→DETAIL→SCORE→EVALUATE→REPLAN→OUTREACH→ROUND_END…） |
| **共享内核** | `extension/discovery-runner.js`、`extension/ai-client.js` | Review 与 Autopilot 共用同一套过滤/评估/Replan/AI 调用（禁止第二份实现） |
| **持久化** | `extension/event-store.js`、`job-state.js`、`action-queue.js`、`autopilot-runtime.js` | 事件（按日分区）/ 12 状态岗位机 / 动作队列 / 运行时状态 |
| **纪律层** | `extension/core-logic.js`、`autopilot-policy.js`、`settings.js` | 硬排除、限额、幂等、Policy 12 条件、统一设置 |
| **UI** | `extension/sidepanel.*` | 目标输入、Review 流程、Autopilot 控制台、日报查看/导出（只发命令与渲染，不参与执行） |
| **Brain** | `packages/model-client` | `/plan` `/replan` `/score`：只输出结构化 JSON，不做动作 |

### 本机 AI 服务接口

| 接口 | 作用 |
|---|---|
| `GET /health` | 健康检查（含版本号） |
| `GET /config` | 画像摘要（排除词等，供硬过滤合并） |
| `POST /plan` | 目标 → 搜索计划（关键词 3~6 个由模型生成） |
| `POST /replan` | 结果不足 → 只新增搜索词；Autopilot 下按"可自动联系候选 / 候选目标"判定 |
| `POST /score` | 岗位打分（≥75 推荐；Autopilot 另有自己的联系阈值） |

服务只监听 `127.0.0.1`，API Key 仅存本地 `.env`。

---

## 权限（最小必要，逐阶段增加）

| 权限 | 用途 |
|---|---|
| `storage` | 事件、岗位状态、动作队列、运行时状态、日报快照（唯一事实来源） |
| `tabs` | 复用/创建 Autopilot 执行标签、导航 |
| `sidePanel` | 主界面 |
| `alarms` | Autopilot tick 与 18:00 日报调度（不用长驻 timer） |
| `downloads` | 导出日报 Markdown |
| host: `*.zhipin.com` / `127.0.0.1` / `localhost` | 只在 BOSS 页面与本机 AI 服务上工作 |

**没有**：`notifications`、`unlimitedStorage`、`scripting`、`webRequest`、`cookies`、`history`。

---

## 安全与纪律（产品的一部分）

- **规则优先**：命中硬排除 / 低于薪资下限 → 直接移除，不进模型
- **双重 Policy 校验**：Action 创建前 + 执行前各校验一次（每日上限可能已变）
- **额度硬约束**：绝不"先创建 6 个 approved 再发现超上限"
- **异常即停**：验证码 / 登录失效 / 风险页 / 连续工具失败 → PAUSED 交还给人，不绕过、不无限重试
- **工作时间**：只在设定窗口内搜索与联系；超时收工进入 MONITORING，不为凑额度夜里继续联系
- **不做**：HR 自动聊天、自动发简历、自动回复、微信推送、多平台、多账号、验证码绕过

---

## 测试

```bash
npm run typecheck   # 类型检查
npm test            # 全部单测（525 个用例）
npm run ci          # typecheck + 版本锁定校验 + 全部测试
npm run scan:redline# 敏感信息扫描（手机号/邮箱/Key/私钥）
```

覆盖：Planner/Replan 边界、Policy 12 条件、Action Queue 状态机与幂等、Runtime 恢复与 SW 中断、
Replan 终止条件（Eligible vs Target）、评分分批与续评、工作时间窗口、日报聚合与 snapshot 幂等、
顺手还锁住了若干真实事故的回归（`/score` 响应无 `ok` 字段、日志 UTC 显示、面板提前生成正式日报等）。

---

## 已知边界

- Autopilot **只在 Chrome 打开时**推进；严格 18:00 不保证，靠 catch-up 补生成
- 计划里的搜索词由模型生成（`temperature: 0` ⇒ 同一目标文本会得到很接近的词表）；想要不同方向，把目标写细一些
- MONITORING 只是"今天主动联系结束"的终点状态，**还没有** HR 回复监测
- 未联系的高质量候选不会跨天保留（候选池消费策略尚未实现）
- Email 日报（Phase 4B）、HR Monitor、Resume 相关能力尚未实现

---

## 文档地图（想学架构从这里进）

| 文档 | 内容 |
|---|---|
| [`docs/AGENT-ARCHITECTURE.md`](docs/AGENT-ARCHITECTURE.md) | **用到了哪些 Agent 架构模式**、为什么这么选、没用哪些、7 步学习路线 |
| [`docs/PRD-v0.5.md`](docs/PRD-v0.5.md) | 完整需求（功能需求编号化 + 验收标准 + 非目标 + 后续路线） |
| [`docs/DESIGN-v0.5.md`](docs/DESIGN-v0.5.md) | 完整设计（模块地图、11 个 step、事件目录、状态机、幂等、调度、测试、扩展点） |
| [`docs/INDEX.md`](docs/INDEX.md) | 文档地图与阅读顺序（含历史文档标注） |
| [`CHANGELOG.md`](CHANGELOG.md) | 每个版本的变化与修复背后的真实事故 |

> ⚠️ `docs/` 里的 `PRD.md` / `ARCHITECTURE.md` / `DATA_MODEL.md` / `TOOL_SPEC.md` / `IMPLEMENTATION_PLAN.md`
> 是项目**最早的设计稿（V0.1，SQLite + 平台适配器路线，未按此实现）**，已在文件顶部标注；看当前实现请用上面这套。

---

## 旧入口（Legacy）

`extension/auto.html` 保留为 V0.3 的调试台；Side Panel 是主入口，popup 作为轻量启动器。

## 免责声明与许可

- 仅供个人学习与求职使用；请遵守 BOSS 直聘服务条款与你所在地法律。
- 自动化操作可能导致账号受限，**使用即视为自愿接受**。
- Apache-2.0，详见 `LICENSE`。
