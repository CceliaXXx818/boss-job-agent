# PINNED — DeepSeek Harness 版本锁定记录（P0-D3）

> 本文件由 `npm run verify:pinned`（scripts/verify-pinned.mjs）在 CI 首步断言。
> 升级 = 显式流程：改本文件 → 全量测试 → 回写 ARCHITECTURE/TOOL_SPEC 中依赖的 API 表格（见 IMPLEMENTATION_PLAN §3 P0-D3）。

## 锁定目标

```text
DSH_NPM_PACKAGE=@deepseek-ai/dsh
DSH_NPM_VERSION=0.1.1-rc.2
DSH_REPO_COMMIT=待人工核实（见下）
DSH_LOCKED_AT=2026-09-04
```

## 说明

- `DSH_NPM_VERSION=0.1.1-rc.2`：本机运行实例（GUI 宿主）实测版本，registry 上确认存在（0.1.2-* 已发布但**不采用**，本产品锁定 0.1.1-rc.2 直至显式升级）。
- **安装状态（2026-09-04 更新）**：已安装为根 devDependency（精确版本），`npm run verify:pinned` 实测断言版本一致 ✔；CLI 已可运行（`--help/--version/--dump-default-config`）。因 npm 10.9 legacy-peer-deps 不自动装 optional/peer，曾补装 `@deepseek-ai/cordis-plugin-group` 及 17 个 `@deepseek-ai/dsh-*` peer（见 docs/HARNESS_BINDING.md §3；换无 bug 的 npm 后可去掉这些补装）。
- `DSH_REPO_COMMIT`：官方 GitHub 仓库对应 commit。规划期沙箱无法访问 GitHub（curl 超时），暂无法核实；
  候选 `47f943859bef60e4160492346772ded9b24f765a`（来自官方文档 URL 引用，非本机核实）——
  **待联网或人工核对后回填**；回填前不得据此假设任何插件 API。
- 运行时环境：Node v22.23.2 实测（`node:sqlite` 免 flag 可用，最低 22.13.0）。
- 包管理器：npm workspaces（package-lock.json 提交入库）。

## 精确锁定依赖（根 package.json，由 verify:pinned 强制）

| 包 | 版本 |
|---|---|
| @deepseek-ai/dsh | 0.1.1-rc.2 |
| typescript | 5.9.3 |
| vitest | 4.1.11 |
| zod | 4.5.4 |
| yaml | 2.9.0 |
| @types/node | 22.20.1 |

## 升级检查清单

1. 评估新版本对工具注册/定时/会话 API 的影响（对照 docs/HARNESS_BINDING.md 的已核验项）。
2. 更新本文件 DSH_NPM_VERSION 与 DSH_REPO_COMMIT。
3. `npm ci && npm run ci` 全绿。
4. 跑通 P1 mock 场景（若已存在）后，回写 HARNESS_BINDING.md 中"待核验"项的状态。
