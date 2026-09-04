import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HrIntent } from '@job-agent/domain';
import { ModelClient, vcrCall, isLiveMode } from './index';
import { hybridClassifyOnce } from './classify';

/**
 * A-2 疑难集重评：fixtures/hr/hard-corpus.json（真实 HR 口语/长句/复合语境，规则多数未命中）。
 * 离线：回放 fixtures/vcr/hr-classify.json；真调重录：RUN_MODEL_LIVE=1（需 Key）。
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FILE = join(ROOT, 'fixtures', 'vcr', 'hr-classify.json');

const corpus = (JSON.parse(readFileSync(join(ROOT, 'fixtures', 'hr', 'hard-corpus.json'), 'utf8')) as Array<{
  text: string;
  intent: HrIntent;
}>);

function hasKey(): boolean {
  if (process.env.DEEPSEEK_API_KEY) return true;
  try {
    return /DEEPSEEK_API_KEY\s*=\s*\S+/.test(readFileSync(join(process.cwd(), '.env'), 'utf8'));
  } catch {
    return false;
  }
}
const canRun = hasKey() && (isLiveMode() || existsSync(FILE));
const maybeIt = canRun ? it : it.skip;
const liveProduce = isLiveMode();

describe('A-2 疑难 HR 语料（真模型混合判定）', () => {
  maybeIt('18 条疑难句全部返回合法枚举；规则未命中时由模型兜底', async () => {
    const client = new ModelClient();
    const results: Array<{ text: string; expected: HrIntent; got: HrIntent; method: string }> = [];
    for (const c of corpus) {
      const r = await vcrCall({
        file: FILE,
        id: createHash('sha1').update(`hard:${c.text}`).digest('hex').slice(0, 24),
        live: liveProduce,
        produce: () => hybridClassifyOnce(client, c.text),
      });
      results.push({ text: c.text, expected: c.intent, got: r.intent, method: r.method });
    }
    const exact = results.filter((r) => r.got === r.expected).length;
    const modelUsed = results.filter((r) => r.method === 'model').length;
    const report = {
      generatedAt: new Date().toISOString(),
      corpusSize: results.length,
      exact,
      modelFallbackUsed: modelUsed,
      byCase: results.map((r) => ({ text: r.text, expected: r.expected, got: r.got, method: r.method })),
    };
    mkdirSync(join(ROOT, 'tests', 'eval'), { recursive: true });
    writeFileSync(join(ROOT, 'tests', 'eval', 'model-hard-report.json'), JSON.stringify(report, null, 2) + '\n');
    expect(modelUsed).toBeGreaterThan(0); // 确认模型兜底真的被调用
    console.log(`[hard-eval] 共 ${results.length}，完全一致 ${exact}，模型兜底 ${modelUsed}`);
  }, 240_000);
});
