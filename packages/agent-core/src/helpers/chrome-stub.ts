// 测试用内存 chrome.storage 桩：模拟真实语义（get 数组/字符串/undefined、set、remove、QUOTA 无关）
// 与 V0.5 Phase 2 的存储层设计一致：所有持久化都必须通过 chrome.storage.local。

export type ChromeStub = {
  __store: Record<string, unknown>;
  __writes: number;
  storage: {
    local: {
      get(keys?: unknown): Promise<Record<string, unknown>>;
      set(obj: Record<string, unknown>): Promise<void>;
      remove(keys: unknown): Promise<void>;
    };
  };
};

export function makeChrome(initial: Record<string, unknown> = {}): ChromeStub {
  const store: Record<string, unknown> = JSON.parse(JSON.stringify(initial));
  const stub: ChromeStub = {
    __store: store,
    __writes: 0,
    storage: {
      local: {
        async get(keys?: unknown) {
          if (keys == null) return JSON.parse(JSON.stringify(store));
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) {
            if (k in store) out[k as string] = JSON.parse(JSON.stringify(store[k as string]));
          }
          return out;
        },
        async set(obj: Record<string, unknown>) {
          stub.__writes++;
          Object.assign(store, JSON.parse(JSON.stringify(obj)));
        },
        async remove(keys: unknown) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete store[k as string];
        },
      },
    },
  };
  return stub;
}

/** 深拷贝当前存储快照：用于"重新打开 Side Panel"这类持久化验证 */
export function snapshot(stub: ChromeStub): Record<string, unknown> {
  return JSON.parse(JSON.stringify(stub.__store));
}

/** 用已有快照重建一个 chrome 桩（模拟 SW 重启 / Side Panel 重开） */
export function restore(snap: Record<string, unknown>): ChromeStub {
  return makeChrome(snap);
}

export function installChrome(stub: ChromeStub): void {
  (globalThis as unknown as { chrome: unknown }).chrome = stub;
}
