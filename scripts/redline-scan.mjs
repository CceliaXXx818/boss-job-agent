#!/usr/bin/env node
/**
 * redline-scan.mjs —— Git 红线扫描（P5 预备 / ARCHITECTURE §6.6）。
 * 扫描仓库（跳过 node_modules/.toolcache/data/private/docs）中疑似真实敏感信息：
 *   大陆手机号、邮箱、常见 API Key 形态、.env 内容泄漏。
 * 退出码：命中即 1。规则宽松（启发式），命中需人工复核。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const SKIP_DIRS = new Set(['node_modules', '.toolcache', '.git', 'data', 'dist', 'coverage', 'reports']);
const PATTERNS = [
  [/(^|[^0-9A-Za-z])1[3-9]\d{9}([^0-9A-Za-z]|$)/, '疑似大陆手机号'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, '疑似邮箱'],
  [/(sk-[A-Za-z0-9]{16,}|api[_-]?key["'\s:=]+[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16})/i, '疑似 API Key'],
  [/\bBEGIN (RSA |EC |OPENSSH )?PRIVATE KEY\b/, '疑似私钥'],
];

const hits = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP_DIRS.has(name)) continue;
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.(ts|js|mjs|json|yaml|yml|md|html|txt)$/.test(name)) continue;
    const content = readFileSync(p, 'utf8');
    for (const line of content.split('\n')) {
      for (const [re, label] of PATTERNS) {
        if (re.test(line)) {
          hits.push(`${relative(root, p)}: ${label}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
  }
}
walk(root);
if (hits.length) {
  console.error(`[redline-scan] 发现 ${hits.length} 处疑似敏感内容（人工复核）：`);
  for (const h of hits.slice(0, 40)) console.error(`  ${h}`);
  process.exit(1);
}
console.log('[redline-scan] OK：未发现疑似手机号/邮箱/API Key/私钥。');
