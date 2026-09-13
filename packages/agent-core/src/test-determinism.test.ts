// 测试确定性护栏：Autopilot 用例不得把「真实今天」和「脚手架固定时钟」混用
//
// 真实事故：脚手架时钟固定在 2026-09-13T10:00，而部分用例用 `localDateKey()`（真实今天）
// 去写 legacy 计数键或读事件分区。真实日期一变（本地时间跨过 00:00），两者指向不同分区，
// 用例就会在"前一天全绿、第二天全红"之间反复横跳。
//
// 这类脆弱性必须在结构上禁止，而不是靠记忆。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'packages', 'agent-core', 'src');

describe('Autopilot 测试的时间确定性', () => {
  const autopilotTests = readdirSync(SRC).filter((f) => f.startsWith('autopilot-') && f.endsWith('.test.ts'));

  it('至少存在若干 Autopilot 测试文件（防止护栏失效后静默跳过）', () => {
    expect(autopilotTests.length).toBeGreaterThanOrEqual(5);
  });

  it('不允许裸用 localDateKey()（必须用脚手架的 h.dateKey()）', () => {
    const offenders: string[] = [];
    for (const file of autopilotTests) {
      const src = readFileSync(join(SRC, file), 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        // 允许显式传入日期/小时毫秒的场景（例如 new Date('2026-09-13T20:00:00')）
        if (/\blocalDateKey\(\)/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('脚手架提供 dateKey()，与固定时钟一致', async () => {
    const src = readFileSync(join(SRC, 'helpers', 'autopilot-harness.ts'), 'utf8');
    expect(src).toMatch(/function dateKey\(\)/);
    expect(src).toMatch(/localDateKey\(current\)/);
    expect(src).toMatch(/new Date\('2026-09-13T10:00:00'\)/); // 固定时钟，保证可复现
  });

  it('说明为什么：事件按本地日期分区，真实日期跨天会让两者分叉', () => {
    const src = readFileSync(join(SRC, 'helpers', 'autopilot-harness.ts'), 'utf8');
    expect(src).toContain('脚手架时钟对应的本地日期键');
  });
});
