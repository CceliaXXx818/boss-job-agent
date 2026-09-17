// 内容脚本消息处理的结构护栏（真实事故回归）
//
// 事故：Autopilot 抓详情时反复失败，错误是
//   "A listener indicated an asynchronous response by returning true,
//    but the message channel closed before a response was received"
// 根因：content.js 里的异步 handler 写成 `detailScrapeFull().then(sendResponse)` 而**没有 .catch**。
// 只要内部抛错（页面布局异常、document.body 未就绪……），Promise 就 reject，
// sendResponse 永远不被调用 —— 发送端看到的就是"通道关闭"，被误判成连接问题。
//
// 内容脚本是 classic script（不能用 ESM import），无法直接单测；
// 因此这里用结构断言锁住"必须恰好回一次消息"这一契约。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const content = readFileSync(join(process.cwd(), 'extension', 'content.js'), 'utf8');
const listenerStart = content.indexOf('chrome.runtime.onMessage.addListener');
const listener = content.slice(listenerStart, content.indexOf('});', listenerStart) + 3);

describe('content.js：只要答应了异步回复，就必须恰好回一次', () => {
  it('提供 respondSync / respondAsync 统一封装', () => {
    expect(content).toMatch(/function respondSync\(fn, sendResponse\)/);
    expect(content).toMatch(/function respondAsync\(fn, sendResponse\)/);
    expect(content).toMatch(/\.catch\(\(e\) => \{/);
  });

  it('异步 handler（detailScrape / greetFull）都走 respondAsync 并返回 true', () => {
    expect(listener).toMatch(/respondAsync\(\(\) => detailScrapeFull\(\), sendResponse\)/);
    expect(listener).toMatch(/respondAsync\(\(\) => greetFull\(/);
    // 两个异步分支都必须 return true（Chrome 要求显式声明异步）
    const asyncBranches = listener.match(/respondAsync\([\s\S]*?return true;/g) ?? [];
    expect(asyncBranches.length).toBe(2);
  });

  it('同步 handler 也走 respondSync（内部抛错时回 {ok:false} 而不是让通道静默关闭）', () => {
    for (const type of ['pageHealth', 'scrape', 'greet', 'bossContext', 'diagnose']) {
      expect(listener).toContain(`msg?.type === '${type}'`);
    }
    expect(listener).toMatch(/respondSync\(\(\) => pageHealth\(\), sendResponse\)/);
    expect(listener).toMatch(/respondSync\(\(\) => cardRows|respondSync\(\(\) => \{\s*\n\s*const rows = cardRows\(\)/);
  });

  it('不再出现"裸的 .then(sendResponse)"写法（事故根因）', () => {
    // 允许 respondAsync 封装内部的那一次 .then；监听器里不允许再直连 sendResponse
    expect(listener).not.toMatch(/\.then\(\(r\) => sendResponse\(/);
    expect(listener).not.toMatch(/\.then\(sendResponse\)/);
    // 整个文件里 .then 只允许出现在 respondAsync 封装中（Promise.resolve().then(fn).then(send)）
    const asyncWrapper = content.slice(
      content.indexOf('function respondAsync'),
      content.indexOf('chrome.runtime.onMessage.addListener'),
    );
    const thenOutsideWrapper = (content.match(/\.then\(/g) ?? []).length - (asyncWrapper.match(/\.then\(/g) ?? []).length;
    expect(thenOutsideWrapper).toBe(0);
  });

  it('detailScrapeFull 首次解析包在 try/catch 里（抛出可读错误而不是静默失败）', () => {
    const body = content.slice(content.indexOf('async function detailScrapeFull()'));
    expect(body.slice(0, 400)).toMatch(/try \{\s*\n\s*first = detailScrape\(\);/);
  });

  it('回复体里带 stage/error 字段，便于上游归类（内容脚本错误 vs 连接错误）', () => {
    expect(content).toContain("stage: 'content_error'");
    expect(content).toMatch(/ok: false, error: String\(e\?\.message \?\? e\), stage: 'content_error'/);
  });
});

describe('页面加载态：能应答 ≠ 内容可用（真实事故：打招呼时页面还在"加载中"）', () => {
  it('pageHealth 汇报 loading 与 textLength（供上游判断内容是否可用）', () => {
    expect(content).toMatch(/function isPageLoading\(\)/);
    expect(content).toMatch(/loading: isPageLoading\(\)/);
    expect(content).toMatch(/textLength:/);
  });

  it('isPageLoading 覆盖三种加载态信号（readyState / 占位符 / 文案）', () => {
    const body = content.slice(content.indexOf('function isPageLoading()'), content.indexOf('function pageHealth()'));
    expect(body).toContain("document.readyState !== 'complete'");
    expect(body).toMatch(/page-loading/);
    expect(body).toMatch(/加载中/);
  });

  it('greetFull 与 detailScrapeFull 都会先等页面脱离加载态', () => {
    const greet = content.slice(content.indexOf('async function greetFull'), content.indexOf('async function greetFull') + 600);
    expect(greet).toContain('await waitForPageReady(');
    const detail = content.slice(content.indexOf('async function detailScrapeFull'), content.indexOf('async function detailScrapeFull') + 600);
    expect(detail).toContain('await waitForPageReady(');
  });

  it('入口是异步出现的 → clickEntrance 有界重试（而不是一次找不到就报 no_chat_entrance）', () => {
    expect(content).toMatch(/async function clickEntrance\(\{ attempts = 3, waitMs = 2500 \} = \{\}\)/);
    expect(content).toMatch(/async function clickEntranceOnce\(\)/);
    const body = content.slice(content.indexOf('async function clickEntrance({'), content.indexOf('async function clickEntranceOnce()'));
    expect(body).toContain('await clickEntranceOnce()');
    expect(body).toMatch(/for \(let round = 0; round < attempts; round\+\+\)/);
  });

  it('等页面就绪有硬上界（不会无限等待）', () => {
    expect(content).toMatch(/async function waitForPageReady\(\{ tries = 12, delayMs = 1200 \} = \{\}\)/);
  });
});

describe('失败现场证据：pageHealth 必须带回"页面显示了什么"', () => {
  it('pageHealth 含 bodyPreview（截断 + 压缩空白）', () => {
    expect(content).toMatch(/bodyPreview:/);
    const body = content.slice(content.indexOf('function pageHealth()'), content.indexOf('function respondSync'));
    expect(body).toContain('.replace(/\\s+/g, \' \')');
    expect(body).toContain('.slice(0, 160)');
  });

  it('pageHealth 同时含 loading / textLength（供上游判断内容是否可用）', () => {
    const body = content.slice(content.indexOf('function pageHealth()'), content.indexOf('function respondSync'));
    expect(body).toContain('loading: isPageLoading()');
    expect(body).toContain('textLength:');
  });
});
