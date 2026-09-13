// V0.5 Phase 1：设置层（settings.js）单元测试
// 关注点：默认值必须是"最安全"的（Review + 自动发简历 OFF + 无授权），
//         非法输入必须被钳制而不是抛错（Side Panel 输入不可信）。
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  loadSettings,
  saveSettings,
  patchSettings,
  MODES,
  DEFAULT_SETTINGS,
  DEFAULT_GREETING_TEMPLATE,
  MAX_GREETING_TEMPLATE_LENGTH,
  SETTINGS_KEY,
  isValidHHMM,
  hhmmToMinutes,
  isWithinWorkingHours,
  validateGreetingTemplate,
  normalizeSettings,
  hasAutopilotConsent,
  recordAutopilotConsent,
  revokeAutopilotConsent,
  recordAutoResumeConsent,
} from '../../../extension/settings.js';

const norm = (raw: unknown, legacy = {}) => normalizeSettings(raw, legacy).settings;

describe('settings 默认值（安全基线）', () => {
  it('默认 Review Mode，未授权 Autopilot，自动发简历关闭', () => {
    const s = norm(undefined);
    expect(s.mode).toBe('review');
    expect(s.consent.autopilot).toBe(false);
    expect(s.consent.autoResume).toBe(false);
    expect(s.autoSendResume).toBe(false);
    expect(MODES).toEqual(['review', 'autopilot']);
  });

  it('默认参数与 V0.5 规格一致', () => {
    const s = norm({});
    expect(s.batchQualifiedTarget).toBe(10);
    expect(s.minimumAutoGreetingScore).toBe(80);
    expect(s.dailyGreetingCap).toBe(5); // V0.5 保守默认值
    expect(s.maxDiscoveryRounds).toBe(3);
    expect(s.maxReplanPerRound).toBe(1);
    expect(s.monitorIntervalMinutes).toBe(10);
    expect(s.workingHours).toEqual({ start: '09:00', end: '18:00' });
    expect(s.dailyReportTime).toBe('18:00');
    expect(s.greetingStrategy.mode).toBe('template');
    expect(s.greetingStrategy.template).toBe(DEFAULT_GREETING_TEMPLATE);
    expect(s.resumeConfig.strategy).toBe('boss_default');
    expect(SETTINGS_KEY).toBe('jobAgentSettings');
  });

  it('非对象输入也返回完整默认设置', () => {
    for (const bad of [null, 'x', 42, [], true]) {
      expect(norm(bad).mode).toBe('review');
    }
  });
});

describe('normalizeSettings 钳制非法数值', () => {
  it('分数阈值钳制到 0-100', () => {
    expect(norm({ minimumAutoGreetingScore: 150 }).minimumAutoGreetingScore).toBe(100);
    expect(norm({ minimumAutoGreetingScore: -5 }).minimumAutoGreetingScore).toBe(0);
    expect(norm({ minimumAutoGreetingScore: 'NaN' }).minimumAutoGreetingScore).toBe(80);
    expect(norm({ minimumAutoGreetingScore: 88.6 }).minimumAutoGreetingScore).toBe(89);
  });

  it('每日上限钳制到 1-100（0 视为非法而非"禁止联系"）', () => {
    expect(norm({ dailyGreetingCap: 0 }).dailyGreetingCap).toBe(1);
    expect(norm({ dailyGreetingCap: 999 }).dailyGreetingCap).toBe(100);
    expect(norm({ dailyGreetingCap: 12 }).dailyGreetingCap).toBe(12);
  });

  it('候选目标 / 轮次 / 监测间隔钳制', () => {
    expect(norm({ batchQualifiedTarget: 0 }).batchQualifiedTarget).toBe(1);
    expect(norm({ batchQualifiedTarget: 99 }).batchQualifiedTarget).toBe(50);
    expect(norm({ maxDiscoveryRounds: 0 }).maxDiscoveryRounds).toBe(1);
    expect(norm({ maxDiscoveryRounds: 99 }).maxDiscoveryRounds).toBe(10);
    expect(norm({ maxReplanPerRound: 5 }).maxReplanPerRound).toBe(1);
    expect(norm({ monitorIntervalMinutes: 1 }).monitorIntervalMinutes).toBe(5);
    expect(norm({ monitorIntervalMinutes: 999 }).monitorIntervalMinutes).toBe(15);
  });

  it('非法 mode 回退 review；autoSendResume 只认显式 true', () => {
    expect(norm({ mode: 'auto' }).mode).toBe('review');
    expect(norm({ mode: 'AUTOPILOT' }).mode).toBe('review');
    expect(norm({ mode: 'autopilot' }).mode).toBe('autopilot');
    expect(norm({ autoSendResume: 'true' }).autoSendResume).toBe(false);
    expect(norm({ autoSendResume: 1 }).autoSendResume).toBe(false);
    expect(norm({ autoSendResume: true }).autoSendResume).toBe(true);
  });
});

describe('工作时间校验', () => {
  it('isValidHHMM / hhmmToMinutes', () => {
    expect(isValidHHMM('09:00')).toBe(true);
    expect(isValidHHMM('23:59')).toBe(true);
    expect(isValidHHMM('00:00')).toBe(true);
    expect(isValidHHMM('9:00')).toBe(false);
    expect(isValidHHMM('24:00')).toBe(false);
    expect(isValidHHMM('09:60')).toBe(false);
    expect(hhmmToMinutes('09:30')).toBe(570);
    expect(hhmmToMinutes('bad')).toBeNull();
  });

  it('日内区间（含边界）', () => {
    expect(isWithinWorkingHours('12:00', '09:00', '18:00')).toBe(true);
    expect(isWithinWorkingHours('09:00', '09:00', '18:00')).toBe(true);
    expect(isWithinWorkingHours('18:00', '09:00', '18:00')).toBe(true);
    expect(isWithinWorkingHours('08:59', '09:00', '18:00')).toBe(false);
    expect(isWithinWorkingHours('18:01', '09:00', '18:00')).toBe(false);
  });

  it('跨夜区间与异常配置', () => {
    expect(isWithinWorkingHours('23:00', '22:00', '06:00')).toBe(true);
    expect(isWithinWorkingHours('05:00', '22:00', '06:00')).toBe(true);
    expect(isWithinWorkingHours('12:00', '22:00', '06:00')).toBe(false);
    expect(isWithinWorkingHours('12:00', '09:00', '09:00')).toBe(true); // start==end 视为全天
    expect(isWithinWorkingHours('bad', '09:00', '18:00')).toBe(true); // 配置异常不阻断
  });

  it('workingHours 非法时回退默认并给出 warning', () => {
    const { settings, warnings } = normalizeSettings({ workingHours: { start: '9:00', end: '25:00' } });
    expect(settings.workingHours).toEqual({ start: '09:00', end: '18:00' });
    expect(warnings.some((w) => w.includes('workingHours'))).toBe(true);
  });
});

describe('招呼话术校验', () => {
  it('空 / 纯空白 / 超长 / 控制字符均非法', () => {
    expect(validateGreetingTemplate('').ok).toBe(false);
    expect(validateGreetingTemplate('   ').ok).toBe(false);
    expect(validateGreetingTemplate(undefined).ok).toBe(false);
    expect(validateGreetingTemplate('あ'.repeat(MAX_GREETING_TEMPLATE_LENGTH + 1)).ok).toBe(false);
    expect(validateGreetingTemplate('你好\u0007世界').ok).toBe(false);
  });

  it('合法话术返回 trim 后长度', () => {
    const r = validateGreetingTemplate('  你好，希望聊聊  ');
    expect(r.ok).toBe(true);
    expect(r.length).toBe(7);
  });

  it('非法模板在 normalizeSettings 中回退默认，并保留 warning', () => {
    const { settings, warnings } = normalizeSettings({
      greetingStrategy: { mode: 'template', template: '   ' },
    });
    expect(settings.greetingStrategy.template).toBe(DEFAULT_GREETING_TEMPLATE);
    expect(warnings.some((w) => w.includes('greeting template'))).toBe(true);
  });

  it('jd_personalized 模式被保留但 Phase 1 不生成话术', () => {
    expect(norm({ greetingStrategy: { mode: 'jd_personalized', template: 'hi' } }).greetingStrategy.mode).toBe(
      'jd_personalized',
    );
  });
});

describe('V0.4 旧数据迁移（只读一次）', () => {
  it('legacy.dailyCap → dailyGreetingCap', () => {
    expect(norm({}, { dailyCap: 7 }).dailyGreetingCap).toBe(7);
    // 新字段优先于旧字段
    expect(norm({ dailyGreetingCap: 15 }, { dailyCap: 7 }).dailyGreetingCap).toBe(15);
  });

  it('legacy.greetText → greetingStrategy.template', () => {
    const s = norm({}, { greetText: '这是老用户自定义话术' });
    expect(s.greetingStrategy.template).toBe('这是老用户自定义话术');
  });

  it('旧值非法时仍回退默认', () => {
    expect(norm({}, { dailyCap: 0 }).dailyGreetingCap).toBe(5);
    expect(norm({}, { greetText: '  ' }).greetingStrategy.template).toBe(DEFAULT_GREETING_TEMPLATE);
  });
});

describe('授权状态机', () => {
  it('consent.autopilot 单独为 true 但 mode=review 时不算已授权', () => {
    expect(hasAutopilotConsent({ mode: 'review', consent: { autopilot: true } })).toBe(false);
    expect(hasAutopilotConsent({ mode: 'autopilot', consent: { autopilot: false } })).toBe(false);
    expect(hasAutopilotConsent({ mode: 'autopilot', consent: { autopilot: true } })).toBe(true);
    expect(hasAutopilotConsent(null)).toBe(false);
  });

  it('recordAutopilotConsent 生成新对象并带时间戳（不改原对象）', () => {
    const base = norm({});
    const at = '2026-01-01T09:00:00.000Z';
    const next = recordAutopilotConsent(base, at);
    expect(next.mode).toBe('autopilot');
    expect(next.consent.autopilot).toBe(true);
    expect(next.consent.autopilotAt).toBe(at);
    expect(base.consent.autopilot).toBe(false);
    expect(base.mode).toBe('review');
  });

  it('revokeAutopilotConsent 切回 review 并记录撤销时间', () => {
    const on = recordAutopilotConsent(norm({}), '2026-01-01T09:00:00.000Z');
    const off = revokeAutopilotConsent(on, '2026-01-02T09:00:00.000Z');
    expect(off.mode).toBe('review');
    expect(off.consent.autopilot).toBe(false);
    expect(off.consent.autopilotAt).toBe('2026-01-02T09:00:00.000Z');
    expect(hasAutopilotConsent(off)).toBe(false);
  });

  it('recordAutoResumeConsent 关闭时保留首次授权时间', () => {
    const on = recordAutoResumeConsent(norm({}), true, '2026-01-01T00:00:00.000Z');
    expect(on.autoSendResume).toBe(true);
    expect(on.consent.autoResume).toBe(true);
    expect(on.consent.autoResumeAt).toBe('2026-01-01T00:00:00.000Z');
    const off = recordAutoResumeConsent(on, false, '2026-02-01T00:00:00.000Z');
    expect(off.autoSendResume).toBe(false);
    expect(off.consent.autoResume).toBe(false);
    expect(off.consent.autoResumeAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('授权不会隐式开启自动发简历', () => {
    const on = recordAutopilotConsent(norm({}), '2026-01-01T09:00:00.000Z');
    expect(on.autoSendResume).toBe(false);
    expect(on.consent.autoResume).toBe(false);
  });

  it('DEFAULT_SETTINGS 被冻结，防止运行期意外改写默认值', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
  });
});


// ---------------- storage 包装（用内存 chrome 桩，验证 key 与旧数据迁移） ----------------

function makeChrome(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    __store: store,
    storage: {
      local: {
        async get(keys?: unknown) {
          if (keys == null) return { ...store };
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (k in store) out[k as string] = store[k as string];
          return out;
        },
        async set(obj: Record<string, unknown>) {
          Object.assign(store, obj);
        },
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadSettings / saveSettings（仅读写 jobAgentSettings）', () => {
  it('首次运行无任何存储 → 返回默认设置', async () => {
    vi.stubGlobal('chrome', makeChrome());
    const s = await loadSettings();
    expect(s.mode).toBe('review');
    expect(s.dailyGreetingCap).toBe(5); // V0.5 保守默认值
  });

  it('读取 V0.4 旧 key（dailyCap / greetText）完成一次迁移', async () => {
    vi.stubGlobal('chrome', makeChrome({ dailyCap: 6, greetText: '老话术' }));
    const s = await loadSettings();
    expect(s.dailyGreetingCap).toBe(6);
    expect(s.greetingStrategy.template).toBe('老话术');
  });

  it('新 key 存在时忽略旧 key', async () => {
    vi.stubGlobal(
      'chrome',
      makeChrome({ jobAgentSettings: { mode: 'review', dailyGreetingCap: 9 }, dailyCap: 3, greetText: '旧' }),
    );
    const s = await loadSettings();
    expect(s.dailyGreetingCap).toBe(9);
  });

  it('save → load 往返一致，且不写入旧 key', async () => {
    const stub = makeChrome();
    vi.stubGlobal('chrome', stub);
    const saved = await saveSettings({ ...DEFAULT_SETTINGS, mode: 'autopilot', dailyGreetingCap: 12 });
    expect(saved.dailyGreetingCap).toBe(12);
    expect(stub.__store[SETTINGS_KEY]).toEqual(saved);
    expect(stub.__store.dailyCap).toBeUndefined();
    expect(stub.__store.greetText).toBeUndefined();
    expect((await loadSettings()).dailyGreetingCap).toBe(12);
  });

  it('saveSettings 对非法输入做钳制后才落盘', async () => {
    const stub = makeChrome();
    vi.stubGlobal('chrome', stub);
    const saved = await saveSettings({ mode: 'nope', dailyGreetingCap: 9999, minimumAutoGreetingScore: -1 });
    expect(saved.mode).toBe('review');
    expect(saved.dailyGreetingCap).toBe(100);
    expect(saved.minimumAutoGreetingScore).toBe(0);
    expect((stub.__store[SETTINGS_KEY] as { dailyGreetingCap: number }).dailyGreetingCap).toBe(100);
  });

  it('patchSettings 基于当前值合并（授权流程用的就是这条路径）', async () => {
    vi.stubGlobal('chrome', makeChrome({ [SETTINGS_KEY]: { dailyGreetingCap: 15, minimumAutoGreetingScore: 85 } }));
    const patched = await patchSettings({ mode: 'autopilot' });
    expect(patched.mode).toBe('autopilot');
    expect(patched.dailyGreetingCap).toBe(15);
    expect(patched.minimumAutoGreetingScore).toBe(85);
  });
});
