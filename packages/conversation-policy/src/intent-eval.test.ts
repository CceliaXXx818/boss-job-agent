import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HrIntent } from '@job-agent/domain';
import { classifyByRule } from './classifier';

/**
 * 意图评测（P2-①）：fixtures/hr/intent_corpus.json（≥200 条）→ 混淆矩阵 → report-latest.json。
 * 门槛：整体准确率 ≥95%（当前为规则覆盖集；接入模型后对疑难集重评，见 IMPLEMENTATION_PLAN P2）。
 */

const PKG_SRC = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url)); // conversation-policy/src -> packages -> root? src/.. = pkg? 
// 计算：src -> conversation-policy(..) -> packages(../..) -> root(../../..) = 3 层
const CORPUS_PATH = join(ROOT, 'fixtures', 'hr', 'intent_corpus.json');
const REPORT_PATH = join(ROOT, 'tests', 'eval', 'report-latest.json');

const corpus = (JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as {
  total: number;
  corpus: Array<{ text: string; intent: HrIntent }>;
}).corpus;

function evaluate(): {
  accuracy: number;
  matrix: Record<string, Record<string, number>>;
  failures: Array<{ text: string; expected: string; actual: string }>;
  perIntent: Record<string, { total: number; ok: number }>;
} {
  const matrix: Record<string, Record<string, number>> = {};
  const failures: Array<{ text: string; expected: string; actual: string }> = [];
  const perIntent: Record<string, { total: number; ok: number }> = {};
  for (const c of corpus) {
    const actual = classifyByRule(c.text).intent;
    matrix[c.intent] ??= {};
    matrix[c.intent][actual] = (matrix[c.intent][actual] ?? 0) + 1;
    perIntent[c.intent] ??= { total: 0, ok: 0 };
    perIntent[c.intent].total++;
    if (actual === c.intent) {
      perIntent[c.intent].ok++;
    } else {
      failures.push({ text: c.text, expected: c.intent, actual });
    }
  }
  const ok = Object.values(perIntent).reduce((a, b) => a + b.ok, 0);
  return { accuracy: ok / corpus.length, matrix, failures, perIntent };
}

describe('意图评测（P2-①）', () => {
  it('语料规模 ≥200 且唯一', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(200);
    expect(new Set(corpus.map((c) => c.text)).size).toBe(corpus.length);
  });

  it('规则覆盖集整体准确率 ≥95%（失败样例与混淆矩阵写入 report）', () => {
    const r = evaluate();
    const summary = {
      generatedAt: new Date().toISOString(),
      corpusSize: corpus.length,
      accuracy: Number((r.accuracy * 100).toFixed(2)),
      thresholdPercent: 95,
      failures: r.failures.slice(0, 100),
      perIntent: r.perIntent,
      worstIntent: Object.entries(r.perIntent)
        .filter(([, v]) => v.total > 0)
        .map(([k, v]) => ({ intent: k, accuracy: Number(((v.ok / v.total) * 100).toFixed(1)) }))
        .sort((a, b) => a.accuracy - b.accuracy),
    };
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(summary, null, 2) + '\n');

    if (r.accuracy < 0.95) {
      const topFails = r.failures.slice(0, 25).map((f) => `  ${f.text}  期望=${f.expected} 实际=${f.actual}`);
      throw new Error(
        `意图准确率 ${(r.accuracy * 100).toFixed(2)}% < 95%。失败样例：\n${topFails.join('\n')}\n完整报告: ${REPORT_PATH}`,
      );
    }
    expect(r.accuracy).toBeGreaterThanOrEqual(0.95);
  });
});
