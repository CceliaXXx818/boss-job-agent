#!/usr/bin/env node
/**
 * boss:login —— 第一步：仅打开 BOSS 主页，由你手动扫码登录（脚本零探测、零跳转）。
 * 登录态保存在 data/private/boss-profile（后续 boss:wizard 直接复用）。
 * 用法：完成后按【回车】关闭浏览器（或直接手动关窗，等同结束）。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const consent = join(root, 'data', 'consent.txt');
if (!existsSync(consent) || !/consent:job-application-agent/.test(readFileSync(consent, 'utf8'))) {
  console.error('[boss:login] 缺少 data/consent.txt 授权标记。停止。');
  process.exit(2);
}
const PROFILE = join(root, 'data', 'private', 'boss-profile');
mkdirSync(PROFILE, { recursive: true });

const rl = createInterface({ input: process.stdin, output: process.stdout });
const waitEnter = () => new Promise((resolve) => rl.once('line', resolve));

console.log('[boss:login] 启动浏览器（登录目录：data/private/boss-profile）...');
const launchOpts = { headless: false };
if (process.env.BOSS_CHROME === '1') {
  launchOpts.channel = 'chrome'; // 用系统 Chrome（真实指纹）
  launchOpts.ignoreDefaultArgs = ['--no-sandbox']; // 避免“不受支持的命令行标记”黄条
}
let browser;
try {
  browser = await chromium.launchPersistentContext(PROFILE, launchOpts);
} catch (e) {
  console.error(`[boss:login] 浏览器启动失败：${e?.message ?? e}`);
  console.error('[boss:login] 提示：BOSS_CHROME=1 需要本机装有 Google Chrome；否则去掉该变量使用内置内核。15 秒后退出。');
  await new Promise((r) => setTimeout(r, 15000));
  process.exit(3);
}
try {
  const page = browser.pages()[0] ?? (await browser.newPage());
  // 只打开主页；之后不做任何自动跳转或读取，避免触发风控自动刷新。
  try {
    await page.goto('https://www.zhipin.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    console.error(`[boss:login] 打开主页失败：${e.message}`);
    console.error('[boss:login] 请确认本机可访问 www.zhipin.com 且未使用会触发风控的网络环境后重试。');
    await new Promise((r) => setTimeout(r, 15000));
    process.exit(3);
  }
  await page.waitForTimeout(2500);
  try {
    const urlNow = page.url();
    const bodyNow = await page.evaluate(() => document.body?.innerText?.slice(0, 300) ?? '');
    if (urlNow === 'about:blank' || !bodyNow.trim()) {
      console.error('[boss:login] 检测到页面被清空（about:blank/无内容）。这是 BOSS 对自动化浏览器的风控动作；');
      console.error('[boss:login] 请换网络环境（如家庭宽带、关闭代理/VPN）后重试；我们不会绕过该检测。');
    }
  } catch { /* 忽略瞬时读取错误 */ }
  console.log('────────────────────────────────────────────');
  console.log('【请手动操作浏览器】');
  console.log(' 1) 若出现登录/二维码：用手机 BOSS App 扫码登录；');
  console.log(' 2) 若页面自动刷新或出现验证提示：请手动等待其稳定；若持续无法登录，');
  console.log('    请把页面上可见的文字告诉我（可能与本机网络环境有关，我们不绕过验证）；');
  console.log(' 3) 确认已登录并能浏览职位后，回到终端按【回车】关闭浏览器。');
  console.log('────────────────────────────────────────────');
  await waitEnter();
} catch (e) {
  console.error(`[boss:login] 出错：${e?.message ?? e}`);
  await new Promise((r) => setTimeout(r, 15000));
} finally {
  rl.close();
  await browser?.close().catch(() => {});
}
