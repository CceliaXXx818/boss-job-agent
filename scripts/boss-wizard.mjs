#!/usr/bin/env node
/**
 * boss:wizard —— 真实 BOSS 只读校准向导（范围 A，不含任何外发动作）。
 * 交互式：打开浏览器 → 你扫码/确认登录 → 回到终端按【回车】→ 导出岗位卡片结构。
 * 纪律：只读；搜索用 URL 参数；不出错静默退出（出错停留 15s 并打印说明）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
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

const rl = createInterface({ input: process.stdin, output: process.stdout });
const waitEnter = () => new Promise((resolve) => rl.once('line', resolve));

let browser;
const pauseOnExit = async (ms) => new Promise((r) => setTimeout(r, ms));
try {
  console.log('[boss:wizard] 启动浏览器（持久登录目录：data/private/boss-profile）...');
  browser = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: { width: 1360, height: 900 } });
  const page = browser.pages()[0] ?? (await browser.newPage());

  console.log('[boss:wizard] 打开 BOSS 首页/推荐页，请在弹出的浏览器里完成登录...');
  try {
    await page.goto('https://www.zhipin.com/web/geek/recommend', { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    console.error(`[boss:wizard] 打开首页失败：${e.message}`);
    console.error('[boss:wizard] 若提示网络/连接问题，请确认本机可访问 www.zhipin.com 后重试。');
    await pauseOnExit(15000);
    process.exit(3);
  }
  await page.waitForTimeout(3000);

  console.log('────────────────────────────────────────────');
  console.log('【请操作浏览器】');
  console.log(' 1) 若出现二维码/登录页：用手机 BOSS App 扫码登录；');
  console.log(' 2) 确认已进入求职页面（能看到推荐/搜索内容）；');
  console.log(' 3) 然后回到【这个终端】按回车键继续。');
  console.log('────────────────────────────────────────────');
  await waitEnter();

  console.log(`[boss:wizard] 打开搜索页：${searchUrl}`);
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    console.error(`[boss:wizard] 打开搜索页失败：${e.message}`);
    await pauseOnExit(15000);
    process.exit(3);
  }
  // 等待岗位卡片出现（最多约 40s）
  let found = 0;
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(3000);
    found = await page.evaluate(
      () => document.querySelectorAll('a[href*="/job_detail/"]').length,
    );
    if (found > 0) break;
  }
  if (found === 0) {
    console.error('[boss:wizard] 40 秒内未在搜索页找到岗位卡片。可能原因：未登录 / 出现验证码 / 页面结构变化。');
    console.error('[boss:wizard] 请人工在浏览器里确认状态后告诉我现象（本窗口 15 秒后关闭）。');
    await pauseOnExit(15000);
    process.exit(3);
  }

  const dump = await page.evaluate(() => {
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
  });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const out = join(DUMP_DIR, `boss-dump-${ts}.json`);
  writeFileSync(out, JSON.stringify(dump, null, 1));
  console.log(`[boss:wizard] 已导出 ${dump.cards.length} 条岗位结构 → ${out}`);
  console.log('[boss:wizard] 只读完成。把上面这行输出（或文件路径）发我，我来校准真实选择器。');
  await pauseOnExit(5000);
} catch (e) {
  console.error(`[boss:wizard] 出错：${e?.message ?? e}`);
  console.error('[boss:wizard] 请把以上红字发给我（浏览器 15 秒后关闭）。');
  await pauseOnExit(15000);
} finally {
  rl.close();
  await browser?.close().catch(() => {});
}
