import { describe, expect, it } from 'vitest';
import type { PageSpec } from './core';
import { InMemoryDriver, validatePageSpecs } from './in-memory';

const LOGIN_PAGE: PageSpec = {
  pageName: 'boss-login',
  version: '1.0',
  roles: [{ key: 'login_state', kind: 'text' }],
};

const JOBS_PAGE: PageSpec = {
  pageName: 'boss-jobs',
  version: '1.0',
  roles: [
    { key: 'search_box', kind: 'input' },
    { key: 'job_list', kind: 'list' },
    { key: 'job_detail', kind: 'text' },
    { key: 'greet_button', kind: 'button' },
    { key: 'chat_input', kind: 'input' },
    { key: 'chat_unread', kind: 'text' },
    { key: 'resume_online_button', kind: 'button' },
  ],
};

describe('browser-runtime：页面对象与确定性动词（P3）', () => {
  it('页面结构校验：重复角色/非法 kind/版本号被检出', () => {
    expect(validatePageSpecs([LOGIN_PAGE, JOBS_PAGE])).toEqual([]);
    const bad: PageSpec = {
      pageName: 'bad',
      version: '1',
      roles: [
        { key: 'a', kind: 'button' },
        { key: 'a', kind: 'text' },
        { key: 'b', kind: 'wat' as never },
      ],
    };
    const problems = validatePageSpecs([bad]);
    expect(problems.join(';')).toContain('重复角色');
    expect(problems.join(';')).toContain('非法 kind');
    expect(problems.join(';')).toContain('版本号');
  });

  it('InMemoryDriver：登录状态→搜索→打开岗位→打招呼，行为确定性可回放', async () => {
    const d = new InMemoryDriver();
    d.registerPages([LOGIN_PAGE, JOBS_PAGE]);
    d.loadFixture({ pageName: 'boss-login', roleValues: { login_state: { text: 'logged_in' } } });
    const login = await d.run({ verb: 'read_login_state' });
    expect(login).toEqual({ ok: true, data: { state: 'logged_in' } });

    d.loadFixture({
      pageName: 'boss-jobs',
      roleValues: { search_box: {}, job_list: { items: ['J1', 'J2'] }, greet_button: { clickable: true } },
    });
    const first = await d.run({ verb: 'search', roleKey: 'search_box', arg: { city: '深圳', keywords: ['AI产品经理'] } });
    expect(first.ok).toBe(true);
    const second = await d.run({ verb: 'search', roleKey: 'search_box', arg: { city: '深圳', keywords: ['AI产品经理'] } });
    expect(second).toEqual(first); // 确定性
    const open = await d.run({ verb: 'open_job', roleKey: 'job_list', arg: { externalId: 'J1' } });
    expect(open.ok).toBe(true);
    const greet = await d.run({ verb: 'greet_send', roleKey: 'greet_button', arg: { text: '您好…' } });
    expect(greet.ok).toBe(true);
    expect(d.actions.map((a) => a.verb)).toEqual(['read_login_state', 'search', 'search', 'open_job', 'greet_send']);
  });

  it('护栏：页面角色缺失 → PAGE_CHANGED；岗位不存在 → NOT_FOUND（不猜测不盲点）', async () => {
    const d = new InMemoryDriver();
    d.registerPages([LOGIN_PAGE, JOBS_PAGE]);
    d.loadFixture({ pageName: 'boss-jobs', roleValues: { job_list: { items: ['J1'] } } });
    // 当前页面没有 login_state 角色
    const bad = await d.run({ verb: 'read_login_state' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('PAGE_CHANGED');
    const missing = await d.run({ verb: 'open_job', roleKey: 'job_list', arg: { externalId: 'NOPE' } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('NOT_FOUND');
  });
});
