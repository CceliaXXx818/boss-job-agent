#!/usr/bin/env node
/**
 * boss:cdp —— 连接"你自己已登录的 Chrome"（CDP），只读抓取岗位结构。
 * 前置：
 *   1) 用下面的命令启动一个独立 Chrome（不要关），在里面打开 www.zhipin.com 并扫码登录；
 *   2) 保持该窗口开着，再运行本脚本：
 *      npm run boss:cdp
 * 纪律：只读（URL 参数搜索 + 读取页面），不发招呼/简历/不提交表单。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const consent = join(root, 'data', 'consent.txt');
if (!existsSync(consent) || !/consent:job-application-agent/.test(readFileSync(consent, 'utf8'))) {
  console.error('[boss:cdp] 缺少 data/consent.txt 授权标记。停止。');
  process.exit(2);
}
const port = process.env.BOSS_CDP_PORT ?? '9222';
const endpoint = `http://127.0.0.1:${port}`;
const query = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'AI产品经理';
const city = process.argv.includes('--hangzhou') ? 101210100 : 101280600;
const noNav = process.argv.includes('--now'); // --now：不跳转，直接读取你当前打开的页面
const searchUrl = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(query)}&city=${city}`;

console.log(`[boss:cdp] 连接本机 Chrome（${endpoint}）...`);
let browser;
try {
  browser = await chromium.connectOverCDP(endpoint);
} catch (e) {
  console.error(`[boss:cdp] 连接失败：${e?.message ?? e}`);
  console.error('[boss:cdp] 请先用以下命令启动独立 Chrome 并完成 BOSS 登录（保持窗口开着）：');
  console.error('  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\');
  console.error('    --remote-debugging-port=9222 --user-data-dir="$HOME/boss-chrome"');
  process.exit(3);
}
try {
  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages()).filter((p) => !p.url().startsWith('devtools://'));
  const zhipinPages = pages.filter((p) => p.url().includes('zhipin.com'));
  // 优先"搜索结果页"（URL 含 /web/geek/jobs），其次任何 BOSS 页
  const page =
    zhipinPages.find((p) => /\/web\/geek\/jobs/.test(p.url())) ?? zhipinPages[0];
  if (!page) {
    console.error('[boss:cdp] 未发现已打开的 BOSS 标签页，请先在你的 Chrome 里打开 BOSS。');
    process.exit(3);
  }
  await page.bringToFront().catch(() => {});
  console.log('[boss:cdp] 已选中标签：', page.url());
  if (noNav) {
    if (/^https:\/\/www\.zhipin\.com\/?$/.test(page.url())) {
      console.error('[boss:cdp] 当前选中的是 BOSS 首页而非搜索结果页。请在 Chrome 中把“搜索结果”标签保持打开并激活，然后重跑。');
      console.error('[boss:cdp] 也可直接在这个标签里手动输入：AI产品经理（深圳），确认列表出现后再重跑本命令。');
      process.exit(4);
    }
    console.log('[boss:cdp] --now 模式：不跳转，等待列表稳定后直接读取当前页面…');
  } else {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  let found = 0;
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(3000);
    found = await page.evaluate(() => document.querySelectorAll('a[href*="/job_detail/"]').length);
    if (found > 0) break;
  }
  if (found === 0) {
    console.error('[boss:cdp] 40 秒内未找到岗位卡片。请人工检查浏览器：是否已登录/是否出现验证码。');
    process.exit(4);
  }
  const dump = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'))
      .filter((a) => (a.getAttribute('href') ?? '').includes('/job_detail/'))
      .slice(0, 15);
    const cards = links.map((a) => {
      const el = a.closest('li, .job-card-wrapper, [class*="job-card"], [class*="job-list"]') ?? a;
      const classChain = [];
      let node = el;
      for (let i = 0; i < 3 && node; i++) {
        const c = node.getAttribute?.('class');
        if (c) classChain.push(c.slice(0, 160));
        node = node.parentElement;
      }
      return {
        href: a.getAttribute('href'),
        textLines: (el.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 14),
        classChain,
        pageTitle: document.title,
      };
    });
    return { url: location.href, cards };
  });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const out = join(root, 'data', 'private', `boss-dump-${ts}.json`);
  writeFileSync(out, JSON.stringify(dump, null, 1));
  console.log(`[boss:cdp] 已导出 ${dump.cards.length} 条岗位结构 → ${out}`);
  console.log('[boss:cdp] 只读完成。把上面这行（或文件路径）发我，我来校准真实选择器。');
} catch (e) {
  console.error(`[boss:cdp] 出错：${e?.message ?? e}`);
  console.error('[boss:cdp] 请把红字发我（浏览器窗口保留不关）。');
  process.exit(5);
} finally {
  // 注意：不关闭用户浏览器，只断开连接
  await browser?.close().catch(() => {});
}
