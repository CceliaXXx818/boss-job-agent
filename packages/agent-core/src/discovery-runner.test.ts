// V0.5 Phase 3：Discovery 共享内核测试 + Review/Autopilot 共享代码断言
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeChrome, installChrome, type ChromeStub } from './helpers/chrome-stub.js';
import {
  buildSearchUrl,
  buildJobUrl,
  buildResultSummary,
  decideAfterRound,
  dedupeQueries,
  excludeSeen,
  filterRound,
  mergeDetail,
  mergeReplanQueries,
  mergeSearchRows,
  needsReplan,
  pickDetailTargets,
  pickOutreachCandidates,
  queryKey,
  resolveHardExclusions,
  strongMatches,
  attachScores,
} from '../../../extension/discovery-runner.js';
import { recordJobsDiscovered } from '../../../extension/agent-records.js';
import { EVENT_TYPES, getEventsByDate, localDateKey } from '../../../extension/event-store.js';
import { createHarness, autopilotSettings, makeJob } from './helpers/autopilot-harness.js';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** 去掉注释后再做结构化断言：注释里提到"禁止 while(true)"不应该被当成违规代码 */
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Discovery 纯函数（Review 与 Autopilot 共用）', () => {
  it('buildSearchUrl / buildJobUrl 规则统一', () => {
    expect(buildSearchUrl({ keyword: 'AI 产品经理', cityCode: '101020100' })).toBe(
      'https://www.zhipin.com/web/geek/jobs?query=AI%20%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86&city=101020100',
    );
    expect(buildJobUrl({ jobId: 'abc', href: '/job_detail/abc.html' })).toBe('https://www.zhipin.com/job_detail/abc.html');
  });

  it('queryKey / dedupeQueries：同城同词只保留一次，跨轮不重复搜', () => {
    expect(queryKey({ cityCode: '101020100', keyword: ' AI产品经理 ' })).toBe('101020100|ai产品经理');
    const out = dedupeQueries(
      [
        { cityCode: '101020100', keyword: 'AI产品经理' },
        { cityCode: '101020100', keyword: 'ai产品经理' },
        { cityCode: '101020100', keyword: 'B端产品经理' },
        { cityCode: '101280600', keyword: 'AI产品经理' },
      ],
      [{ cityCode: '101020100', keyword: 'B端产品经理' }],
    );
    expect(out.map((q) => `${q.cityCode}:${q.keyword}`)).toEqual(['101020100:AI产品经理', '101280600:AI产品经理']);
  });

  it('mergeSearchRows 按 jobId 去重并统计新增', () => {
    const first = mergeSearchRows([], [makeJob({ jobId: 'a' }), makeJob({ jobId: 'b' })], { fromQuery: '上海·AI' });
    expect(first.added).toBe(2);
    expect(first.jobs[0].fromQuery).toBe('上海·AI');
    const second = mergeSearchRows(first.jobs, [makeJob({ jobId: 'b' }), makeJob({ jobId: 'c' })]);
    expect(second.added).toBe(1);
    expect(second.jobs.map((j) => j.jobId)).toEqual(['a', 'b', 'c']);
  });

  it('excludeSeen / filterRound：跨轮 dedupe + 硬排除', () => {
    const jobs = [makeJob({ jobId: 'a' }), makeJob({ jobId: 'b' }), makeJob({ jobId: 'c', title: '销售代表' })];
    expect(excludeSeen(jobs, ['a']).map((j) => j.jobId)).toEqual(['b', 'c']);
    const { qualified, removedCount, removed } = filterRound(jobs, { hardExclusions: ['销售'], seenJobIds: ['a'] });
    expect(qualified.map((j) => j.jobId)).toEqual(['b']);
    expect(removedCount).toBe(1);
    expect(removed[0].removedReason).toContain('销售');
  });

  it('pickDetailTargets 受 DETAIL_FETCH_LIMIT 与已抓过集合约束', () => {
    const jobs = Array.from({ length: 30 }, (_v, i) => makeJob({ jobId: `j-${i}`, title: 'AI 产品经理' }));
    expect(pickDetailTargets(jobs, [], 15)).toHaveLength(15);
    expect(pickDetailTargets(jobs, ['j-0'], 15).some((j) => j.jobId === 'j-0')).toBe(false);
  });

  it('mergeDetail：详情字段覆盖列表字段，expEdu 回退到列表标签', () => {
    const merged = mergeDetail({ jobId: 'a', tags: '3-5年|本科' }, { descFull: 'JD', expEdu: [] });
    expect(merged.descFull).toBe('JD');
    expect(merged.expEdu).toEqual(['3-5年', '本科']);
  });

  it('attachScores / strongMatches：≥75 分才算达标，并按分数降序', () => {
    const scored = attachScores(
      [{ jobId: 'a' }, { jobId: 'b' }, { jobId: 'c' }],
      [
        { jobId: 'a', ok: true, score: 70 },
        { jobId: 'b', ok: true, score: 92 },
        { jobId: 'c', ok: true, score: 80 },
      ],
    );
    expect(strongMatches(scored).map((j) => j.jobId)).toEqual(['b', 'c']);
  });

  it('buildResultSummary 口径与 V0.4 一致（Review 与 Autopilot 同源）', () => {
    const summary = buildResultSummary({
      discoveredCount: 20,
      qualifiedCount: 12,
      strongMatchCount: 4,
      topTitles: ['A', 'B'],
      filteredOut: 8,
    });
    expect(summary).toMatchObject({ discoveredCount: 20, qualifiedCount: 12, strongMatchCount: 4, topTitles: ['A', 'B'] });
    expect(summary.rejectedReasons[0]).toContain('8');
  });

  it('needsReplan：达标数不足且未超 Replan 上限才需要补充', () => {
    expect(needsReplan({ qualifiedCount: 3, targetQualifiedJobs: 10, replanCount: 0, maxReplan: 1 })).toBe(true);
    expect(needsReplan({ qualifiedCount: 3, targetQualifiedJobs: 10, replanCount: 1, maxReplan: 1 })).toBe(false);
    expect(needsReplan({ qualifiedCount: 10, targetQualifiedJobs: 10, replanCount: 0, maxReplan: 1 })).toBe(false);
  });

  it('mergeReplanQueries：只允许新增 keyword，重复词被丢弃', () => {
    const merged = mergeReplanQueries({
      existingQueries: [{ cityCode: '101020100', cityName: '上海', keyword: 'AI产品经理' }],
      newQueries: [{ keyword: 'AI平台产品经理' }, { keyword: 'ai产品经理' }],
      searchedQueries: [],
      cityCode: '101020100',
      cityName: '上海',
    });
    expect(merged.added.map((q) => q.keyword)).toEqual(['AI平台产品经理']);
    expect(merged.queries).toHaveLength(2);
  });

  it('decideAfterRound：cap / 轮次 / 工作时间 / 无新结果 都会收工', () => {
    const base = {
      todayGreetingCount: 0,
      dailyGreetingCap: 5,
      roundIndex: 1,
      maxDiscoveryRounds: 3,
      withinWorkingHours: true,
      roundHasNewCandidates: true,
      hasNewQueries: true,
    };
    expect(decideAfterRound(base)).toMatchObject({ action: 'NEXT_ROUND', code: 'CONTINUE' });
    expect(decideAfterRound({ ...base, todayGreetingCount: 5 })).toMatchObject({ action: 'COMPLETE', code: 'DAILY_CAP_REACHED' });
    expect(decideAfterRound({ ...base, roundIndex: 3 })).toMatchObject({ action: 'COMPLETE', code: 'MAX_ROUNDS_REACHED' });
    expect(decideAfterRound({ ...base, withinWorkingHours: false })).toMatchObject({ action: 'COMPLETE', code: 'OUTSIDE_WORKING_HOURS' });
    expect(decideAfterRound({ ...base, roundHasNewCandidates: false, hasNewQueries: false })).toMatchObject({
      action: 'COMPLETE',
      code: 'NO_NEW_RESULTS',
    });
  });

  it('pickOutreachCandidates：受今日剩余额度限制，且跳过已排队/已联系', () => {
    const recommended = [1, 2, 3, 4, 5].map((i) => ({ ...makeJob({ jobId: `j-${i}`, score: 90 - i }), __ai: { ok: true, score: 90 - i } }));
    const picked = pickOutreachCandidates(recommended, { remaining: 2, alreadyQueued: ['j-1'], alreadyGreeted: ['j-5'] });
    expect(picked.map((j) => j.jobId)).toEqual(['j-2', 'j-3']);
    expect(pickOutreachCandidates(recommended, { remaining: 0 })).toEqual([]);
    expect(pickOutreachCandidates(recommended, { remaining: 99, alreadyGreeted: ['j-1', 'j-2', 'j-3', 'j-4', 'j-5'] })).toEqual([]);
  });

  it('resolveHardExclusions：系统硬排除始终生效，soft 偏好不进入硬约束', () => {
    const merged = resolveHardExclusions(['外包'], ['驻场']);
    expect(merged).toContain('外包');
    expect(merged).toContain('驻场');
    expect(merged).toContain('销售'); // 系统级
  });
});

describe('共享代码断言（Review 与 Autopilot 不允许各写一套）', () => {
  const sidepanel = read('extension/sidepanel.js');
  const background = read('extension/background.js');
  const engine = read('extension/autopilot-engine.js');

  it('两边都从 ai-client 调用 /plan /replan /score（不允许各写一份 fetch）', () => {
    for (const src of [sidepanel, engine]) {
      expect(src).toMatch(/planSearch\(/);
      expect(src).toMatch(/replanSearch\(/);
      expect(src).toMatch(/scoreJobs\(/);
    }
    // 原始 HTTP 细节只允许出现在 ai-client.js
    expect(sidepanel).not.toMatch(/fetch\(`\$\{AI_BASE\}\/plan/);
    expect(sidepanel).not.toMatch(/fetch\(`\$\{AI_BASE\}\/score/);
    expect(engine).not.toMatch(/fetch\(/);
    expect(background).not.toMatch(/fetch\(/);
  });

  it('两边都使用 discovery-runner 的共享纯函数', () => {
    expect(sidepanel).toMatch(/from '\.\/discovery-runner\.js'/);
    expect(engine).toMatch(/from '\.\/discovery-runner\.js'/);
    expect(sidepanel).toMatch(/buildSearchUrl\(/);
    expect(sidepanel).toMatch(/buildResultSummaryCore\(/);
    expect(sidepanel).toMatch(/strongMatchesCore\(/);
    expect(sidepanel).toMatch(/pickDetailTargets\(/);
    expect(engine).toMatch(/filterRound\(/);
    expect(engine).toMatch(/mergeSearchRows\(/);
    expect(engine).toMatch(/decideAfterRound\(/);
  });

  it('不允许出现第二套 autopilotSearch / autopilotScore / autopilotReplan', () => {
    const all = stripComments(sidepanel + background + engine + read('extension/discovery-runner.js'));
    expect(all).not.toMatch(/autopilotSearch|autopilotScore|autopilotReplan/);
  });

  it('Review（Side Panel）没有把编排搬进 Background：两边的浏览器 I/O 各自独立', () => {
    // Side Panel 仍通过 tabs.sendMessage 直接驱动内容脚本（Review 不依赖 Background）
    expect(sidepanel).toMatch(/chrome\.tabs\.sendMessage/);
    expect(sidepanel).toMatch(/'greetFull'/);
    // Background 不实现 Review 流程，只做 Autopilot
    expect(background).not.toMatch(/stageGreetingActions|executeStagedActions/);
  });

  it('Background 没有长驻循环 / setInterval / 无限 sleep', () => {
    const code = stripComments(background);
    expect(code).not.toMatch(/while\s*\(\s*true/);
    expect(code).not.toMatch(/setInterval/);
    expect(code).not.toMatch(/for\s*\(\s*;;/);
    // 只允许 bounded 的 sleep(constant)
    expect(code).toMatch(/const sleep = \(ms\) =>/);
    // 同样要求引擎代码干净
    const engineCode = stripComments(engine);
    expect(engineCode).not.toMatch(/while\s*\(\s*true/);
    expect(engineCode).not.toMatch(/setInterval/);
  });

  it('Background 不在模块级变量里保存关键状态（只缓存引擎实例与 tick 锁）', () => {
    const moduleVars = [...background.matchAll(/^let\s+(\w+)/gm)].map((m) => m[1]);
    expect(moduleVars.sort()).toEqual(['engine', 'ticking']);
  });
});

describe('发现事件的幂等（跨轮）', () => {
  it('同一个岗位重复发现只写一条 JOB_DISCOVERED', async () => {
    const stub: ChromeStub = makeChrome();
    installChrome(stub);
    await recordJobsDiscovered({ jobs: [makeJob({ jobId: 'x' })], round: 1, mode: 'autopilot' });
    await recordJobsDiscovered({ jobs: [makeJob({ jobId: 'x' })], round: 2, mode: 'autopilot' });
    const events = (await getEventsByDate(localDateKey())).filter((e) => e.type === EVENT_TYPES.JOB_DISCOVERED);
    expect(events).toHaveLength(1);
  });
});

describe('引擎与 runtime 的可序列化性', () => {
  it('Autopilot runtime 在多轮推进后依然可以 JSON 往返', async () => {
    const h = createHarness({
      initialStorage: { jobAgentSettings: autopilotSettings() },
      jobs: [makeJob({ jobId: 'j-1', score: 88 })],
      replanResponses: [{ ok: true, status: 'complete', newQueries: [] }],
    });
    await h.engine.startAutopilot({ rawGoal: '上海 AI 产品经理' });
    for (let i = 0; i < 12; i++) await h.engine.advanceAutopilot();
    const raw = h.chromeStub.__store['jobAgentAutopilotRuntime'];
    expect(JSON.parse(JSON.stringify(raw))).toEqual(raw);
  });
});
