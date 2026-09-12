# BOSS Job Agent

**A goal-driven AI job-search agent running inside the user's browser.**

你只要用一句自然语言描述目标，Agent 就会自己规划搜索、筛选、抓详情、AI 打分、评估结果并在需要时补充一轮搜索，最后把值得投的岗位排给你确认。

> 个人作品集项目，非官方工具、与 BOSS 直聘无关。自动化操作存在平台账号风险，请自行判断并**风险自担**。项目不含任何验证码绕过 / 反检测 / 指纹伪装能力。

---

## 核心特性

| 能力 | 说明 |
|---|---|
| **Goal-driven Planning** | 自然语言目标 → 结构化搜索计划（城市/岗位/技能/薪资/排除项 + 搜索词） |
| **Adaptive Search** | 结果不足时自动 Replan **一次**，只允许"新增搜索词"，绝不放宽你的硬约束 |
| **AI Job Matching** | 读 JD + 你的画像 → 0–100 分 + 优势 + 顾虑 + 一句话结论 |
| **Human-in-the-loop** | Agent 只做推荐；**是否打招呼由你勾选 + 确认** |
| **Browser-native Execution** | 所有页面动作都在你已登录的浏览器里用确定性代码完成 |
| **Safety Policy** | 规则闸优先于模型、每日上限、跨天防重复、验证码/异常立即停止 |

---

## 架构：眼睛和手 vs 大脑

```
User Goal（自然语言）
        ↓
   Planner（LLM：/plan）            ← 大脑：理解目标、生成搜索计划
        ↓
   Search Plan（有限查询 ≤6）
        ↓
   Chrome Browser Tools             ← 眼睛和手：搜索 / 抓列表 / 抓详情
        ↓
      BOSS 直聘
        ↓
    Observation（岗位结构）
        ↓
  Filter（确定性规则：排除词/薪资） → Score（LLM：/score）
        ↓
   Evaluator（程序判断是否达标）
        ↓
  Replan once（LLM：/replan，最多 1 次）或 Complete
        ↓
   Human Approval（你勾选 + 确认）
        ↓
   Greeting（确定性代码，复用已验证的 greetFull）
```

- **Chrome Extension = Eyes + Hands**：读页面、点按钮，全部确定性实现（`content.js` / `sidepanel.js`）
- **Agent Core / LLM = Brain**：理解目标、补充搜索策略、解释推荐理由（只输出结构化 JSON）
- **规则层（`extension/core-logic.js`）= 纪律**：硬排除、限额、防重复、Replan 次数上限

> LLM decides **WHAT** to do. Deterministic browser code decides **HOW**. User decides **WHETHER** consequential actions run.

---

## 快速开始

### 1. 环境
- Google Chrome
- Node.js 20+（仅 AI 规划/打分需要）与一个 [DeepSeek API Key](https://platform.deepseek.com/)

### 2. 启动本机 AI 服务
```bash
cd 项目目录
npm ci
echo 'DEEPSEEK_API_KEY=你的key' > .env
npm run score:serve   # http://127.0.0.1:8799（只监听本机）
```

### 3. 配置你的画像（AI 打分依据）
```bash
cp config/candidate.example.json config/candidate.json
# 编辑 config/candidate.json：年限 / 技能 / 做过项目 / 目标岗位 / 排除词
```

### 4. 安装扩展
1. `chrome://extensions` → 打开「开发者模式」
2. 「加载已解压的扩展程序」→ 选择 `extension/` 目录
3. 用 Chrome 打开 `www.zhipin.com` 并**手动登录**

### 5. 使用
1. 点扩展图标 →「**打开 Job Agent**」（打开 Side Panel）
2. 输入一句话目标，例如：
   > 杭州和深圳AI产品经理，优先Agent和LLM方向，30K以上，不要外包、售前、纯运营
3. 点「开始找工作」→ Agent 自动：Plan → 搜索 → 过滤 → 抓详情 → AI 打分 → （不足时）Replan 一次
4. 查看 Shortlist（≥75 分岗位卡片），勾选你想联系的岗位
5. 点「联系选中岗位」→ 确认数量/日限/话术 → 执行打招呼

> 首次使用建议把每日上限设为 1，跑通一次再调大。

---

## Agent Loop（有限状态）

状态机：`idle → planning → searching → filtering → fetching_details → scoring → evaluating → replanning → complete | stopped | error`

- 搜索**顺序执行**，始终复用同一个已登录 BOSS 标签页
- 只抓 Top 15 详情（已抓过的不重复抓）
- **MAX_REPLAN = 1**：第二轮结束后无论结果多少都结束，绝不无限循环
- 出现验证码 / 城市跳转 / content 无响应 → 立即 `stopped`，提示人工处理

Agent Activity 面板展示的是**行为与决策摘要**（例如"当前仅找到 6 个 ≥75 分岗位，因此增加'AI平台产品经理'"），不是模型内部思维链。

---

## 数据结构（V0.4）

```ts
JobSearchGoal { rawGoal, cities[{name,code}], targetTitles[], preferredSkills[],
                excludeTokens[], salaryMinK|null, targetQualifiedJobs, dailyGreetingCap }
SearchQuery   { cityName, cityCode, keyword, source: 'initial' | 'replan' }
AgentPlan     { goal, queries[], successCriteria{ targetQualifiedJobs, qualifiedScoreThreshold } }
```

- 目前支持城市：**杭州 101210100 / 深圳 101280600**；模型识别到其他城市时返回 warning，**不猜 city code**
- 默认目标：`targetQualifiedJobs = 10`，`qualifiedScoreThreshold = 75`

---

## 本机 AI 服务接口

| 接口 | 作用 |
|---|---|
| `GET /health` | 服务健康检查 |
| `GET /config` | 返回画像摘要（排除词等，供硬过滤合并） |
| `POST /score` | 岗位打分（复用 `candidate.json`） |
| `POST /plan` | 自然语言 Goal → 搜索计划 |
| `POST /replan` | 结果不足 → 仅新增搜索词（硬约束不可改） |

服务只监听 `127.0.0.1`；API Key 仅存本地 `.env`。

---

## 安全与纪律（产品的一部分）

- **规则优先**：命中排除词/低于薪资下限 → 直接移除，不进模型、不推荐
- **三重闸门**：用户批准 + 每日上限 + 历史去重（打过招呼的岗位永不重复）
- **异常即停**：验证码/风控/页面异常 → 停止并交还给人，绝不尝试绕过
- **不做**：多 Agent、向量库、RAG、长期记忆、多平台、自动发简历、HR 自动聊天、后台定时、无限循环

---

## 旧入口（Legacy）

`extension/auto.html` 保留为 **Legacy / Debug** 页面（V0.3 的调试台），Side Panel 是 V0.4 的推荐入口。popup 仍作为轻量启动器与诊断入口。

---

## 测试

```bash
npm run typecheck   # 类型检查
npm test            # 全部单测（Planner/Replan/闸门/评分/状态机…）
npm run ci          # typecheck + 版本锁定校验 + 全部测试
```

---

## 免责声明与许可

- 仅供个人学习与求职使用；请遵守 BOSS 直聘服务条款与你所在地法律。
- 自动化操作可能导致账号受限，**使用即视为自愿接受**。
- Apache-2.0，详见 `LICENSE`。
