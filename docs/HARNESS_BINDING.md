# HARNESS_BINDING — DeepSeek Harness 插件 API 核验报告（P0-D6）

> 状态：**主要核验完成（2026-09-04 更新）**。工具注册（U1）与定时/唤醒（U2）已用**已安装包的官方文档与类型**实证；
> 运行时烟测（headless 全量 + 模型调用）仍需模型凭据/网络。更新记录见文末。

## 1. 环境事实（本机实测）

| 项 | 值 | 来源 |
|---|---|---|
| 运行时包 | `@deepseek-ai/dsh`（npm，精确锁版 devDependency） | 根 package.json（`npm run verify:pinned` 实测断言 **0.1.1-rc.2 ✔**） |
| 版本 | 0.1.1-rc.2（registry 确认存在；0.1.2-* 已发布但不采用） | node_modules/@deepseek-ai/dsh/package.json |
| 相关包实测版本 | dsh-tools / dsh-schedule / dsh-llm / dsh-session = 0.1.1-rc.2；@deepseek-ai/cordis = 4.0.2；cordis-plugin-timer = 1.1.4 | node_modules/@deepseek-ai/* |
| CLI 行为 | `npm exec dsh -- --help` / `--version` / `--dump-default-config` 均可运行（0.1.1-rc.2） | 实测 |
| 运行形态 | `dsh` 启动 profile：`$DSH_HOME/profiles` 下 bundle 栈 + `cordis.patch.yml` 覆盖层；`--patch` 附加层；`web`/`headless` profile（headless = 单任务问答即退） | @deepseek-ai/dsh README.zh.md（随包） |

## 2. 核验结果（依据：已安装包自带 README 与 .d.ts，全部来自锁定版本本体）

| # | 事实 | 状态 | 依据 |
|---|---|---|---|
| U1 | **工具注册 API**：`ctx.tools.register(definition: ToolDefinition): () => void`；作者侧 `defineTool()`（`@deepseek-ai/dsh-tools`），含 name/description、参数级 `required:true` 的 parameters、**必填** `output:{schema, render}`、`execute(args, exec): Promise<unknown>`（只返回 canonical JSON 值，需观测 exec.signal）。schema 自动流入系统提示词；`tools/pre-execute→guard→execute→post-execute→result` 流水线。**本仓库 spike 已按此 API 编译通过**（packages/dsh-integration/src/spike.ts，fake-host 单测绿） | ✅ 已核验 | dsh-tools/README.zh.md + lib/types/*.d.ts（本机安装包） |
| U1b | 隐藏 schema 校验（H4 落实于类型）：对象节点必须显式 `additionalProperties`（输出对象 even 更强制）；类型不支持联合数组 | ✅ | dsh-tools schema.d.ts（ObjectValueSchemaSpec.additionalProperties 必填） |
| U2 | **定时/唤醒**：`@deepseek-ai/dsh-schedule` 提供 agent-scoped 工具 `schedule_create`（`after_seconds`/`at`+`time_zone`/`every_seconds`≥5min）/`schedule_list`/`schedule_delete`；持久化于会话日志，到期后 `followup()` 在 agent **idle 时开启普通后续轮次**（不打断当前对话）——即"定时唤醒继续执行"的官方机制；另有 host 级 `timer` 插件行（cordis-plugin-timer） | ✅ 已核验 | dsh-schedule/README.zh.md；headless --dump-default-config 含 `- id: timer` |
| U3 | **preset/组合挂载**：dsh = profile(bundle 顺序栈) + 用户 patch 层；headless profile 默认装配 agent-loop、`tools`(mode=DSH_TOOLS_MODE)、llm/session/credentials、system-prompt(persona {{model}}/{{cwd}}) 等插件行；agent 默认模型 provider `deepseek-official`、model `deepseek-v4-flash` | ✅（挂载形态）/ 部分（我方 preset 打包方式待 headless 烟测定稿） | headless --dump-default-config；README.zh.md |
| U4 | **模型凭据**：默认 provider deepseek-official；`DEEPSEEK_API_KEY` env（web-search 行实证）；另有 credentials 服务与 settings 文件 | ✅（入口）/（完整凭据加载路径待烟测） | dump + 各 README |
| U5 | 独立 npm 安装的 CLI 可运行（--help/--version/dump-config 已实测）；`--profile headless "任务"` 端到端需模型凭据与 api 网络 | ✅（CLI）/ 部分（LLM 会话） | 实测 |
| E1 | 环境注意：npm 10.9 arborist 对 optional peer 有 bug ⇒ `.npmrc` legacy-peer-deps；副作用是 dsh 树若干 peer 不会被自动安装，需按 §3 补装 | ✅ 已知并已处理 | 实测错误 + 修复记录 |

## 3. 安装与补装记录（2026-09-04）

```bash
npm i -D -E @deepseek-ai/dsh@0.1.1-rc.2            # 423 packages, 4m
npm i -D -E @deepseek-ai/cordis-plugin-group       # CLI 启动缺包
npm i -D -E @deepseek-ai/dsh-scope @deepseek-ai/dsh-timeout ...（共 17 个 peer，见 git 记录/package.json）
```

> 根因：legacy-peer-deps 不自动装 optional/peer；`verify:pinned` 会断言 dsh 实测版本。
> 若在无该 bug 的 npm 版本（如 ≥11/12）下安装，可移除 .npmrc 后让 npm 自动装 peer，此补装清单可删除。

## 4. 仍待核验项（需要模型凭据/网络/真机，不阻塞编译级集成）

| # | 问题 | 方法 |
|---|---|---|
| U3b | 我方 profile（bundle/patch）打包方式与 agent preset 文件挂载 | 配置 DEEPSEEK_API_KEY 后 `dsh --profile headless …` 烟测；对照 dump 输出调整 patch 层 |
| U4b | 凭据注入到哪一档（env vs credentials 文件 vs settings） | 同上烟测 |
| U6 | `schedule_create` 在真实 agent 会话中的持久化与 follow-up 行为 | 同上烟测（可先造 60s 后提醒） |
| U7 | 全量 19 工具注册（spike 已证单工具）在真会话可见性 | 用 tools.schemas()/dump 复核 |

## 5. 风险与缓解

- DSH developer preview 接口可能变动 ⇒ 版本锁定 + 本表维护 + `verify:pinned`。
- 本沙箱无模型凭据/外部 LLM 网络 ⇒ LLM 会话类核验留在真机；业务层不受影响（Mock/契约测试离线全绿）。
- fallback 保持：宿主定时 + `dsh headless` 会话仍可作为 schedule 之外的系统级备选（决策点已记录，不影响业务层设计）。

## 6. 更新记录

| 日期 | 变更 |
|---|---|
| 2026-09-04 | 初版（offline 部分核验，U1–U5 待办） |
| 2026-09-04 | 实测更新：dsh 安装并 CLI 可运行；**U1/U2 已核验**（官方包 README/类型）；U3–U5 形态已核验、LLM 烟测待真机；spike 落地 |
| 2026-09-04 | **headless 冒烟通过**：配置 DEEPSEEK_API_KEY 后 `dsh --profile headless "1+1?"` 正常返回（用户真机与沙箱均验证）。前置修复：peer 版本错线（0.0.1-rc.x）→ 全部对齐 `0.1.1-rc.2`（commit 339005a）。U3b–U7 剩余 = 自定义 profile 内注册我方 19 工具并真会话烟测 |
