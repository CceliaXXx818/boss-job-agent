import type { PlatformId } from '@job-agent/domain';

/**
 * JobPlatformAdapter 端口 —— ARCHITECTURE §5 的可执行版。
 * 本包（agent-core）只依赖此接口，不依赖任何具体适配器。
 * 平台实现：platform-mock（P0–P2 唯一启用）、platform-boss（Phase 3+）。
 */

export interface LoginStatus {
  ok: boolean;
  state: 'logged_in' | 'logged_out' | 'verification_required' | 'page_changed' | 'unknown';
  checkedAt: string;
  detail?: string;
}

export interface SearchQuery {
  city: string;
  keywords: string[];
  experienceYears?: number;
  salaryMinK?: number;
  page?: number;
}

export interface JobSummary {
  platform: PlatformId;
  externalId: string;
  title: string;
  company: string;
  city: string;
  salaryText?: string;
  url: string;
  jdFingerprint: string;
}

export interface JobDetail extends JobSummary {
  salaryMinK?: number;
  salaryMaxK?: number;
  experienceRequired?: string;
  educationRequired?: string;
  tags: string[];
  jobType?: string;
  workMode?: string;
  description: string;
  hrName?: string;
  hrTitle?: string;
  conversationId?: string;
}

export interface ConversationMessage {
  platform: PlatformId;
  conversationId: string;
  externalJobId: string;
  messageId: string;
  direction: 'hr' | 'agent';
  text: string;
  sentAt: string;
  attachmentsHint?: string[];
}

export interface SendResult {
  platform: PlatformId;
  ok: boolean;
  effectId?: string;
  error?: { code: string; message: string; retryable: boolean };
  executedAt: string;
}

export type ResumeSendMode = 'online' | 'attachment';

export interface JobPlatformAdapter {
  readonly platformId: PlatformId;
  checkLogin(): Promise<LoginStatus>;
  searchJobs(query: SearchQuery): Promise<JobSummary[]>;
  getJobDetail(externalJobId: string): Promise<JobDetail>;
  getNewMessages(conversationId: string, afterMessageId?: string): Promise<ConversationMessage[]>;
  listActiveConversations(): Promise<{ conversationId: string; externalJobId: string; lastMessageId?: string }[]>;
  sendGreeting(externalJobId: string, message: string): Promise<SendResult>;
  sendResume(
    conversationId: string,
    opts: { mode: ResumeSendMode; filePath?: string },
  ): Promise<SendResult>;
  sendTextReply(conversationId: string, text: string): Promise<SendResult>;
}
