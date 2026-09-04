# 自动求职投递 Agent — DeepSeek Harness 工具清单与 Schema（TOOL_SPEC.md）

> 状态：规划稿 v0.1，等待确认
> 关联：docs/ARCHITECTURE.md（§4 数据流、§6.2 Harness 集成面）、docs/DATA_MODEL.md（字段与枚举唯一来源）
> 本文档定义 Agent（模型）可调用的**全部工具**的输入/输出 Schema、副作用等级、护栏与裁决矩阵。
> 工具注册入口、定时唤醒等宿主 API 名称以 IMPLEMENTATION_PLAN.md P0 锁定 commit 的官方 extension-cookbook 为准；**Schema 内容本身（字段/语义/约束）不随 API 变**。

---

## 1. Schema 通用约定

1. 每个工具输入、输出都是 **JSON 对象**；对象节点必须显式 `"additionalProperties": false`（DSH 工具 schema 的隐藏校验，见 [deepseek-harness discussion #1040](https://github.com/deepseek-ai/deepseek-harness/discussions/1040)）。
2. 枚举字段的值以本文件与 DATA_MODEL.md 为准；`type` 不支持联合数组，可选字段用"nullable + 注释说明"表达。
3. 所有时间：ISO-8601 UTC 字符串；`day_key` 为 Asia/Shanghai 的 `YYYY-MM-DD`。
4. 输出统一信封（模型必须按信封解析）：

```jsonc
{ "ok": true,  "data": { /* 各工具出参 */ } }
{ "ok": false, "error": { "code": "PLATFORM_ERROR", "message": "…", "retryable": true } }
```

5. 错误码全集（错误语义见 ARCHITECTURE §6.3）：

```
PAUSED | QUOTA_EXHAUSTED | DUPLICATE | POLICY_DENIED | STATE_INVALID | NOT_FOUND
PLATFORM_ERROR(retryable) | PLATFORM_AUTH | PAGE_CHANGED | MODEL_OUTPUT_INVALID | INTERNAL
```

6. 副作用等级（决定 pause 拦截与审计）：

| 等级 | 含义 | 代表性工具 |
|---|---|---|
| `read` | 只读 DB/配置，零副作用 | get_profile_and_config / list_candidates / get_approval_queue / query_audit_log |
| `probe` | 平台只读探测（网络 GET 级） | check_login / get_job_detail(刷新时) |
| `discovery` | 外部读 + **本地写**（快照/去重/水位） | search_jobs / list_unread_messages |
| `decision` | 纯本地写（状态机合法迁移/评分/分类） | score_job / classify_hr_message / update_application_status / escalate_to_user |
| `external_write` | 对平台产生副作用（写操作三重门） | send_greeting / send_resume / send_template_reply / apply_pending_auto_actions |
| `control` | 全局控制 | request_pause / generate_daily_report |

`external_write` 与 `control` 在 **pause 期间一律被拒绝**（返回 `PAUSED`）；`decision` 对冻结中的会话同样拒绝。

7. Agent 提示词强约束（写进 preset，见 ARCHITECTURE §6.2）：
   - 不得绕过工具拼接"自由文本"外发；任何对外文本只能经 send_* 工具且内容源自模板或预设。
   - 收到 `DUPLICATE` 不要重试，继续后续任务。
   - 收到 `QUOTA_EXHAUSTED` 停止今日打招呼，转入消息处理。
   - `escalate_to_user` 用于 PRD 第六节"必须暂停等待确认"清单。

---

## 2. 工具总览与 PRD 工具清单映射

| # | 工具 | 副作用等级 | PRD 建议清单对应 |
|---|---|---|---|
| 1 | get_profile_and_config | read | （新增：开工上下文） |
| 2 | get_system_status | read | （合并 login/quota/pause 状态） |
| 3 | list_candidates | read | check_duplicate 的查询面（去重本身为确定性代码，见注1） |
| 4 | get_job_detail | read/probe | get_job_detail |
| 5 | get_approval_queue | read | （新增：人工确认列表=65~74分+needs_human） |
| 6 | query_audit_log | read | （新增：审计自查） |
| 7 | check_login | probe | （登录状态检查步骤） |
| 8 | search_jobs | discovery | search_jobs |
| 9 | score_job | decision | score_job |
| 10 | list_unread_messages | discovery | list_unread_messages |
| 11 | classify_hr_message | decision | classify_hr_message |
| 12 | send_greeting | external_write | send_greeting |
| 13 | send_resume | external_write | send_resume |
| 14 | send_template_reply | external_write | send_template_reply |
| 15 | update_application_status | decision | update_application_status |
| 16 | apply_pending_auto_actions | external_write* | （新增：确定性安全网，见注2） |
| 17 | escalate_to_user | decision | （升级人工=暂停语义） |
| 18 | request_pause | control | pause_platform |
| 19 | generate_daily_report | control | generate_daily_report |

注1：PRD 的 `check_duplicate` **不作为模型工具**——去重是 `search_jobs` 内部的确定性步骤（`(platform,external_id)` 与 `fingerprint`，DATA_MODEL §4.1）；模型用 `list_candidates` 查看去重结果，避免模型"记得"哪些投过。
注2：`apply_pending_auto_actions` 由宿主 cron 在每次扫描周期末确定性调用（无需模型），把规则判定为 `auto_send_resume`/`auto_reply_preset` 的到期动作兜底执行；Agent 也可主动调用。它走与 send_* 完全相同的三重门，因此**模型不调用也不会漏发，模型误调也不会超发**。

---

## 3. 共享类型（被多个工具引用）

```jsonc
// JobRef
{ "platform": "mock", "external_id": "MOCK-00042" }

// ConversationRef
{ "platform": "mock", "conversation_id": "01H...ULID", "external_job_id": "MOCK-00042" }

// EvidenceItem（score_job 产出，与 PRD 第四节一致）
{ "requirement": "string", "resume_evidence": "string", "status": "matched|partial|missing" }

// ScoreOutcome
{
  "score_total": 86,            // REAL 0-100，程序计算
  "score_dims": { "direction": 20, "ai_core": 22, "project": 22, "pm": 12, "industry": 4, "city_mode": 6 },
  "bucket": "hot|apply|review|reject|filtered",   // ≥80|75-79|65-74|<65|硬过滤
  "decision": "auto_greet|auto_greet|review|reject|filtered", // 分桶决定（程序）
  "matched_evidence": [ "EvidenceItem" ],
  "risks": [ "string" ],
  "rubric_version": "2026.05.0"
}
// 说明：决策字段由程序给出，模型不输出分数与 decision（ARCHITECTURE A3）。
```

---

## 4. 工具详细规格

### 4.1 读工具（read）

#### 1) get_profile_and_config
开工第一步：返回当前生效画像/目标/排除/限额/模板摘要，供 Agent 在会话内自持（Agent 不应凭记忆猜配置）。

- Input：`{}`（可带 `"section"?: "all|target|exclude|application|templates|evidence"`）
- Output data：
```jsonc
{
  "profile_version": "2026.05.0",
  "candidate": { "experience_years": 7, "ai_product_years": 3, "evidence_projects": ["AI智能语音外呼","LLM与RAG智能客服","智能质检平台","智能对话数字人"] },
  "target": { "cities": ["深圳","杭州"], "job_titles": ["AI产品经理","大模型产品经理","Agent产品经理","对话AI产品经理","AI解决方案产品经理"], "preferred_skills": ["LLM","Agent","RAG","Prompt Engineering","Conversational AI","智能客服","智能外呼","智能质检","Workflow","Function Calling"] },
  "exclude": { "cities": ["北京","上海"], "job_types": ["纯数据标注","纯AI运营","模型训练运营","纯项目经理","长期海外驻场","销售岗位"] },
  "application": { "minimum_match_score": 75, "daily_minimum": 10, "daily_maximum": 30, "weekdays_only": true, "start_time": "09:30", "end_time": "17:30", "report_time": "18:00", "timezone": "Asia/Shanghai" },
  "greeting_templates": [{ "template_id": "t1", "kind": "greeting", "approved": true, "slots": ["hr_name","job_title","jd_core_requirement","evidence_project"] }],
  "salary_rule": { "enabled": false },   // 默认不设薪资硬过滤（Q7）
  "out_of_scope": ["北京","上海","纯数据标注","纯AI运营","模型训练运营","纯项目经理","长期海外驻场","销售岗位","外包?(按tags，Q7)"]
}
```

#### 2) get_system_status
- Input：`{}`
- Output data：
```jsonc
{
  "paused": { "active": false },
  "login": { "ok": true, "state": "logged_in", "checked_at": "…" },
  "quota": { "day_key": "2026-05-04", "greeted": 12, "max": 30 },
  "run": { "kind": "morning", "status": "completed", "run_id": "run_2026-05-04_morning" },
  "time_now_local": "2026-05-04T10:02:00+08:00"
}
```

#### 3) list_candidates
- Input：`{ "day_key"?: "YYYY-MM-DD", "state"?: "application_state枚举", "bucket"?: "hot|apply|review|reject|filtered", "limit"?: 50(默认50,≤100), "sort_by"?: "score_desc|discovered_desc" }`，可多个 state/bucket 用 `"states": [...]`。
- Output data：`{ "items": [{ "platform","external_id","title","company","city","salary_text","state","score_total"?,"decision"?,"greeted_at"?,"hr_last_reply_at"?,"next_action"?,"failure_reason"? }], "total": 68 }`
- 说明：模型据此判断"今日还差几个/哪些在等人处理"，不暴露 JD 全文（避免上下文爆炸），全文走 get_job_detail。

#### 4) get_job_detail
- Input：`{ "job_ref": JobRef, "refresh"?: false }`（refresh=true 时经适配器回源，属 probe）
- Output data：`{ "job": { JobDetail 全字段含 description(Jd原文), hr_name, tags }, "snapshot_at": "…" }`
- 约束：JD 原文每次仅允许有限条进入上下文（默认 ≤15 条/会话，Q14）。

#### 5) get_approval_queue
- Input：`{ "kind"?: "needs_human|review" , "limit"?: 50 }`
- Output data：
```jsonc
{ "items": [{
  "kind": "needs_human", "conversation_id": "…", "platform": "mock", "external_job_id": "…",
  "hr_latest": "询问期望薪资", "hr_intent": "salary_discussion", "frozen_reason": "salary_discussion→需人工",
  "application_state": "NEEDS_HUMAN", "queued_at": "…", "suggested_next_actions": ["用户回复薪资后置 RESUME_SENT 并恢复"] }],
  "review_count": 3, "needs_human_count": 2 }
```

#### 6) query_audit_log
- Input：`{ "day_key"?:, "category"?:, "actor"?:, "entity_type"?:, "entity_id"?:, "result"?:, "limit"?: 100 }`
- Output data：`{ "items": [{ "id","at","run_id","actor","category","event","entity_type","entity_id","result","error_code"?, "payload_summary" }] }`
- 约束：payload 只给摘要（`payload_json` 全文不直接进模型上下文，按需由本地工具查看）。

### 4.2 平台只读 / 发现（probe / discovery）

#### 7) check_login
- Input：`{}`
- Output data：`{ "ok": true, "state": "logged_in", "checked_at": "…" }` 或 ok:false + state：`logged_out|verification_required|page_changed|unknown` + `detail`。
- 语义：仅探测。`logged_out` 返回给 Agent → Agent 应调用 request_pause(reason=logged_out)（登录只能用户手工扫码，Q12 流程）；`verification_required`/`page_changed` 同理直接暂停，**不重试、不点验证码**。

#### 8) search_jobs
- Input：`{ "city"?: "覆盖配置城市", "keywords"?: ["覆盖配置岗位关键词"], "salary_min_k"?:, "max_pages"?: 3(默认), "overrides"?: { "replace_target"?: false } }`（省略=用生效配置）
- Output data：
```jsonc
{ "fetched": 68, "new_jobs": 41, "duplicates_skipped": 27,
  "candidates": [{ "platform","external_id","title","company","city","salary_text","state":"DISCOVERED|FILTERED(历史)","first_seen_day" }],
  "hard_excluded_immediately": [{ "external_id","reason":"exclude_city|exclude_job_type|…" }] }
```
- 语义：内部执行 搜索→列表→（仅对候选）详情→指纹去重 upsert→**硬排除初筛**；硬排除只落在 DISCOVERED 行做记录（不建"假装投递"）。
- 副作用：本地写 candidate_jobs（discovery 级）；外部仅平台搜索读。

#### 9) score_job
- Input：`{ "job_ref": JobRef, "rescore"?: false }`
- Output data：ScoreOutcome（§3）。
- 语义：硬过滤（程序）→ 证据提取（内部模型调用，仅允许结构化 JSON 输出，Zod 校验）→ 加权算分（程序）→ 分桶（程序）→ 迁移状态 `DISCOVERED→QUEUED/FILTERED`（或写入 review 记录）。**模型工具调用方不传分数**，防止 Agent 改分。

### 4.3 消息（discovery / decision）

#### 10) list_unread_messages
- Input：`{ "conversation_id"?: "只查单个", "max_messages"?: 50 }`
- Output data：
```jsonc
{ "scanned_conversations": 6, "new_hr_messages": 8, "new_agent_messages": 0,
  "messages": [{
    "message_id": "ULID", "conversation_id": "…", "platform_message_id": "…", "external_job_id": "…",
    "direction": "hr", "text": "可以看看你的简历吗", "sent_at": "…",
    "intent": "request_resume", "confidence": 1.0, "policy_bucket": "auto_send_resume", "classification_method": "rule"
  }],
  "watermark_updated": true }
```
- 语义：拉取 → 平台消息 ID 去重入库 → **规则分类**（高置信直接给 intent/bucket）→ 更新会话水位。需要模型深判的标记 `"intent": null, "needs_model_classification": true`。

#### 11) classify_hr_message
- Input：`{ "message_id": "ULID" }`
- Output data：`{ "message_id", "intent": "hr_intent枚举", "confidence": 0.93, "policy_bucket": "…", "classification_method": "model", "reason": "HR 询问当前薪资，属于 salary_discussion→需人工" }`
- 语义：仅用于规则未命中/Agent 存疑的消息；模型**只能选枚举值**并给理由，禁止自造意图。产出回填 messages 并迁移相关 application（若 needs_human → 冻结会话）。

### 4.4 对外写（external_write，全部走三重门：政策→幂等/限额→审计）

> 以下 4 个工具共享 Output 信封与错误语义：
```jsonc
// data（成功）
{ "result": "executed|duplicate|quota_exhausted|skipped_paused", "intent_id": "ULID", "effect_id"?: "平台返回ID",
  "detail"?: "人读说明", "executed_at": "…" }
// duplicate 时附 original_intent_id；quota_exhausted 时附 quota:{used,max}
```

#### 12) send_greeting
- Input：
```jsonc
{ "job_ref": JobRef, "template_id": "t1|t2|t3",
  "slot_values": {
    "hr_name"?: "如 HR 名称缺失可省略",
    "job_title": "AI产品经理",            // 必填，取 JD 岗位名
    "jd_core_requirement": "LLM+RAG 产品落地", // 必填，须来自 JD 原文（模型在 score 证据里引用）
    "evidence_project": "LLM与RAG智能客服" } }  // 必填，须 ∈ 画像 evidence_projects
```
- 校验（工具内代码执行，非模型自觉）：`template_id` ∈ 已批准模板；`job_title/jd_core_requirement` 子串存在于该岗位 JD 原文；`evidence_project` ∈ 画像白名单；应用状态 ∈ {QUEUED}（未打招呼）；今日 quota 未满；模板 t1..t3 轮换（同日同 HR 不重复同模板）。
- 语义：三重门 → adapter.sendGreeting → application QUEUED→GREETED、写 greeting_text_snapshot/effect_id/greeted_at；若无会话则建 conversation。模板内不得出现简历外能力（A4）。
- Output：见上信封；命中任一校验失败返回 `POLICY_DENIED` + detail（如"evidence_project 不在画像白名单"）。

#### 13) send_resume
- Input：
```jsonc
{ "conversation_ref": ConversationRef, "mode": "online|attachment",
  "attachment_path"?: "本地绝对路径(仅attachment且仅用户配置指向的目录)", "source_message_id"?: "ULID(触发消息)" }
```
- 校验：会话对应 application.state ∈ {GREETED, RESUME_SENT?no→GREETED, 以及人工解除冻结后}；最近触发消息 intent ∈ `auto_send_resume` 白名单（request_resume / request_online_submit）；会话未冻结；幂等键含 source_message_id。
- 语义：adapter.sendResume → GREETED→RESUME_SENT、写 resume_sent_at/mode/effect_id；`attachment` 只允许用户配置目录内的文件（默认：data/private/ 下，Q11 决定渠道顺序）。
- Output：同上信封。

#### 14) send_template_reply
- Input：`{ "conversation_ref": ConversationRef, "reply_key": "availability|start_date|location_confirm|smalltalk", "slot_values"?: {"answer"?: "由配置给出,模型不得自编"} }`
- 校验：reply_key ∈ 预设；intent 桶 = auto_reply_preset；答案文本只能来自 `config/messages.yaml` 的预设（用户填写"在职=是/到岗=随时/接受城市=接受深圳杭州"），**模型不生成答案内容**。
- Output：同上信封。

#### 15) update_application_status
- Input：`{ "job_ref": JobRef, "target_state": "NO_REPLY|INTERVIEWING|NEEDS_HUMAN(原因必填)|FAILED(原因必填)", "reason"?: "必填当进入 NEEDS_HUMAN/FAILED" }`
- 校验：只允许 §DATA_MODEL 3.2 合法边；其余目标状态由专用工具负责（GREETED 归 send_greeting、RESUME_SENT 归 send_resume）。
- Output：`{ "result": "executed|duplicate|state_invalid", "from_state": "GREETED", "to_state": "NO_REPLY" }`

#### 16) apply_pending_auto_actions（确定性安全网）
- Input：`{}`
- Output data：`{ "applied": [{ "intent_id", "action_type", "target_ref", "result": "executed|duplicate" }], "skipped": [{ "intent_id", "reason": "quota_exhausted|paused|policy_denied" }] }`
- 语义：扫描所有 `policy_bucket ∈ {auto_send_resume, auto_reply_preset}` 且未执行的意图并逐一执行（内部直接复用 13/14 的三重门逻辑，不产生新的模型调用）。
- 谁调用：宿主 cron 扫描周期末（默认每天 4 次整点后 + 17:30 收尾一次）+ Agent 可选。**这是"HR 明确要简历时不会因模型漏调而漏发"的兜底。**

### 4.5 控制（control）

#### 17) escalate_to_user
- Input：`{ "conversation_ref"?: ConversationRef, "job_ref"?: JobRef, "reason_code": "salary_discussion|reason_for_leaving|interview_invitation|relocation_request|sensitive_data_request|offer_background_check|unknown|login_issue|page_changed|quota_sensitive", "question": "给用户的一句话问题，如：HR 询问期望薪资，请问如何回复？" }`
- 语义：冻结会话（state→frozen_needs_human，application→NEEDS_HUMAN），进 get_approval_queue；审计。不自动外发任何文本。

#### 18) request_pause
- Input：`{ "reason_code": "login_expired|verification|page_changed|policy|manual_request|other", "reason": "人读说明" }`
- Output data：`{ "paused": true, "resume_requires": "user", "paused_at": "…" }`
- 语义：写 settings.global_pause + 审计；**之后所有 external_write/control 返回 PAUSED**。恢复只能用户（`dsh` 命令/界面），Agent 无恢复工具——这是本产品最重要的安全阀。

#### 19) generate_daily_report
- Input：`{ "date"?: "YYYY-MM-DD(默认今天)", "formats"?: ["md","csv"], "include_detail"?: true }`
- Output data：`{ "run_id", "md_path": "reports/2026-05-04.md", "csv_path": "reports/2026-05-04.csv", "summary": { "discovered":68,"hard_passed":31,"ge75":18,"greeted":18,"hr_replied":6,"resume_sent":4,"needs_human":2,"failures":1 } }`
- 内容范围（PRD 第八节）：汇总数字 + 明细表（含分数/沟通时间/进度/HR 回复/下一步）+ 最高分 5 + 过滤原因 + 待人工问题 + 当日异常。全部数据来自 runs/messages/applications/audit_log 派生，无模型生成内容（防止日报虚构）。

---

## 5. HR 意图 × 动作矩阵（PRD 第六节的执行化）

| HR 消息示例 | intent | 桶 | 执行的工具 | 是否暂停等待 |
|---|---|---|---|---|
| 发一下简历 / 可以看看简历吗 | request_resume | auto_send_resume | send_resume(mode 按 Q11) / apply_pending_auto_actions | 否 |
| 投递一下在线简历 | request_online_submit | auto_send_resume | send_resume(mode=online) | 否 |
| 目前在职吗 | availability_check | auto_reply_preset | send_template_reply(availability) | 否 |
| 多久可以到岗 | start_date_question | auto_reply_preset | send_template_reply(start_date) | 否 |
| 接受深圳/杭州吗 | location_confirm | auto_reply_preset | send_template_reply(location_confirm) | 否 |
| 你好/在吗 | greeting_smalltalk | auto_reply_preset | send_template_reply(smalltalk) | 否 |
| 期望/当前薪资、离职原因 | salary_discussion / reason_for_leaving | needs_human | escalate_to_user | ✅ |
| 邀约面试时间 | interview_invitation | needs_human | escalate_to_user | ✅ |
| 要求北京/上海/驻外 | relocation_request | needs_human | escalate_to_user | ✅ |
| 索要身份证等 | sensitive_data_request | needs_human | escalate_to_user | ✅ |
| Offer/背调/合同 | offer_background_check | needs_human | escalate_to_user | ✅ |
| 无法判定 | unknown | needs_human | escalate_to_user | ✅ |

---

## 6. 问候模板契约（config/messages.yaml 示例结构，Q4 待你定稿文案）

```yaml
greeting_templates:
  - template_id: t1
    approved: true
    text: "您好，我有7年产品经验，其中3年专注AI产品，主导过AI语音外呼、LLM+RAG智能客服和智能质检项目，与贵司「{{jd_core_requirement}}」比较匹配，希望进一步沟通，谢谢。"
    slots: [jd_core_requirement]           # 白名单：hr_name/job_title/jd_core_requirement/evidence_project
    rotation_weight: 1
preset_replies:
  availability: { text: "在职。", approved: true }
  start_date:    { text: "随时可以到岗。", approved: true }
  location_confirm: { text: "接受深圳和杭州。", approved: true }
  smalltalk:     { text: "您好，我在的，可以聊聊这个岗位吗？", approved: true }
```

约束：模板文案须用户确认（`approved:true` 才可被 send_greeting 引用）；t1–t3 轮换避免机械化（PRD 第五节）；slot 白名单外字段无法注入。

---

## 7. 确定性边界总结（模型能/不能做什么）

| 模型（Agent）可以做 | 模型（Agent）不能做 |
|---|---|
| 决定调用哪个工具、参数、顺序 | 直接执行浏览器/HTTP 动作 |
| 从 JD 提取证据、说明风险 | 输出分数/决策（score_job 的 bucket 是程序给的） |
| 对未命中规则的 HR 消息选择意图枚举 | 自造意图枚举值 |
| 请求暂停、升级人工、生成日报 | 恢复暂停（仅用户） |
| 选择待沟通岗位顺序（同分时） | 修改画像/模板/白名单（仅用户改配置） |
| 阅读审计日志自查 | 对已投岗位再次 send_greeting（幂等+状态机双拒） |

---

## 8. 与数据模型/审计的对应（实现核对表）

每个工具在 Phase 1 实现时须通过表格测试：工具 → 副作用等级 → 写入表 → 审计 category/event → 幂等键（DATA_MODEL §6）。例如 `send_greeting`：external_write → action_intents + applications(GREETED) + messages(agent 侧快照) → audit `external_write/greeting.sent` → `send_greeting:{platform}:job:{id}:{template}:{day}`。

---

## 9. 待你确认的工具级问题

| ID | 问题 | 默认建议 |
|---|---|---|
| Q2 | 意图/证据提取使用的模型与主决策模型是否分离、成本上限 | 同一 DeepSeek 账号，reasoner 仅用于疑难分类，成本上限按日/月（见 PLAN 附录 A） |
| Q4 | 3 套问候模板最终文案 | 先按 PRD 第五节示例定稿 t1，t2/t3 稍后补齐（P1 用占位但结构先行） |
| Q11 | send_resume 渠道默认 online or attachment | online 优先（平台在线简历已在用户 BOSS 账号维护），attachment 仅当用户配置 |
| Q14 | 单次会话 get_job_detail 上限 / 扫描周期 / NO_REPLY 判定天数 | 15 条详情/会话、周期 30 分钟、5 天无回复 |
