# Roadmap

BOSS Job Agent 按“逐步开放自主权”的方式迭代：先保证可控、可审计、可恢复，再增加更高风险的自动动作。

## ✅ v0.5 — Job Autopilot

当前版本重点：**Discovery + Outreach + Reporting**

- [x] Natural-language Goal
- [x] Planner + Browser Context
- [x] Search / Hard Filter / Detail / AI Score
- [x] Adaptive Replan
- [x] Review Mode
- [x] Autopilot Mode
- [x] Explicit Consent
- [x] Configurable Greeting Strategy
- [x] Autopilot Policy
- [x] Background Service Worker
- [x] Persistent Runtime
- [x] Action Queue
- [x] Event Store / Job State
- [x] Daily Cap / Working Hours
- [x] Pause / Resume / Stop
- [x] Risk Pause
- [x] Daily Report

## 🔜 v0.6 — Conversation Loop

计划方向，不承诺具体发布日期。

- [ ] Read-only HR Message Monitor
- [ ] Message deduplication
- [ ] Conversation → Job mapping
- [ ] Intent Classification
- [ ] User notification for manual follow-up
- [ ] Resume-request workflow with stricter authorization gates

## 💡 Later

- [ ] JD-personalized Greeting
- [ ] Candidate Pool / cross-day reuse
- [ ] Preference Memory
- [ ] Outcome-driven search optimization
- [ ] Agent Evals / strategy metrics
- [ ] Additional job platforms

## Product principles

1. **LLM decides WHAT.**
2. **Deterministic tools decide HOW.**
3. **Policy decides WHETHER.**
4. 高风险动作使用更严格的 gate。
5. 默认可控，不以“无限自动化”为目标。
6. 不做 CAPTCHA bypass、anti-detection、proxy-pool evasion 或指纹伪装。
