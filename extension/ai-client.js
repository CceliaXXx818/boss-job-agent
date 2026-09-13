// ai-client.js —— 本机 AI 服务客户端（Side Panel 与 Background 共用）
//
// Phase 3 抽取：Review（Side Panel）与 Autopilot（Background SW）必须调用同一套
// /plan、/replan、/score、/health，不允许各自复制一份。
// 本模块只做 HTTP + 错误归类，不做任何业务判断，也不碰 DOM。

export const AI_BASE = 'http://127.0.0.1:8799';

export const AI_TIMEOUTS = {
  health: 3000,
  plan: 60000,
  replan: 90000,
  score: 180000,
};

/** 把底层错误翻译成用户能看懂的话（Phase 3：Background 也要用同一套文案） */
export function friendlyError(msg) {
  const s = String(msg ?? '');
  if (s.includes('402') || s.includes('Insufficient Balance')) {
    return 'AI 服务账户余额不足（DeepSeek 402），请充值后再开始。';
  }
  if (s.includes('401') || s.includes('Unauthorized')) {
    return 'AI 服务鉴权失败（401），请检查 DEEPSEEK_API_KEY。';
  }
  if (s.includes('TimeoutError') || s.includes('aborted') || s.includes('timeout')) {
    return 'AI 服务响应超时，请稍后重试或检查本地服务。';
  }
  if (s.includes('ECONNREFUSED') || s.includes('Failed to fetch') || s.includes('NetworkError')) {
    return 'AI 服务未连接，请先在本机运行 npm run score:serve。';
  }
  if (s.includes('EADDRINUSE')) {
    return '端口 8799 已被占用：请先停掉旧进程（lsof -ti :8799 | xargs kill）再启动。';
  }
  return s;
}

/** 统一 POST：网络/服务异常都被归类为 ok:false + reason，不抛错 */
async function postJson(path, body, timeout) {
  try {
    const res = await fetch(`${AI_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const json = await res.json();
    return json ?? { ok: false, error: `AI 服务返回空响应（${path}）` };
  } catch (e) {
    return { ok: false, error: friendlyError(e?.message ?? e), code: 'AI_SERVICE_UNAVAILABLE' };
  }
}

export async function checkHealth(timeout = AI_TIMEOUTS.health) {
  try {
    const res = await fetch(`${AI_BASE}/health`, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return { ok: false, error: `AI 服务异常（HTTP ${res.status}）`, code: 'AI_SERVICE_UNAVAILABLE' };
    const json = await res.json();
    return { ok: true, version: json?.version ?? null };
  } catch (e) {
    return { ok: false, error: friendlyError(e?.message ?? e), code: 'AI_SERVICE_UNAVAILABLE' };
  }
}

export async function getConfig() {
  try {
    const res = await fetch(`${AI_BASE}/config`, { signal: AbortSignal.timeout(AI_TIMEOUTS.health) });
    return (await res.json()) ?? {};
  } catch {
    return {};
  }
}

/** @param {string} rawGoal @param {{cityName: string, cityCode: string}} context */
export async function planSearch(rawGoal, context) {
  return postJson('/plan', { goal: rawGoal, context }, AI_TIMEOUTS.plan);
}

/** @param {{goal: object, searchedQueries: object[], resultSummary: object, replanCount: number}} input */
export async function replanSearch(input) {
  return postJson(
    '/replan',
    {
      goal: input.goal,
      searchedQueries: input.searchedQueries,
      resultSummary: input.resultSummary,
      replanCount: input.replanCount,
    },
    AI_TIMEOUTS.replan,
  );
}

/** @param {{jobs: object[], salaryMinK?: number, goalContext: object}} input */
export async function scoreJobs(input) {
  return postJson(
    '/score',
    { jobs: input.jobs, salaryMinK: input.salaryMinK, goalContext: input.goalContext },
    AI_TIMEOUTS.score,
  );
}

/** /score 请求体的构造规则（Review 与 Autopilot 共用，避免两边字段漂移） */
export function buildScorePayload(job) {
  return {
    jobId: job.jobId,
    title: job.title || job.name || '',
    company: job.company || '',
    area: job.area || '',
    salaryAscii: job.asciiSalary || job.salaryAscii || '',
    expEdu: job.expEdu || [],
    companyMeta: job.companyMeta || [],
    descFull: job.descFull || '',
  };
}

/** goalContext 构造（Review 与 Autopilot 共用） */
export function buildGoalContext(goal) {
  return {
    cities: (goal?.cities ?? []).map((c) => c.name),
    salaryMinK: goal?.salaryMinK,
    hardExclusions: goal?.hardExclusions ?? [],
    softNegativePreferences: goal?.softNegativePreferences ?? [],
    targetTitles: goal?.targetTitles ?? [],
    preferredSkills: goal?.preferredSkills ?? [],
  };
}
