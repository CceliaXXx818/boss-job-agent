// V0.5 Phase 3 修复回归：ai-client 与「本机 AI 服务真实响应形状」的契约测试
//
// 背景（真实事故）：server.ts 的 /score 成功时返回 `{ results: [...] }`，**没有 `ok` 字段**；
// Autopilot 的 stepScore 早期直接判断 `res.ok` → 把成功响应当成失败，
// 用户看到的就是 "Autopilot paused：评分失败"（而且 Resume 后又重评一遍，白花 token）。
//
// 这里用 fetch 打桩把服务端的真实响应形状搬进测试，防止再次漂移。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkHealth,
  getConfig,
  normalizePlanResponse,
  normalizeReplanResponse,
  normalizeScoreResponse,
  pickErrorMessage,
  planSearch,
  replanSearch,
  scoreJobs,
  buildScorePayload,
  buildGoalContext,
} from '../../../extension/ai-client.js';

type Route = { status?: number; body: unknown };

function stubFetch(routes: Record<string, Route | (() => Route)>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    const path = String(url).replace('http://127.0.0.1:8799', '');
    const route = routes[path];
    if (!route) throw new Error(`ECONNREFUSED ${path}`);
    const r = typeof route === 'function' ? route() : route;
    calls.push({ url: path, body: init?.body ? JSON.parse(init.body) : null });
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
    };
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/score 响应形状（真实服务端：{results} 没有 ok）', () => {
  it('拿到 {results:[...]} 时必须视为成功', async () => {
    stubFetch({
      '/score': {
        body: {
          results: [
            { jobId: 'j-1', ok: true, score: 88, tier: 'hot', label: '很匹配', strengths: [], concerns: [] },
            { jobId: 'j-2', ok: false, ruleBlocked: '命中硬排除：外包' },
          ],
        },
      },
    });
    const res = await scoreJobs({ jobs: [buildScorePayload({ jobId: 'j-1' })], goalContext: buildGoalContext({}) });
    expect(res.ok).toBe(true);
    expect(res.results).toHaveLength(2);
    expect(res.results[0]).toMatchObject({ jobId: 'j-1', score: 88 });
  });

  it('空 results 数组同样是成功（不是失败）', async () => {
    stubFetch({ '/score': { body: { results: [] } } });
    const res = await scoreJobs({ jobs: [] });
    expect(res.ok).toBe(true);
    expect(res.results).toEqual([]);
  });

  it('服务端 500 {error} → 失败并带上原因与 HTTP 状态', async () => {
    stubFetch({ '/score': { status: 500, body: { error: 'upstream model crashed' } } });
    const res = await scoreJobs({ jobs: [] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('upstream model crashed');
    expect(res.httpStatus).toBe(500);
  });

  it('已知错误会被翻译成人话（402 余额不足 / 超时）', async () => {
    stubFetch({ '/score': { status: 500, body: { error: 'deepseek 402 Insufficient Balance' } } });
    expect((await scoreJobs({ jobs: [] })).error).toContain('余额不足');
    stubFetch({ '/score': { status: 500, body: { error: 'TimeoutError: request timeout' } } });
    expect((await scoreJobs({ jobs: [] })).error).toContain('超时');
  });

  it('服务端 400（jobs 不能为空）→ 失败并带原因', async () => {
    stubFetch({ '/score': { status: 400, body: { error: 'jobs 不能为空' } } });
    const res = await scoreJobs({ jobs: [] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('jobs 不能为空');
  });

  it('AI 服务未启动（连接被拒）→ AI_SERVICE_UNAVAILABLE + 中文提示', async () => {
    stubFetch({});
    const res = await scoreJobs({ jobs: [] });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('AI_SERVICE_UNAVAILABLE');
    expect(res.error).toContain('score:serve');
  });

  it('服务端返回非 JSON → 明确报错而不是静默变成"评分失败"', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    }));
    const res = await scoreJobs({ jobs: [] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('无法解析');
  });
});

describe('normalizeScoreResponse / pickErrorMessage', () => {
  it('results 数组 → ok', () => {
    expect(normalizeScoreResponse({ results: [] }).ok).toBe(true);
  });

  it('其它形状 → 失败，并从 error/reason/message/detail 里取原因', () => {
    expect(normalizeScoreResponse({ error: 'x' }).error).toContain('x');
    expect(normalizeScoreResponse({ reason: 'y' }).error).toContain('y');
    expect(normalizeScoreResponse({ message: 'z' }).error).toContain('z');
    expect(normalizeScoreResponse({ detail: 'w' }).error).toContain('w');
    expect(normalizeScoreResponse({}, 502).error).toContain('502');
  });

  it('pickErrorMessage 会把已知错误翻译成人话', () => {
    expect(pickErrorMessage({ error: 'deepseek 402 Insufficient Balance' })).toContain('余额不足');
    expect(pickErrorMessage(null, 500)).toContain('500');
  });
});

describe('/health 与 /config', () => {
  it('/health → ok + version', async () => {
    stubFetch({ '/health': { body: { ok: true, version: '0.4.1' } } });
    const res = await checkHealth();
    expect(res.ok).toBe(true);
    expect(res.version).toBe('0.4.1');
  });

  it('/health 非 200 → 失败并提示 AI 服务异常', async () => {
    stubFetch({ '/health': { status: 503, body: {} } });
    const res = await checkHealth();
    expect(res.ok).toBe(false);
    expect(res.code).toBe('AI_SERVICE_UNAVAILABLE');
  });

  it('/config 不可用时返回空对象（不阻断）', async () => {
    stubFetch({});
    expect(await getConfig()).toEqual({});
  });
});

describe('/plan 与 /replan 响应形状', () => {
  it('/plan → {ok:true, plan}', async () => {
    stubFetch({
      '/plan': {
        body: {
          ok: true,
          plan: {
            goal: { rawGoal: 'g', cities: [{ name: '上海', code: '101020100' }], hardExclusions: [] },
            queries: [{ keyword: 'AI产品经理', cityName: '上海', cityCode: '101020100' }],
            successCriteria: { targetQualifiedJobs: 10 },
            mentionedCities: ['上海'],
          },
        },
      },
    });
    const res = await planSearch('上海 AI 产品经理', { cityName: '上海', cityCode: '101020100' });
    expect(res.ok).toBe(true);
    expect(res.plan.queries[0].keyword).toBe('AI产品经理');
  });

  it('/plan 失败 → {ok:false, error}', async () => {
    stubFetch({ '/plan': { status: 500, body: { ok: false, error: 'plan model failed' } } });
    const res = await planSearch('g', { cityName: '上海', cityCode: '101020100' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('plan model failed');
  });

  it('/replan → {ok:true, status, newQueries}', async () => {
    stubFetch({
      '/replan': { body: { ok: true, status: 'continue', reason: '补充搜索', newQueries: [{ keyword: '二轮词' }] } },
    });
    const res = await replanSearch({ goal: {}, searchedQueries: [], resultSummary: {}, replanCount: 0 });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('continue'); // payload 的决策状态不能被 HTTP 状态覆盖
    expect(res.httpStatus).toBe(200);
    expect(res.newQueries).toHaveLength(1);
  });

  it('归一化函数对缺少 ok 的旧/新形状都容错', () => {
    expect(normalizePlanResponse({ plan: { queries: [] } }).ok).toBe(true);
    expect(normalizeReplanResponse({ status: 'complete', newQueries: [] }).ok).toBe(true);
    expect(normalizePlanResponse({ error: 'x' }).ok).toBe(false);
    expect(normalizeReplanResponse({ error: 'x' }).ok).toBe(false);
  });
});

describe('契约防漂移（直接读 server.ts 的成功响应形状）', () => {
  const server = readFileSync(join(process.cwd(), 'packages', 'model-client', 'src', 'server.ts'), 'utf8');

  it('/score 成功响应确实是 { results }（没有 ok）—— 所以客户端必须做归一化', () => {
    expect(server).toMatch(/JSON\.stringify\(\{ results \}\)/);
    expect(server).not.toMatch(/JSON\.stringify\(\{ ok: true, results/);
  });

  it('/plan 与 /replan 成功响应带 ok', () => {
    expect(server).toMatch(/JSON\.stringify\(\{ ok: true, plan \}\)/);
    expect(server).toMatch(/JSON\.stringify\(\{ ok: true, \.\.\.result \}\)/);
  });
});

describe('engine 侧不再把"评分成功"当失败（回归）', () => {
  const engine = readFileSync(join(process.cwd(), 'extension', 'autopilot-engine.js'), 'utf8');

  it('stepScore 使用归一化后的 res.ok / res.results，并在失败时带上真实原因', () => {
    expect(engine).toMatch(/const res = await deps\.ai\.scoreJobs\(/);
    expect(engine).toMatch(/评分失败：\$\{res\?\.error \?\? 'AI 服务返回异常'\}/);
    expect(engine).not.toMatch(/pause: res\?\.error \?\? '评分失败'/);
  });

  it('评分按 SCORE_BATCH_SIZE 分批，并跳过已经评过分的岗位', () => {
    expect(engine).toMatch(/SCORE_BATCH_SIZE = 5/);
    expect(engine).toMatch(/const pending = buffer\.filter\(\(j\) => !already\.has\(j\.jobId\)\)/);
    expect(engine).toMatch(/nextStep: remaining > 0 \? AUTOPILOT_STEPS\.SCORE : AUTOPILOT_STEPS\.EVALUATE/);
  });
});
