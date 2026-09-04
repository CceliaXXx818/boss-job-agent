#!/usr/bin/env node
/**
 * boss-report —— 把扩展导出的 boss-jobs.csv 解析为可读日报（纯 Node，无 TS 依赖）。
 * 用法：node scripts/boss-report.mjs <boss-jobs.csv> [输出目录]
 * 说明：只做展示与基础归类（标题/公司/城市/经验/学历/薪资原文）；薪资数字为 BOSS 自定义字体，
 *       本脚本不试图解码（且薪资默认不参与过滤）。真实 JD 匹配在后续“抓详情”阶段接入。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [, , csvPath, outDirArg] = process.argv;
if (!csvPath || !existsSync(csvPath)) {
  console.error('用法: node scripts/boss-report.mjs <boss-jobs.csv> [输出目录]');
  process.exit(2);
}
const outDir = outDirArg ?? join(process.cwd(), 'reports');
mkdirSync(outDir, { recursive: true });

function parseCSV(text) {
  const rows = [];
  let cur = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { cur.push(field); field = ''; }
    else if (ch === '\n') { cur.push(field); field = ''; if (cur.some((c) => c.trim() !== '')) rows.push(cur); cur = []; }
    else field += ch;
  }
  return rows;
}

const rows = parseCSV(readFileSync(csvPath, 'utf8'));
const header = rows[0] ?? [];
const idx = (k) => header.indexOf(k);
const I = { title: idx('title'), salary: idx('salary'), company: idx('company'), area: idx('area'), jobId: idx('jobId'), href: idx('href'), lines: idx('lines') };

const jobs = rows.slice(1).map((r) => {
  const get = (k) => (I[k] >= 0 ? (r[I[k]] ?? '').trim() : '');
  const lineTokens = get('lines').split('|').map((s) => s.trim()).filter(Boolean);
  const exp = lineTokens.find((t) => /年/.test(t) && !t.includes('K')) ?? '';
  const edu = lineTokens.find((t) => /本科|硕士|大专|博士|学历/.test(t)) ?? '';
  const area = get('area') || lineTokens.find((t) => t.includes('·')) || '';
  const title = get('title') || lineTokens[0] || '';
  // 公司：行 tokens 中紧邻地区前的那个非空 token
  let company = get('company');
  if (!company) {
    const areaIdx = area ? lineTokens.indexOf(area) : -1;
    if (areaIdx > 0) company = lineTokens[areaIdx - 1];
  }
  return { title, company, area, exp, edu, salaryRaw: get('salary'), jobId: get('jobId'), href: get('href'), lines: lineTokens };
}).filter((j) => j.title && j.href);

const cities = new Set();
for (const j of jobs) {
  const m = j.area.match(/^(上海|北京|深圳|杭州|广州)/);
  if (m) cities.add(m[1]);
}
const lines = [];
lines.push(`# BOSS 导入岗位报告（只读 CSV → ${jobs.length} 条）`, '');
lines.push(`来源：${csvPath}`);
lines.push(`城市：${[...cities].join('、') || '未知'}`, '');
lines.push('| # | 岗位 | 公司 | 城市·区域 | 经验 | 学历 | 薪资(原文) |');
lines.push('|---|---|---|---|---|---|---|');
jobs.forEach((j, i) => {
  lines.push(`| ${i + 1} | ${j.title} | ${j.company} | ${j.area} | ${j.exp} | ${j.edu} | ${j.salaryRaw} |`);
});
const ts = new Date().toISOString().slice(0, 10);
const mdPath = join(outDir, `boss-imported-${ts}.md`);
writeFileSync(mdPath, lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(`\n报告已写入：${mdPath}`);
