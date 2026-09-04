import {
  APPLICATION_STATES,
  TERMINAL_APPLICATION_STATES,
} from '@job-agent/domain';
import type { ApplicationState } from '@job-agent/domain';

/**
 * 岗位状态机迁移表 —— DATA_MODEL §3.2 的可执行版。
 * 约定：迁移由纯函数 canTransition 守卫；DB 另有 CHECK 兜底；
 * NO_REPLY 收到新 HR 消息后的"唤醒"路径由 conversation 处理逻辑决定去向（此处仅允许合法终态）。
 */

export const APPLICATION_TRANSITIONS: Readonly<Record<ApplicationState, readonly ApplicationState[]>> = {
  DISCOVERED: ['FILTERED', 'QUEUED', 'NEEDS_HUMAN'],
  QUEUED: ['GREETED', 'FAILED', 'NEEDS_HUMAN'],
  GREETED: ['RESUME_SENT', 'FAILED', 'NEEDS_HUMAN', 'NO_REPLY'],
  RESUME_SENT: ['NO_REPLY', 'NEEDS_HUMAN', 'INTERVIEWING'],
  NO_REPLY: ['NEEDS_HUMAN', 'RESUME_SENT', 'INTERVIEWING'],
  INTERVIEWING: [],
  NEEDS_HUMAN: ['INTERVIEWING', 'NO_REPLY', 'RESUME_SENT', 'FAILED'],
  FILTERED: [],
  FAILED: ['QUEUED'],
};

export function canTransition(from: ApplicationState, to: ApplicationState): boolean {
  return APPLICATION_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ApplicationState, to: ApplicationState): void {
  if (!canTransition(from, to)) {
    throw new StateTransitionError(`非法状态迁移 ${from} -> ${to}（见 DATA_MODEL §3.2）`);
  }
}

export function isTerminal(state: ApplicationState): boolean {
  return TERMINAL_APPLICATION_STATES.has(state);
}

export class StateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateTransitionError';
  }
}

/** 一致性自检：迁移表每个目标都在枚举内、且不等于自身 */
export function validateTransitionTable(): string[] {
  const problems: string[] = [];
  for (const from of APPLICATION_STATES) {
    for (const to of APPLICATION_TRANSITIONS[from]) {
      if (!APPLICATION_STATES.includes(to)) problems.push(`${from} -> 未知状态 ${to}`);
      if (from === to) problems.push(`${from} -> ${to} 自环`);
    }
  }
  return problems;
}
