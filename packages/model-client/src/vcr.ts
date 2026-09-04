import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 简易 VCR：以 (文件, id) 为键录制/回放模型调用结果，离线可复现。 */
export class VcrNoDataError extends Error {
  constructor(id: string, file: string) {
    super(`VCR 无可用数据（id=${id}，file=${file}）：离线回放需要先在有 Key 时以 RUN_MODEL_LIVE=1 录制一次。`);
    this.name = 'VcrNoDataError';
  }
}

export type VcrStore = Record<string, unknown>;

export function isLiveMode(): boolean {
  return process.env.RUN_MODEL_LIVE === '1';
}

function readStore(file: string): VcrStore {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8')) as VcrStore;
}

/** 有录制→回放；live 且可联网→真调并落盘；否则抛 VcrNoDataError。 */
export async function vcrCall<T>(opts: { file: string; id: string; live: boolean; produce: () => Promise<T> }): Promise<T> {
  const store = readStore(opts.file);
  if (opts.id in store) return store[opts.id] as T;
  if (!opts.live) throw new VcrNoDataError(opts.id, opts.file);
  const value = await opts.produce();
  store[opts.id] = value;
  mkdirSync(dirname(opts.file), { recursive: true });
  writeFileSync(opts.file, JSON.stringify(store, null, 1) + '\n');
  return value;
}

export function vcrHas(file: string, id: string): boolean {
  return readStore(file)[id] !== undefined;
}
