import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLiveMode, VcrNoDataError, vcrCall, vcrHas } from './vcr';

describe('model-client: VCR（录制/回放/缺数据）', () => {
  it('录制后可回放；无录制且非 live 抛 VcrNoDataError', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcr-'));
    const file = join(dir, 'store.json');
    try {
      // live 录制
      const produced = await vcrCall({ file, id: 'a', live: true, produce: async () => ({ ok: 1 }) });
      expect(produced).toEqual({ ok: 1 });
      expect(vcrHas(file, 'a')).toBe(true);
      // 回放（不调用 produce）
      let calls = 0;
      const replayed = await vcrCall({
        file,
        id: 'a',
        live: false,
        produce: async () => {
          calls++;
          return { ok: 2 };
        },
      });
      expect(replayed).toEqual({ ok: 1 });
      expect(calls).toBe(0);
      // 缺数据
      await expect(vcrCall({ file, id: 'missing', live: false, produce: async () => ({}) })).rejects.toThrow(VcrNoDataError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isLiveMode 读取 RUN_MODEL_LIVE', () => {
    const prev = process.env.RUN_MODEL_LIVE;
    process.env.RUN_MODEL_LIVE = '1';
    expect(isLiveMode()).toBe(true);
    process.env.RUN_MODEL_LIVE = '0';
    expect(isLiveMode()).toBe(false);
    if (prev === undefined) delete process.env.RUN_MODEL_LIVE;
    else process.env.RUN_MODEL_LIVE = prev;
  });

  it('store 文件可读回（幂等保存）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcr2-'));
    const file = join(dir, 's.json');
    try {
      writeFileSync(file, JSON.stringify({ k: 1 }));
      expect(vcrHas(file, 'k')).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain('"k"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
