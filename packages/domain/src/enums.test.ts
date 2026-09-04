import { describe, expect, it } from 'vitest';
import {
  APPLICATION_STATE_LABELS,
  APPLICATION_STATES,
  TERMINAL_APPLICATION_STATES,
  DEFAULT_AUTO_SEND_INTENTS,
  DEFAULT_NEEDS_HUMAN_INTENTS,
  HR_INTENTS,
} from './enums';

describe('domain enums（DATA_MODEL §3 的可执行版本）', () => {
  it('岗位状态含 9 个值且每个有中文标签', () => {
    expect(APPLICATION_STATES).toHaveLength(9);
    for (const s of APPLICATION_STATES) {
      expect(APPLICATION_STATE_LABELS[s]).toBeTruthy();
    }
  });

  it('终态集合是岗位状态的子集', () => {
    for (const t of TERMINAL_APPLICATION_STATES) {
      expect(APPLICATION_STATES).toContain(t);
    }
  });

  it('意图白名单互斥：自动发送清单不包含需人工清单', () => {
    const auto = new Set(DEFAULT_AUTO_SEND_INTENTS);
    for (const h of DEFAULT_NEEDS_HUMAN_INTENTS) {
      expect(auto.has(h)).toBe(false);
    }
    expect(HR_INTENTS.length).toBeGreaterThanOrEqual(auto.size + DEFAULT_NEEDS_HUMAN_INTENTS.length);
  });
});
