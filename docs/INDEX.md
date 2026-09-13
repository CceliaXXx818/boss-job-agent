# 文档索引（docs/INDEX.md）

> 第一次来？按下面的顺序读，**不要**从 `ARCHITECTURE.md` 开始（那是 V0.1 的历史规划）。

## 1. 想快速了解这个项目

| 顺序 | 文档 | 说明 |
|---|---|---|
| 1 | [`../README.md`](../README.md) | 项目是什么、两种模式、怎么跑起来 |
| 2 | [`AGENT-ARCHITECTURE.md`](AGENT-ARCHITECTURE.md) | **用了哪些 Agent 架构模式**、为什么这么选、没用什么、学习路线 |
| 3 | [`PRD-v0.5.md`](PRD-v0.5.md) | 完整需求（功能需求编号化 + 验收标准 + 非目标） |
| 4 | [`DESIGN-v0.5.md`](DESIGN-v0.5.md) | 完整设计（模块地图、11 个 step、事件目录、状态机、幂等、调度、测试、扩展点） |
| 5 | [`PM-INTERVIEW-STORY.md`](PM-INTERVIEW-STORY.md) | 要拿去面试讲这个故事时的脚本与弹药（含指标口径与问答防御） |
| 6 | [`../CHANGELOG.md`](../CHANGELOG.md) | 每个版本做了什么 |

## 2. 想动手改代码

| 目标 | 先读 | 再读代码 |
|---|---|---|
| 改 Autopilot 行为 | `DESIGN-v0.5.md` §5（步骤机）、§8（Policy） | `extension/autopilot-engine.js`、`extension/autopilot-policy.js` |
| 改设置项 | `PRD-v0.5.md` §FR-SET | `extension/settings.js`、`extension/sidepanel.*` |
| 改日报 | `PRD-v0.5.md` §FR-REPORT、`DESIGN-v0.5.md` §11 | `extension/report-builder.js`、`report-markdown.js`、`daily-report-service.js` |
| 改页面动作（危险） | `DESIGN-v0.5.md` §3.1、§15 扩展点 | `extension/content.js`（**改前必须先在真实页面校准**） |
| 加新能力 | `DESIGN-v0.5.md` §15 扩展点 checklist | — |

## 3. 想复盘"为什么当初这样决定"

| 文档 | 状态 |
|---|---|
| `docs/AGENT-ARCHITECTURE.md` §5 | 约束 → 设计 的因果链（存活约束） |
| `docs/DESIGN-v0.5.md` §7、§10 | 幂等模型与 LLM 契约 |
| `CHANGELOG.md` | 每个修复背后的真实事故 |

## 4. 历史文档（V0.1 规划，**未按该路线实现**）

> 这些文档描述的是项目最早的设计：SQLite 本地库 + `JobPlatformAdapter` 平台适配器 + DeepSeek Harness 工具清单 + 多包 monorepo。
> 实际实现走的是**Chrome 扩展 + 本机 Node AI 服务 + 零构建纯 ESM** 路线。保留它们是为了记录设计推演与部分可复用产物
> （`packages/conversation-policy` 的 HR 意图规则语料、`packages/daily-reporter` 的报告字段形状等）。

| 文档 | 内容 | 与现状的关系 |
|---|---|---|
| `docs/PRD.md` | 最早的 MVP 需求（含 HR 回复处理、投递状态机、日报、Harness 架构） | 需求意图仍有效；**当前权威需求见 `PRD-v0.5.md`** |
| `docs/ARCHITECTURE.md` | 平台适配器 / 决策回路 / 写路径设计 | 未实现该架构；思想（决策回路、三重门）被继承 |
| `docs/DATA_MODEL.md` | SQLite 表结构与枚举 | 数据**语义**相近（岗位状态枚举几乎一致），存储改用 `chrome.storage` |
| `docs/TOOL_SPEC.md` | DSH 工具清单与 Schema | 未作为工具暴露；对应能力在 `extension/content.js` 与 `packages/dsh-integration` |
| `docs/IMPLEMENTATION_PLAN.md` | 阶段计划与测试策略 | 阶段划分仍可参考（P0–P8），实际按 Phase 1–4A 推进 |
| `docs/PINNED.md` / `HARNESS_BINDING.md` | 依赖锁定与 Harness 绑定说明 | 仍然有效（`npm run verify:pinned` 把关） |
| `docs/REVIEW_CHECKLIST.md` | 人工验收清单 | 部分仍适用 |
| `docs/USER_PROFILE.md` | 用户画像（已匿名化） | 现由 `config/candidate.example.json` / `config/candidate.json` 承载 |

## 5. 代码入口地图

| 想找什么 | 去哪 |
|---|---|
| 扩展清单 / 权限 | `extension/manifest.json` |
| 控制面（命令、alarm、tab） | `extension/background.js` |
| 编排（步骤机） | `extension/autopilot-engine.js` |
| 纪律（Policy / 设置 / 硬规则） | `extension/autopilot-policy.js`、`settings.js`、`core-logic.js` |
| 事实（事件 / 状态 / 队列 / 运行时） | `extension/event-store.js`、`job-state.js`、`action-queue.js`、`autopilot-runtime.js` |
| 共享内核（Review 与 Autopilot 共用） | `extension/discovery-runner.js`、`ai-client.js` |
| 页面动作（Eyes + Hands） | `extension/content.js` |
| UI | `extension/sidepanel.js|html|css` |
| 模型能力（本机服务） | `packages/model-client/src/{server,client,job-plan,score}.ts` |
| 测试与脚手架 | `packages/agent-core/src/**/*.test.ts`、`helpers/{chrome-stub,autopilot-harness}.ts` |
