// V0.5 Phase 2：Job State 单元测试
// 覆盖：合法/非法转移、非法跳转拒绝、持久化、路径补齐、Greeting 成功/失败的状态后果
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeChrome, installChrome, snapshot, restore, type ChromeStub } from './helpers/chrome-stub.js';
import {
  ALL_STATES,
  EVENT_TO_STATE,
  JOB_STATES_KEY,
  PHASE2_STATES,
  STATES,
  TRANSITIONS,
  canTransition,
  clearAllJobStates,
  countByState,
  ensureJobState,
  getAllJobStates,
  getJobIdsByState,
  getJobState,
  isKnownState,
  nextStatesOf,
  pathTo,
  setJobState,
} from '../../../extension/job-state.js';
import {
  recordGreetingFailure,
  recordGreetingSuccess,
  recordJobsDiscovered,
} from '../../../extension/agent-records.js';

let chromeStub: ChromeStub;

beforeEach(() => {
  chromeStub = makeChrome();
  installChrome(chromeStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('状态定义', () => {
  it('12 个状态齐备且 Phase 2 只用其中 4 个', () => {
    expect(ALL_STATES).toHaveLength(12);
    expect(PHASE2_STATES).toEqual(['DISCOVERED', 'SCORED', 'SHORTLISTED', 'GREETED']);
  });

  it('每个状态都有转移表条目（便于后续阶段扩展）', () => {
    for (const s of ALL_STATES) expect(Array.isArray(TRANSITIONS[s])).toBe(true);
  });

  it('isKnownState 拒绝未知状态', () => {
    expect(isKnownState(STATES.GREETED)).toBe(true);
    expect(isKnownState('HIRED')).toBe(false);
    expect(isKnownState(null)).toBe(false);
  });
});

describe('transition guard', () => {
  it('合法转移（Phase 2 链路 + 后续链路）', () => {
    expect(canTransition(STATES.DISCOVERED, STATES.SCORED).ok).toBe(true);
    expect(canTransition(STATES.SCORED, STATES.SHORTLISTED).ok).toBe(true);
    expect(canTransition(STATES.SHORTLISTED, STATES.GREETED).ok).toBe(true);
    expect(canTransition(STATES.GREETED, STATES.HR_REPLIED).ok).toBe(true);
    expect(canTransition(STATES.HR_REPLIED, STATES.RESUME_REQUESTED).ok).toBe(true);
    expect(canTransition(STATES.RESUME_REQUESTED, STATES.RESUME_SENT).ok).toBe(true);
    expect(canTransition(STATES.RESUME_SENT, STATES.OFFER).ok).toBe(true);
    expect(canTransition(STATES.INTERVIEW, STATES.OFFER).ok).toBe(true);
  });

  it('明显错误的跳转必须被拒绝', () => {
    const bad = [
      [STATES.DISCOVERED, STATES.GREETED],
      [STATES.DISCOVERED, STATES.SHORTLISTED],
      [STATES.DISCOVERED, STATES.OFFER],
      [STATES.SCORED, STATES.GREETED],
      [STATES.GREETED, STATES.RESUME_SENT],
      [STATES.REJECTED, STATES.GREETED],
      [STATES.OFFER, STATES.INTERVIEW],
    ] as const;
    for (const [from, to] of bad) {
      const r = canTransition(from, to);
      expect(r.ok, `${from} → ${to} 应被拒绝`).toBe(false);
      expect(r.reason).toContain('非法状态转移');
    }
  });

  it('同状态视为无变化而非非法；首次记录（from=null）总是允许', () => {
    expect(canTransition(STATES.GREETED, STATES.GREETED)).toEqual({ ok: true, changed: false, reason: null });
    expect(canTransition(null, STATES.SCORED).changed).toBe(true);
  });

  it('未知目标状态被拒绝', () => {
    expect(canTransition(STATES.SCORED, 'HIRED').ok).toBe(false);
  });

  it('nextStatesOf 暴露合法出口', () => {
    expect(nextStatesOf(STATES.SHORTLISTED)).toEqual([STATES.GREETED, STATES.REJECTED]);
    expect(nextStatesOf(STATES.OFFER)).toEqual([]);
  });

  it('pathTo 求合法路径，不可达返回 null', () => {
    expect(pathTo(STATES.DISCOVERED, STATES.GREETED)).toEqual([STATES.SCORED, STATES.SHORTLISTED, STATES.GREETED]);
    expect(pathTo(STATES.SHORTLISTED, STATES.GREETED)).toEqual([STATES.GREETED]);
    expect(pathTo(STATES.GREETED, STATES.GREETED)).toEqual([]);
    expect(pathTo(STATES.REJECTED, STATES.GREETED)).toBeNull();
    expect(pathTo(null, STATES.DISCOVERED)).toEqual([STATES.DISCOVERED]);
    expect(pathTo(null, STATES.SCORED)).toEqual([STATES.DISCOVERED, STATES.SCORED]);
    expect(pathTo(null, STATES.GREETED)).toEqual([
      STATES.DISCOVERED,
      STATES.SCORED,
      STATES.SHORTLISTED,
      STATES.GREETED,
    ]);
  });
});

describe('持久化与查询', () => {
  it('setJobState 写入并记录转移历史', async () => {
    const r1 = await setJobState({ jobId: 'j-1', state: STATES.DISCOVERED, jobTitle: 'AI 产品经理', company: 'A 公司' });
    expect(r1).toMatchObject({ ok: true, changed: true, state: STATES.DISCOVERED, previous: null });
    const r2 = await setJobState({ jobId: 'j-1', state: STATES.SCORED, reason: 'scored' });
    expect(r2.changed).toBe(true);
    const rec = await getJobState('j-1');
    expect(rec?.state).toBe(STATES.SCORED);
    expect(rec?.jobTitle).toBe('AI 产品经理');
    expect(rec?.transitions.map((t) => t.to)).toEqual([STATES.DISCOVERED, STATES.SCORED]);
    expect(rec?.transitions[1].reason).toBe('scored');
  });

  it('非法转移不写入任何内容', async () => {
    await setJobState({ jobId: 'j-1', state: STATES.DISCOVERED });
    const before = snapshot(chromeStub);
    const r = await setJobState({ jobId: 'j-1', state: STATES.GREETED });
    expect(r.ok).toBe(false);
    expect(r.state).toBe(STATES.DISCOVERED); // 保持原状态
    expect(snapshot(chromeStub)).toEqual(before); // 存储未变
  });

  it('缺少 jobId 直接拒绝', async () => {
    const r = await setJobState({ state: STATES.SCORED } as unknown as { jobId: string; state: string });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('jobId 必填');
  });

  it('重复设置同状态不产生新转移记录', async () => {
    await setJobState({ jobId: 'j-1', state: STATES.SCORED });
    const r = await setJobState({ jobId: 'j-1', state: STATES.SCORED });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
    expect((await getJobState('j-1'))?.transitions).toHaveLength(1);
  });

  it('countByState / getJobIdsByState / getAllJobStates', async () => {
    await setJobState({ jobId: 'a', state: STATES.DISCOVERED });
    await setJobState({ jobId: 'b', state: STATES.DISCOVERED });
    await setJobState({ jobId: 'b', state: STATES.SCORED });
    expect(await countByState()).toEqual({ DISCOVERED: 1, SCORED: 1 });
    expect(await getJobIdsByState(STATES.DISCOVERED)).toEqual(['a']);
    expect(Object.keys(await getAllJobStates())).toEqual(['a', 'b']);
  });

  it('持久化：重建 chrome 桩后状态仍在（Side Panel 关闭再打开）', async () => {
    await setJobState({ jobId: 'j-1', state: STATES.SHORTLISTED });
    const snap = snapshot(chromeStub);
    expect(snap[JOB_STATES_KEY]).toBeTruthy();
    installChrome(restore(snap));
    expect((await getJobState('j-1'))?.state).toBe(STATES.SHORTLISTED);
  });

  it('clearAllJobStates 只清岗位状态', async () => {
    await setJobState({ jobId: 'j-1', state: STATES.SCORED });
    chromeStub.__store['jobAgentEvents:2026-03-01'] = [{ eventId: 'e1' }];
    await clearAllJobStates();
    expect(await getAllJobStates()).toEqual({});
    expect(chromeStub.__store['jobAgentEvents:2026-03-01']).toBeTruthy();
  });
});

describe('ensureJobState（沿合法路径补齐）', () => {
  it('从未记录 → 走到 SHORTLISTED 会依次补齐 DISCOVERED、SCORED', async () => {
    const r = await ensureJobState({ jobId: 'j-1', state: STATES.SHORTLISTED });
    expect(r.ok).toBe(true);
    expect(r.steps).toEqual([STATES.DISCOVERED, STATES.SCORED, STATES.SHORTLISTED]);
    expect((await getJobState('j-1'))?.state).toBe(STATES.SHORTLISTED);
  });

  it('已在 SHORTLISTED → 走到 GREETED 只补一步', async () => {
    await ensureJobState({ jobId: 'j-1', state: STATES.SHORTLISTED });
    const r = await ensureJobState({ jobId: 'j-1', state: STATES.GREETED });
    expect(r.steps).toEqual([STATES.GREETED]);
  });

  it('不可达状态返回失败且不写脏数据', async () => {
    await setJobState({ jobId: 'j-1', state: STATES.REJECTED });
    const r = await ensureJobState({ jobId: 'j-1', state: STATES.GREETED });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('无法从 REJECTED 到达 GREETED');
    expect((await getJobState('j-1'))?.state).toBe(STATES.REJECTED);
  });
});

describe('Event → Job State 映射', () => {
  it('GREETING_FAILED 不在映射表中（失败绝不等于 GREETED）', () => {
    expect(Object.prototype.hasOwnProperty.call(EVENT_TO_STATE, 'GREETING_FAILED')).toBe(false);
    expect(EVENT_TO_STATE.GREETING_SENT).toBe(STATES.GREETED);
  });

  it('Phase 2 相关事件映射到 Phase 2 状态', async () => {
    await recordJobsDiscovered({ jobs: [{ jobId: 'j-1', title: 'PM', company: 'A' }] });
    expect((await getJobState('j-1'))?.state).toBe(STATES.DISCOVERED);
  });
});

describe('Greeting 成功 / 失败对状态的影响（统一 helper）', () => {
  it('成功 → GREETED（自动补齐合法路径）', async () => {
    const r = await recordGreetingSuccess({
      job: { jobId: 'j-1', title: 'AI 产品经理', company: 'A 公司' },
      message: '你好',
      templateId: 'default',
    });
    expect(r.ok).toBe(true);
    expect(r.state).toBe(STATES.GREETED);
    expect(r.stateSteps).toEqual([STATES.DISCOVERED, STATES.SCORED, STATES.SHORTLISTED, STATES.GREETED]);
    expect((await getJobState('j-1'))?.state).toBe(STATES.GREETED);
  });

  it('失败 → 不进入 GREETED（保持原状态）', async () => {
    await ensureJobState({ jobId: 'j-1', state: STATES.SHORTLISTED });
    const r = await recordGreetingFailure({
      job: { jobId: 'j-1', title: 'PM' },
      error: '发送按钮未启用',
      actionId: 'act_1',
    });
    expect(r.ok).toBe(true);
    expect(r.state).toBe(STATES.SHORTLISTED);
    expect((await getJobState('j-1'))?.state).toBe(STATES.SHORTLISTED);
  });

  it('失败后再成功，状态才变 GREETED', async () => {
    await ensureJobState({ jobId: 'j-1', state: STATES.SHORTLISTED });
    await recordGreetingFailure({ job: { jobId: 'j-1' }, error: 'x', actionId: 'act_1' });
    expect((await getJobState('j-1'))?.state).toBe(STATES.SHORTLISTED);
    await recordGreetingSuccess({ job: { jobId: 'j-1' }, message: '你好' });
    expect((await getJobState('j-1'))?.state).toBe(STATES.GREETED);
  });
});
