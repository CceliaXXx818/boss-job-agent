import type { BrowserDriver, PageRole, PageSpec, VerbOutcome, VerbStep } from './core';

/** fixture 页面内容（驱动输入，替代浏览器 DOM 供离线测试/演示） */
export interface FixtureRoleValue {
  text?: string;
  items?: string[];
  clickable?: boolean;
}

export interface FixturePage {
  pageName: string;
  roleValues: Record<string, FixtureRoleValue>;
}

export interface ActionRecord {
  verb: string;
  roleKey?: string;
  detail: string;
}

export class PageStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageStructureError';
  }
}

/** 页面对象校验：role key 唯一、字段合法（A6：版本化页面结构） */
export function validatePageSpecs(pages: PageSpec[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    if (seen.has(p.pageName)) problems.push(`重复页面名 ${p.pageName}`);
    seen.add(p.pageName);
    const keys = new Set<string>();
    for (const r of p.roles) {
      if (keys.has(r.key)) problems.push(`${p.pageName} 重复角色 ${r.key}`);
      keys.add(r.key);
      if (!['button', 'input', 'list', 'text', 'upload', 'nav'].includes(r.kind)) {
        problems.push(`${p.pageName}.${r.key} 非法 kind ${r.kind}`);
      }
    }
    if (!/^\d+\.\d+$/.test(p.version)) problems.push(`${p.pageName} 版本号须 x.y`);
  }
  return problems;
}

/**
 * InMemoryDriver：确定性内存驱动（离线测试/演示用）。
 * 真实浏览器替换为 PlaywrightDriver（见 platform-boss，浏览器二进制需真机下载后启用）。
 */
export class InMemoryDriver implements BrowserDriver {
  private pages = new Map<string, PageSpec>();
  private fixture = new Map<string, FixtureRoleValue>();
  url = '';
  currentPage = '';
  readonly actions: ActionRecord[] = [];
  /** 动词行为结果由引擎按角色 kind 决定 */
  private roleKindCache = new Map<string, PageRole['kind']>();

  registerPages(pages: PageSpec[]): void {
    const problems = validatePageSpecs(pages);
    if (problems.length) throw new PageStructureError(problems.join('; '));
    for (const p of pages) this.pages.set(p.pageName, p);
    for (const p of pages) {
      for (const r of p.roles) this.roleKindCache.set(`${p.pageName}:${r.key}`, r.kind);
    }
  }

  loadFixture(f: FixturePage): void {
    if (!this.pages.has(f.pageName)) throw new PageStructureError(`未注册页面 ${f.pageName}`);
    this.fixture = new Map(Object.entries(f.roleValues));
    this.currentPage = f.pageName;
  }

  private kindOf(roleKey: string): PageRole['kind'] {
    const k = this.roleKindCache.get(`${this.currentPage}:${roleKey}`);
    if (!k) throw new PageStructureError(`当前页面 ${this.currentPage} 无角色 ${roleKey}`);
    return k;
  }

  private val(roleKey: string): FixtureRoleValue {
    const v = this.fixture.get(roleKey);
    if (!v) throw new PageStructureError(`fixture 缺少角色值 ${roleKey}`);
    return v;
  }

  async goto(url: string): Promise<VerbOutcome<{ url: string }>> {
    this.url = url;
    return { ok: true, data: { url } };
  }

  async run(step: VerbStep): Promise<VerbOutcome<unknown>> {
    const { verb, roleKey } = step;
    try {
      switch (verb) {
        case 'read_login_state': {
          const v = this.val('login_state');
          this.actions.push({ verb, roleKey: 'login_state', detail: v.text ?? 'unknown' });
          return { ok: true, data: { state: v.text } };
        }
        case 'open_job': {
          const arg = step.arg as { externalId: string };
          const items = this.val('job_list').items ?? [];
          if (!items.includes(arg.externalId)) {
            return { ok: false, code: 'NOT_FOUND', message: `岗位 ${arg.externalId} 不在列表中` };
          }
          this.actions.push({ verb, roleKey: 'job_list', detail: arg.externalId });
          return { ok: true, data: { opened: arg.externalId } };
        }
        case 'greet_send': {
          const arg = step.arg as { text: string };
          this.requireRole('greet_button', 'button');
          this.actions.push({ verb, roleKey: 'greet_button', detail: arg.text });
          return { ok: true, data: { sent: true, text: arg.text } };
        }
        case 'text_send': {
          const arg = step.arg as { text: string };
          this.requireRole('chat_input', 'input');
          this.actions.push({ verb, roleKey: 'chat_input', detail: arg.text });
          return { ok: true, data: { sent: true, text: arg.text } };
        }
        case 'search': {
          const arg = step.arg as { city: string; keywords: string[] };
          this.requireRole('search_box', 'input');
          this.actions.push({ verb, roleKey: 'search_box', detail: `${arg.city} ${arg.keywords.join('+')}` });
          const jobIds = this.val('job_list').items ?? [];
          return { ok: true, data: { jobIds } };
        }
        default:
          if (!roleKey) return { ok: false, code: 'GUARD', message: `动词 ${verb} 需要 roleKey` };
          // 通用：按角色 kind 记账（click/list/text）
          if (this.kindOf(roleKey) === 'list') {
            const v = this.val(roleKey);
            return { ok: true, data: { items: v.items ?? [] } };
          }
          if (this.kindOf(roleKey) === 'text') {
            const v = this.val(roleKey);
            return { ok: true, data: { text: v.text } };
          }
          return { ok: true, data: {} };
      }
    } catch (e) {
      return { ok: false, code: 'PAGE_CHANGED', message: (e as Error).message };
    }
  }

  private requireRole(roleKey: string, kind: PageRole['kind']): void {
    const actual = this.kindOf(roleKey);
    if (actual !== kind) throw new PageStructureError(`角色 ${roleKey} 类型不符: 期望 ${kind} 实际 ${actual}`);
  }
}
