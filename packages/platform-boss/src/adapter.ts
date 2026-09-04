import { readFileSync } from 'node:fs';
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
import type { PageSpec } from '@job-agent/browser-runtime';

/**
 * BossPlatformAdapter —— 真实 BOSS 平台实现（默认禁运，Q12 / PLAN P3-P4）。
 * 安全边界（fail-closed）：
 *   - 未显式 enabled + 本地 consent 标记前，任何方法抛 BossDisabledError，零网络请求；
 *   - 页面交互全部走 browser-runtime 的确定性动词 + 页面角色（页面对象），
 *     选择器与真实页面对齐需要用户真机校准（P4），本仓库 fixture 仅占位。
 */

export const BOSS_CONSENT_MARKER = 'consent:job-application-agent';

export class BossDisabledError extends Error {
  constructor() {
    super(
      'BossPlatformAdapter 禁运中：需用户完成 Q12 授权（consent 文件）+ 真机校准后显式启用（见 docs/IMPLEMENTATION_PLAN.md P4 / docs/PINNED.md）',
    );
    this.name = 'BossDisabledError';
  }
}

export interface BossOptions {
  enabled: boolean;
  consentFile?: string;
}

export function checkConsentFile(path: string): boolean {
  try {
    const text = readFileSync(path, 'utf8');
    return text.split('\n').some((l) => l.trim() === BOSS_CONSENT_MARKER);
  } catch {
    return false;
  }
}

/** 供验证：每个平台方法应使用的页面角色集合（绑定 fixture/真机页面对象） */
export const BOSS_PAGE_ROLE_USAGE: Record<string, readonly string[]> = {
  checkLogin: ['login_state'],
  searchJobs: ['search_box', 'job_list'],
  getJobDetail: ['job_list', 'job_detail'],
  sendGreeting: ['greet_button'],
  getNewMessages: ['chat_unread', 'chat_input'],
  sendResume: ['resume_online_button'],
  sendTextReply: ['chat_input'],
};

export class BossPlatformAdapter implements JobPlatformAdapter {
  readonly platformId: PlatformId = 'boss';
  private readonly enabled: boolean;

  constructor(private readonly opts: BossOptions & { pages?: PageSpec[] }) {
    this.enabled = opts.enabled && (!opts.consentFile || checkConsentFile(opts.consentFile));
    if (!opts.enabled && !opts.consentFile) {
      // 未授权默认态：启动即可见（构造允许，调用时抛）
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private guard(): never {
    throw new BossDisabledError();
  }

  /** 供测试/审计：确认启用的方法会引用已注册页面中的角色 */
  requireRolesFor(method: keyof JobPlatformAdapter): readonly string[] {
    const need = BOSS_PAGE_ROLE_USAGE[method] ?? [];
    if (!this.enabled) this.guard();
    return need;
  }

  async checkLogin(): Promise<LoginStatus> {
    this.guard();
  }
  async searchJobs(_query: SearchQuery): Promise<JobSummary[]> {
    this.guard();
  }
  async getJobDetail(_externalJobId: string): Promise<JobDetail> {
    this.guard();
  }
  async getNewMessages(_conversationId: string, _afterMessageId?: string): Promise<ConversationMessage[]> {
    this.guard();
  }
  async listActiveConversations(): Promise<{ conversationId: string; externalJobId: string; lastMessageId?: string }[]> {
    this.guard();
  }
  async sendGreeting(_externalJobId: string, _message: string): Promise<SendResult> {
    this.guard();
  }
  async sendResume(
    _conversationId: string,
    _opts: { mode: 'online' | 'attachment'; filePath?: string },
  ): Promise<SendResult> {
    this.guard();
  }
  async sendTextReply(_conversationId: string, _text: string): Promise<SendResult> {
    this.guard();
  }
}
