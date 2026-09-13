import { describe, expect, it } from 'vitest';
import {
  KNOWN_CITY_CODES,
  resolveBossContext,
  detectCityConflict,
  hardFilter,
  mergeHardExclusions,
} from '../../../extension/core-logic.js';

/**
 * V0.4.1 Browser Context（对应验收测试 §19）
 * 城市来自当前 BOSS 页面：URL city code 优先 → 已知 code 映射 → DOM 城市文本。
 */
describe('V0.4.1 Browser Context 城市识别', () => {
  const page = (codeFromUrl: string, domTexts: string[] = [], url = 'https://www.zhipin.com/web/geek/jobs') => ({
    url,
    codeFromUrl,
    domCandidates: domTexts.map((text, i) => ({ text, cls: 'city-name', y: i * 10 })),
  });

  it('当前页面上海（code 101020100）→ 正常识别', () => {
    const ctx = resolveBossContext(page('101020100', ['上海']));
    expect(ctx).toMatchObject({ cityName: '上海', cityCode: '101020100', pageType: 'job-list' });
  });

  it('当前页面北京（code 101010100）→ 正常识别（原有实现只支持杭州/深圳，现已放开）', () => {
    const ctx = resolveBossContext(page('101010100', ['北京']));
    expect(ctx?.cityName).toBe('北京');
    expect(ctx?.cityCode).toBe('101010100');
  });

  it('当前页面杭州/深圳 → 正常识别', () => {
    expect(resolveBossContext(page('101210100', ['杭州']))?.cityName).toBe('杭州');
    expect(resolveBossContext(page('101280600', ['深圳']))?.cityName).toBe('深圳');
  });

  it('不在原白名单的城市（如南京/成都）→ 仍可正常工作', () => {
    expect(resolveBossContext(page('101190100', ['南京']))?.cityName).toBe('南京');
    expect(resolveBossContext(page('101270100'))?.cityName).toBe('成都'); // 仅 code，用 fallback 映射
  });

  it('未知 code + DOM 城市文本 → 使用 DOM 文本（不猜 code）', () => {
    const ctx = resolveBossContext(page('999999999', ['切换城市', '南京']));
    expect(ctx?.cityName).toBe('南京');
    expect(ctx?.cityCode).toBe('999999999');
  });

  it('无法识别城市 → 返回 null（调用方应 STOPPED 提示用户选择城市）', () => {
    expect(resolveBossContext(page('', []))).toBeNull();
    expect(resolveBossContext(null)).toBeNull();
  });

  it('切换 BOSS 城市后重新读取 → 得到新城市（纯函数无缓存）', () => {
    const first = resolveBossContext(page('101020100', ['上海']));
    const second = resolveBossContext(page('101010100', ['北京']));
    expect(first?.cityName).toBe('上海');
    expect(second?.cityName).toBe('北京');
    expect(second?.cityName).not.toBe(first?.cityName);
  });

  it('fallback 映射表包含常见城市（仅作兜底，不再是白名单）', () => {
    for (const name of ['上海', '北京', '杭州', '深圳', '广州']) {
      expect(Object.values(KNOWN_CITY_CODES)).toContain(name);
    }
  });
});

/** 对应验收测试 §19.6：Goal 与当前城市冲突 → 不自动切城市 */
describe('V0.4.1 城市冲突检测', () => {
  it('当前上海 + Goal 写杭州 → conflict=true，others=[杭州]', () => {
    expect(detectCityConflict(['杭州'], '上海')).toEqual({ conflict: true, others: ['杭州'] });
  });
  it('当前上海 + Goal 写上海/未提城市 → 无冲突', () => {
    expect(detectCityConflict(['上海'], '上海').conflict).toBe(false);
    expect(detectCityConflict([], '上海').conflict).toBe(false);
  });
});

/** 对应验收测试 §20.7 / §20.8：hard 命中必过滤；soft 不影响资格 */
describe('V0.4.1 Hard vs Soft 在过滤层的表现', () => {
  const job = (title: string, score = 95) => ({ jobId: 'J1', title, company: '某公司', tags: '', expEdu: [], __ai: { ok: true, score } });

  it('hardExclusion 命中 → 即使 AI Score ≥ 90 也必须过滤', () => {
    const merged = mergeHardExclusions(['数据标注'], ['外包']);
    const r = hardFilter(job('AI产品经理（外包）', 95), merged);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('外包');
  });

  it('softNegativePreferences 不进入 hard 列表 → 岗位仍可进入 Shortlist', () => {
    const merged = mergeHardExclusions([], ['外包']); // soft 不参与合并
    expect(merged).not.toContain('售前属性过强');
    const r = hardFilter(job('AI产品经理（含少量售前沟通）', 88), merged);
    expect(r.pass).toBe(true);
  });

  it('系统硬排除 + 画像硬排除 + 本轮 Goal 硬排除 三者合并去重', () => {
    const merged = mergeHardExclusions(['外包'], ['长期出差', '外包']);
    expect(merged).toContain('外包');
    expect(merged).toContain('长期出差');
    expect(merged).toContain('销售'); // 系统级
    expect(new Set(merged).size).toBe(merged.length);
  });
});
