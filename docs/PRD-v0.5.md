# BOSS Job Agent — 需求文档（PRD v0.5.0）

| 项 | 值 |
|---|---|
| 版本 | v0.5.0（正式发布） |
| 状态 | 已实现并通过验收（Phase 1–4A） |
| 适用代码 | `extension/`（Chrome 扩展）+ `packages/model-client`（本机 AI 服务） |
| 与旧文档关系 | `docs/PRD.md` 是项目最初的输入（V0.1 规划，描述 SQLite/平台适配器路线，**未按该路线实现**）。**本文档是当前权威需求基线。** |
| 配套设计 | `docs/DESIGN-v0.5.md`（设计）、`docs/AGENT-ARCHITECTURE.md`（架构模式与学习路径）、`CHANGELOG.md`（变更） |

---

## 1. 背景与目标

### 1.1 要解决的问题
求职者每天在 BOSS 直聘上重复四件事：**找岗位 → 读 JD 判断匹配 → 决定投不投 → 打招呼**。
重复劳动多、判断标准不稳定（今天觉得合适的岗位明天可能就投了），而且"投了多少、为什么停、还有哪些值得投"没有记录。

### 1.2 产品目标
用一个**在用户自己已登录浏览器里运行**的 Agent 完成这条链路，并且：

1. **判断可解释**：每个岗位为什么被推荐 / 被排除 / 被联系，都能追溯到结构化事实；
2. **动作可控制**：默认（Review）高风险动作必须用户确认；Autopilot 也必须在明确、可撤销的授权与硬边界内；
3. **过程可审计**：一天发生了什么（搜索了什么词、找到了什么、联系了谁、为什么停）能生成日报；
4. **失败安全**：任何异常（验证码、登录失效、服务不可用、中断）都以"停下来交还给人"结束，而不是绕过或重试到失控；
5. **不伪造能力**：没有实现的监测（HR 回复/简历/面试）在界面上明确标注"尚未监测"，绝不显示 0。

### 1.3 成功判据（可验证）
- 用户用一句话目标，能让 Agent 完成 Plan → 搜索 → 过滤 → 详情 → 打分 → 推荐；
- Review 模式下**未经用户确认不会发出任何消息**；
- Autopilot 模式下，一天内**每个岗位最多联系一次**，且不超过每日上限与工作时间；
- 关闭 Side Panel / SW 被回收 / 页面刷新后，都能从断点继续且不重复发送；
- 18:00（或下次唤醒补生成）能得到一份数据完全来自事件、不需要 LLM 的日报。

### 1.4 非目标（明确不做）
| 不做 | 原因 |
|---|---|
| 验证码绕过 / 反检测 / 指纹伪装 / 代理池 / 多账号 | 合规与账号安全底线 |
| HR 自动聊天、自动回复开放问题 | 高风险、易造成真实社交损失（后续阶段单独评估） |
| 自动发简历（V0.5） | 需要先校准简历发送链路与双确认门（Phase 6） |
| 多平台（猎聘/智联…） | 先在一个平台把纪律做扎实 |
| 多 Agent 协作、RAG、向量库、长期记忆、fine-tune | 对当前任务没有收益，增加不可控面 |
| 云端账号体系 / 数据上云 | 数据必须留在本机 |

---

## 2. 用户与场景

**目标用户**：技术背景的求职者（自己会装扩展、能跑 Node 服务），希望把投递流程标准化、并且愿意遵守平台规则。

| 场景 | 触发 | 期望结果 |
|---|---|---|
| S1 首次试用 | 装好扩展、填好画像 | 在 Review 模式跑通一轮搜索，看到打分与推荐理由，手动投 1–2 个 |
| S2 日常自动 | 早上切 Autopilot、确认目标、Start | Agent 按纪律自动找到候选人并联系；下班后看日报 |
| S3 中途干预 | 用户要接手 / 出现异常 | Pause → 处理 BOSS 页面 → Resume；Stop 结束今天 |
| S4 复盘 | 18:00 后 | 看日报：今天怎么找、为什么停、还剩哪些好岗位 |
| S5 中断恢复 | Chrome 重启 / 面板关掉 | 打开后状态自动续上；被打断的发送动作被标记"需人工确认" |

---

## 3. 范围（V0.5 已实现）

| Phase | 交付 | 状态 |
|---|---|---|
| P1 | 双模式（Review / Autopilot）、Autopilot 设置、首次授权、打招呼话术策略、Policy 判定 | ✅ |
| P2 | Event Store、Job State、Action Queue，Review 打招呼接入统一事件流 | ✅ |
| P3 | Autopilot Outreach：Background SW 有界步骤机、多轮探索、自动打招呼、Pause/Resume/Stop、风险暂停 | ✅ |
| P4A | 每日求职执行日报（18:00 自动生成、快照、预览、Markdown 导出） | ✅ |
| P4B | Email 日报（SMTP） | ⬜ 未实现（UI 标注 Coming Soon） |
| P5 | HR Message Monitor（对话监测、简历意向判定） | ⬜ 未实现 |
| P6 | Auto Resume（自动发简历，需 DOM 校准 + 双确认门） | ⬜ 未实现 |

---

## 4. 功能需求

> 编号规则：`FR-<域>-<序号>`。每条都给出**可验收的规则**，不写"尽量/最好"。

### FR-PLAN 目标解析与计划

| 编号 | 需求 | 规则与验收 |
|---|---|---|
| FR-PLAN-1 | 一句话目标 → 结构化计划 | `POST /plan` 返回 `goal{targetTitles, preferredSkills, salaryMinK, hardExclusions, softNegativePreferences, targetQualifiedJobs, dailyGreetingCap}` + `queries[]`；Zod 校验，失败即报错不猜测 |
| FR-PLAN-2 | 城市跟随浏览器上下文 | 城市由当前 BOSS 页面决定（URL city code → 已知 code 映射 → DOM 文案 → name 反查）；**模型不输出也不猜 cityCode** |
| FR-PLAN-3 | 城市冲突即停 | 目标中提到的城市与当前 BOSS 城市不一致 → 不自动切城市，提示用户先切换并停止启动 |
| FR-PLAN-4 | 硬/软约束分离 | `hardExclusions` 只能来自明确否定（不要/不接受/不考虑/拒绝…），进入**确定性硬过滤**且优先级高于 AI 分数；弱否定只能进 `softNegativePreferences`，只影响评分与排序 |
| FR-PLAN-5 | 搜索词数量 | 初始关键词 3~6 个（程序上限 `MAX_INITIAL_QUERIES=6`），每个词绑定当前城市 |

### FR-SEARCH 搜索与详情

| 编号 | 需求 | 规则与验收 |
|---|---|---|
| FR-SEARCH-1 | 顺序搜索、复用标签 | 搜索按查询顺序串行；Autopilot 只维护**一个 inactive 执行标签**，不抢占用户当前标签 |
| FR-SEARCH-2 | 跨轮去重 | 全天维护 `searchedQueries`（`city+keyword` 去重）；同一组合不重复搜索 |
| FR-SEARCH-3 | 岗位去重 | 按 `jobId` 去重；一轮内新发现数单独统计（`newDiscoveredCount`） |
| FR-SEARCH-4 | 详情预算 | 每轮抓详情数量 = `clamp(batchQualifiedTarget × 3, 5, 15)`；已抓过的不重复抓 |
| FR-SEARCH-5 | 详情字段 | 抓取真实薪资、经验学历、公司规模/融资、JD 全文；列表页的自定义字体数字不可用（用详情页 ASCII 薪资） |

### FR-FILTER / FR-SCORE 过滤与打分

| 编号 | 需求 | 规则与验收 |
|---|---|---|
| FR-FILTER-1 | 规则优先 | 命中硬排除（含系统级排除词）→ 直接移除，不进模型、不推荐；移除原因可追溯 |
| FR-SCORE-1 | AI 打分 | `POST /score` 返回 `score/tier/strengths/concerns/matchedNote`；失败不阻断整轮（该岗位标记失败） |
| FR-SCORE-2 | 推荐线 | ≥75 分为"AI 推荐"（`JOB_SHORTLISTED`），用于 Shortlist 与日报的 Recommended |
| FR-SCORE-3 | 分批打分 | 每批 5 个岗位；只对未评分岗位调用模型；失败/恢复后不重复付费 |

### FR-REPLAN 补充搜索与终止

| 编号 | 需求 | 规则与验收 |
|---|---|---|
| FR-REPLAN-1 | 只在需要时补搜 | 触发条件：`autopilotEligibleJobs < batchQualifiedTarget`；达标即 **skip Replan** 直接进入 Outreach |
| FR-REPLAN-2 | 上限 | 每轮最多 1 次（`maxReplanPerRound`），每次最多新增 4 个关键词 |
| FR-REPLAN-3 | 不可放宽约束 | Replan 只能新增关键词：城市、硬排除、薪资下限、每日上限、阈值一律不可被它改动 |
| FR-REPLAN-4 | 决策可审计 | 每次 Replan 决策（含"判定无需补充"）写 `REPLAN_DECIDED` 事件：roundIndex / decision / reason / addedQueries / eligible / target / source |

### FR-MODE 双模式与授权

| 编号 | 需求 | 规则与验收 |
|---|---|---|
| FR-MODE-1 | 默认 Review | 全新安装默认 Review；不切模式不显示 Autopilot 相关面板 |
| FR-MODE-2 | Review 必须人工确认 | 勾选 → 创建 `pending` Action → 二次确认 → `approved` → 执行；未确认不发送 |
| FR-MODE-3 | 首次授权 | 切 Autopilot 必须先过授权页（会做什么/不会做什么/完整话术）；未授权不可启动 |
| FR-MODE-4 | 撤销授权 | 切回 Review 即撤销 Autopilot 授权；再次开启需重新授权 |
| FR-MODE-5 | 两端一致 | 设置存在 `chrome.storage`（唯一来源），Side Panel 与 SW 读同一份；Review 的话术编辑与 Autopilot 共用同一模板 |

### FR-SET 设置项

| 字段 | 默认 | 范围（程序钳制） | 说明 |
|---|---|---|---|
| `mode` | `review` | review / autopilot | 非法值回退 review |
| `minimumAutoGreetingScore` | 80 | 0–100 | Autopilot 自动联系阈值 |
| `dailyGreetingCap` | **5** | 1–100 | 每日联系上限（第一版保守默认，可主动提高） |
| `batchQualifiedTarget` | 10 | 1–50 | 每轮候选目标（决定何时停止补搜） |
| `maxDiscoveryRounds` | 3 | 1–10 | 单日最多探索轮次 |
| `maxReplanPerRound` | 1 | 0–1 | 每轮最多补搜次数 |
| `workingHours` | 09:00–18:00 | 合法 HH:MM，支持跨夜 | 只在此窗口内搜索与联系 |
| `monitorEnabled` | true | 布尔 | HR 监测开关（**能力未实现**，仅保存配置） |
| `monitorIntervalMinutes` | 10 | 5–15 | 同上 |
| `autoSendResume` | **false** | 只认显式 true | 自动发简历（**能力未实现**，UI 禁用） |
| `dailyReportEnabled` | true | 布尔 | 每日日报开关 |
| `dailyReportTime` | 18:00 | 合法 HH:MM | 日报生成时间 |
| `emailReportEnabled` | **false** | 强制 false | Email 日报（未实现，UI 标注 Coming Soon） |
| `greetingStrategy` | template | template / jd_personalized | `jd_personalized` 明确未实现（调用即报错，不允许不可见话术被发送） |
| `consent.autopilot` | false | 布尔 + 时间戳 | 授权记录 |
| `resumeConfig` | boss_default | boss_default / extension_upload | Phase 6 才用 |

| FR-SET-1 | 设置是唯一事实来源 | 候选目标 / 阈值 / 每日上限 / 轮次 / 工作时间 / 授权等，运行时（Autopilot 会话中）必须以**当前设置**为准；会话进行中修改设置，之后的推进立即按新值执行（不重启也生效） |
| FR-SET-2 | 启动即核对 | 点 Start 前必须先持久化设置表单；启动后把本次生效配置显示给用户并写入日志/事件，便于核对"到底按哪套设置跑" |

验收：非法输入一律钳制或回退默认并给出 warning，**不抛错、不崩界面**；旧版本键（`dailyCap`/`greetText`）只读一次迁移。

### FR-ACTION 动作队列与幂等

| 编号 | 需求 | 规则与验收 |
|---|---|---|
| FR-ACTION-1 | 先落盘再执行 | 打招呼必须先创建 Action（`pending`）并持久化，再经批准执行 |
| FR-ACTION-2 | 状态机 | `pending→approved→executing→success｜failed｜skipped｜requires_manual`；终态无出口，重试需新建 Action；非法转移被拒绝且不写脏数据 |
| FR-ACTION-3 | 话术固化 | 创建 Action 时固化 `payload.message / messageStrategy / templateId`；之后改模板不影响已 approved/executing 的 Action |
| FR-ACTION-4 | 幂等键 | `greeting:<jobId>` / `resume:<jobId>` / `report:<YYYY-MM-DD>`；同键不重复执行 |
| FR-ACTION-5 | 四道闸门 | ① 创建时查队列阻塞态 + 事件 + legacy 历史；② 执行前再查一次；③ 事件写入幂等；④ 中断恢复标记 `requires_manual` |
| FR-ACTION-6 | 中断保守 | SW/浏览器在发送中途终止 → `requires_manual`，**绝不自动重发**；界面提示到 BOSS 消息列表人工确认 |

### FR-GREET 打招呼执行

| 编号 | 需求 | 规则与验收 |
|---|---|---|
| FR-GREET-1 | 确定性发送 | 全程复用已验证的 DOM 链路（点击入口 → 原生文本插入 → 叶节点点击发送 → 校验编辑框已清空） |
| FR-GREET-2 | 发送即记账 | 成功：`GREETING_SENT`（含 message/策略/模板/分数/mode/round）+ Job State `GREETED` + legacy 计数；失败：`GREETING_FAILED`，**状态绝不置 GREETED** |
| FR-GREET-3 | 模板校验 | 空 / 纯空白 / 超 1000 字 / 含控制字符 → 拒绝发送并给出原因 |
| FR-GREET-4 | 话术可见 | Autopilot 授权页必须展示将自动发送的完整话术；`jd_personalized` 未实现即报错 |

### FR-CAP 额度与时间窗

| 编号 | 需求 | 规则与验收 |
|---|---|---|
| FR-CAP-1 | 今日计数 | `max(当日 GREETING_SENT 事件数, legacy 本地键, legacy UTC 键)`（宁多算不少算） |
| FR-CAP-2 | 创建阶段就不超 | 只把 `min(剩余额度, 单轮上限)` 个候选放入队列；绝不"先创建 N 个 approved 再发现超 cap" |
| FR-CAP-3 | 启动即判定 | 启动时若已满 → 不进入 Discovery，直接 `OUTREACH_COMPLETE → MONITORING` |
| FR-CAP-4 | 工作时间 | 超窗即收工（`OUTSIDE_WORKING_HOURS`），不为凑额度在夜里继续联系；离结束 < 15 分钟启动时给出提醒 |

### FR-RISK 风险与暂停

| 编号 | 需求 | 规则与验收 |
|---|---|---|
| FR-RISK-1 | 立即暂停 | 验证码 / 登录失效 / 风险页 / 执行标签不可用 / AI 服务不可用 / 浏览器上下文失效 / 连续工具失败（≥2）→ `PAUSED` + `AUTOPILOT_PAUSED` 事件（含 code） |
| FR-RISK-2 | 不绕过不重试 | 不做验证码处理、不做反检测；单个 bounded 浏览器操作最多安全重试 1 次（消息层另有 ≤3 次可重试错误重试 + 一次标签 reload 兜底，均有硬上界） |
| FR-RISK-6 | 空结果不是风险 | 某关键词返回 0 条岗位（无结果）或列表尚未渲染完，**不得**判定为"未登录/未选城市"等风险；应先重试等待渲染，仍为空则记为"该关键词无结果"、跳过并继续下一个关键词 |
| FR-RISK-7 | 风险判定只用可靠事实 | 只依据 URL / 标题（含标签页自身信息，不依赖 content script）判定验证码 / 登录失效 / 风险页；**禁止**用"卡片数为 0"之类易假阳性的信号推断风险 |
| FR-RISK-5 | 个别坏页面不拖垮整轮 | 某岗位详情页解析失败（内容脚本正常返回但内容为空/布局异常）只跳过该岗位并记录；连续 3 个此类失败才暂停，并提示"页面结构可能已变化" |
| FR-RISK-3 | Resume 重新校验 | Resume 必须重跑全部关键校验（模式/授权/话术/上下文/工作时间/额度/平台/AI 服务）；不通过则保持 PAUSED 并说明原因 |
| FR-RISK-4 | Pause 语义 | Pause 后不再发起新的搜索与打招呼；正在执行的单个动作允许自然结束并记账 |

### FR-RUNTIME 运行时与恢复

| 编号 | 需求 | 规则与验收 |
|---|---|---|
| FR-RUNTIME-1 | storage 是唯一事实来源 | Side Panel 不参与执行；关掉面板后 Autopilot 继续推进 |
| FR-RUNTIME-2 | 每步落盘 | `advanceAutopilot()` 一次只推进一步并持久化 runtime；SW 重启后从 `step` 续跑 |
| FR-RUNTIME-3 | 无长驻循环 | 无 `while(true)` / `setInterval` / 跨小时 await；每次唤醒 ≤3 步；调度用 `chrome.alarms` + tabs 事件 |
| FR-RUNTIME-4 | 跨天重置 | 新的一天自动重置 Session（轮次/搜索记录清空），不继承昨天状态 |
| FR-RUNTIME-5 | 状态可读 | 面板显示 status / step / 今日已联系 / 轮次 / 当前搜索词 / 推荐 / Eligible·Target / 队列；日志按本地时区 |

### FR-REPORT 每日求职执行日报

| 编号 | 需求 | 规则与验收 |
|---|---|---|
| FR-REPORT-1 | 自动生成 | 默认 18:00（`dailyReportTime`）由 alarm 生成；同一天最多一份正式日报 |
| FR-REPORT-2 | Catch-up | Chrome 未运行时，在下次唤醒（启动 / 打开面板 / 启动 Autopilot）补生成；未到时间或已生成则跳过 |
| FR-REPORT-3 | 数据来源 | 只读 Event Store / Job State / Runtime；**不解析 Activity 文本、不调用 LLM**；详细指标映射见设计文档 §11 |
| FR-REPORT-4 | 内容 | 今日汇总 / Outreach（额度、达成、停止原因人类可读、来源拆分）/ 每轮表现 / 搜索策略 / 高分岗位 / 今日未联系的高质量候选 / 已联系明细 / 异常与暂停 |
| FR-REPORT-5 | 不伪造 | HR 回复 / 简历请求 / 简历发送 / 面试在本版本**字段不存在**；页面单列「尚未监测」说明，而非显示 0 |
| FR-REPORT-6 | 预览不落正式事件 | 「查看今日日报」是实时预览，不写 `DAILY_REPORT_GENERATED` |
| FR-REPORT-7 | 幂等 | 快照键 `jobAgentDailyReport:<date>` + 事件幂等键 `report:<date>` 双保险；重复 alarm / SW 重启 / 面板重开都不重复生成 |
| FR-REPORT-8 | 导出 | 支持导出 Markdown（复用 `downloads` 权限，不引入新依赖） |
| FR-REPORT-9 | 只读 | 生成日报不得修改 Job State / Action Queue / Daily Cap / Runtime（唯一允许写入的是日报快照与生成事件） |

### FR-PERM 权限

| 编号 | 需求 | 规则与验收 |
|---|---|---|
| FR-PERM-1 | 最小权限 | 仅 `storage / tabs / sidePanel / alarms / downloads` + host `*.zhipin.com`、`127.0.0.1`、`localhost` |
| FR-PERM-2 | 逐阶段增加 | 每个 Phase 只加本阶段真正用到的权限；**不得**提前加入 notifications / unlimitedStorage / scripting / webRequest / cookies / history（测试断言） |

---

## 5. 非功能需求

| 类别 | 要求 |
|---|---|
| 可靠性 | 任何中断都不产生重复的外部副作用；恢复路径必须"保守优先"（宁可标记需人工，也不自动重发） |
| 可测试性 | 所有编排逻辑可注入依赖，能在 Node + 内存 chrome 桩下完整驱动；纯函数内核与浏览器 I/O 严格分离 |
| 可审计性 | 关键决策（Policy 拒绝原因、Replan 决策、停止原因、发送结果）必须落事件；日报可从事件重建 |
| 性能 | 单次 bounded 浏览器操作 ≤1 个页面动作；模型调用分批（5 岗/次）；不扫描 30 天全量事件（只读当日分区） |
| 隐私 | 所有数据在本机 `chrome.storage.local`；API Key 只存 `.env`；仓库不含简历/Cookie/凭据（红线扫描把关） |
| 合规 | 不绕过平台风控、不做反检测、不做高频刷新；所有自动行为有硬上限且可随时暂停 |
| 兼容 | Chrome MV3；Node ≥ 20（本机 AI 服务）；扩展零构建步骤（纯 ESM，无打包器） |

---

## 6. 数据与隐私要求
- 存储键：`jobAgentEvents:<date>`、`jobAgentEventMeta`、`jobAgentIdempotency`、`jobAgentJobStates`、`jobAgentActions`、`jobAgentAutopilotRuntime`、`jobAgentSettings`、`jobAgentDailyReport:<date>`、legacy：`greet-<date>` / `greetedHistory` / `dailyCap` / `greetText`
- 保留策略：事件默认 30 天清理；**副作用幂等键（`greeting:`/`resume:`）永久保留**；未完成的 Action 永不清理；日报快照永久保留
- 禁止入库：简历二进制、Cookie、账号密码、API Key、手机号/邮箱（红线脚本 `npm run scan:redline` 把关）

---

## 7. 验收标准

| Phase | 验收方式 | 通过判据 |
|---|---|---|
| P1 | `npm run ci` + 手工切换模式 | 默认 Review；未授权不能启动 Autopilot；Policy 试算只展示不发送 |
| P2 | `npm run ci` + Review 手动投递 | 未确认不发送；重复点击/刷新/重开不重复发送；失败不标 GREETED |
| P3 | 真实 BOSS 跑一轮（阈值 85 / 上限 1） | 自动完成搜索→打分→推荐→Policy→发送；关掉面板仍在推进；达到上限后 `OUTREACH_COMPLETE → MONITORING` |
| P4A | 手工 + `npm run ci` | 能看到今日日报（预览）+ 导出 Markdown；18:00 后自动生成正式日报；重复触发不重复生成；日报里**没有** HR/简历/面试数字 |
| 全局 | `npm run typecheck && npm run ci && npm run scan:redline` | 全绿；48 个测试文件 / 525 个用例通过 |

---

## 8. 后续路线（未实现，供排期）
| 阶段 | 内容 | 前置 |
|---|---|---|
| P4B | Email 日报（`POST /notify/email` + Nodemailer，SMTP 只在 `.env`；失败只产生 `REPORT_EMAIL_FAILED`，本地日报不受影响） | 无（架构已预留 `renderDailyReportMarkdown`/结构化 report） |
| 候选池 | 跨天候选池持久化与消费策略（让"今日未联系高质量候选"明天真的可用） | 无 |
| P5 | HR Message Monitor：先做 `chatDiagnose` DOM 校准，再做 Inbox-first 监测（只扫已联系的会话）、去重、通知；**不做**自动回复 | DOM 校准 |
| P6 | Resume Intent（规则 + LLM 双确认门，precision ≥0.95，宁可漏不可错发） | P5 |
| P7 | Auto Resume（`resumeDiagnose` 校准后，默认 OFF） | P6 |

---

## 9. 风险与声明
- **账号风险**：自动打招呼属于平台自动化操作，存在账号受限风险，使用即视为自愿接受；
- **信息风险**：Agent 可能推荐不合适的岗位或发送不理想的话术，Review 模式与授权页（展示完整话术）是主要防线；
- **能力边界**：V0.5 还没有 HR 回复监测，`MONITORING` 只是"今天主动联系结束"的终态，不代表在监控对话；
- **非官方**：本项目为个人作品集项目，与 BOSS 直聘无关，Apache-2.0 许可，风险自担。
