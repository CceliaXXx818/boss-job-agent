# Changelog

本项目遵循语义化版本。日期为本地发布日期。

## [0.5.0] — 2026-09-13

第一次让 Agent 在明确纪律下**自己跑一天**，并把一天的过程变成可审计的数据与日报。

### 新增：双模式

- **Review Mode（默认）**：搜索 / 打分 / 推荐，打招呼必须由用户勾选并确认（V0.4 行为保持不变）
- **Autopilot**：在阈值、每日上限、候选目标、工作时间内自动搜索与联系
  - 首次开启必须完成授权（授权页明示"会做什么 / 不会做什么 / 将自动发送的完整话术"）；切回 Review 即撤销授权
  - 支持 `Start / Pause / Resume / Stop`；Pause 后不再发起新的搜索与打招呼
  - 切换模式才显示 Autopilot 设置 / 话术 / Policy 试算 / 控制台 / 运行状态

### 新增：事件驱动编排

- **Background Service Worker**：`advanceAutopilot()` 每次只推进一个 bounded step，每步立即落盘；
  每次唤醒最多 3 步，用 `chrome.alarms` + `tabs.onUpdated` 驱动，没有 `while(true)` / 长驻 timer
- **Day State Machine**：`PLANNING → DISCOVERING → SCORING → OUTREACH → ROUND_END → (NEXT_ROUND | OUTREACH_COMPLETE → MONITORING)`，可 `PAUSED / ERROR / STOPPED`
- **Runtime 持久化**：`jobAgentAutopilotRuntime`（纯 JSON），SW 被回收后从断点续跑；跨天自动重置
- **执行标签策略**：只维护一个 inactive 执行标签，丢失只重建一次，连续失败 → `PAUSED(AUTOPILOT_TAB_UNAVAILABLE)`
- **多轮探索**：`maxDiscoveryRounds` / `maxReplanPerRound` / 跨轮 job dedupe / 全天搜索词去重（不重复搜同一个 city+keyword）
- **风险暂停**：验证码、登录失效、风险页、连续工具失败（2 次）、AI 服务不可用、执行标签不可用、超出工作时间

### 新增：Event Store / Job State / Action Queue

- **Event Store**：按日分区 `jobAgentEvents:YYYY-MM-DD` + 幂等索引 + meta；30 天 retention，
  但 `GREETING_SENT` / `RESUME_SENT` 的幂等键永久保留（否则清理后可能重复打招呼）
- **Job State**：12 状态 + 转移守卫（`DISCOVERED→SCORED→SHORTLISTED→GREETED→…`），非法跳转拒绝且不写脏数据
- **Action Queue**：`pending→approved→executing→success|failed|skipped|requires_manual`，payload 固化（message / 策略 / 模板）
- **统一记录 helper**：`recordGreetingSuccess` = 事件 + 岗位状态 + legacy 兼容写入；失败绝不误标 `GREETED`
- **中断保守处理**：SW/浏览器在发送中途被终止 → `requires_manual`，绝不自动重发（Release Blocking Requirement）

### 新增：每日求职执行日报（Phase 4A）

- 18:00（`dailyReportTime` 可配）自动生成；Chrome 没开着则在下次唤醒补生成，同一天只有一份正式日报
- 快照落盘 `jobAgentDailyReport:YYYY-MM-DD`，正式生成写 `DAILY_REPORT_GENERATED`（幂等键 `report:<date>`）
- 统计全部来自结构化事件（不解析日志、不调用 LLM）：汇总 / Outreach / 每轮表现 / 搜索策略 /
  高分岗位 / 今日未联系的高质量候选 / 已联系明细 / 异常与暂停
- Side Panel 随时可看实时预览（**不**产生正式事件）并导出 Markdown
- 明确不显示 HR 回复 / 简历 / 面试（本版本没有监测能力，不写 0，而是单列「尚未监测」）

### 改进

- Review 与 Autopilot 共享同一套 Discovery 内核（`discovery-runner.js`）与 AI 客户端（`ai-client.js`），禁止出现第二份实现
- **Replan 终止条件**：改用"可自动联系候选（Eligible）≥ 候选目标"，不再使用 V0.4 Planner 的旧目标值（10）
- **提前收敛**：详情预算随候选目标缩放（目标 2 → 6），边抓边评，凑齐候选即停止本轮抓取与评分
- **评分分批**：每批 5 个（避免一次 60 秒的模型调用被 SW 回收），失败/恢复后不重复付费
- Autopilot 面板按模式显示；日志时间按本地时区显示；收工原因写明当前时间与工作时间区间
- manifest 只新增真正需要的权限（`alarms`）

### 修复（均由真实使用暴露）

- `/score` 成功响应没有 `ok` 字段 → 曾把成功当失败，导致必然"评分失败"；现在统一归一化响应并把真实原因写进暂停原因
- `/replan` 服务端存在 V0.4 硬编码守卫（`≥75 分 ≥ 10` 直接返回"无需补充"）→ 现在按 Autopilot 语义判定，并把 eligible/target/阈值告诉模型
- 日报活动日志显示 UTC 时间 → 改为本地时区
- Side Panel 打开时过早生成正式日报（会导致 18:00 被跳过）→ 改为时间感知的 catch-up

### 测试

- 48 个测试文件 / 525 个用例（`npm run ci` 全绿），覆盖 Planner/Replan 边界、Policy 12 条件、
  Action Queue 状态机与幂等、Runtime 恢复与 SW 中断、Replan 终止条件、评分分批与续评、
  工作时间窗口、日报聚合与 snapshot 幂等、以及上述每个事故的回归

### 未实现（计划中）

- HR Message Monitor（对话监测、简历意向判定、自动回复）
- Auto Resume（发简历）
- Email 日报（Phase 4B：本机 Node 服务 + SMTP）
- 候选池跨天持久化与消费策略

---

## [0.4.1] — 2026-09-04

- City follows the current BOSS page（Browser Context）：城市 code 兜底（URL → 链接候选 → DOM 文案 → name 反查），不再有城市白名单
- Planner 拆分负向约束：`hardExclusions`（硬过滤）与 `softNegativePreferences`（只影响评分）
- Side Panel 强制以当前 BOSS 城市重建查询，避免旧计划串城市；`/health` 带版本号，`EADDRINUSE` 友好提示
- 打招呼链路修复：叶节点点击、编辑框清空校验、禁用按钮等待

## [0.4.0] — 2026-08

- Goal-driven Agent Loop：Plan → Search → Hard Filter → Detail → Score → Evaluate → Replan(≤1) → Shortlist
- Side Panel 主界面 + Human-in-the-loop 打招呼 + Agent Activity 时间线

## [0.3.0] 及更早

- 扩展式自动化原型（`auto.html` 调试台）、列表抓取与 CSV 导出、本机打分服务雏形
