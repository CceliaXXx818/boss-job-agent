// greeting-builder.js —— V0.5 统一 Greeting 构建（Review / Autopilot 共用）
// 原则：话术对用户可见、可修改、可固化；V0.5 只实现 template；
//      jd_personalized 仅保留接口（Phase 之后实现，且必须只引用真实经历与 JD 明确要求）。

import { validateGreetingTemplate } from './settings.js';

export const GREETING_STRATEGY_MODES = Object.freeze(['template', 'jd_personalized']);

/**
 * @param {{
 *   job?: {jobId?: string, title?: string, company?: string},
 *   candidateProfile?: object,
 *   goal?: object,
 *   greetingStrategy?: {mode: string, templateId?: string, template?: string}
 * }} [input] 缺少有效 greetingStrategy 时抛错（绝不发送不可见话术）
 * @returns {{
 *   message: string,
 *   strategy: {mode: string, templateId: string},
 *   metadata: {
 *     builtAt: string,
 *     jobId: string|null,
 *     jobTitle: string|null,
 *     templateId: string,
 *     length: number,
 *     personalizedFields: string[]
 *   }
 * }}
 */
export function buildGreetingMessage(input) {
  const strategy = input?.greetingStrategy ?? {};
  const mode = strategy.mode ?? 'template';

  if (!GREETING_STRATEGY_MODES.includes(mode)) {
    throw new Error(`未知的 greeting strategy：${mode}`);
  }
  if (mode === 'jd_personalized') {
    // 明确占位：V0.5 不实现个性化生成，避免"不可见话术"被自动发送
    throw new Error('jd_personalized 尚未实现（V0.5 仅支持 template）');
  }

  const check = validateGreetingTemplate(strategy.template);
  if (!check.ok) throw new Error(`greeting template 无效：${check.reason}`);

  return {
    message: String(strategy.template).trim(),
    strategy: { mode: 'template', templateId: String(strategy.templateId ?? 'default') },
    metadata: {
      builtAt: new Date().toISOString(),
      jobId: input?.job?.jobId ?? null,
      jobTitle: input?.job?.title ?? null,
      templateId: String(strategy.templateId ?? 'default'),
      length: check.length,
      personalizedFields: [], // 未来 jd_personalized 会填充；template 模式恒为空
    },
  };
}
