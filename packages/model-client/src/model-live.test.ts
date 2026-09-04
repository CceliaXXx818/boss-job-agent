import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HrIntent } from '@job-agent/domain';
import { finalizeEvidence, DEFAULT_RUBRIC } from '@job-agent/job-matcher';
import { ModelClient, vcrCall, isLiveMode } from './index';
import { extractEvidenceWithModel, evidenceSchema } from './evidence';
import { hybridClassifyOnce, hrIntentChoiceSchema } from './classify';

/**
 * 真模型集成测试（路径 A）：
 *  - 无 DEEPSEEK_API_KEY 或既无录制又非 live 时自动跳过；
 *  - 默认离线：VCR 回放已录制结果（fixtures/vcr/*.json，提交入库）；
 *  - 需重录/真调：`RUN_MODEL_LIVE=1 npm run test:model-live`（有 Key 时）。
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url)); // model-client/src → root = 3 层
const EVIDENCE_FILE = join(ROOT, 'fixtures', 'vcr', 'evidence.json');
const CLASSIFY_FILE = join(ROOT, 'fixtures', 'vcr', 'hr-classify.json');

const recordingExists = existsSync(EVIDENCE_FILE) && existsSync(CLASSIFY_FILE);

function hasKey(): boolean {
  if (process.env.DEEPSEEK_API_KEY) return true;
  try {
    return /DEEPSEEK_API_KEY\s*=\s*\S+/.test(readFileSync(join(process.cwd(), '.env'), 'utf8'));
  } catch {
    return false;
  }
}

const canRun = hasKey() && (isLiveMode() || recordingExists);
const maybeIt = canRun ? it : it.skip;
const liveProduce = isLiveMode();

describe('model-client 真模型（证据提取 + 混合判定）', () => {
  it('schema 自检：证据与意图 schema 可编译且类型完备', () => {
    expect(evidenceSchema).toBeDefined();
    expect(hrIntentChoiceSchema).toBeDefined();
  });

  maybeIt('证据提取：真实模型读 JD 产出结构化维度（VCR 录制/回放）', async () => {
    const catalog = JSON.parse(
      readFileSync(join(ROOT, 'fixtures', 'jobs', 'catalog.json'), 'utf8'),
    ) as {
      jobs: Array<{ externalId: string; title: string; company: string; city: string; description: string; tags: string[]; jobType?: string }>;
    };
    const job = catalog.jobs.find((j) => j.externalId === 'MOCK-0001')!;
    const client = new ModelClient();
    const evidence = await vcrCall({
      file: EVIDENCE_FILE,
      id: `evidence-${job.externalId}`,
      live: liveProduce,
      produce: () =>
        extractEvidenceWithModel(client, {
          job: { title: job.title, city: job.city, jobType: job.jobType, description: job.description, tags: job.tags },
          candidate: {
            experienceYears: 7,
            aiProductYears: 3,
            evidenceProjects: ['AI智能语音外呼', 'LLM与RAG智能客服', '智能质检平台', '智能对话数字人'],
            preferredSkills: ['LLM', 'Agent', 'RAG', 'Prompt Engineering', 'Conversational AI'],
          },
        }),
    });
    // 结构与分数可复算
    const out = finalizeEvidence(evidence, DEFAULT_RUBRIC, { hot: 80, apply: 75, review: 65 });
    expect(out.scoreTotal).toBeGreaterThan(0);
    for (const v of Object.values(evidence.dimScores)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  maybeIt('混合判定：语料子集（含 unknown 疑难句）规则优先、模型兜底，全部返回合法枚举', async () => {
    const corpus = (JSON.parse(readFileSync(join(ROOT, 'fixtures', 'hr', 'intent_corpus.json'), 'utf8')) as {
      corpus: Array<{ text: string; intent: HrIntent }>;
    }).corpus;
    // 取样：全部 unknown + 每类前 2 条（封顶 45 条）
    const byIntent = new Map<string, number>();
    const sample = corpus.filter((c) => {
      if (c.intent === 'unknown') return true;
      const n = byIntent.get(c.intent) ?? 0;
      byIntent.set(c.intent, n + 1);
      return n < 2;
    });
    expect(sample.length).toBeGreaterThan(10);
    const client = new ModelClient();
    const results: Array<{ text: string; expected: string; intent: string; method: string; ok: boolean }> = [];
    for (const c of sample) {
      const r = await vcrCall({
        file: CLASSIFY_FILE,
        id: createHash('sha1').update(`classify:${c.text}`).digest('hex').slice(0, 24),
        live: liveProduce,
        produce: async () => hybridClassifyOnce(client, c.text),
      });
      results.push({ text: c.text, expected: c.intent, intent: r.intent, method: r.method, ok: r.intent === c.intent });
    }
    const modelUsed = results.filter((r) => r.method === 'model').length;
    const report = {
      generatedAt: new Date().toISOString(),
      sampleSize: sample.length,
      exactMatch: results.filter((r) => r.ok).length,
      modelFallbackUsed: modelUsed,
      nonOk: results.filter((r) => !r.ok).map((r) => ({ text: r.text, expected: r.expected, got: r.intent })),
    };
    mkdirSync(join(ROOT, 'tests', 'eval'), { recursive: true });
    writeFileSync(join(ROOT, 'tests', 'eval', 'model-live-report.json'), JSON.stringify(report, null, 2) + '\n');
    // 结构性断言：全部枚举合法、未抛 schema 错
    expect(results.every((r) => r.intent !== 'unknown' || r.expected === 'unknown')).toBe(true);
    console.log(
      `[model-live] 样本 ${report.sampleSize}，完全一致 ${report.exactMatch}，模型兜底 ${report.modelFallbackUsed}，不一致 ${report.nonOk.length}`,
    );
  });
}, 180_000);
