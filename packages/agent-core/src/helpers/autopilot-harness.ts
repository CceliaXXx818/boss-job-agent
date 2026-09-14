// Autopilot 引擎测试脚手架：真实业务模块 + 内存 chrome + 假浏览器/假 AI
// 目的：在 Node 里完整驱动 bounded step machine，验证启动校验、轮次、cap、恢复、风险暂停。

import { makeChrome, installChrome, type ChromeStub } from './chrome-stub.js';
import { createAutopilotEngine } from '../../../../extension/autopilot-engine.js';
import { AUTOPILOT_STATUS, AUTOPILOT_STEPS, loadRuntime, RUNTIME_KEY } from '../../../../extension/autopilot-runtime.js';
import { localDateKey } from '../../../../extension/event-store.js';
import * as settings from '../../../../extension/settings.js';
import * as events from '../../../../extension/event-store.js';
import * as states from '../../../../extension/job-state.js';
import * as queue from '../../../../extension/action-queue.js';
import * as records from '../../../../extension/agent-records.js';
import * as policy from '../../../../extension/autopilot-policy.js';
import * as greeting from '../../../../extension/greeting-builder.js';
import * as core from '../../../../extension/core-logic.js';

export type JobSpec = {
  jobId: string;
  title?: string;
  company?: string;
  href?: string;
  tags?: string;
  salary?: string;
  city?: string;
  score?: number;
};

/** 造一个不含系统硬排除词的岗位 */
export function makeJob(spec: JobSpec) {
  return {
    jobId: spec.jobId,
    title: spec.title ?? 'AI 产品经理',
    company: spec.company ?? '某科技公司',
    href: spec.href ?? `/job_detail/${spec.jobId}.html`,
    tags: spec.tags ?? '3-5年|本科|AI',
    salary: spec.salary ?? '30-50K',
    city: spec.city ?? '上海',
    score: spec.score ?? 88,
  };
}

export const CITY = { cityName: '上海', cityCode: '101020100', pageType: 'job_list', url: 'https://www.zhipin.com/web/geek/jobs?city=101020100' };

export type HarnessOptions = {
  jobs?: ReturnType<typeof makeJob>[];
  /** 第二轮 / replan 返回的岗位 */
  round2Jobs?: ReturnType<typeof makeJob>[];
  settings?: Record<string, unknown>;
  planQueries?: string[];
  initialStorage?: Record<string, unknown>;
  now?: Date;
  greetResults?: Array<{ ok: boolean; error?: string; risk?: string; reason?: string }>;
  /** 让第 N 次 /score 调用失败（从 1 开始计数），用于测试评分失败与 Resume 后的续评 */
  scoreFailAt?: number[];
  scoreError?: string;
  browserFails?: { search?: number; detail?: number };
  /** detail 失败的类型：transport（默认，工具/连接问题）或 page（该页面解析失败） */
  detailFailureKind?: 'transport' | 'page';
  /** 让第 N 个详情失败（从 1 开始），用于测试"个别坏页面被跳过" */
  detailFailAt?: number[];
  context?: Record<string, unknown> | null;
  searchRows?: (query: { keyword: string; round?: number }) => ReturnType<typeof makeJob>[];
  replanResponses?: Array<Record<string, unknown>>;
};

/** 默认（合法、可启动）的 Autopilot 设置 */
export function autopilotSettings(over: Record<string, unknown> = {}) {
  return {
    mode: 'autopilot',
    consent: { autopilot: true, autopilotAt: '2026-09-13T00:00:00.000Z', autoResume: false, autoResumeAt: null },
    dailyGreetingCap: 5,
    minimumAutoGreetingScore: 80,
    batchQualifiedTarget: 10,
    maxDiscoveryRounds: 3,
    maxReplanPerRound: 1,
    workingHours: { start: '00:00', end: '23:59' },
    greetingStrategy: { mode: 'template', templateId: 'default', template: '你好，我想聊聊这个岗位。', updatedAt: null },
    ...over,
  };
}

export function createHarness(opts: HarnessOptions = {}) {
  const jobs = opts.jobs ?? [makeJob({ jobId: 'j-1', score: 88 }), makeJob({ jobId: 'j-2', score: 85 })];
  const chromeStub: ChromeStub = makeChrome(opts.initialStorage ?? {});
  installChrome(chromeStub);

  const activities: string[] = [];
  const calls = {
    search: [] as string[],
    detail: [] as string[],
    greet: [] as string[],
    plan: 0,
    replan: 0,
    score: 0,
    scoreBatches: [] as string[][],
    pause: [] as string[],
  };

  let current = opts.now ? new Date(opts.now) : new Date('2026-09-13T10:00:00');
  const greetResults = [...(opts.greetResults ?? [])];
  const scoreFailAt = new Set(opts.scoreFailAt ?? []);
  let searchFailsLeft = opts.browserFails?.search ?? 0;
  let detailFailsLeft = opts.browserFails?.detail ?? 0;
  const replanResponses = [...(opts.replanResponses ?? [])];

  const browser: {
    getContext(): Promise<any>;
    health(): Promise<{ risk: string | null; reason?: string; tabMissing?: boolean }>;
    ensureTab(id?: number | null): Promise<{ tabId: number; reused: boolean }>;
    search(tabId: number, query: { keyword: string; round?: number }): Promise<any>;
    detail(tabId: number, job: { jobId: string }): Promise<any>;
    greet(tabId: number, action: { jobId: string }): Promise<any>;
  } = {
    async getContext() {
      return opts.context === undefined ? { ...CITY } : opts.context;
    },
    async health() {
      return { risk: null };
    },
    async ensureTab() {
      return { tabId: 101, reused: false };
    },
    async search(_tabId: number, query: { keyword: string; round?: number }) {
      calls.search.push(query.keyword);
      if (searchFailsLeft > 0) {
        searchFailsLeft--;
        return { ok: false, error: '模拟搜索失败' };
      }
      const rows = opts.searchRows ? opts.searchRows(query) : query.keyword.includes('二轮') ? (opts.round2Jobs ?? []) : jobs;
      return { ok: true, rows, count: rows.length, url: CITY.url };
    },
    async detail(_tabId: number, job: { jobId: string }) {
      calls.detail.push(job.jobId);
      const failAt = new Set(opts.detailFailAt ?? []);
      if (detailFailsLeft > 0 || failAt.has(calls.detail.length)) {
        if (detailFailsLeft > 0) detailFailsLeft--;
        const kind = failAt.has(calls.detail.length) ? (opts.detailFailureKind ?? 'transport') : 'transport';
        return { ok: false, kind, error: kind === 'page' ? '详情抓取失败：详情内容为空（页面可能未渲染完）' : '模拟详情失败' };
      }
      return { ok: true, detail: { descFull: `${job.jobId} 的职位描述`, asciiSalary: '30-50K', expEdu: ['3-5年'] } };
    },
    async greet(_tabId: number, action: { jobId: string }) {
      calls.greet.push(action.jobId);
      const next = greetResults.shift();
      if (!next) return { ok: true };
      if (next.risk) return { ok: false, risk: next.risk, reason: next.reason ?? '平台风险' };
      return { ok: next.ok, error: next.error };
    },
  };

  const ai: {
    checkHealth(): Promise<{ ok: boolean; version?: string | null; error?: string }>;
    planSearch(rawGoal: string, context: { cityName: string; cityCode: string }): Promise<any>;
    replanSearch(input?: unknown): Promise<any>;
    scoreJobs(input: { jobs: Array<{ jobId: string }> }): Promise<any>;
  } = {
    async checkHealth() {
      return { ok: true, version: 'test' };
    },
    async planSearch(rawGoal: string, context: { cityName: string; cityCode: string }) {
      calls.plan++;
      const queries = (opts.planQueries ?? ['AI产品经理']).map((keyword) => ({
        cityName: context.cityName,
        cityCode: context.cityCode,
        keyword,
        source: 'initial',
      }));
      return {
        ok: true,
        plan: {
          goal: {
            rawGoal,
            cities: [{ name: context.cityName, code: context.cityCode }],
            targetTitles: ['AI 产品经理'],
            hardExclusions: [],
            softNegativePreferences: [],
          },
          queries,
          successCriteria: { targetQualifiedJobs: 10 },
          mentionedCities: [context.cityName],
        },
      };
    },
    async replanSearch() {
      calls.replan++;
      const next = replanResponses.shift();
      if (next) return next;
      return { ok: true, status: 'complete', reason: '无需补充', newQueries: [] };
    },
    async scoreJobs({ jobs: list }: { jobs: Array<{ jobId: string }> }) {
      calls.score++;
      calls.scoreBatches.push(list.map((j) => j.jobId));
      if (scoreFailAt.has(calls.score)) {
        return { ok: false, results: [], error: opts.scoreError ?? '模拟评分服务不可用' };
      }
      const byId = new Map(jobs.map((j) => [j.jobId, j]));
      return {
        ok: true,
        results: list.map((j) => ({
          jobId: j.jobId,
          ok: true,
          score: (byId.get(j.jobId) as { score?: number } | undefined)?.score ?? 88,
          tier: 'hot',
          reasons: ['测试'],
          concerns: [],
        })),
      };
    },
  };

  const engine = createAutopilotEngine({
    browser,
    ai,
    settings,
    policy,
    greeting,
    queue,
    records,
    states,
    events,
    core,
    now: () => new Date(current),
    onActivity: (t: string) => activities.push(t),
  });

  async function advance(steps = 1) {
    const out = [];
    for (let i = 0; i < steps; i++) out.push(await engine.advanceAutopilot());
    return out;
  }

  /** 一直推进直到条件满足 / 步数上限（测试内部的循环，不是被实现的循环） */
  async function runUntil(predicate: (rt: any) => boolean | Promise<boolean>, { maxSteps = 120 } = {}) {
    const seen = [];
    for (let i = 0; i < maxSteps; i++) {
      const rt = await loadRuntime();
      if (await predicate(rt)) return { reached: true, steps: i, runtime: rt, seen };
      const r = await engine.advanceAutopilot();
      seen.push(`${r.status}/${r.step}`);
      if (!r.advanced && !r.done) {
        // 没有推进（例如 PAUSED）→ 直接返回，避免测试里出现无限循环
        const after = await loadRuntime();
        if (after.status === AUTOPILOT_STATUS.PAUSED) return { reached: false, steps: i, runtime: after, seen };
      }
    }
    return { reached: false, steps: maxSteps, runtime: await loadRuntime(), seen };
  }

  function setNow(date: Date | string) {
    current = date instanceof Date ? date : new Date(date);
  }

  /**
   * 脚手架时钟对应的本地日期键。
   * 注意：Autopilot 相关测试**必须**用这个，而不是 `localDateKey()`（真实今天）——
   * 脚手架时钟固定在 2026-09-13，一旦真实日期跨天（例如本地已到 00:0x），
   * 两者就会指向不同的事件分区，导致用例随机失败。
   */
  function dateKey() {
    return localDateKey(current);
  }

  function reinstallStorage(snapshot: Record<string, unknown>) {
    const restored = makeChrome(snapshot);
    installChrome(restored);
    return restored;
  }

  return {
    engine,
    browser,
    ai,
    calls,
    activities,
    chromeStub,
    jobs,
    advance,
    runUntil,
    setNow,
    dateKey,
    reinstallStorage,
    snapshot: () => JSON.parse(JSON.stringify(chromeStub.__store)) as Record<string, unknown>,
    runtime: () => loadRuntime(),
    statusOf: async () => (await loadRuntime()).status,
    statuses: AUTOPILOT_STATUS,
    steps: AUTOPILOT_STEPS,
    runtimeKey: RUNTIME_KEY,
  };
}
