# Contributing

感谢你对 BOSS Job Agent 的兴趣。

这个项目的目标是做一个**有边界、可审计、可恢复的求职 Agent**，而不是无限量群发脚本。

## 欢迎的贡献

特别欢迎：

- Bug fixes
- 测试补充
- 浏览器兼容性修复
- Planner / Replan 质量优化
- Agent Eval
- Policy / Guardrail 改进
- UI / UX
- Daily Report
- 文档与示例

## 不接受的方向

请不要提交主要用于以下目的的功能：

- CAPTCHA bypass
- anti-detection / fingerprint spoofing
- proxy-pool based evasion
- 无限量 mass outreach
- 绕过平台风险控制

## Development

```bash
npm ci
npm run typecheck
npm test
npm run ci
npm run scan:redline
```

提交 PR 前请确认：

1. Review Mode 没有回归。
2. 新增核心逻辑有测试。
3. 浏览器动作保持 deterministic，不让 LLM 直接操作 selector / DOM。
4. 不把个人账号数据、Cookie、Token、API Key 放进 fixture 或日志。
5. Autopilot 行为变化要说明新的权限边界和失败策略。

## Bug report 建议包含

- Chrome 版本
- OS
- extension 版本 / commit
- Review 或 Autopilot Mode
- 相关 Agent Activity 日志
- 是否出现登录 / 验证码 / 风险页面

请先脱敏个人信息、Cookie、Token 和 API Key。
