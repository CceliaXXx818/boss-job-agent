/**
 * Clock 端口 —— ARCHITECTURE §4.5（可回放 A9）。
 * 所有"今天/时间"都经 Clock 产生；测试注入虚拟时钟实现确定性。
 */

export interface Clock {
  now(): Date;
  /** Asia/Shanghai 的本地日键 YYYY-MM-DD（限额日/日报日） */
  todayKey(): string;
}

const TZ = 'Asia/Shanghai';

function partsOf(d: Date, tz = TZ): { year: string; month: string; day: string; hour: string; minute: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = fmt.formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

export function localDateKey(d: Date, tz = TZ): string {
  const p = partsOf(d, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localHHMM(d: Date, tz = TZ): string {
  const p = partsOf(d, tz);
  return `${p.hour}:${p.minute}`;
}

/** 系统时钟：真实本地时间，Asia/Shanghai 日键 */
export function systemClock(): Clock {
  return {
    now: () => new Date(),
    todayKey: () => localDateKey(new Date()),
  };
}

/** 虚拟时钟：测试确定性（起始点 + 步进） */
export type VirtualClock = Clock & { advance: (ms: number) => void; set: (iso: string) => void };

export function virtualClock(startISO: string): VirtualClock {
  let current = new Date(startISO);
  return {
    now: () => new Date(current),
    todayKey: () => localDateKey(current),
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
    set: (iso: string) => {
      current = new Date(iso);
    },
  };
}
