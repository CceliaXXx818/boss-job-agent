/**
 * 确定性浏览器动词 —— ARCHITECTURE §3.2 / P3。
 * 设计要点（A1/A6）：
 *   1. Agent/业务层只能表达"动词 + 页面角色 + 参数"，绝不接触 DOM/选择器；
 *   2. 页面结构用 PageRole 映射声明（页面对象），版本化；任何动词找不到对应角色
 *      ⇒ 返回 PAGE_CHANGED（不猜测、不盲点）；
 *   3. 动词是代码级确定性实现，可被两个驱动执行：
 *      - InMemoryDriver：离线测试/演示（fixture 页面对象）；
 *      - PlaywrightDriver：真实浏览器（浏览器二进制需用户在真机下载后启用，见说明）。
 */

export type VerbName =
  | 'goto'
  | 'search'
  | 'open_job'
  | 'read_login_state'
  | 'greet_send'
  | 'read_unread_messages'
  | 'open_chat'
  | 'resume_send'
  | 'text_send';

export interface VerbArgMap {
  goto: { url: string };
  search: { city: string; keywords: string[] };
  open_job: { externalId: string };
  read_login_state: Record<string, never>;
  greet_send: { text: string };
  read_unread_messages: Record<string, never>;
  open_chat: { jobId: string };
  resume_send: { mode: 'online' | 'attachment'; filePath?: string };
  text_send: { text: string };
}

export type VerbOutcome<T> = { ok: true; data: T } | { ok: false; code: 'PAGE_CHANGED' | 'NOT_FOUND' | 'BUSY' | 'GUARD'; message: string };

/** 页面角色（页面对象的最小单元）：名称唯一，可附带断言 hint */
export interface PageRole {
  key: string;
  kind: 'button' | 'input' | 'list' | 'text' | 'upload' | 'nav';
}

/** 页面结构声明（页面对象）：roles 必须覆盖其支持的全部动词所需角色 */
export interface PageSpec {
  pageName: string;
  version: string;
  roles: PageRole[];
}

/** 动词执行计划的单步 */
export interface VerbStep {
  verb: VerbName;
  roleKey?: string;
  arg?: unknown;
}

/** 驱动接口：把 Step 翻译为浏览器动作。选择器在驱动内按 roleKey 解析。 */
export interface BrowserDriver {
  /** 页面对象注册表（真实实现会绑定到可解析的页面） */
  registerPages(pages: PageSpec[]): void;
  run(step: VerbStep): Promise<VerbOutcome<unknown>>;
  /** 打开 URL（首步通常为 goto） */
  goto(url: string): Promise<VerbOutcome<{ url: string }>>;
}
