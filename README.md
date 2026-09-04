# job-application-agent（自动求职投递 Agent）

> 本地运行、定时执行、可审计的个人求职助手（DeepSeek Harness + Mock 优先）。
> **当前状态：P0–P3 已完成（规划稿 G0/G1/G2/G3 全绿，`npm run ci` 全通过）；真实平台接入（P4）默认关闭，需用户显式授权。**

## 是什么 / 不是什么

- ✅ 是：工作日自动搜索岗位 → 匹配排序（程序算分）→ 主动打招呼（已批准模板）→ 识别 HR 消息 → **明确索要时自动发简历** → 18:00 日报（MD/CSV）；一切外部写操作 **可审计、可暂停、幂等不重复**。
- ❌ 不是：验证码绕过 / 反检测 / 代理池 / 批量账号；不会替你承诺面试时间、薪资、地点；不把简历、Cookie、账号、API Key 提交到 Git。

## 快速开始（本地，无需真实招聘平台）

```bash
npm ci                      # 依赖安装（.npmrc 已固定 legacy-peer-deps）
npm run ci                  # typecheck + 版本锁定校验（含 dsh 实测版本断言）+ 全量测试（19 文件 / 107 用例）
npm run demo:day            # 1 个虚拟工作日一键演示（Mock，无网络），产出 reports/demo-*.md|csv
npm run test:intent-eval    # HR 意图评测（270 条语料 ≥95% 门槛）
npm run test:soak           # 5 虚拟工作日 soak（0 重复 / 0 状态丢失）
npm run scan:redline        # Git 红线扫描（手机号/邮箱/API Key/私钥）
```

首次使用请复制示例配置并按需修改（真实姓名/语气请本地处理）：

```bash
cp config/profile.example.yaml  config/profile.yaml
cp config/messages.example.yaml config/messages.yaml
cp config/schedule.example.yaml config/schedule.yaml
```

## 仓库结构

```text
packages/
  domain|config-loader|sqlite-store   # 枚举·配置 schema·SQLite 迁移/约束
  agent-core                          # 状态机/时钟/三重门/仓储/兜底执行器
  job-matcher                         # 硬过滤 + 权重评分 + 分桶
  conversation-policy                 # HR 意图规则分类 + 策略桶
  platform-mock                      # Mock 平台（P0–P2 唯一启用）
  model-client                        # DeepSeek 真模型：证据提取/意图判定(JSON+Zod+VCR)
  browser-runtime                     # 确定性浏览器动词 + 页面对象 + InMemoryDriver
  platform-boss                       # BOSS 适配器（默认禁运 fail-closed）
  daily-reporter | dsh-integration    # 日报渲染 · Harness 工具清单（注册待 U1–U5）
fixtures/                             # 匿名测试数据（岗位目录/意图语料/页面占位）
docs/                                 # PRD/USER_PROFILE + 5 份设计文档 + 版本锁定记录
```

## 版本锁定与隐私

- DeepSeek Harness 锁定：`docs/PINNED.md`（`@deepseek-ai/dsh@0.1.1-rc.2`）+ `npm run verify:pinned`（CI 首步）。
- 数据边界：`data/private/`（简历/Cookie/浏览器 profile）、`data/*.db`、`reports/`、`.env` 均 Git 忽略。
- 合规：真实 BOSS 阶段默认关闭；进入需本地 consent 标记（`docs/IMPLEMENTATION_PLAN.md` P4 / Q12）并自行复核平台现行协议。

## 路线图状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 工程地基/锁版/DB/配置 | ✅ |
| P1 | Mock 垂直切片（全链路 + 三重门 + E2E） | ✅ |
| P2 | 质量：意图 95% / 5 日 soak / 场景矩阵 / 兜底 / 保留清理 | ✅ |
| P3 | 浏览器执行层 + BOSS 禁运实现 | ✅（全量 107 用例绿） |
| P4 | 真实平台接入（**默认关**，需你授权+真机） | ⏸ 待办（consent/Q12） |
| P5 | 开源发布 | 🚧 本 README 为骨架；LICENSE 已加（Apache-2.0） |

真机待办（记录于 PINNED/HARNESS_BINDING/PLAN）：配模型凭据后跑 `dsh --profile headless` LLM 烟测（HARNESS_BINDING U3b–U7，dsh 已安装且 U1/U2 已核验）、Playwright 浏览器 L4、BOSS 真实 DOM 校准、CLI 人工队列（Q13）。

## 设计文档

`docs/ARCHITECTURE.md`（架构/适配器接口）· `docs/DATA_MODEL.md`（数据模型）· `docs/TOOL_SPEC.md`（19 个 Harness 工具）· `docs/IMPLEMENTATION_PLAN.md`（路线图/测试策略/待决策）· `docs/PINNED.md` / `docs/HARNESS_BINDING.md`（锁版与 Harness API 核验）。
