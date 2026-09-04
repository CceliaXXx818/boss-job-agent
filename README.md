# job-application-agent（自动求职投递 Agent）

> 本地运行、定时执行、可审计的个人求职助手（DeepSeek Harness + Mock 优先）。
> **当前状态：v0.1 可用（本地 Mock 全链路 + 可选真实模型）。轻量收尾，不追加大功能。**

## 是什么 / 不是什么

- ✅ 是：工作日自动搜索岗位 → 匹配排序（程序算分）→ 主动打招呼（已批准模板）→ 识别 HR 消息 → **明确索要时自动发简历** → 18:00 日报（MD/CSV）；一切外部写操作 **可审计、可暂停、幂等不重复**。
- ❌ 不是：验证码绕过 / 反检测 / 代理池 / 批量账号；不会替你承诺面试时间、薪资、地点；不把简历、Cookie、账号、API Key 提交到 Git。

## 日常使用（就这三句）

```bash
npm ci                      # 换机器/第一次时安装依赖
npm run demo:day            # 跑一遍"虚拟工作日"，自动产出日报
open reports/demo-2026-09-04.md   # 看日报（投递/回复/待人工/异常）
```

每次想看结果就跑 `npm run demo:day`（约 1 秒），报告落在 `reports/`。
想确认代码没坏：`npm run ci`（全量自检，107 个用例）。

可选（有 DeepSeek API Key 时）：
```bash
npm run test:model-live    # 用真实模型重跑证据提取与意图判定评测
npm run agent:smoke        # 演示"模型真的调用我们注册的工具"
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
| P4 | 真实平台接入（默认关） | 🚫 暂不做（Backlog：需授权+真机） |
| P5 | 开源发布 | ✅ 基础已具备（README/CI/LICENSE）；细节 Backlog |

Backlog（暂不做，仅记录）：19 工具全量注册与模型驱动 E2E、定时唤醒、Playwright L4、BOSS 真实接入（需授权）、CLI 人工队列、DB 备份。

## 设计文档

`docs/ARCHITECTURE.md`（架构/适配器接口）· `docs/DATA_MODEL.md`（数据模型）· `docs/TOOL_SPEC.md`（19 个 Harness 工具）· `docs/IMPLEMENTATION_PLAN.md`（路线图/测试策略/待决策）· `docs/PINNED.md` / `docs/HARNESS_BINDING.md`（锁版与 Harness API 核验）。
