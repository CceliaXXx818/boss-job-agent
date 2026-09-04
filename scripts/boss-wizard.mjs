#!/usr/bin/env node
/**
 * boss:wizard —— 真实 BOSS 只读校准向导（范围 A，不含任何外发动作）。
 * 流程：打开 BOSS 求职搜索页 → 你在弹出的浏览器窗口扫码登录 → 脚本自动检测登录态
 *       → 导出前 N 条岗位卡片的页面结构到 data/private/boss-dump-<ts>.json（git 忽略）。
 * 前置：node_modules 已含 playwright；浏览器内核请先执行 npx playwright install chromium。
 * 纪律：本脚本只读；不点击打招呼/发简历，不提交任何表单（搜索用 URL 参数完成）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const consent = join(root, 'data', 'consent.txt');
if (!existsSync(consent) || !/consent:job-application-agent/.test(readFileSync(consent, 'utf8'))) {
  console.error('[boss:wizard] 缺少 data/consent.txt 授权标记。停止。');
  process.exit(2);
}

const PROFILE = join(root, 'data', 'private', 'boss-profile');
const DUMP_DIR = join(root, 'data', 'private');
mkdirSync(PROFILE, { recursive: true });

const query = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'AI产品经理';
const city = process.argv.includes('--hangzhou') ? 101210100 : 101280600; // 深圳 101280600 / 杭州 101210100
const searchUrl = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(query)}&city=${city}`;

const browser = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: { width: 1360, height: 900 } });
try {
  const page = browser.pages()[0] ?? (await browser.newPage());
  console.log(`[boss:wizard] 打开求职搜索页：${searchUrl}`);
  await page.goto('https://www.zhipin.com/web/geek/recommend', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  console.log('[boss:wizard] 若出现登录/二维码，请用手机 BOSS App 扫码登录（约 30–120 秒）。');
  // 粗略登录检测：页面主体不再出现“扫码/登录”提示，最多等 180 秒
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const body = (await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? '')) as string;
    const loginish = /登录|扫码|验证/.test(body);
    if (!loginish) {
      console.log('[boss:wizard] 检测到已登录。');
      break;
    }
    await page.waitForTimeout(5000);
  }
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const dump = (await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'))
      .filter((a) => (a.getAttribute('href') ?? '').includes('/job_detail/'))
      .slice(0, 15);
    const cards = links.map((a) => {
      const el = a.closest('li, .job-card-wrapper, [class*="job-card"], [class*="job-list"]') ?? a;
      return {
        href: a.getAttribute('href'),
        title: a.innerText.split('\n')[0] ?? '',
        textLines: (el.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 12),
        boxClass: (el.getAttribute('class') ?? '').slice(0, 120),
        pageTitle: document.title,
      };
    });
    return { url: location.href, cards };
  })) as { url: string; cards: unknown[] };
  if (dump.cards.length === 0) {
    console.error('[boss:wizard] 未抓取到岗位卡片。可能原因：未登录/出现验证/页面结构变化。请在浏览器里人工确认后重跑。');
    process.exit(3);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const out = join(DUMP_DIR, `boss-dump-${ts}.json`);
  writeFileSync(out, JSON.stringify(dump, null, 1));
  console.log(`[boss:wizard] 已导出 ${dump.cards.length} 条岗位结构 → ${out}`);
  console.log('[boss:wizard] 只读完成。现在把该文件路径告诉我，我来校准真实选择器。');
} finally {
  await browser.close();
}
