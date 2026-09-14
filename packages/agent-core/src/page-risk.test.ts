// V0.5 修复回归：平台风险判定不能产生假阳性（真实事故）
//
// 事故：面板显示 "岗位列表为空（可能未登录或城市未选择），已暂停"，
// 但用户明确登录着、城市也选着。
// 根因：把"列表此刻没有卡片"直接当成 BROWSER_CONTEXT_INVALID 风险，忽略了两种正常情况：
//   ① 该关键词本身没有结果（BOSS 显示"没有找到相关职位"）；
//   ② 列表是 SPA 异步渲染的，ping 到 content script 的那一刻卡片还没渲染出来。
// 并且判定顺序也有问题：先判风险、再看抓取结果 —— 即使 scrape 已经抓回岗位也会被误停。
import { describe, it, expect } from 'vitest';
import { classifyPageRisk, inspectJobListPage } from '../../../extension/page-risk.js';
import { RISK_REASONS } from '../../../extension/autopilot-runtime.js';

const listUrl = 'https://www.zhipin.com/web/geek/jobs?query=AI&city=101020100';

describe('classifyPageRisk：只依据可靠事实判风险', () => {
  it('空列表 ≠ 风险（这是本次事故的核心）', () => {
    expect(classifyPageRisk({ page: { url: listUrl, title: 'BOSS直聘', cardCount: 0 } })).toBeNull();
    expect(classifyPageRisk({ page: { url: listUrl, title: 'BOSS直聘', cardCount: null } })).toBeNull();
  });

  it('验证码 / 安全校验页 → CAPTCHA', () => {
    for (const url of ['https://www.zhipin.com/web/geek/jobs?captcha=1', 'https://www.zhipin.com/safe/verify', 'https://www.zhipin.com/security-check']) {
      expect(classifyPageRisk({ page: { url, title: '' } })?.risk).toBe(RISK_REASONS.CAPTCHA);
    }
  });

  it('登录失效 → LOGIN_REQUIRED（URL 或标题任一命中）', () => {
    expect(classifyPageRisk({ page: { url: 'https://www.zhipin.com/web/user/login', title: '' } })?.risk).toBe(
      RISK_REASONS.LOGIN_REQUIRED,
    );
    expect(classifyPageRisk({ tab: { url: 'https://www.zhipin.com/web/geek/jobs', title: '请先登录 BOSS直聘' } })?.risk).toBe(
      RISK_REASONS.LOGIN_REQUIRED,
    );
  });

  it('标题提示异常 → RISK_PAGE', () => {
    expect(classifyPageRisk({ page: { url: listUrl, title: '访问异常请稍后再试' } })?.risk).toBe(RISK_REASONS.RISK_PAGE);
  });

  it('正常列表页（有卡片）→ 无风险', () => {
    expect(classifyPageRisk({ page: { url: listUrl, title: 'BOSS直聘', cardCount: 20 } })).toBeNull();
  });

  it('优先使用标签页自身信息（content script 未注入时也能识别登录/验证页）', () => {
    expect(classifyPageRisk({ page: null, tab: { url: 'https://www.zhipin.com/web/user/', title: '' } })?.risk).toBe(
      RISK_REASONS.LOGIN_REQUIRED,
    );
    expect(classifyPageRisk({ page: null, tab: { url: listUrl, title: 'BOSS直聘' } })).toBeNull();
  });
});

describe('inspectJobListPage：把"空列表"表达成事实而不是风险', () => {
  it('列表页 cardCount=0 → empty=true 且无风险', () => {
    const r = inspectJobListPage({ page: { url: listUrl, title: 'BOSS直聘', cardCount: 0 } });
    expect(r).toMatchObject({ empty: true, risk: null });
  });

  it('列表页有卡片 → empty=false', () => {
    expect(inspectJobListPage({ page: { url: listUrl, cardCount: 12 } }).empty).toBe(false);
  });

  it('非列表页不判断为空（详情页本来就没有卡片）', () => {
    expect(inspectJobListPage({ page: { url: 'https://www.zhipin.com/job_detail/x.html', cardCount: 0 } }).empty).toBe(false);
  });

  it('卡片数未知（未渲染/无数据）不判为空', () => {
    expect(inspectJobListPage({ page: { url: listUrl, cardCount: null } }).empty).toBe(false);
    expect(inspectJobListPage({ page: { url: listUrl } }).empty).toBe(false);
  });

  it('风险优先于空列表（登录页即使 0 卡片也返回风险）', () => {
    const r = inspectJobListPage({ page: { url: 'https://www.zhipin.com/web/user/login', cardCount: 0 } });
    expect(r.risk?.risk).toBe(RISK_REASONS.LOGIN_REQUIRED);
  });
});

describe('源码回归：适配器不再用 cardCount 推断风险，且以抓取结果为准', () => {
  const bg = require('node:fs').readFileSync('extension/background.js', 'utf8') as string;
  const risk = require('node:fs').readFileSync('extension/page-risk.js', 'utf8') as string;

  it('风险判定集中在 page-risk.js（纯函数，可测）', () => {
    expect(risk).toMatch(/export function classifyPageRisk/);
    expect(risk).toContain('不要**根据 cardCount === 0 判定风险');
  });

  it('background 里不再内联 cardCount → BROWSER_CONTEXT_INVALID 的规则', () => {
    expect(bg).not.toMatch(/cardCount[\s\S]{0,80}BROWSER_CONTEXT_INVALID/);
    expect(bg).toMatch(/classifyPageRisk\(\{ page, tab \}\)/);
  });

  it('搜索以 scrape 结果为准，并在空结果时先重试等待渲染', () => {
    expect(bg).toMatch(/Number\(response\.count\) > 0/);
    expect(bg).toMatch(/EMPTY_LIST_RETRIES/);
    expect(bg).toMatch(/empty: true/);
  });
});
