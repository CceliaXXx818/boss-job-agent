# Agent 架构解读（AGENT-ARCHITECTURE.md）

> 目的：回答"我这个项目到底用了哪些 Agent 架构、为什么这么选"，并给出一条可以照着学的路径。
> 本文只描述**已经实现**的东西；没实现的会明确写"未实现"。
> 对应代码：`extension/`（21 个文件，约 8.8k 行）+ `packages/model-client`（本机 AI 服务）。

---

## 0. 一句话结论

这个项目不是"自主循环 Agent"，而是一个

> **目标驱动（Plan-and-Execute）+ 事件溯源持久化（Event Sourcing）+ 有界步骤机（Bounded Step Machine）+ Policy 门禁（Policy-as-Code）+ 人在环（Human-in-the-Loop）的浏览器 Agent。**

它把传统 Agent 的"想 → 做 → 看 → 再想"的自由循环，拆成了**离散、可持久化、可审计、可中断恢复的步骤**，并且把"能不能做"的判断从 LLM 手里拿走了，交给确定性的 Policy。

```
LLM 决定 WHAT（想做什么）
确定性浏览器代码决定 HOW（怎么做）
Policy 决定 WHETHER（允不允许做）
用户决定 CONSENT（授不授权这样做）
```

---

## 1. 用到了哪些 Agent 架构模式

| # | 模式 | 在本项目里的实现 | 为什么用它 |
|---|---|---|---|
| 1 | **Goal-driven Planning / Plan-and-Execute** | `/plan` 把自然语言目标变成结构化计划（城市/岗位/技能/薪资/硬排除/搜索词），`runtime.currentPlan` 持久化；执行阶段按计划逐条搜索 | 一次规划、多次执行，比每步都问模型省 token、也更可复现（`temperature: 0`） |
| 2 | **有界步骤机（Bounded Step Machine）** | `extension/autopilot-engine.js` 的 `advanceAutopilot()`：11 个 step，**一次调用只推进一步**，步与步之间必须落盘 | MV3 Service Worker 随时会被回收；长驻 `await` 循环不可靠 |
| 3 | **事件驱动编排（不是轮询循环）** | `chrome.alarms`（Autopilot tick + 日报）+ `chrome.tabs.onUpdated`（导航完成即推进）+ 用户命令 | 没有 `while(true)` / `setInterval`，每次唤醒最多 3 步，随时可被打断 |
| 4 | **持久化执行 / Durable Execution** | `jobAgentAutopilotRuntime`（纯 JSON）记录 `step / currentQueryIndex / detailBuffer / outreachQueue / activeActionId`，SW 重启后从断点续跑 | 崩溃/回收/关闭面板都不丢进度，也不需要用户重新打开界面 |
| 5 | **Event Sourcing + 派生状态** | `jobAgentEvents:YYYY-MM-DD` 只追加（append-only），`job-state.js` 是从事件派生的当前状态；日报完全从事件重建 | 可审计、可复盘、可重算；改状态逻辑不影响历史事实 |
| 6 | **CQRS 味道的读写分离** | 写：`appendEvent()`；读：`job-state` 的 `countByState()`、`aggregateEvents()`、日报 `buildDailyReport()` | 写入路径极简（只追加 + 幂等），读取路径各自聚合 |
| 7 | **命令队列 / Outbox + 幂等键** | `action-queue.js`：`pending→approved→executing→success|failed|skipped|requires_manual`；幂等键 `greeting:<jobId>` / `resume:<jobId>` / `report:<date>` | 把"要做的事"先落盘再执行，天然支持中断恢复，且重复点击/刷新/重开都不会重复发送 |
| 8 | **近似 exactly-once（真正的工程做法是幂等）** | 四道闸门：创建时查队列与事件 → 执行前再查一次 → 写入时事件幂等 → 中断恢复标记 `requires_manual` | 分布式系统里"恰好一次"要靠幂等实现，而不是靠"永不失败" |
| 9 | **Policy-as-Code / 决策门禁** | `autopilot-policy.js` 12 个条件（模式、授权、话术、暂停、工作时间、分数阈值、硬排除、历史去重、每日上限、信息完整 + 验证码/页面健康两个风险闸门），**创建前 + 执行前各判一次** | LLM 与执行器都不许自己决定"能不能发"，规则集中一处、可测试、可解释 |
| 10 | **人在环（Human-in-the-Loop）审批** | Review 模式：勾选 → 创建 pending Action → 二次确认（显示将发送的完整话术）→ approved → 执行 | 高风险外部动作前保留人的否决权 |
| 11 | **一次性授权（Consent Gate）** | 首次切 Autopilot 必须过授权页（会做什么/不会做什么/完整话术）；切回 Review 即撤销授权 | 把"持续授权"与"单次批准"分开，避免误以为只是临时同意 |
| 12 | **工具使用 = 确定性技能（Tool Use / Skills）** | `content.js` 只暴露确定性动作：`scrape / detailScrape / greetFull / bossContext / pageHealth`；Background 从不猜 selector | "眼睛和手"必须是可测的普通代码，模型不碰 DOM |
| 13 | **能力最小化（Least Privilege）** | manifest 权限逐个 Phase 才加：`storage/tabs/sidePanel` → `alarms`（Autopilot 调度）→ 沿用 `downloads`（导出）；**没有** notifications/unlimitedStorage/scripting/webRequest | 一个能自动联系招聘者的扩展，权限越小越好审计 |
| 14 | **预算与早停（Budgeting / Early Stop）** | 候选目标 `batchQualifiedTarget`（凑齐就停搜）、`dailyGreetingCap`（今日上限）、`maxDiscoveryRounds`、`maxReplanPerRound=1`、工作时间窗、详情预算 `clamp(target×3, 5, 15)` | Agent 必须有硬边界，否则会"越努力越危险" |
| 15 | **失败即降级/暂停（Fail-safe）** | 验证码/登录失效/风险页/连续 2 次工具失败/AI 服务不可用 → `PAUSED` 并写事件；单次浏览器操作最多重试 1 次 | 不绕过平台风控、不无限重试、不装作没事 |
| 16 | **审计优先（Audit-first）** | 每个决策都落事件（含 Policy 拒绝原因、Replan 决策与新增词、停止原因 code）；Activity 日志只是可读层 | 用户能回答"为什么发/为什么停/为什么搜这个词" |
| 17 | **可测试编排（Dependency Injection）** | `createAutopilotEngine({browser, ai, settings, policy, greeting, queue, records, states, events, core, now})`，浏览器与 AI 全部注入 | 整个 Agent 能在 Node 里用内存桩完整驱动（525 个用例） |

---

## 2. 明确**没有**用的（避免学习时误解）

| 没用 | 说明 |
|---|---|
| 多 Agent（Multi-Agent / 角色分工） | 单 Agent + 确定性执行器已足够；多 Agent 只会增加不可控面 |
| ReAct 自由循环 / 无限 tool-calling | 允许模型自由决定下一步在浏览器自动化里太危险；改为固定 step 序列 + 模型只在两个点介入（规划、打分） |
| Reflexion / 自我反思迭代 | 没有"让模型批判自己再重试"的循环；Replan 是**有上限的一次**策略补充，不是反思 |
| 向量库 / RAG / 长期记忆 | 岗位匹配靠结构化打分（JD + 画像），不需要检索增强；跨天只保留事实事件 |
| Fine-tune / 训练 | 全部用 prompt + JSON schema 约束 |
| 视觉浏览器 Agent（截图 → 坐标点击） | 用 DOM 结构与 CSS 选择器（已按真实页面校准），确定性远高于视觉方案 |
| LangChain / LlamaIndex / Agent 框架 | 只有两层：`fetch` 调模型 + 手写编排；依赖少、行为可预测 |
| 验证码绕过 / 反检测 / 代理池 / 多账号 | 明确不做，且写在 PRD 的"非目标"里 |

---

## 3. 架构图

```
┌────────────────────────────── 控制面（Control Plane）──────────────────────────────┐
│  Side Panel（sidepanel.js/html）            Background Service Worker（background.js）│
│  · 目标输入 / Review 审批 / Autopilot 控制台    · 命令接口（9 个 runtime message）      │
│  · 日报查看与导出                            · chrome.alarms 调度（tick / 日报）      │
│  · 只发命令 + 渲染，不参与执行                 · 执行标签管理 / 风险判定 / catch-up     │
└───────────────▲───────────────────────────────────────────┬─────────────────────────┘
                │ chrome.runtime.sendMessage                │ advanceAutopilot()
                │ chrome.storage.onChanged（被动跟随）        ▼
┌────────────────────────────── 编排面（Orchestration）───────────────────────────────┐
│  autopilot-engine.js —— 有界步骤机 advanceAutopilot()                               │
│  PLAN → SEARCH_QUERY → FILTER → FETCH_DETAIL → SCORE → EVALUATE                     │
│      → REPLAN → OUTREACH_CREATE → OUTREACH_EXECUTE → ROUND_END → NEXT_ROUND_PLAN    │
│  依赖注入：browser / ai / settings / policy / greeting / queue / records / states     │
└───────────────┬───────────────────────────┬───────────────────────┬─────────────────┘
                │                           │                       │
                ▼                           ▼                       ▼
┌────── 纪律层（Discipline）──────┐ ┌──── 事实层（Facts）────┐ ┌── 执行层（Hands）──┐
│ autopilot-policy.js（12 条件）   │ │ event-store.js          │ │ content.js          │
│ core-logic.js（硬排除/排序）     │ │  jobAgentEvents:<date>  │ │  scrape/detail/     │
│ settings.js（统一设置+校验）      │ │ job-state.js（12 状态）  │ │  greetFull/health   │
│ action-queue.js（7 状态+幂等）   │ │ action-queue.js         │ │  （确定性 DOM）      │
│                                 │ │ autopilot-runtime.js    │ │                     │
│                                 │ │ daily-report-service.js │ │                     │
└─────────────────────────────────┘ └─────────────────────────┘ └──────────┬──────────┘
                                    ▲                                       │
                      共享内核：discovery-runner.js（纯函数）                  ▼
                                ai-client.js（/plan /replan /score）    BOSS 直聘页面
                                    ▲
                        本机 Node AI 服务（packages/model-client）
                        GET /health /config · POST /plan /replan /score
```

**三个平面各管一件事**：控制面只发命令、编排面只推步骤、事实层只记事实；执行层永远不做判断。

---

## 4. 一次 tick 到底发生了什么（时序）

```
chrome.alarms 触发（或 tabs.onUpdated / 用户命令）
        │
        ▼
background.runTick()                       ← 可重入保护：同一时刻只允许一个 tick
        │  最多循环 MAX_STEPS_PER_WAKE = 3 次
        ▼
engine.advanceAutopilot()
        │
        ├─ loadRuntime()                    ← 状态唯一来源：chrome.storage.local
        ├─ 状态闸门：PAUSED/ERROR/终态 → 直接返回，不做任何浏览器操作
        ├─ 跨天保护：runtime.date !== 今天 → 重置为今天的新 Session
        ├─ 工作时间闸门：超时 → finishOutreach(OUTSIDE_WORKING_HOURS)
        ├─ 取 STEPS[runtime.step] 并执行「一个」step
        │     · 需要浏览器 → deps.browser.search/detail/greet（内部走 content.js 消息）
        │     · 需要模型   → deps.ai.planSearch/replanSearch/scoreJobs（本机 127.0.0.1）
        │     · 需要判断   → deps.policy.evaluateAutopilotGreeting(...)
        └─ patchRuntime({...patch, step: nextStep, lastStepAt})   ← 立即持久化
        ▼
返回 { status, step, advanced, done }；未收工则继续下一步 / 等下一次唤醒
```

关键点：**任何时刻被杀死，最多丢失"当前正在执行的那一步"**，而这一步如果是发送动作，Action 会停在 `executing`，下次恢复时被保守标记为 `requires_manual`（绝不自动重发）。

---

## 5. 为什么必须这么设计（约束 → 设计）

| 现实约束 | 逼出来的设计 |
|---|---|
| MV3 Service Worker 随时被回收、不能长驻 | 有界步骤机 + 每次唤醒最多 3 步 + 每步落盘 + alarm/事件驱动 |
| 平台风控：不能绕过验证码、不能高频刷新 | 风险即 `PAUSED`、单操作最多重试 1 次、连续失败 2 次停 |
| "自动联系真人"是不可逆的外部副作用 | 幂等键 + 动作队列 + 四道闸门 + 授权页 + 每日上限 |
| 用户要能解释"为什么发/为什么停" | 事件溯源 + 决策事件（Policy 拒绝原因、Replan 决策、停止 code） |
| 模型输出不稳定、可能被注入 | 只让模型输出结构化 JSON（Zod 校验）、只生成"计划/分数/新搜索词"，不允许它产生动作 |
| 一个扩展要长期维护、可回归 | 依赖注入 + 纯函数内核 + 内存 chrome 桩（525 个用例，含真实事故回归） |

---

## 6. 学习路线（照着做就能把架构吃透）

**第 1 步：理解"三层分工"**
读 `docs/PRD-v0.5.md` 的 §5 需求清单，再读 `extension/autopilot-policy.js`（77 行）。
实验：改一个条件（比如把 `daily_cap` 改成 `<=`），跑 `npm test`，看哪些用例红了 → 你会理解"为什么规则要集中一处"。

**第 2 步：理解"有界步骤机"**
读 `extension/autopilot-engine.js` 的 `advanceAutopilot()` 与 11 个 `stepXxx()`；再读 `packages/agent-core/src/helpers/autopilot-harness.ts`（测试脚手架）。
实验：`npx vitest run packages/agent-core/src/autopilot-rounds.test.ts`，在测试里把 `maxSteps` 改小，观察"一步一落盘"的效果。

**第 3 步：理解"事件溯源 + 派生状态"**
读 `extension/event-store.js`（幂等索引、按日分区、critical key 永久保留）与 `job-state.js`（12 状态转移守卫）。
实验：在 `packages/agent-core/src/event-store.test.ts` 里加一条断言：清理 30 天前的分区后 `hasEvent({idempotencyKey:'greeting:j-1'})` 仍为 true —— 这是"为什么副作用幂等键不能随数据一起删"的答案。

**第 4 步：理解"命令队列与幂等"**
读 `extension/action-queue.js` 与 `packages/agent-core/src/review-regression.test.ts`（含"伪造 Action 也拦得住""中断后不重发"）。
实验：跑 `npx vitest run packages/agent-core/src/action-queue.test.ts`，逐个看状态机允许/拒绝的转移。

**第 5 步：理解"与 LLM 的契约"**
读 `packages/model-client/src/client.ts`（`temperature: 0`、`response_format: json_object`、失败重试 1 次）、`job-plan.ts`（Planner/Replan 的 prompt 与 Zod schema）、`extension/ai-client.js`（响应归一化）。
实验：`npm run score:serve` 后 `curl -s localhost:8799/health`；再看 `packages/agent-core/src/ai-client.test.ts` 里"`/score` 没有 `ok` 字段"的回归用例。

**第 6 步：理解"可观测性与日报"**
读 `extension/report-builder.js`（纯函数聚合）与 `daily-report-service.js`（snapshot + catch-up + 幂等）。
实验：`npx vitest run packages/agent-core/src/report-builder.test.ts`，改一条事件看日报数字怎么变。

**第 7 步：动手加一个能力**（最好的复习）
例如"新增一个事件类型 + 一个 step + 一条 Policy 条件 + 一条日报字段"，跑 `npm run ci`。
文档末尾的"扩展点"（见 `docs/DESIGN-v0.5.md` §15）给了逐项 checklist。

---

## 7. 想继续深入时可以检索的经典概念

| 概念 | 为什么和本项目相关 |
|---|---|
| Plan-and-Execute / ReAct / Reflexion | 三种主流 Agent 循环范式；本项目的取舍是"Plan-and-Execute + 有界步骤"，你必须能说清为什么不选 ReAct |
| Durable Execution（Temporal、Cadence、AWS Step Functions） | 本项目 `advanceAutopilot()` 的"每步落盘 + 从断点续跑"就是它的轻量版 |
| Event Sourcing / CQRS | 事件只追加、状态由事件派生；理解"事实 vs 视图" |
| Outbox Pattern / Idempotency Key / at-least-once vs exactly-once | 幂等键 + 命令队列 + 重放安全，是"自动联系真人"能安全上线的前提 |
| Saga / 补偿事务 | 多步外部副作用的失败回滚思路（本项目用"标记需人工 + 绝不重发"替代自动补偿） |
| Policy-as-Code（OPA/Rego 思想） | Policy 与执行解耦、可单测、可解释 |
| Human-in-the-Loop / Approval Gate | 高风险动作的审批设计 |
| Least Privilege / Capability-based Security | manifest 权限逐阶段收敛 |
| Tool Use / Function Calling / Skills | 模型只选工具与参数，执行器负责落地 |
| Chrome MV3 生命周期（Service Worker suspend） | 决定了"不能写长驻循环"这条铁律 |

---

## 8. 一句话记住这个架构

> **模型负责"想"，代码负责"做"，规则负责"允不允许"，事件负责"记得住"，用户负责"批不批"。**
> 五者缺一，浏览器里的自动投递就只是一个随时会失控的脚本。
