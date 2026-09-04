#!/usr/bin/env node
/**
 * agent:smoke —— 一键验证"模型调用自定义工具"闭环（路径 B 最小实证）。
 * 前置：DEEPSEEK_API_KEY（环境变量或根 .env）；自动把 DSH_HOME 指向仓库内缓存目录。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const env = { ...process.env };
// 无条件指向仓库内缓存目录：保证冒烟测试不触碰 ~/.dsh（含沙箱/真机均一致）
env.DSH_HOME = join(root, '.toolcache', 'dsh-home');
if (!env.DEEPSEEK_API_KEY) {
  try {
    const m = readFileSync(join(root, '.env'), 'utf8').match(/^DEEPSEEK_API_KEY\s*=\s*(\S+)\s*$/m);
    if (m?.[1]) env.DEEPSEEK_API_KEY = m[1];
  } catch {
    /* 下方报错 */
  }
}
if (!env.DEEPSEEK_API_KEY) {
  console.error('[agent:smoke] 缺少 DEEPSEEK_API_KEY（环境变量或根 .env）。');
  process.exit(2);
}
if (!existsSync(join(root, 'profiles', 'job-agent.patch.yml'))) {
  console.error('[agent:smoke] 未找到 profiles/job-agent.patch.yml。');
  process.exit(2);
}
const task = '调用 job_agent_echo 工具，传 text=B-min-OK，然后把工具返回的 text 原样告诉我';
console.log(`[agent:smoke] 任务：${task}`);
const bin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const child = spawn(
  process.execPath,
  [bin, '--profile', 'headless', '--patch', 'profiles/job-agent.patch.yml', task],
  { stdio: 'inherit', env },
);
child.on('exit', (code) => process.exit(code ?? 1));
