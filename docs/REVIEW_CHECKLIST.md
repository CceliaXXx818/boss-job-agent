# 复核查验清单（REVIEW_CHECKLIST.md）

> 适用：在任何一台自己的机器上复核 P0–P3 成果。全程**不需要** dsh、不需要真实 BOSS、不需要浏览器下载。
> 预计耗时：首次含依赖安装约 5–15 分钟（取决于网络），复核命令本身 <1 分钟。

## 0. 前提（一条命令确认）

```bash
node -v        # 需要 ≥ v22.13（本机实测 22.23.2，node:sqlite 免 flag）
npm -v
```

> 不需要安装 pnpm；仓库用 npm workspaces。`.npmrc` 已固定 `legacy-peer-deps=true`（规避 npm 10.9 对 vitest peer 的已知 bug），**不要删**。

## 1. 安装依赖（第一次或换了机器）

```bash
cd <项目根目录>          # 例如 cd ~/Documents/nol-ticket-monitor/job-application-agent
npm ci                   # 按 package-lock.json 精确安装（比 npm install 更严格）
```

## 2. 一键总检（推荐第一件事）

```bash
npm run ci
```

预期：**三关全过**，最后输出：

```text
Test Files  19 passed (19)
Tests       106 passed (106)
```

`ci` = ① `tsc -p tsconfig.json`（TypeScript strict 全量类型检查）→ ② `verify:pinned`（版本锁定校验，含 docs/PINNED.md 的 dsh 0.1.1-rc.2）→ ③ vitest 全量 106 用例。

## 3. 分项验收（每条都有独立含义，建议都跑一遍）

| 命令 | 验证什么 | 预期关键输出 |
|---|---|---|
| `npm run test:intent-eval` | HR 意图分类 ≥95% 门槛 | 2 tests passed；`tests/eval/report-latest.json` 中 `"accuracy": 100` |
| `npm run test:soak` | 5 虚拟工作日：0 重复投递、0 状态丢失、每日限额、日报连续 | 1 test passed（断言见 soak.test.ts 注释 A–F） |
| `npm run demo:day` | 本地无网一键演示一个虚拟工作日 | `打招呼 8，自动发简历 3，升级人工 2`；生成 `reports/demo-2026-09-04.md/.csv` |
| `npm run scan:redline` | Git 红线扫描（手机号/邮箱/API Key/私钥） | `[redline-scan] OK` |
| `npm test` | 全部 106 用例明细 | 19 files passed |

## 4. 人工复查（机器只能证明"测试通过"，这步证明"设计没跑偏"）

按顺序看 6 个文件即可，都是给"你"写的：

1. `docs/IMPLEMENTATION_PLAN.md` —— 先看 P0/P1/P2/P3 各段末尾的 **"P* 交付记录"**：写了交付了什么、实测数字、与计划的差异和原因。这是最省时的入口。
2. `docs/ARCHITECTURE.md` §4.4 —— **写操作三重门**：政策→幂等/限额→审计。全系统的安全核心。
3. `docs/DATA_MODEL.md` §4.6 —— audit_log append-only 语义（库里 UPDATE/DELETE 直接被触发器拒绝）。
4. `docs/TOOL_SPEC.md` §2 —— 19 个 Harness 工具清单与副作用等级（写/控制工具暂停即拒）。
5. `docs/PINNED.md` —— 版本锁定内容：dsh 0.1.1-rc.2、精确依赖表、**安装策略说明**（dsh 未进 devDependencies 的原因与补装命令）。
6. 抽查 1–2 个测试文件读断言，例如：
   - `packages/agent-core/src/services/action-gate.test.ts`（幂等重复 → `duplicate` 且 perform 只调 1 次）
   - `packages/agent-core/src/e2e/soak.test.ts` 注释 A–F（0 重复 / 0 状态丢失 / 限额 / 审计不可变）
   - `reports/demo-2026-09-04.md`（读一读日报长什么样）

## 5. 想更深入时：单文件定向跑测试

```bash
npx vitest run packages/agent-core/src/services/action-gate.test.ts   # 只看三重门
npx vitest run packages/agent-core/src/e2e/daily-flow.test.ts         # 只看一日主链路
npx vitest run packages/sqlite-store/src/store.test.ts                # 只看 DB 约束/触发器
```

失败时把报错文件 + 断言行贴回来即可，我来修。

## 6. Git 红线自查（若你要 git init）

```bash
git init
git add -A
git status                     # 确认以下内容【绝不能被加入】：
```

`.gitignore` 已排除：`data/private/`（你的真实简历）、`data/*.db`、`reports/`（真实日报）、`.env`、`node_modules/`、`.toolcache/`。
**建议先 `git status` 检查，确认没有出现 resume.pdf / *.db / .env 后再 `git commit`。**
若想让我把关，也可以不 init，把目录给我看。

## 7. 复核通过后的下一步（真机前置清单，按序做）

只在你**自己授权的机器**上进行（需要网络）：

1. `npm i -D @deepseek-ai/dsh@0.1.1-rc.2`（或按 docs/PINNED.md 安装策略），跑 `npm run verify:pinned` 确认实测版本一致；
2. 对照 `docs/HARNESS_BINDING.md` U1–U5 完成核验（工具注册/定时/preset/模型配置），回填该文件；
3. `npm i -D playwright` + `npx playwright install chromium`，对 `fixtures/web/boss-*.html` 补跑 L4 浏览器测试；
4. 决定是否进入 P4 真实 BOSS（Q12）——需你本地 consent 标记 + 协议复核 + 手动扫码 + dry-run→低限额。

完成 1–3 后把结果告诉我，我会据此推进 `dsh-integration` 真实工具注册与模型证据提取接入；第 4 步完全由你把关。
