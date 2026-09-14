# BOSS Job Agent — 设计文档（DESIGN v0.5.0）

| 项 | 值 |
|---|---|
| 版本 | v0.5.0（与实现一致） |
| 状态 | 已实现（Phase 1–4A） |
| 配套 | `docs/PRD-v0.5.md`（需求）、`docs/AGENT-ARCHITECTURE.md`（模式解读与学习路径）、`docs/ARCHITECTURE.md`（V0.1 历史规划，未按该路线实现） |
| 代码规模 | `extension/` 21 个文件 ≈ 8.8k 行；`packages/model-client` ≈ 1.8k 行；测试 48 文件 / 525 用例 |

---

## 1. 设计原则

1. **判断与执行分离**：LLM 只产出结构化判断（计划/分数/新搜索词），浏览器代码只做确定性动作，Policy 统一裁决"允不允许"。
2. **事实只有一个来源**：`chrome.storage.local`。Side Panel 不参与执行，关掉也不影响推进。
3. **有界**：一次唤醒只推进有限步，每步落盘；所有循环都有硬上限（轮次/补搜/额度/时间窗/重试）。
4. **保守恢复**：任何不确定状态都"停下来交还给人"，绝不自作主张重发。
5. **可审计**：关键决策必须落事件，日报可以从事件完全重建。
6. **可测试**：纯函数内核 + 依赖注入 + 内存 chrome 桩，整个 Agent 能在 Node 里完整驱动。
7. **最小权限 / 零构建**：纯 ESM（无打包器），权限逐阶段增加。

---

## 2. 运行时拓扑

```
┌─────────────────────── 用户的 Chrome ───────────────────────┐      ┌──── 本机 Node ────┐
│                                                             │      │                   │
│  BOSS 页面（用户已登录）                                      │      │  score:serve      │
│      ▲  │                                                  │      │  127.0.0.1:8799   │
│      │  │ 确定性 DOM 动作 / 只读抓取                          │      │  /health /config  │
│  ┌───┴──▼─────────┐   chrome.tabs.sendMessage   ┌─────────┐  │      │  /plan /replan    │
│  │ content.js     │ ◄────────────────────────── │background│  │ HTTP │  /score           │
│  │ (Eyes + Hands) │ ──────────────────────────► │  .js     │  │ ───► │      ↓            │
│  └────────────────┘   结构化事实 / 执行结果       │ (SW)     │  │      │  DeepSeek API     │
│                                                 │          │  │      └───────────────────┘
│  ┌────────────────┐   chrome.runtime.sendMessage │ 引擎      │  │
│  │ sidepanel.js   │ ◄──────────────────────────► │ 步骤机    │  │
│  │ (UI / 控制器)   │   chrome.storage.onChanged   └─────────┘  │
│  └────────────────┘                                          │
│                        chrome.storage.local（唯一事实来源）    │
└─────────────────────────────────────────────────────────────┘
```

三方职责：**页面（事实与动作）↔ 扩展（编排与纪律）↔ 本机服务（模型能力）**。模型永远不直接接触页面。

---

## 3. 模块地图

### 3.1 扩展（全部在实际运行路径上）

| 文件 | 行数 | 职责 | 关键导出 |
|---|---|---|---|
| `manifest.json` | — | MV3 清单：权限、SW、content script、side panel | — |
| `background.js` | 502 | **控制面**：命令接口、alarm 调度、执行标签、风险判定、catch-up | `handleCommand` |
| `autopilot-engine.js` | 1407 | **编排面**：有界步骤机 11 步 | `createAutopilotEngine`、`minutesUntilWindowEnd`、`SCORE_BATCH_SIZE` |
| `autopilot-runtime.js` | 249 | 运行时状态（纯 JSON）：状态/步骤常量、读写、跨天重置、log | `AUTOPILOT_STATUS/STEPS`、`loadRuntime/saveRuntime/patchRuntime` |
| `daily-report-service.js` | 202 | 日报：snapshot、幂等生成、catch-up、alarm 时间 | `generateDailyReportOnce`、`catchUpIfNeeded`、`ensureDailyReportAlarm` |
| `report-builder.js` | 365 | 日报聚合（纯函数） | `buildDailyReport`、`STOP_REASON_LABELS` |
| `report-markdown.js` | 124 | 日报 Markdown 渲染（与统计解耦） | `renderDailyReportMarkdown` |
| `event-store.js` | 476 | **事件存储**：按日分区、幂等索引、聚合、retention | `appendEvent(s)`、`getEventsByDate/Job`、`hasEvent`、`pruneEvents` |
| `job-state.js` | 266 | **岗位状态机**：12 状态 + 转移守卫 ± 持久化 | `STATES`、`TRANSITIONS`、`setJobState`、`ensureJobState` |
| `action-queue.js` | 469 | **动作队列**：7 状态、payload 固化、幂等、中断恢复 | `createGreetingActions`、`approveActions`、`markExecuting/Success/Failed`、`recoverInterruptedActions` |
| `agent-records.js` | 343 | 统一记录 helper：事件 + 状态 + legacy 兼容 | `recordGreetingSuccess/Failure`、`recordJobsDiscovered/Scored/Shortlisted`、`getDailyGreetingCount` |
| `autopilot-policy.js` | 77 | **Policy 引擎**：12 条件短路判定 | `evaluateAutopilotGreeting`、`previewAutopilotDecisions` |
| `settings.js` | 222 | 统一设置 + 钳制 + legacy 迁移 + 授权状态机 | `DEFAULT_SETTINGS`、`loadSettings/saveSettings`、`recordAutopilotConsent` |
| `discovery-runner.js` | 392 | **共享内核（纯函数）**：URL/dedupe/过滤/详情目标/评分合并/Replan 合并/轮次决策/Eligible 判定 | `filterAutopilotEligible`、`decideReplanForCandidates`、`detailBudgetForTarget`、`buildResultSummary` |
| `ai-client.js` | 193 | **共享 AI 客户端**：/plan /replan /score /health + 响应归一化 + 错误翻译 | `planSearch`、`replanSearch`、`scoreJobs`、`normalizeScoreResponse` |
| `greeting-builder.js` | 56 | 话术构建（Review/Autopilot 共用，发送前固化） | `buildGreetingMessage` |
| `core-logic.js` | 219 | 纪律层纯函数：城市解析、硬过滤、排序、详情目标、打招呼闸门 | `resolveBossContext`、`hardFilter`、`canGreet`、`hhmm` |
| `content.js` | 481 | **执行面**：只读抓取 + 确定性点击/填写 | 消息：`scrape / detailScrape / greetFull / greet / bossContext / pageHealth / diagnose` |
| `tab-messaging.js` | 121 | **可靠通信**：等 content script 就绪、可重试错误分类与翻译、reload 兜底（有硬上界） | `waitForContentReady`、`sendMessageReliably`、`isRetryableMessageError`、`friendlyMessageError` |
| `sidepanel.js` / `.html` / `.css` | 1670 / 260 / 154 | **UI**：目标输入、Review 审批、Autopilot 控制台、运行状态、日报查看与导出 | — |
| `popup.js` / `popup.html` | 95 | 轻量启动器（打开 Side Panel） | — |
| `auto.js` / `auto.html` | 425 | V0.3 Legacy 调试台（不参与 V0.5 流程） | — |

### 3.2 packages

| 包 | 是否在 V0.5 运行路径 | 说明 |
|---|---|---|
| `model-client` | ✅ 是 | 本机 AI 服务：`server.ts`（HTTP）+ `client.ts`（DeepSeek 调用，`temperature:0`、json_object、失败重试 1 次）+ `job-plan.ts`（Planner/Replan prompt 与 Zod schema）+ `score.ts`（打分 schema/画像/门槛）+ `classify.ts`（HR 意图规则，Phase 5 会用到） |
| `agent-core` | 测试用 | V0.1 状态机/仓库等 + **V0.5 全部测试宿主**（`packages/agent-core/src/*.test.ts`，含内存 chrome 桩与引擎脚手架） |
| 其他 11 个包（`browser-runtime`、`platform-*`、`sqlite-store`、`dsh-integration`、`conversation-policy`、`daily-reporter`、`domain`、`job-matcher`、`config-loader`、`harness-profile`） | ❌ 否 | V0.1 规划的脚手架/原型（SQLite 路线、平台适配器、DSH 工具清单）。保留作为参考与测试语料来源，**不在扩展运行路径上**；扩展是零依赖纯 ESM，不 import 任何 package |

> 学习者请注意：`docs/ARCHITECTURE.md` / `DATA_MODEL.md` / `TOOL_SPEC.md` 描述的是上面这一列"❌"的设计。当前实现见本文档。

---

## 4. 控制面：Background Service Worker

### 4.1 消息协议（Side Panel → SW）

| 命令 | 语义 | 返回 |
|---|---|---|
| `START_AUTOPILOT{goal}` | 启动前重跑全部校验，写 runtime + `AUTOPILOT_STARTED` | `{ok, status, reason?, code?, windowWarning?}` |
| `PAUSE_AUTOPILOT` | 立即持久化 PAUSED（`USER_PAUSED`）+ 事件 | `{ok, status}` |
| `RESUME_AUTOPILOT` | 重新校验；通过则继续，否则保持 PAUSED 并给 reason | `{ok, status?, code?, reason?}` |
| `STOP_AUTOPILOT` | 结束今天这次 Session（保留全部历史） | `{ok, status}` |
| `GET_AUTOPILOT_STATUS` | 面板轮询/刷新用汇总 | `{status, step, roundIndex, currentQuery, recommended, eligible, roundTarget, todayGreetingCount, queue, jobStates, log…}` |
| `GET_DAILY_REPORT{date?, preview?}` | 有正式快照就返回快照，否则实时预览 | `{source:'snapshot'|'preview', report}` |
| `CATCH_UP_DAILY_REPORT` | 时间感知补生成（幂等） | `{generated, reason}` |
| `GENERATE_DAILY_REPORT{date?}` | 显式生成正式日报（测试/未来手动按钮） | `{created, source, report}` |
| `GET_DAILY_REPORT_STATUS` | 开关/时间/catch-up 状态/快照列表 | `{enabled, reportTime, catchUp, snapshots}` |
| `ADVANCE_AUTOPILOT{steps?}` | **仅调试**：手工推进 tick | `{steps, last}` |

### 4.2 调度

| 调度源 | 名称/条件 | 作用 |
|---|---|---|
| `chrome.alarms` | `jobAgentAutopilotTick`（周期 1 分钟，仅有活跃 Session 时存在） | 兜底推进 |
| `chrome.alarms` | `jobAgentAutopilotTick-soon`（0.5 分钟后一次性） | 命令后快速推进 |
| `chrome.alarms` | `jobAgentDailyReportAlarm`（一次性 `when`=下一次 `dailyReportTime`） | 18:00 生成日报 |
| `chrome.tabs.onUpdated` | 执行标签 `status==='complete'` | 导航完成立即推进 1 步（事件驱动，非轮询） |
| `chrome.runtime.onStartup/onInstalled` | 浏览器启动 / 扩展安装 | 恢复中断 Action + 日报 catch-up + 排 alarm + 推进 1 步 |
| 用户命令 | 见 4.1 | 立即响应；START/RESUME 后安排快速 tick |

- 每次唤醒：`runTick({steps: MAX_STEPS_PER_WAKE = 3})`，**可重入保护**（模块级 `ticking` promise）。
- 每步之间必定 `patchRuntime()`；任何时刻被杀死最多丢失"当前这一步"。

### 4.3 执行标签策略
- 只维护**一个** `autopilotTabId`（`chrome.tabs.create({active:false})`，不抢占用户当前标签）；
- 标签丢失 → 重建**一次**；仍失败 → `tabFailureCount++` 并返回 `AUTOPILOT_TAB_UNAVAILABLE`（启动失败 / 运行中暂停），**绝不无限重建**；
- 所有页面动作通过 `chrome.tabs.sendMessage` 发给 `content.js`；background 里没有一处 `querySelector`/`document.`。

### 4.4 风险判定（启发式但确定）
只用**事实**判断：URL 是否命中 `captcha|geetest|/safe/|verify|security-check` → `CAPTCHA`；`/web/user/|/login|登录` → `LOGIN_REQUIRED`；标题含 风险/异常/限制 → `RISK_PAGE`；搜索页 `cardCount===0` → `BROWSER_CONTEXT_INVALID`。
`pageHealth` 由 `content.js` 提供（URL / title / readyState / cardCount），**不做新的选择器猜测**。

---

## 5. 编排面：有界步骤机

### 5.1 状态与步骤常量

```
AUTOPILOT_STATUS: IDLE | PLANNING | DISCOVERING | SCORING | OUTREACH |
                  OUTREACH_COMPLETE | MONITORING | PAUSED | STOPPED | ERROR
AUTOPILOT_STEPS : NONE | PLAN | SEARCH_QUERY | FILTER | FETCH_DETAIL | SCORE |
                  EVALUATE | REPLAN | OUTREACH_CREATE | OUTREACH_EXECUTE |
                  ROUND_END | NEXT_ROUND_PLAN | FINISH
```

### 5.2 各步骤定义

| step | 一次做了什么（bounded） | 依赖 | 产出/持久化 | 下一步 |
|---|---|---|---|---|
| `PLAN` | 调 `/plan`；城市冲突检查；关键词绑定当前城市；去重 | ai, browser.getContext, events | `goal/currentPlan/hardExclusions/roundIndex=1` + `DISCOVERY_ROUND_STARTED` | `SEARCH_QUERY` |
| `SEARCH_QUERY` | **一个**查询：导航 + `scrape` | browser.search | `roundDiscovered` 合并、`searchedQueries`、`currentQueryIndex++`、`currentRoundStats` | 还有查询→`SEARCH_QUERY`；否则 `FILTER` |
| `FILTER` | 硬过滤 + 跨轮 seen 去重 + 选详情目标（预算 `clamp(target×3,5,15)`） | core.hardFilter | `roundQualified`、`seenJobIds`、`detailTargets` + `JOB_DISCOVERED` 事件（Job State `DISCOVERED`） | 有目标→`FETCH_DETAIL`；否则 `SCORE` |
| `FETCH_DETAIL` | **一个**岗位详情：导航 + `detailScrape` | browser.detail | `detailBuffer`、`fetchedDetailIds`、`currentDetailIndex++` | 攒够 5 个未评分→`SCORE`；否则 `FETCH_DETAIL` |
| `SCORE` | **一批**（≤5）打分：只发未评分岗位 | ai.scoreJobs | `scoredBuffer` 合并 + `JOB_SCORED`（Job State `SCORED`）；若 `Eligible ≥ Target` 则 `detailsStoppedEarly=true` | 有剩余批次→`SCORE`；有未抓详情→`FETCH_DETAIL`；否则 `EVALUATE` |
| `EVALUATE` | 计算 Recommended（≥75）与 **Autopilot Eligible**（≥阈值+未硬排除+未联系+信息完整+话术可用） | settings, records, greeting, discovery-runner | `recommendedJobIds`、`eligibleJobIds`、`currentRoundStats`、拒绝原因样本 + `JOB_SHORTLISTED` | `decideReplanForCandidates`：达标→`OUTREACH_CREATE`；不足且未用尽→`REPLAN` |
| `REPLAN` | 调 `/replan`（携带 eligible/target/阈值/轮次/拒绝原因）；只允许新增关键词（同城去重、≤4 个） | ai.replanSearch | `currentPlan.queries` 追加、`replanCount++` + `REPLAN_DECIDED` | 有新词→`SEARCH_QUERY`；否则 `OUTREACH_CREATE` |
| `OUTREACH_CREATE` | 取 **Eligible** 候选，按 `min(剩余额度, 20)` 逐个 Policy 判定 → 批量创建 Action（pending，固化话术） | policy, greeting, queue, records | `outreachQueue`、`actionsCreatedFor` + `ACTION_CREATED`；被拒写 `ACTION_SKIPPED{source:'policy'}` | `OUTREACH_EXECUTE` |
| `OUTREACH_EXECUTE` | **一条** Action：pending→（执行前 Policy 复核）→`approved`（本 tick 结束）；下个 tick：`executing` → `greetFull` → 记账 | policy, queue, browser.greet, records | 成功 `GREETING_SENT`+`GREETED`+`markSuccess`；失败 `GREETING_FAILED`+`markFailed`；风险→`markRequiresManual`+PAUSED | 队列空→`ROUND_END`；否则 `OUTREACH_EXECUTE` |
| `ROUND_END` | 写 `DISCOVERY_ROUND_COMPLETED`（含全部轮次指标）；按 4 条规则决定继续/收工 | events, settings | round 事件；继续→下一轮缓冲清空 | `NEXT_ROUND_PLAN` 或 `FINISH` |
| `NEXT_ROUND_PLAN` | 用全天 `searchedQueries` 调 `/replan` 拿新一轮关键词；拿不到→收工 | ai.replanSearch | `roundIndex++`、`currentRoundStats` 重置 + `DISCOVERY_ROUND_STARTED` + `REPLAN_DECIDED{source:'next-round'}` | `SEARCH_QUERY` 或 `FINISH` |

**收工判定（优先级顺序）**：`今日已联系 ≥ 上限` → `轮次 ≥ maxDiscoveryRounds` → `超出工作时间` → `本轮无新候选且无新搜索空间` → 否则继续下一轮。

### 5.3 每步的通用闸门（`advanceAutopilot` 开头）
1. 终态/PAUSED/ERROR → 直接返回，不做任何外部动作；
2. 跨天 → 重置为今天的新 Session；
3. 超出工作时间 → `finishOutreach(OUTSIDE_WORKING_HOURS)`；
4. 执行 step；异常 → 记 `lastError` 并保持原 step（下次重试）；
5. `pause` 分支 → 写 PAUSED + 事件；`toolFailure` 分支 → 计数，达 2 次 → PAUSED；
6. 正常分支 → 应用 patch、写 `step`、清 `consecutiveToolFailures`。

---

## 6. 数据面

### 6.1 存储键

| 键 | 结构 | 保留 |
|---|---|---|
| `jobAgentEvents:<YYYY-MM-DD>` | `StoredEvent[]`（按本地日期分区） | 30 天 |
| `jobAgentEventMeta` | `{version, retentionDays, dates:{date:count}, totalEvents, lastPrunedAt}` | — |
| `jobAgentIdempotency` | `{ [idempotencyKey]: {eventId, date, type, jobId, critical, pruned?} }` | 普通键随分区清理；**critical 永久** |
| `jobAgentJobStates` | `{ [jobId]: {jobId, state, company, jobTitle, firstSeenAt, updatedAt, transitions[≤20]} }` | 180 天（手动 prune） |
| `jobAgentActions` | `AgentAction[]`（≤300，未完成永不清理） | 终态 30 天 |
| `jobAgentAutopilotRuntime` | 运行时单对象（见 6.5） | 永久（跨天重置内容） |
| `jobAgentSettings` | 统一设置（见 PRD §FR-SET） | 永久 |
| `jobAgentDailyReport:<date>` | `{date, generatedAt, version, report}` | 永久 |
| legacy：`greet-<date>` / `greetedHistory` / `dailyCap` / `greetText` | 旧格式 | 只读兼容 + 写双份 |

### 6.2 事件 schema 与目录

```ts
StoredEvent { eventId, timestamp(ISO), type, jobId|null, company|null, jobTitle|null, metadata, idempotencyKey|null }
```

| 事件 | 何时写 | metadata 关键字段 |
|---|---|---|
| `JOB_DISCOVERED` | FILTER 后（通过硬过滤） | round, mode, salary, city, tags, **href** |
| `JOB_SCORED` | 每批打分后 | mode, score, tier, **href** |
| `JOB_SHORTLISTED` | EVALUATE（AI 推荐 ≥75） | mode, score, href |
| `DISCOVERY_ROUND_STARTED` | PLAN / NEXT_ROUND_PLAN | roundIndex, queries, city |
| `DISCOVERY_ROUND_COMPLETED` | ROUND_END | roundIndex, searchedQueries, discoveredCount, newDiscoveredCount, filteredCount, analyzedCount, recommendedCount, eligibleCount, roundTarget, replanCount, city |
| `REPLAN_DECIDED` | 每次补搜决策（含"无需补充"） | roundIndex, decision, reason, addedQueries, eligibleCount, targetCandidates, minimumAutoGreetingScore, source |
| `ACTION_CREATED` | 创建 Action | actionId, actionType, mode, score, templateId, messageLength |
| `ACTION_APPROVED` / `ACTION_SKIPPED` / `ACTION_REQUIRES_MANUAL` | 状态迁移 | actionId, actionType, status, reason? |
| `GREETING_SENT` | 发送成功 | message, messageStrategy, templateId, messageLength, score, actionId, mode, **roundIndex** |
| `GREETING_FAILED` | 发送失败 | error, stage, actionId, mode |
| `AUTOPILOT_STARTED` | START 成功 | sessionId, date, city, cityCode, dailyGreetingCap, todayGreetingCount, maxDiscoveryRounds |
| `AUTOPILOT_PAUSED` | 任何暂停 | reason, code, activeActionId, roundIndex |
| `AUTOPILOT_RESUMED` | Resume 成功 | sessionId, roundIndex, step |
| `AUTOPILOT_STOPPED` | 用户 Stop | sessionId, roundIndex, todayGreetingCount |
| `AUTOPILOT_OUTREACH_COMPLETE` | 收工 | sessionId, reason, **code**, roundIndex, todayGreetingCount |
| `DAILY_REPORT_GENERATED` | 正式日报 | date, summary, outreach, rounds, hasActivity, reportVersion |
| 控制面 | 设置/授权变更 | `MODE_CHANGED` / `CONSENT_GRANTED` / `CONSENT_REVOKED` / `SETTINGS_UPDATED` |
| 预留（未写） | Phase 5+ | `RESUME_REQUESTED` / `RESUME_SENT` / `HR_REPLIED` / `NEEDS_MANUAL_REPLY` / `INTERVIEW` / `REJECTED` / `OFFER` |

### 6.3 岗位状态机（`job-state.js`）

```
DISCOVERED → FILTERED | SCORED
SCORED     → SHORTLISTED | REJECTED
SHORTLISTED→ GREETED | REJECTED
GREETED    → HR_REPLIED | REJECTED
HR_REPLIED → RESUME_REQUESTED | NEEDS_MANUAL_REPLY | INTERVIEW | REJECTED
RESUME_REQUESTED → RESUME_SENT | NEEDS_MANUAL_REPLY
NEEDS_MANUAL_REPLY → HR_REPLIED | RESUME_SENT | INTERVIEW | REJECTED
RESUME_SENT→ INTERVIEW | REJECTED | OFFER
INTERVIEW  → OFFER | REJECTED        REJECTED / OFFER = 终态
```
V0.5 实际只用到前四个 + `GREETED`；后段为 Phase 5/6 预留。
`ensureJobState()` 只沿合法路径补齐（首次记录从 `DISCOVERED` 起算），非法跳转**不写脏数据**。
`GREETING_FAILED` **不在事件→状态映射表**里：失败绝不等于 GREETED。

### 6.4 动作队列（`action-queue.js`）

```
pending → approved → executing → success
   │          │           ├─────→ failed
   │          └→ skipped  └─────→ requires_manual
   └→ skipped
```
- 阻塞态：`pending/approved/executing/success`（同键不再创建；`failed` 允许重试）；
- payload 固化：`{score, message, messageStrategy, templateId, href}`；
- `recoverInterruptedActions()`：`executing` → `requires_manual`（保守）；
- `pruneActions()`：未完成永不清理，终态 30 天 / 最多 300 条。

### 6.5 Runtime 字段（节选）

```
version, sessionId, date, status, step,
rawGoal, goal, browserContext, cityConflictWarning,
roundIndex, maxDiscoveryRounds, maxReplanPerRound, batchQualifiedTarget,
dailyGreetingCap, minimumAutoGreetingScore, workingHours,
currentPlan{goal,queries,successCriteria}, hardExclusions,
searchedQueries[], currentQueryIndex, replanCount,
currentRoundStats{roundIndex,searchedQueries,discoveredCount,newDiscoveredCount,filteredCount,
                  analyzedCount,recommendedCount,eligibleCount,roundTarget,replanCount},
roundDiscovered[], roundQualified[], detailTargets[], currentDetailIndex, detailBuffer[], scoredBuffer[],
recommendedJobIds[], eligibleJobIds[], eligibleRejectSamples[], detailsStoppedEarly,
outreachQueue[], actionsCreatedFor[], seenJobIds[], fetchedDetailIds[],
todayGreetingCount, activeActionId, paused, pauseReason,
autopilotTabId, tabFailureCount, consecutiveToolFailures, lastRisk,
startedAt, completedAt, updatedAt, lastStepAt, lastError, log[≤40]
```

### 6.6 事件目录的幂等键规范

| 语义 | 键 |
|---|---|
| 岗位发现 / 评分 / 入选 | `discovered:<jobId>` / `scored:<jobId>` / `shortlisted:<jobId>:<date>` |
| 打招呼（副作用，critical） | `greeting:<jobId>`（永久保留） |
| 打招呼失败 | `greeting-failed:<actionId>` |
| 轮次开始 / 结束 | `round-started:<sessionId>:<n>` / `round-completed:<sessionId>:<n>` |
| 补搜决策 | `replan:<sessionId>:<round>:<source>:<count>` |
| Session / 收工 / 日报 | `autopilot-started:<sessionId>` / `outreach-complete:<sessionId>` / `report:<date>` |

---

## 7. 幂等与一致性设计

**为什么需要**：发送消息是**不可逆的外部副作用**，而执行环境（MV3 SW）随时可能被中断。

四道闸门（缺一不可）：

1. **创建前**：Action 阻塞态同键存在 → 不创建；`GREETING_SENT` 事件存在 → 不创建；legacy `greetedHistory` 命中 → 不创建；
2. **执行前**：`hasGreeted(jobId)`（事件 + 历史）再查一次；命中 → `markSkipped`；
3. **写入时**：`appendEvent` 幂等键命中 → 不写事件、不再加计数（`recordGreetingSuccess` 返回 `duplicate:true`）；
4. **中断恢复**：`executing` 的 Action 一律 `requires_manual`，**绝不自动重发**。

配套设计：
- **写锁**：`event-store`/`job-state`/`action-queue` 各有一个模块级 Promise 串行链，避免读-改-写丢更新；
- **critical 幂等键永久保留**：30 天清理后，"这个岗位已打过招呼"这个事实依然成立（否则清理 ⇒ 重复打扰真人）;
- **`eventId` 全局唯一**（`evt_<base36 时间>_<rand>`）；日报聚合同时按"事件唯一性"和"jobId"两重去重，重放/导入不会让指标翻倍。

---

## 8. Policy 引擎（12 条件）

| 顺序 | 条件 id | 判定 | 失败原因（人类可读） |
|---|---|---|---|
| — | `no_captcha` | 非验证码页 | 检测到验证码/风险页面（**短路 + shouldPause**） |
| — | `boss_healthy` | 页面状态正常 | BOSS 页面状态异常（**短路 + shouldPause**） |
| 1 | `mode_autopilot` | `settings.mode==='autopilot'` | 当前不是 Autopilot 模式 |
| 2 | `consent` | `consent.autopilot===true` | 用户尚未授权 Autopilot |
| 3 | `template_valid` | 话术校验通过 | 打招呼话术无效 |
| 4 | `not_paused` | 未暂停 | Agent 处于暂停状态 |
| 5 | `within_working_hours` | 在时间窗内 | 当前不在工作时间内（附区间） |
| 6 | `score_threshold` | `score ≥ minimumAutoGreetingScore` | 分数低于阈值 N |
| 7 | `no_hard_exclusion` | 未命中硬排除 | 命中硬排除：X |
| 8 | `not_greeted_before` | 此前未联系过 | 该岗位此前已联系过 |
| 9 | `daily_cap` | `dailyDone < dailyGreetingCap` | 已达今日上限 N |
| 10 | `job_complete` | 岗位信息完整 | 岗位信息不完整（缺 jobId 等） |

- **短路语义**：条件按固定顺序求值，首个失败项即原因，之后不再评估（`checks` 只保留已执行部分，便于审计"为什么停在这里"）；
- **两次校验**：`OUTREACH_CREATE`（创建前，`dailyDone` 计入本批已计划名额）与 `OUTREACH_EXECUTE`（执行前，读数可能已变）；
- 缺输入一律 **fail-closed**（拒绝）。

---

## 9. 共享内核：Review 与 Autopilot 如何共用

| 层 | 共享方式 |
|---|---|
| AI 调用 | 同一个 `ai-client.js`（HTTP 细节只存在于此；响应归一化：`/score` 成功无 `ok` 字段也判为成功） |
| 纯逻辑 | 同一个 `discovery-runner.js` + `core-logic.js`（URL 构造、dedupe、硬过滤、详情目标、评分合并、Replan 合并、结果摘要、Eligible 判定） |
| 事实与状态 | 同一套 `event-store / job-state / action-queue / agent-records` |
| 发送动作 | 同一个 `content.js greetFull` |
| **编排循环** | **各自拥有**：Review 在 Side Panel（用户驱动），Autopilot 在 SW（事件驱动）——测试断言禁止出现 `autopilotSearch/Score/Replan` 这类第二套实现 |

---

## 10. 与 LLM 的契约

| 接口 | 请求 | 响应 | 归一化/防御 |
|---|---|---|---|
| `POST /plan` | `{goal, context:{cityName, cityCode}}` | `{ok:true, plan:{goal, queries, successCriteria, mentionedCities, warnings}}` | `normalizePlan`：城市以 Browser Context 为准、关键词去重且 ≤6、soft 不得混入 hard |
| `POST /replan` | `{goal, searchedQueries, resultSummary, replanCount}` | `{ok:true, status:'continue'|'complete', reason, newQueries}` | 程序守卫：Autopilot 语义用 `eligibleCount/targetCandidates`（给了才用），否则退回 V0.4 的"≥75 数量 ≥ targetQualifiedJobs"；只允许新增关键词 |
| `POST /score` | `{jobs[], salaryMinK, goalContext}` | **`{results:[…]}`（没有 `ok`）** | `normalizeScoreResponse`：有 `results` 数组即成功；失败从 `error/reason/message/detail` 取原因并翻译（402/超时/未启动） |
| `GET /health` | — | `{ok:true, version:'0.5.0'}` | 面板徽标显示版本 |

模型调用参数：`temperature: 0` + `response_format:{type:'json_object'}` + Zod 校验 + 失败重试 1 次；**模型不产生任何动作**。

---

## 11. 日报子系统

```
event-store（当日分区） ┐
job-state（当前状态）    ├─→ report-builder.buildDailyReport()  → 结构化 report
runtime（finalStatus）   ┘                                        ├→ Side Panel HTML 渲染
settings（cap/时间）                                              ├→ renderDailyReportMarkdown（导出/未来 Email）
                                                                  └→ snapshot: jobAgentDailyReport:<date>
```

**聚合规则（全部 deterministic）**

| 指标 | 来源 | 去重 |
|---|---|---|
| discovered / analyzed / recommended / contacted | `JOB_DISCOVERED` / `JOB_SCORED` / `JOB_SHORTLISTED` / `GREETING_SENT` | 事件唯一性（幂等键或 eventId）+ jobId |
| greetingFailed | `GREETING_FAILED` | 同上 |
| discoveryRounds / 每轮指标 | `DISCOVERY_ROUND_COMPLETED.metadata` | 同上 |
| searchQueries | 各轮 `searchedQueries` | `city|keyword` 去重，只含真实执行过的 |
| replans | `REPLAN_DECIDED` 计数 | 回退：round metadata 的 `replanCount` |
| dailyCap | `AUTOPILOT_STARTED.metadata.dailyGreetingCap`（无 Session 用 settings） | — |
| stopReason | `OUTREACH_COMPLETE.code` → `STOPPED`→USER_STOPPED → `PAUSED`→AUTOPILOT_PAUSED → `IN_PROGRESS` / `NO_SESSION` | 映射为人类可读 |
| 每轮联系数 | `GREETING_SENT.metadata.roundIndex` | 老数据回退时间窗（第 N 轮打招呼发生在其 ROUND_END 之前） |
| mode 拆分 | `GREETING_SENT.metadata.mode` | 有一条缺失则整体不拆 |
| Top/Remaining | `JOB_SCORED ∪ JOB_SHORTLISTED` | 减去已联系；`≥75` 且非 `REJECTED` |

**明确不存在**的字段：`hrReplied / hrReplies / resumeSent / resumeRequested / interview(s)`（测试断言），改为 `system.capabilities = {hrReplyMonitoring:false, resumeMonitoring:false, interviewTracking:false}` 并在 UI/Markdown 单列「尚未监测」。

**幂等与 catch-up**：快照存在 → 直接返回；事件已存在但快照丢失 → 只补快照；`shouldCatchUp` 检查开关/时间/是否已生成；触发点 = alarm / startup / onInstalled / 面板打开 / START_AUTOPILOT。

---

## 12. 安全与权限设计

| 维度 | 设计 |
|---|---|
| 权限 | `storage / tabs / sidePanel / alarms / downloads`；host 仅 `*.zhipin.com` + 本机；测试断言不存在 notifications/unlimitedStorage/scripting/webRequest/cookies/history |
| 数据 | 全部落在本机 `chrome.storage.local`；API Key 只在 `.env`；仓库不含简历/Cookie/凭据（`npm run scan:redline`） |
| 动作边界 | 只做"打招呼"这一类低风险外部动作；不点任何其他按钮、不改页面 DOM、不提交表单 |
| 平台风控 | 无绕过/反检测/代理；风险页即停；单操作重试 ≤1；连续失败 ≥2 即停 |
| 人为闸门 | Review 二次确认（展示话术）；Autopilot 授权页（展示完整话术）+ Pause/Stop 随时可用 |
| 额度 | 每日上限 + 每轮候选目标 + 轮次上限 + 工作时间窗 + 详情预算 |

---

## 13. 测试策略

| 层 | 手段 | 代表文件 |
|---|---|---|
| 纯函数 | 直接断言边界与钳制 | `autopilot-settings.test.ts`、`discovery-runner.test.ts`、`job-state.test.ts`、`autopilot-policy.test.ts` |
| 存储/幂等 | 内存 chrome 桩（`helpers/chrome-stub.ts`） | `event-store.test.ts`、`action-queue.test.ts`、`daily-report-service.test.ts` |
| 编排 | 依赖注入的引擎脚手架（`helpers/autopilot-harness.ts`）+ 假浏览器/假 AI，`runUntil(predicate)` 驱动 | `autopilot-start/rounds/recovery/scoring/eligibility/convergence/hours.test.ts` |
| 契约 | `fetch` 打桩复刻服务端真实响应形状 | `ai-client.test.ts`、`replan-autopilot.test.ts` |
| 胶水 | 假 chrome API 真 import `background.js` 跑命令 | `background-glue.test.ts` |
| 结构/静态 | 源码断言（权限集合、无长驻循环、Review 发送顺序、面板按模式显示） | `extension-manifest.test.ts`、`sidepanel-mode-ui.test.ts`、`review-regression.test.ts` |

**回归锁住真实事故**：`/score` 无 `ok` 字段被当失败、`/replan` 硬编码守卫、日志显示 UTC、面板打开提前生成日报、SCORE 分批后重复付费、Round 1 无 eligible 却 Replan。

---

## 14. 已知技术债与限制

| 项 | 说明 |
|---|---|
| 节奏偏慢 | 每 tick ≤3 步 + 页面等待（搜索 3s、详情/打招呼 4.2s）+ alarm 最小间隔 → 一轮十几分钟；靠"事件驱动 + 提前收敛 + 详情预算"缓解 |
| Chrome 必须在运行 | 关闭期间不推进；日报靠 catch-up |
| 风险检测是启发式 | 只看 URL/标题/卡片数（且优先用 `tabs.get` 的 url/title，**不依赖 content script**）；iframe 内验证码可能漏检（打招呼失败 2 次后才会暂停） |
| 页面就绪依赖轮询 | 详情/打招呼走"导航 → 等 content script 就绪（≤20×800ms）→ 发消息（失败重试 3 次 + 一次 reload 兜底）"；极端慢页面仍可能超时并计入工具失败 |
| 失败分两类处理 | **传输级**（消息通道断/内容脚本未注入）→ 计工具失败，连续 2 次 PAUSED；**页面级**（内容脚本正常返回但该页解析失败/内容为空）→ 只跳过该岗位继续（记入 `skippedDetailJobs`），连续 3 个页面级失败才 PAUSED（说明页面结构可能已变化） |
| 候选池不跨天 | 日报的"今日未联系高质量候选"隔天不再保留 |
| 历史事件字段缺失 | 旧事件的 `href/roundIndex/mode` 缺失时降级渲染（不猜） |
| `eligible` 需新数据 | Phase 3 修复前的轮次没有该字段，日报不显示该行 |
| 单机单账号 | 无云同步、无多账号（设计如此） |
| 包内脚手架 | `packages/` 里 11 个 V0.1 包不在运行路径上，后续可归档以降低认知负担 |

---

## 15. 扩展点（怎么加新能力）

| 想加什么 | 步骤 |
|---|---|
| **新事件类型** | ① `event-store.EVENT_TYPES` 加常量；② 在产出点 `appendEvent`（给幂等键）；③ 若影响岗位状态，在 `job-state.EVENT_TO_STATE` 加映射；④ 若进日报，在 `report-builder` 聚合；⑤ 加测试 |
| **新 step** | ① `AUTOPILOT_STEPS` 加常量；② 写 `stepXxx(rt)` 返回 `{patch, nextStep}` 或 `{pause}`/`{toolFailure}`/`{finish}`；③ 注册到 `STEPS`；④ 在测试脚手架里驱动 |
| **新 Policy 条件** | ① `autopilot-policy.evaluateAutopilotGreeting` 里 `add(id, ok, reason)`；② 更新 PRD §FR-RISK/§8 条件表；③ 加"单条不满足即拒绝"的用例 |
| **新设置项** | ① `settings.DEFAULT_SETTINGS` + `normalizeSettings` 钳制；② Side Panel 表单字段；③ `fillSettingsForm/readSettingsForm`；④ 用例覆盖非法值回退 |
| **新日报字段** | ① `report-builder` 聚合（纯函数，优先用事件）；② `renderDailyReportMarkdown` 与 Side Panel HTML 各加渲染；③ 用例；④ 若无可靠数据源，宁可不显示并写明"未监测" |
| **新平台（如猎聘）** | ① 新增 `content-<platform>.js` 提供同一组消息语义（scrape/detail/greet/health）；② manifest 增加对应 host；③ engine 里把 URL/选择器细节继续留在 content（engine 不感知平台）；④ Browser Context 的城市解析需按平台实现 |
| **Email 日报（Phase 4B）** | ① `renderDailyReportHtml(report)`（新增）；② 本机服务加 `POST /notify/email`（Nodemailer，密钥只读 `.env`）；③ SW 在正式生成后调用；④ 失败只写 `REPORT_EMAIL_FAILED`，不影响本地日报；⑤ 打开 `emailReportEnabled` 开关（当前强制 false） |
| **HR 监测（Phase 5）** | ① 先在真实页面跑 `chatDiagnose` 校准（**禁止猜选择器**）；② 新建 `inbox-monitor.js` 复用 Event Store/Job State；③ 只扫已联系的会话、去重、只读不回复；④ 新增 `HR_REPLIED` 等事件与状态迁移；⑤ 再考虑 Resume Intent（双确认门，precision ≥0.95） |

---

## 16. 快速索引：想改 X 该看哪里

| 需求 | 文件 |
|---|---|
| 调整"什么时候算达标、什么时候停搜" | `discovery-runner.decideReplanForCandidates` + PRD §FR-REPLAN |
| 调整 Autopilot 能否发送 | `autopilot-policy.js`（改条件）+ PRD §8 |
| 调整默认额度/阈值/轮次 | `settings.DEFAULT_SETTINGS` |
| 调整搜索节奏/详情预算/评分批量 | `autopilot-engine.js`（`SCORE_BATCH_SIZE`、`detailBudgetForTarget`） |
| 调整日报内容 | `report-builder.js` + `report-markdown.js` + `sidepanel.js` 渲染 |
| 调整界面显示规则 | `sidepanel.js renderModeUi/renderAgentStatePanel/refreshAutopilotStatus` |
| 调整页面动作 | `content.js`（改前必须先在真实页面校准） |
| 排查"为什么没发/为什么停" | `jobAgentEvents:<今天>`（看 `ACTION_SKIPPED.reason`、`AUTOPILOT_PAUSED.code`、`OUTREACH_COMPLETE.code`） |
