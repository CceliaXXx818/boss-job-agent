// V0.5 Phase 1：Autopilot Policy 判定（autopilot-policy.js）单元测试
// 原则：Policy decides WHETHER —— 它是"是否允许自动联系"的唯一裁决点，
//       任何一条不满足都必须拒绝；平台风险（验证码/页面异常）必须升级为暂停。
import { describe, it, expect } from 'vitest';
import {
  evaluateAutopilotGreeting,
  previewAutopilotDecisions,
} from '../../../extension/autopilot-policy.js';
import { normalizeSettings, recordAutopilotConsent } from '../../../extension/settings.js';

const { settings: baseSettings } = normalizeSettings({
  mode: 'autopilot',
  minimumAutoGreetingScore: 80,
  dailyGreetingCap: 20,
  workingHours: { start: '09:00', end: '18:00' },
});
const autopilotSettings = recordAutopilotConsent(baseSettings, '2026-01-01T00:00:00.000Z');

/** 全条件满足的基线输入 */
const base = (over: Record<string, unknown> = {}) => ({
  settings: autopilotSettings,
  consent: autopilotSettings.consent,
  job: { jobId: 'j-1', score: 88, complete: true },
  hardExclusionHit: { hit: false },
  alreadyGreeted: false,
  dailyDone: 0,
  nowHHMM: '10:00',
  bossHealthy: true,
  captchaDetected: false,
  paused: false,
  ...over,
});

const ids = (r: { checks: Array<{ id: string; ok: boolean }> }) => r.checks.map((c) => c.id);
const failed = (r: { checks: Array<{ id: string; ok: boolean }> }) =>
  r.checks.filter((c) => !c.ok).map((c) => c.id);

describe('Policy 允许路径', () => {
  it('全条件满足 → allowed，且 10 条检查全部通过', () => {
    const r = evaluateAutopilotGreeting(base());
    expect(r.allowed).toBe(true);
    expect(r.shouldPause).toBe(false);
    expect(r.checks.length).toBe(10);
    expect(failed(r)).toEqual([]);
  });

  it('恰好等于阈值与上限边界仍允许', () => {
    const r = evaluateAutopilotGreeting(base({ job: { jobId: 'j-1', score: 80, complete: true }, dailyDone: 19 }));
    expect(r.allowed).toBe(true);
  });

  it('工作时间边界（起止点含）允许', () => {
    expect(evaluateAutopilotGreeting(base({ nowHHMM: '09:00' })).allowed).toBe(true);
    expect(evaluateAutopilotGreeting(base({ nowHHMM: '18:00' })).allowed).toBe(true);
  });

  it('检查项顺序稳定（审计可读）', () => {
    expect(ids(evaluateAutopilotGreeting(base()))).toEqual([
      'mode_autopilot',
      'consent',
      'template_valid',
      'not_paused',
      'within_working_hours',
      'score_threshold',
      'no_hard_exclusion',
      'not_greeted_before',
      'daily_cap',
      'job_complete',
    ]);
  });
});

describe('Policy 拒绝路径：逐条穷举', () => {
  it('非 Autopilot 模式 → 拒绝', () => {
    const s = normalizeSettings({ ...autopilotSettings, mode: 'review' }).settings;
    const r = evaluateAutopilotGreeting(base({ settings: s, consent: s.consent }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('当前不是 Autopilot 模式');
    expect(r.shouldPause).toBe(false);
  });

  it('未授权 → 拒绝', () => {
    const r = evaluateAutopilotGreeting(base({ consent: { autopilot: false } }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('用户尚未授权 Autopilot');
  });

  it('话术无效 → 拒绝（含设置里模板为空的情况）', () => {
    const r1 = evaluateAutopilotGreeting(base({ templateValid: false }));
    expect(r1.reason).toBe('打招呼话术无效');
    const empty = { ...autopilotSettings, greetingStrategy: { ...autopilotSettings.greetingStrategy, template: '' } };
    const r2 = evaluateAutopilotGreeting(base({ settings: empty }));
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toBe('打招呼话术无效');
  });

  it('暂停状态 → 拒绝', () => {
    const r = evaluateAutopilotGreeting(base({ paused: true }));
    expect(r.reason).toBe('Agent 处于暂停状态');
    expect(r.shouldPause).toBe(false); // 已经是暂停，不再重复请求暂停
  });

  it('非工作时间 → 拒绝，且原因含工作时间区间', () => {
    const r = evaluateAutopilotGreeting(base({ nowHHMM: '08:59' }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('09:00-18:00');
    expect(failed(r)).toEqual(['within_working_hours']);
  });

  it('分数低于阈值 → 拒绝', () => {
    const r = evaluateAutopilotGreeting(base({ job: { jobId: 'j-1', score: 79, complete: true } }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('低于阈值 80');
  });

  it('缺少分数视为 0 分 → 拒绝（不因数据缺失放行）', () => {
    const r = evaluateAutopilotGreeting(base({ job: { jobId: 'j-1', complete: true } }));
    expect(r.allowed).toBe(false);
    expect(failed(r)).toContain('score_threshold');
  });

  it('命中硬约束 → 拒绝（即使分数 95）', () => {
    const r = evaluateAutopilotGreeting(
      base({ job: { jobId: 'j-1', score: 95, complete: true }, hardExclusionHit: { hit: true, reason: '命中硬排除：外包' } }),
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('命中硬排除：外包');
  });

  it('此前已联系过 → 拒绝（跨天去重）', () => {
    const r = evaluateAutopilotGreeting(base({ alreadyGreeted: true }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('该岗位此前已联系过');
  });

  it('已达每日上限 → 拒绝（恰好等于上限也拒绝）', () => {
    const r = evaluateAutopilotGreeting(base({ dailyDone: 20 }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('已达今日上限 20');
    expect(evaluateAutopilotGreeting(base({ dailyDone: 21 })).allowed).toBe(false);
  });

  it('岗位信息不完整 → 拒绝', () => {
    const r = evaluateAutopilotGreeting(base({ job: { jobId: 'j-1', score: 90, complete: false } }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('岗位信息不完整（缺 jobId 等）');
  });

  it('多个条件同时不满足时短路在第一条失败项（reason 稳定可解释）', () => {
    const r = evaluateAutopilotGreeting(
      base({ job: { jobId: 'j-1', score: 10, complete: false }, alreadyGreeted: true }),
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('低于阈值'); // 阈值在顺序上先于去重/完整性
    expect(failed(r)).toEqual(['score_threshold']);
    // 短路语义：失败即停，后续未评估项不会出现在 checks 里（保持审计一致）
    expect(ids(r)).toEqual([
      'mode_autopilot',
      'consent',
      'template_valid',
      'not_paused',
      'within_working_hours',
      'score_threshold',
    ]);
  });

  it('缺少输入时不放行（fail-closed）', () => {
    expect(evaluateAutopilotGreeting({}).allowed).toBe(false);
    expect(evaluateAutopilotGreeting(undefined).allowed).toBe(false);
    expect(evaluateAutopilotGreeting({ settings: autopilotSettings }).allowed).toBe(false);
  });
});

describe('平台风险必须升级为暂停（不是静默跳过）', () => {
  it('验证码 → 拒绝 + shouldPause=true，且短路不再评估其它条件', () => {
    const r = evaluateAutopilotGreeting(base({ captchaDetected: true }));
    expect(r.allowed).toBe(false);
    expect(r.shouldPause).toBe(true);
    expect(r.reason).toContain('验证码');
    expect(ids(r)).toEqual(['no_captcha']);
  });

  it('BOSS 页面异常 → 拒绝 + shouldPause=true', () => {
    const r = evaluateAutopilotGreeting(base({ bossHealthy: false }));
    expect(r.allowed).toBe(false);
    expect(r.shouldPause).toBe(true);
    expect(r.reason).toContain('BOSS 页面状态异常');
  });

  it('验证码优先于页面异常（先报最高风险）', () => {
    const r = evaluateAutopilotGreeting(base({ captchaDetected: true, bossHealthy: false }));
    expect(ids(r)).toEqual(['no_captcha']);
  });

  it('平台风险优先于"未授权"（风险必须让 Agent 停下来）', () => {
    const r = evaluateAutopilotGreeting(base({ captchaDetected: true, consent: { autopilot: false } }));
    expect(r.shouldPause).toBe(true);
    expect(r.reason).toContain('验证码');
  });
});

describe('previewAutopilotDecisions（批量试算，不执行）', () => {
  const inputs = [
    base({ job: { jobId: 'ok', score: 90, complete: true } }),
    base({ job: { jobId: 'low', score: 60, complete: true } }),
    base({ job: { jobId: 'dup', score: 90, complete: true }, alreadyGreeted: true }),
  ];

  it('逐条给出结论且顺序与输入一致', () => {
    const out = previewAutopilotDecisions(inputs);
    expect(out.map((o) => o.jobId)).toEqual(['ok', 'low', 'dup']);
    expect(out.map((o) => o.allowed)).toEqual([true, false, false]);
  });

  it('空输入返回空数组', () => {
    expect(previewAutopilotDecisions([])).toEqual([]);
    expect(previewAutopilotDecisions(undefined)).toEqual([]);
  });
});
