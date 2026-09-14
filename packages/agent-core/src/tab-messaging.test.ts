// V0.5 修复回归：内容脚本通信可靠性（Receiving end does not exist）
//
// 真实事故：Autopilot 在"抓详情"阶段连续报
//   `详情抓取失败：Could not establish connection. Receiving end does not exist.`
// 连续 2 次就把 Session 暂停了。
// 根因：search 有"等内容脚本就绪"的轮询，而 detail/greet 只是"导航 → 固定等 4.2 秒 → 直接发消息"；
// 详情页在 inactive 标签里加载慢时 content script 尚未注入 → 消息发送必然失败；
// 内部那次重试同样不等就绪，于是两次都失败并升级为 PAUSED。
import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_TIMING,
  friendlyMessageError,
  isRetryableMessageError,
  pingTab,
  sendMessageReliably,
  waitForContentReady,
} from '../../../extension/tab-messaging.js';

const noSleep = async () => {};

/** 造一个可控的 send：按脚本返回/抛错，并记录调用次数 */
function makeSend(script: Array<{ ok?: unknown; throw?: string }>) {
  const calls: Array<{ tabId: number; message: any }> = [];
  let i = 0;
  const send = async (tabId: number, message: any) => {
    calls.push({ tabId, message });
    const step = script[Math.min(i, script.length - 1)];
    i++;
    if (step.throw) throw new Error(step.throw);
    return step.ok;
  };
  const count = (match?: { type: string }) =>
    match ? calls.filter((c) => c.message?.type === match.type).length : calls.length;
  return { send, calls, count };
}

describe('错误分类与文案', () => {
  it('识别可重试错误（Chrome 在不同版本措辞不同）', () => {
    for (const msg of [
      'Could not establish connection. Receiving end does not exist.',
      'The message port closed before a response was received.',
      // 真实事故：Chrome 实际报的是 "message channel closed"，此前只写了 "message port closed"
      'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received',
      'Extension context invalidated.',
      'No tab with id: 123',
    ]) {
      expect(isRetryableMessageError(msg), msg).toBe(true);
    }
    expect(isRetryableMessageError('Cannot access contents of the page')).toBe(false);
    expect(isRetryableMessageError('')).toBe(false);
  });

  it('channel closed 类错误会被内部重试，而不是直接升级成工具失败', async () => {
    const channelClosed =
      'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received';
    const { send, count } = makeSend([{ throw: channelClosed }, { ok: { ok: true, descFull: 'JD' } }]);
    const res = await sendMessageReliably({ send, sleep: noSleep, tabId: 3, message: { type: 'detailScrape' }, tries: 3, retryMs: 1 });
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(2);
    expect(count()).toBe(2);
    expect(friendlyMessageError(channelClosed)).toContain('未能');
  });

  it('错误翻译成人话（用户看得懂、知道怎么办）', () => {
    expect(friendlyMessageError('Could not establish connection. Receiving end does not exist.')).toContain('内容脚本未就绪');
    expect(friendlyMessageError('Extension context invalidated.')).toContain('重新加载');
    expect(friendlyMessageError('No tab with id: 5')).toContain('标签');
    expect(friendlyMessageError('随便什么错误')).toBe('随便什么错误');
  });
});

describe('waitForContentReady：先等就绪再发消息', () => {
  it('ping 失败若干次后成功 → 返回就绪', async () => {
    const { send, count } = makeSend([
      { throw: 'Receiving end does not exist' },
      { throw: 'Receiving end does not exist' },
      { ok: { url: 'https://www.zhipin.com/job_detail/x.html', cardCount: 1 } },
    ]);
    const res = await waitForContentReady({ send, sleep: noSleep, tabId: 1, tries: 5, delayMs: 1 });
    expect(res.ok).toBe(true);
    expect((res.page as { url?: string } | null)?.url).toContain('/job_detail/');
    expect(count()).toBe(3);
  });

  it('一直不可达 → 返回未就绪（不无限等）', async () => {
    const { send, count } = makeSend([{ throw: 'Receiving end does not exist' }]);
    const res = await waitForContentReady({ send, sleep: noSleep, tabId: 1, tries: 4, delayMs: 1 });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('内容脚本未注入');
    expect(count()).toBe(4); // 严格受 tries 约束
  });

  it('等待期间发现页面已跳到登录页 → 立即返回风险（比继续等更有用）', async () => {
    const { send } = makeSend([{ throw: 'Receiving end does not exist' }]);
    const checkRisk = async () => ({ risk: 'LOGIN_REQUIRED', reason: 'BOSS 登录状态已失效' });
    const res = await waitForContentReady({ send, sleep: noSleep, tabId: 1, checkRisk, tries: 5, delayMs: 1 });
    expect(res).toMatchObject({ ok: false, risk: 'LOGIN_REQUIRED' });
  });
});

describe('sendMessageReliably：可重试错误内部消化', () => {
  it('首次抛 Receiving end does not exist、第二次成功 → 返回成功（不打扰上层）', async () => {
    const { send, count } = makeSend([
      { throw: 'Could not establish connection. Receiving end does not exist.' },
      { ok: { ok: true, count: 20 } },
    ]);
    const res = await sendMessageReliably({ send, sleep: noSleep, tabId: 1, message: { type: 'scrape' }, tries: 3, retryMs: 1 });
    expect(res.ok).toBe(true);
    expect(res.response).toEqual({ ok: true, count: 20 });
    expect(res.attempts).toBe(2);
    expect(count()).toBe(2);
  });

  it('一直失败 → 返回可读错误，且调用次数有上界', async () => {
    const { send, count } = makeSend([{ throw: 'Receiving end does not exist' }]);
    const res = await sendMessageReliably({ send, sleep: noSleep, tabId: 1, message: {}, tries: 3, retryMs: 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('内容脚本未就绪');
    expect(count()).toBe(3);
  });

  it('不可重试的错误立即返回（不做无意义重试）', async () => {
    const { send, count } = makeSend([{ throw: 'Cannot access contents of the page' }]);
    const res = await sendMessageReliably({ send, sleep: noSleep, tabId: 1, message: {}, tries: 3, retryMs: 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Cannot access');
    expect(count()).toBe(1);
  });

  it('兜底：连续失败达阈值后 reload 一次标签，reload 后成功仍算成功', async () => {
    const { send, count } = makeSend([
      { throw: 'Receiving end does not exist' },
      { throw: 'Receiving end does not exist' },
      { ok: { ok: true, stage: 'sent' } },
    ]);
    const reload = vi.fn(async () => {});
    const res = await sendMessageReliably({
      send,
      sleep: noSleep,
      tabId: 7,
      message: { type: 'greetFull' },
      reload,
      tries: 4,
      retryMs: 1,
      reloadAfterFailures: 2,
    });
    expect(res.ok).toBe(true);
    expect(res.reloaded).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1); // 只 reload 一次，绝不反复刷页面
    // 业务消息共发 3 次（失败/失败/reload 后成功）；此外 reload 后还会做一次就绪探测
    expect(count({ type: 'greetFull' } as never)).toBe(3);
  });

  it('reload 期间页面跳到验证码页 → 返回风险原因（而不是工具失败）', async () => {
    const { send } = makeSend([{ throw: 'Receiving end does not exist' }]);
    let riskChecks = 0;
    const checkRisk = async () => {
      riskChecks++;
      return riskChecks >= 2 ? { risk: 'CAPTCHA', reason: '检测到验证码' } : null;
    };
    const res = await sendMessageReliably({ send, sleep: noSleep, tabId: 1, message: {}, checkRisk, tries: 3, retryMs: 1 });
    expect(res).toMatchObject({ ok: false, risk: 'CAPTCHA' });
  });

  it('默认参数有硬上界（不会无限重试）', () => {
    expect(DEFAULT_TIMING.messageTries).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_TIMING.messageTries).toBeLessThanOrEqual(5);
    expect(DEFAULT_TIMING.readyTries * DEFAULT_TIMING.readyMs).toBeLessThanOrEqual(20_000);
  });
});

describe('pingTab', () => {
  it('响应为空也视为"未就绪"（返回 null 而不是空对象）', async () => {
    const send = async () => undefined;
    expect(await pingTab({ send, tabId: 1 })).toBeNull();
  });

  it('抛错被吞掉并返回 null（ping 不应中断流程）', async () => {
    const send = async () => {
      throw new Error('boom');
    };
    expect(await pingTab({ send, tabId: 1 })).toBeNull();
  });
});

describe('适配器接线（结构断言，防止回退到"固定 sleep 后直接发消息"）', () => {
  const src = require('node:fs').readFileSync('extension/background.js', 'utf8') as string;

  it('detail / greet / search 都走统一的 navigateAndAsk（先等就绪再发消息）', () => {
    expect(src).toMatch(/async function navigateAndAsk\(/);
    expect(src).toMatch(/const res = await navigateAndAsk\(tabId, `https:\/\/www\.zhipin\.com\$\{job\.href\}`/);
    // greet 现在传对象参数（含 readyCheck），因此只断言它走 navigateAndAsk + readyCheck
    const greetBlock = src.slice(src.indexOf('async function greet(tabId, action)'), src.indexOf('return { getContext, health, ensureTab'));
    expect(greetBlock).toContain('await navigateAndAsk(');
    expect(greetBlock).toContain("type: 'greetFull'");
    expect(greetBlock).toContain('readyCheck: true');
    expect(src).toMatch(/await navigateAndAsk\(tabId, url, \{ type: 'scrape' \}\)/);
  });

  it('不再出现"固定 sleep 后直接 tabs.sendMessage"的旧写法', () => {
    expect(src).not.toMatch(/await sleep\(4200\);\s*\n\s*const res = await chrome\.tabs\.sendMessage/);
    expect(src).not.toMatch(/await sleep\(3000\);\s*\n\s*for \(let i = 0; i < CONTENT_WAIT_TRIES/);
  });

  it('风险判定不依赖 content script，且集中在 page-risk.js 纯函数里', () => {
    expect(src).toMatch(/function classifyRisk\(page, tab = null\)/);
    expect(src).toMatch(/checkTabRisk/);
    expect(src).toMatch(/classifyPageRisk\(\{ page, tab \}\)/);
    const risk = require('node:fs').readFileSync('extension/page-risk.js', 'utf8') as string;
    expect(risk).toMatch(/classifyPageRisk/);
    expect(risk).toMatch(/tab\?\.url/); // 用标签页自身信息兜底
  });

  it('详情解析要求"真的拿到内容"才算成功', () => {
    expect(src).toMatch(/function hasDetailContent\(res\)/);
    expect(src).toMatch(/validate: \(response\) =>/);
  });
});

describe('bfcache 与页面内容就绪（真实事故）', () => {
  it('bfcache 措辞被识别为可重试（导航时旧页面进入 bfcache）', () => {
    const msg = 'The page keeping the extension port is moved into back/forward cache, so the message channel is closed.';
    expect(isRetryableMessageError(msg)).toBe(true);
    expect(friendlyMessageError(msg)).toContain('bfcache');
  });

  it('重试前会重新等待页面就绪（否则会把消息又发给已进入 bfcache 的旧页面）', async () => {
    const n = 2;
    let calls = 0;
    const { send } = makeSend([...Array(n).fill({ throw: 'Receiving end does not exist' }), { ok: { ok: true } }]);
    const waitReady = vi.fn(async () => {});
    const res = await sendMessageReliably({
      send,
      sleep: noSleep,
      tabId: 1,
      message: {},
      waitReady,
      tries: 3,
      retryMs: 1,
    });
    expect(res.ok).toBe(true);
    calls = waitReady.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(1); // 每次可重试失败后都会先等就绪
  });

  it('isUsable：能应答但仍在加载态时，继续等待而不算就绪', async () => {
    const pages = [
      { url: 'https://www.zhipin.com/job_detail/x.html', loading: true, cardCount: 0 },
      { url: 'https://www.zhipin.com/job_detail/x.html', loading: true, cardCount: 0 },
      { url: 'https://www.zhipin.com/job_detail/x.html', loading: false, cardCount: 0 },
    ];
    let i = 0;
    const send = async () => pages[Math.min(i++, pages.length - 1)];
    const res = await waitForContentReady({
      send,
      sleep: noSleep,
      tabId: 1,
      isUsable: (p: { loading?: boolean }) => p.loading === false,
      tries: 5,
      delayMs: 1,
    });
    expect(res.ok).toBe(true);
    expect(i).toBe(3);
  });

  it('一直处于加载态 → 返回 timeout 标记（上层按"页面级"处理，不暂停整个 Session）', async () => {
    const send = async () => ({ url: 'https://www.zhipin.com/job_detail/x.html', loading: true, cardCount: 0 });
    const res = await waitForContentReady({
      send,
      sleep: noSleep,
      tabId: 1,
      isUsable: (p: { loading?: boolean }) => p.loading === false,
      tries: 3,
      delayMs: 1,
    });
    expect(res.ok).toBe(false);
    expect(res.timeout).toBe(true);
    expect(res.reason).toContain('加载超时');
  });
});
