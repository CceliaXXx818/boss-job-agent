// autopilot-policy.js —— Autopilot 是否允许自动打招呼（纯函数，§13 十二条件）
// 关键原则：Policy decides WHETHER；本模块不执行任何动作，也不修改设置。
// 语义：条件按固定顺序短路求值 —— 首个失败项即原因，之后的检查不再执行
//       （checks 只保留已执行部分，便于审计"为什么停在这里"）。

import { isWithinWorkingHours, validateGreetingTemplate } from './settings.js';

/**
 * 输入整体可缺省：缺省即"不满足条件 → 拒绝"（fail-closed），不抛错。
 * @param {{
 *   settings?: object,
 *   consent?: {autopilot?: boolean},
 *   job?: {jobId?: string, score?: number, complete?: boolean},
 *   hardExclusionHit?: {hit: boolean, reason?: string},
 *   alreadyGreeted?: boolean,
 *   dailyDone?: number,
 *   nowHHMM?: string,
 *   bossHealthy?: boolean,
 *   captchaDetected?: boolean,
 *   paused?: boolean,
 *   templateValid?: boolean
 * }} [input]
 * @returns {{allowed: boolean, reason: string, shouldPause: boolean, checks: Array<{id: string, ok: boolean, reason?: string}>}}
 */
export function evaluateAutopilotGreeting(input) {
  const s = input?.settings ?? {};
  const checks = [];
  const add = (id, ok, reason) => {
    checks.push({ id, ok: !!ok, reason: reason ?? null });
    return !!ok;
  };

  // 8/9 先判平台风险：验证码 → 拒绝并请求暂停（spec §33）
  const captcha = input?.captchaDetected === true;
  if (captcha) {
    add('no_captcha', false, '检测到验证码/风险页面');
    return { allowed: false, reason: '检测到验证码或风险页面：已暂停，需你人工处理 BOSS 页面。', shouldPause: true, checks };
  }

  const bossHealthy = input?.bossHealthy !== false;
  if (!bossHealthy) {
    add('boss_healthy', false, 'BOSS 页面状态异常');
    return { allowed: false, reason: 'BOSS 页面状态异常：已暂停，需你人工处理。', shouldPause: true, checks };
  }

  const ok =
    add('mode_autopilot', s.mode === 'autopilot', '当前不是 Autopilot 模式') &&
    add('consent', input?.consent?.autopilot === true, '用户尚未授权 Autopilot') &&
    add('template_valid', input?.templateValid ?? validateGreetingTemplate(s.greetingStrategy?.template).ok, '打招呼话术无效') &&
    add('not_paused', input?.paused !== true, 'Agent 处于暂停状态') &&
    add(
      'within_working_hours',
      input?.nowHHMM ? isWithinWorkingHours(input.nowHHMM, s.workingHours?.start, s.workingHours?.end) : true,
      `当前不在工作时间内（${s.workingHours?.start}-${s.workingHours?.end}）`,
    ) &&
    add('score_threshold', Number(input?.job?.score ?? 0) >= Number(s.minimumAutoGreetingScore ?? 80),
      `分数低于阈值 ${s.minimumAutoGreetingScore ?? 80}`) &&
    add('no_hard_exclusion', !input?.hardExclusionHit?.hit, input?.hardExclusionHit?.reason ?? '命中硬排除') &&
    add('not_greeted_before', input?.alreadyGreeted !== true, '该岗位此前已联系过') &&
    add('daily_cap', Number(input?.dailyDone ?? 0) < Number(s.dailyGreetingCap ?? 20),
      `已达今日上限 ${s.dailyGreetingCap ?? 20}`) &&
    add('job_complete', input?.job?.complete !== false, '岗位信息不完整（缺 jobId 等）');

  if (ok) return { allowed: true, reason: '满足全部 Policy 条件，允许自动联系。', shouldPause: false, checks };

  const firstFail = checks.find((c) => !c.ok);
  return { allowed: false, reason: firstFail?.reason ?? '未通过 Policy 检查', shouldPause: false, checks };
}

/**
 * 批量试算（不执行）：返回允许/拒绝清单，用于 Autopilot Dashboard 预览。
 * @param {Array<Parameters<typeof evaluateAutopilotGreeting>[0]>} [inputs]
 * @returns {Array<{jobId: string|null, allowed: boolean, reason: string, shouldPause: boolean, checks: Array<{id: string, ok: boolean, reason?: string|null}>}>}
 */
export function previewAutopilotDecisions(inputs) {
  return (inputs ?? []).map((i) => ({ jobId: i?.job?.jobId ?? null, ...evaluateAutopilotGreeting(i) }));
}
