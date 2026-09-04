import { createHash } from 'node:crypto';
import type { PlatformId } from '@job-agent/domain';
import type {
  ConversationMessage,
  JobDetail,
  JobPlatformAdapter,
  JobSummary,
  LoginStatus,
  SearchQuery,
  SendResult,
} from '@job-agent/agent-core';
import type { Clock } from '@job-agent/agent-core';
import { systemClock } from '@job-agent/agent-core';

/**
 * MockPlatformAdapter —— ARCHITECTURE §5.3：确定性内存模拟器（P0–P2 唯一启用实现）。
 * 特性：种子岗位目录 + 脚本化 HR + 副作用账本 + 异常注入（登录过期/验证码/页面变化）。
 * 无网络、无真实平台；所有效果可计数断言（测试金标准）。
 */

export type HrScriptType =
  | 'request_resume'
  | 'request_online_submit'
  | 'ask_salary'
  | 'invite'
  | 'availability'
  | 'smalltalk'
  | 'silence';

export interface MockJob {
  externalId: string;
  title: string;
  company: string;
  city: string;
  salaryText?: string;
  salaryMinK?: number;
  salaryMaxK?: number;
  tags: string[];
  jobType?: string;
  workMode?: string;
  description: string;
  hrName?: string;
  hrScript: HrScriptType;
}

export interface MockEffect {
  seq: number;
  at: string;
  kind: 'greeting' | 'resume' | 'reply';
  jobId?: string;
  conversationId?: string;
  text?: string;
  mode?: 'online' | 'attachment';
  effectId: string;
}

interface MockMsg {
  seq: number;
  messageId: string;
  direction: 'hr' | 'agent';
  text: string;
  sentAt: string;
}

interface MockConversation {
  conversationId: string;
  externalJobId: string;
  externalConversationId: string;
  messages: MockMsg[];
  seq: number;
}

export class AdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

export const SCRIPT_REPLY: Record<Exclude<HrScriptType, 'silence'>, string> = {
  request_resume: '可以发一份简历给我吗？',
  request_online_submit: '方便的话投递一下在线简历',
  ask_salary: '方便问下你期望的薪资范围吗？',
  invite: '你明天下午方便面试吗？',
  availability: '你目前在职吗？',
  smalltalk: '你好',
};

export interface LoginDriver {
  state: 'logged_in' | 'logged_out' | 'verification_required' | 'page_changed';
}

/** 内存市场：并发安全不需要；单线程确定性。 */
export class MockMarket {
  readonly effects: MockEffect[] = [];
  jobs: MockJob[];
  private seq = 0;
  private conversations = new Map<string, MockConversation>();
  private greetedJobs = new Set<string>();
  login: LoginDriver = { state: 'logged_in' };

  constructor(jobs: readonly MockJob[]) {
    this.jobs = [...jobs];
  }

  /** 每日新增岗位投放（soak/场景用） */
  addJobs(list: readonly MockJob[]): void {
    this.jobs.push(...list);
  }

  setLogin(state: LoginDriver['state']): void {
    this.login.state = state;
  }

  private nextEffect(effect: Omit<MockEffect, 'seq' | 'effectId'>): MockEffect {
    const rec: MockEffect = { ...effect, seq: ++this.seq, effectId: `eff-${this.seq}` };
    this.effects.push(rec);
    return rec;
  }

  private conv(jobId: string): MockConversation {
    let c = this.conversations.get(jobId);
    if (!c) {
      c = {
        conversationId: `conv-${jobId}`,
        externalJobId: jobId,
        externalConversationId: `ext-${jobId}`,
        messages: [],
        seq: 0,
      };
      this.conversations.set(jobId, c);
    }
    return c;
  }

  private pushMsg(jobId: string, direction: 'hr' | 'agent', text: string, at: string): MockMsg {
    const c = this.conv(jobId);
    const msg: MockMsg = {
      seq: ++c.seq,
      messageId: `${jobId}-m${c.seq}`,
      direction,
      text,
      sentAt: at,
    };
    c.messages.push(msg);
    return msg;
  }

  isGreeted(jobId: string): boolean {
    return this.greetedJobs.has(jobId);
  }

  /** 打招呼：同一岗位只允许一次（真实平台语义的镜像守卫） */
  greet(jobId: string, text: string, at: string): SendResult {
    if (this.greetedJobs.has(jobId)) {
      return {
        platform: 'mock',
        ok: false,
        executedAt: at,
        error: { code: 'ALREADY_GREETED', message: '该岗位已打过招呼', retryable: false },
      };
    }
    this.greetedJobs.add(jobId);
    this.pushMsg(jobId, 'agent', text, at);
    const e = this.nextEffect({ at, kind: 'greeting', jobId, conversationId: `conv-${jobId}`, text });
    return { platform: 'mock', ok: true, effectId: e.effectId, executedAt: at };
  }

  sendResume(conversationId: string, mode: 'online' | 'attachment', at: string): SendResult {
    const c = this.byConvId(conversationId);
    const e = this.nextEffect({ at, kind: 'resume', conversationId, jobId: c.externalJobId, mode });
    return { platform: 'mock', ok: true, effectId: e.effectId, executedAt: at };
  }

  sendReply(conversationId: string, text: string, at: string): SendResult {
    const c = this.byConvId(conversationId);
    this.pushMsg(c.externalJobId, 'agent', text, at);
    const e = this.nextEffect({ at, kind: 'reply', conversationId, jobId: c.externalJobId, text });
    return { platform: 'mock', ok: true, effectId: e.effectId, executedAt: at };
  }

  /** HR 主动发消息（场景驱动） */
  hrSend(jobId: string, text: string, at: string): void {
    this.pushMsg(jobId, 'hr', text, at);
  }

  /** 按脚本给某岗位 HR 一条回复 */
  replyByScript(jobId: string, at: string): boolean {
    const job = this.jobs.find((j) => j.externalId === jobId);
    if (!job || job.hrScript === 'silence') return false;
    this.hrSend(jobId, SCRIPT_REPLY[job.hrScript], at);
    return true;
  }

  getConversation(jobId: string): { conversationId: string; externalJobId: string; externalConversationId: string } | undefined {
    const c = this.conversations.get(jobId);
    if (!c) return undefined;
    return {
      conversationId: c.conversationId,
      externalJobId: c.externalJobId,
      externalConversationId: c.externalConversationId,
    };
  }

  listConversations(): { conversationId: string; externalJobId: string; lastMessageId?: string }[] {
    return [...this.conversations.values()].map((c) => ({
      conversationId: c.conversationId,
      externalJobId: c.externalJobId,
      lastMessageId: c.messages.at(-1)?.messageId,
    }));
  }

  messagesOf(jobId: string, afterMessageId?: string): ConversationMessage[] {
    const c = this.conversations.get(jobId);
    if (!c) return [];
    let list = c.messages;
    if (afterMessageId) {
      const idx = c.messages.findIndex((m) => m.messageId === afterMessageId);
      if (idx >= 0) list = c.messages.slice(idx + 1);
    }
    return list
      .filter((m) => m.direction === 'hr')
      .map((m) => ({
        platform: 'mock' as PlatformId,
        conversationId: c.conversationId,
        externalJobId: c.externalJobId,
        messageId: m.messageId,
        direction: m.direction,
        text: m.text,
        sentAt: m.sentAt,
      }));
  }

  private byConvId(conversationId: string): MockConversation {
    for (const c of this.conversations.values()) if (c.conversationId === conversationId) return c;
    throw new AdapterError('CONVERSATION_NOT_FOUND', `会话不存在: ${conversationId}`, false);
  }

  countByKind(kind: MockEffect['kind']): number {
    return this.effects.filter((e) => e.kind === kind).length;
  }
}

export function fingerprint(title: string, company: string, description: string): string {
  return createHash('sha256').update(`${title}|${company}|${description}`).digest('hex').slice(0, 24);
}

export class MockPlatformAdapter implements JobPlatformAdapter {
  readonly platformId: PlatformId = 'mock';
  private readonly clock: Clock;

  constructor(
    readonly market: MockMarket,
    clock?: Clock,
  ) {
    this.clock = clock ?? systemClock();
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }

  private guardPage(): void {
    if (this.market.login.state === 'page_changed') {
      throw new AdapterError('PAGE_CHANGED', '平台页面结构变化，需人工更新页面对象', false);
    }
  }

  async checkLogin(): Promise<LoginStatus> {
    const s = this.market.login.state;
    const at = this.nowIso();
    if (s === 'verification_required') {
      return { ok: false, state: 'verification_required', checkedAt: at, detail: '模拟：安全验证' };
    }
    if (s === 'logged_out') {
      return { ok: false, state: 'logged_out', checkedAt: at, detail: '模拟：登录失效' };
    }
    if (s === 'page_changed') {
      return { ok: false, state: 'page_changed', checkedAt: at, detail: '模拟：页面变化' };
    }
    return { ok: true, state: 'logged_in', checkedAt: at };
  }

  private toSummary(j: MockJob): JobSummary {
    return {
      platform: 'mock',
      externalId: j.externalId,
      title: j.title,
      company: j.company,
      city: j.city,
      salaryText: j.salaryText,
      url: `https://mock.jobs.local/job/${j.externalId}`,
      jdFingerprint: fingerprint(j.title, j.company, j.description),
    };
  }

  async searchJobs(query: SearchQuery): Promise<JobSummary[]> {
    this.guardPage();
    return this.market.jobs
      .filter((j) => j.city === query.city)
      .filter((j) => query.keywords.some((k) => j.title.includes(k) || j.description.includes(k)))
      .map((j) => this.toSummary(j));
  }

  async getJobDetail(externalJobId: string): Promise<JobDetail> {
    this.guardPage();
    const j = this.market.jobs.find((x) => x.externalId === externalJobId);
    if (!j) throw new AdapterError('JOB_NOT_FOUND', `岗位不存在: ${externalJobId}`, false);
    const conv = this.market.getConversation(externalJobId);
    return {
      ...this.toSummary(j),
      salaryMinK: j.salaryMinK,
      salaryMaxK: j.salaryMaxK,
      experienceRequired: '3-5年',
      educationRequired: '本科',
      tags: j.tags,
      jobType: j.jobType,
      workMode: j.workMode,
      description: j.description,
      hrName: j.hrName,
      conversationId: conv?.conversationId,
    };
  }

  async getNewMessages(conversationId: string, afterMessageId?: string): Promise<ConversationMessage[]> {
    this.guardPage();
    const entry = this.market.listConversations().find((c) => c.conversationId === conversationId);
    if (!entry) return [];
    return this.market.messagesOf(entry.externalJobId, afterMessageId);
  }

  async listActiveConversations(): Promise<{ conversationId: string; externalJobId: string; lastMessageId?: string }[]> {
    this.guardPage();
    return this.market.listConversations();
  }

  async sendGreeting(externalJobId: string, message: string): Promise<SendResult> {
    this.guardPage();
    return this.market.greet(externalJobId, message, this.nowIso());
  }

  async sendResume(
    conversationId: string,
    opts: { mode: 'online' | 'attachment'; filePath?: string },
  ): Promise<SendResult> {
    this.guardPage();
    return this.market.sendResume(conversationId, opts.mode, this.nowIso());
  }

  async sendTextReply(conversationId: string, text: string): Promise<SendResult> {
    this.guardPage();
    return this.market.sendReply(conversationId, text, this.nowIso());
  }
}
