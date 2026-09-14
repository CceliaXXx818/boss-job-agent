// page-risk.js —— 平台风险判定（纯函数，只依据"事实"判断，可在 Node 里完整测试）
//
// 设计原则：
//   · 只看 URL / 标题这类**不需要解析 DOM** 的事实；卡片数量只作为"是否已渲染"的参考，
//     **绝不**用来推断"未登录/未选城市"。
//   · 真实事故（假阳性）：把"列表此刻没有卡片"当成 BROWSER_CONTEXT_INVALID 并暂停，
//     但用户既登录着、城市也选着——真实原因通常是"该关键词没有结果"或"列表还在异步渲染"。
//     误判的代价是：把正常流程停掉，用户完全不知道自己哪里做错了。
//   · 没有把握的情况一律**不判风险**（宁可继续跑，也不误停）。

import { RISK_REASONS } from './autopilot-runtime.js';

/**
 * 页面 URL / 标题是否已经表明平台需要人工处理
 * @param {{page?: any, tab?: any}} [input]
 * @returns {{risk: string, reason: string}|null}
 */
export function classifyPageRisk({ page = null, tab = null } = {}) {
  const url = String(page?.url ?? tab?.url ?? '');
  const title = String(page?.title ?? tab?.title ?? '');
  const blob = `${url} ${title}`;

  if (/captcha|geetest|\/safe\/|verify|security-check/i.test(blob)) {
    return { risk: RISK_REASONS.CAPTCHA, reason: '检测到验证码/安全校验页面，已暂停，请人工处理 BOSS 页面' };
  }
  if (/\/web\/user\/|\/login|登录/i.test(blob)) {
    return { risk: RISK_REASONS.LOGIN_REQUIRED, reason: 'BOSS 登录状态已失效，请重新登录后再 Resume' };
  }
  if (/风险|异常|限制/.test(title)) {
    return { risk: RISK_REASONS.RISK_PAGE, reason: `BOSS 页面提示异常（${title}），已暂停` };
  }
  // 注意：**不要**根据 cardCount === 0 判定风险。
  // 空列表可能是"无结果"或"尚未渲染"，两种情况都不该暂停整个 Autopilot。
  return null;
}

/**
 * 列表页"是不是空的"这件事单独表达，便于上层决定"重试等一下"还是"跳过该关键词"。
 * @param {{page?: any, tab?: any}} [input]
 * @returns {{empty: boolean, risk: {risk: string, reason: string}|null, reason: string|null}}
 */
export function inspectJobListPage({ page = null, tab = null } = {}) {
  const risk = classifyPageRisk({ page, tab });
  if (risk) return { empty: false, risk, reason: risk.reason };
  const cardCount = page?.cardCount;
  const url = String(page?.url ?? tab?.url ?? '');
  const isListPage = /\/web\/geek\/jobs/.test(url);
  if (!isListPage) return { empty: false, risk: null, reason: null };
  if (cardCount === null || cardCount === undefined) return { empty: false, risk: null, reason: null };
  return { empty: Number(cardCount) === 0, risk: null, reason: null };
}
