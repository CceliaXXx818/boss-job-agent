import { createServer } from 'node:http';
import { DEFAULT_CANDIDATE, scoreJobWithModel, tierOf, DECISION_LABEL } from './score';
import type { JobScoreInput } from './score';
import { ModelClient } from './client';
import type { CandidateProfileText } from './score';

/**
 * A1 本机打分服务：POST http://127.0.0.1:8799/score
 * 请求：{ jobs:[{jobId,title,company?,area?,salaryAscii?,expEdu?,companyMeta?,descFull}], candidate?, salaryMinK? }
 * 响应：{ results:[{jobId,ok,score?,tier?,label?,strengths?,concerns?,matchedNote?,ruleBlocked?,error?}] }
 * 纪律：先规则闸（排除词/薪资下限），通过才调模型；本机只监听 127.0.0.1。
 */

const PORT = Number(process.env.SCORE_PORT ?? 8799);

function parseSalaryMinK(ascii: string): number | null {
  const m = ascii?.match(/^(\d{2,3})\s*[-~]/);
  return m ? Number(m[1]) : null;
}

function gateJob(j: JobScoreInput, candidate: CandidateProfileText, salaryMinK?: number): string | null {
  const blob = `${j.title} ${j.company ?? ''} ${j.expEdu.join(' ')} ${j.companyMeta.join(' ')}`.toLowerCase();
  for (const t of candidate.excludeTokens) if (blob.includes(t)) return `规则排除：含「${t}」`;
  if (salaryMinK != null) {
    const min = parseSalaryMinK(j.salaryAscii ?? '');
    if (min != null && min < salaryMinK) return `薪资下限 ${min}K < ${salaryMinK}K`;
  }
  return null;
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/score') {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      jobs?: Array<JobScoreInput & { jobId: string }>;
      candidate?: Partial<CandidateProfileText>;
      salaryMinK?: number;
    };
    const jobs = body.jobs ?? [];
    if (!jobs.length) {
      res.writeHead(400).end(JSON.stringify({ error: 'jobs 不能为空' }));
      return;
    }
    const candidate = { ...DEFAULT_CANDIDATE, ...(body.candidate ?? {}) };
    let client: ModelClient | null = null;
    const results = [];
    for (const j of jobs) {
      const input: JobScoreInput = {
        title: j.title,
        company: j.company,
        area: j.area,
        salaryAscii: j.salaryAscii,
        expEdu: j.expEdu ?? [],
        companyMeta: j.companyMeta ?? [],
        descFull: j.descFull ?? '',
      };
      const blocked = gateJob(input, candidate, body.salaryMinK);
      if (blocked) {
        results.push({ jobId: j.jobId, ok: false, ruleBlocked: blocked });
        continue;
      }
      try {
        if (!client) client = new ModelClient();
        const m = await scoreJobWithModel(client, input, candidate);
        const tier = tierOf(m.score);
        results.push({
          jobId: j.jobId,
          ok: true,
          score: m.score,
          tier,
          label: DECISION_LABEL[tier],
          strengths: m.strengths,
          concerns: m.concerns,
          matchedNote: m.matchedNote,
        });
      } catch (e) {
        results.push({ jobId: j.jobId, ok: false, error: (e as Error).message });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ results }));
  } catch (e) {
    res.writeHead(500).end(JSON.stringify({ error: (e as Error).message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[score:serve] 本机打分服务 http://127.0.0.1:${PORT}（只监听本机）`);
});
