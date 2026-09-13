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

/** 从各种错误响应里取出人类可读原因（服务端字段名不完全统一） */
export function pickErrorMessage(json, status) {
  const raw =
    json?.error ??
    json?.reason ??
    json?.message ??
    json?.detail ??
    (status ? `HTTP ${status}` : null);
  return raw == null ? null : friendlyError(String(raw));
}

/** 统一 POST：网络/服务异常都被归类为 ok:false + error，不抛错 */
async function postJson(path, body, timeout) {
  try {
    const res = await fetch(`${AI_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!json) {
      return {
        ok: false,
        error: `AI 服务返回无法解析的响应（${path}，HTTP ${res.status}）`,
        status: res.status,
        code: 'AI_SERVICE_UNAVAILABLE',
      };
    }
    return { ...json, httpStatus: res.status, _httpOk: res.ok };
  } catch (e) {
    return { ok: false, error: friendlyError(e?.message ?? e), code: 'AI_SERVICE_UNAVAILABLE' };
  }
}

/**
 * /score 的响应归一化（重要）：
 * 服务端成功时返回 `{ results: [...] }`，**没有 `ok` 字段**；失败时返回 `{ error }`。
 * 早期版本直接判断 `res.ok` 会把成功的响应当成失败（Autopilot 会一直"评分失败"），
 * 因此这里统一归一化成 `{ ok, results }`。
 */
export function normalizeScoreResponse(json, httpStatus = 200) {
  const results = json?.results;
  if (Array.isArray(results)) {
    return { ok: true, results, httpStatus };
  }
  return {
    ok: false,
    results: [],
    httpStatus,
    error: pickErrorMessage(json, httpStatus) ?? '评分服务返回异常',
  };
}

/** /plan 归一化：成功 `{ok:true, plan}`，失败 `{ok:false, error}` */
export function normalizePlanResponse(json, httpStatus = 200) {
  if (json?.plan) return { ok: true, plan: json.plan, warnings: json.warnings ?? [], httpStatus };
  return { ok: false, httpStatus, error: pickErrorMessage(json, httpStatus) ?? '规划服务返回异常' };
}

/** /replan 归一化：成功 `{ok:true, status, newQueries|reason}` */
/**
 * 注意：/replan 的 payload 自带 `status`（'continue' | 'complete'，表示补充搜索决策），
 * 因此 HTTP 状态码必须放在 `httpStatus`，不能覆盖 payload.status（否则引擎会永远读不到 'continue'）。
 */
export function normalizeReplanResponse(json, httpStatus = 200) {
  if (json?.ok === true || json?.status || Array.isArray(json?.newQueries)) {
    return { ...json, httpStatus, ok: true };
  }
  return { ok: false, httpStatus, error: pickErrorMessage(json, httpStatus) ?? '补充搜索服务返回异常' };
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
  const json = await postJson('/plan', { goal: rawGoal, context }, AI_TIMEOUTS.plan);
  return normalizePlanResponse(json, json.httpStatus);
}

/** @param {{goal: object, searchedQueries: object[], resultSummary: object, replanCount: number}} input */
export async function replanSearch(input) {
  const json = await postJson(
    '/replan',
    {
      goal: input.goal,
      searchedQueries: input.searchedQueries,
      resultSummary: input.resultSummary,
      replanCount: input.replanCount,
    },
    AI_TIMEOUTS.replan,
  );
  return normalizeReplanResponse(json, json.httpStatus);
}

/**
 * @param {{jobs: object[], salaryMinK?: number, goalContext?: object}} input
 * @returns {Promise<{ok: boolean, results: any[], httpStatus?: number, error?: string, code?: string}>}
 */
export async function scoreJobs(input) {
  const json = await postJson(
    '/score',
    { jobs: input.jobs, salaryMinK: input.salaryMinK, goalContext: input.goalContext },
    AI_TIMEOUTS.score,
  );
  if (json.code === 'AI_SERVICE_UNAVAILABLE') return { ok: false, results: [], error: json.error, code: json.code };
  return normalizeScoreResponse(json, json.httpStatus);
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
