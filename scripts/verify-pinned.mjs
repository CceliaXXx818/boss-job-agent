#!/usr/bin/env node
/**
 * verify-pinned.mjs —— P0-D3 版本锁定断言（CI 首步）。
 * 规则：
 *   1. docs/PINNED.md 必须存在且声明 DSH_NPM_VERSION（@deepseek-ai/dsh 精确版本）。
 *   2. 若 node_modules 中已安装 @deepseek-ai/dsh，断言其实测版本 === DSH_NPM_VERSION；
 *      未安装时打印提示（沙箱/低网速环境可能跳过安装，P1 接入时随集成一起安装并复核）。
 *   3. 根 package.json 的 dependencies/devDependencies 全部为精确版本（无 ^ ~ > < 通配），
 *      workspace 内部链接（*）单独放行。
 *   4. engines.node 下限 ≥ 22.13（node:sqlite 免 flag）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pinnedText = readFileSync(join(root, 'docs', 'PINNED.md'), 'utf8');

const failures = [];
const notes = [];

const pinnedLine = pinnedText.split('\n').find((l) => l.startsWith('DSH_NPM_VERSION='));
if (!pinnedLine) failures.push('docs/PINNED.md 缺少 DSH_NPM_VERSION= 行');
const pinnedDsh = pinnedLine ? pinnedLine.split('=')[1].trim() : '';

if (pinnedDsh && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pinnedDsh)) {
  failures.push(`PINNED 中的 DSH_NPM_VERSION 不是合法精确版本: ${pinnedDsh}`);
}

// 若已安装则实测断言
const installedDshJson = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
if (existsSync(installedDshJson)) {
  const installedVersion = JSON.parse(readFileSync(installedDshJson, 'utf8')).version;
  if (installedVersion !== pinnedDsh) {
    failures.push(`已安装 @deepseek-ai/dsh@${installedVersion} 与 PINNED ${pinnedDsh} 不一致`);
  } else {
    notes.push(`已安装 @deepseek-ai/dsh = ${installedVersion} ✔`);
  }
} else {
  notes.push(`@deepseek-ai/dsh 未本地安装（可选）：需要运行 Harness 时执行 npm i -D @deepseek-ai/dsh@${pinnedDsh}（锁版仍由本脚本+PINNED.md 强制）`);
}

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const roots = [pkg.dependencies ?? {}, pkg.devDependencies ?? {}];
for (const group of roots) {
  for (const [name, ver] of Object.entries(group)) {
    if (ver === '*') {
      notes.push(`${name}: workspace 链接（放行）`);
      continue;
    }
    if (!EXACT.test(ver)) failures.push(`${name} 版本 ${ver} 不是精确版本（应锁定，如 "1.2.3"）`);
  }
}

const nodeMin = pkg.engines?.node;
if (!nodeMin) {
  failures.push('package.json engines.node 未声明');
} else if (/22\.13/.test(nodeMin)) {
  notes.push(`engines.node = ${nodeMin} ✔`);
} else {
  failures.push(`engines.node=${nodeMin} 未达到 node:sqlite 免 flag 下限 22.13`);
}

if (failures.length > 0) {
  console.error('[verify:pinned] FAILED');
  for (const f of failures) console.error(`  ✘ ${f}`);
  process.exit(1);
}
console.log('[verify:pinned] OK');
for (const n of notes) console.log(`  • ${n}`);
