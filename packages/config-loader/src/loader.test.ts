import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadAppConfig,
  loadMessagesFromFile,
  loadProfileFromFile,
  loadScheduleFromFile,
  parseYamlText,
  validateCrossConstraints,
} from './loader';
import { messagesSchema, profileSchema, scheduleSchema } from './schemas';
import type { AppConfig } from './schemas';

const REPO_CONFIG_DIR = fileURLToPath(new URL('../../../config', import.meta.url));

function parseOk(schema: { safeParse: (d: unknown) => { success: boolean } }, text: string): boolean {
  return schema.safeParse(parseYamlText(text)).success;
}

describe('config-loader: 示例配置文件解析', () => {
  it('profile.example.yaml 解析出目标/排除/限额（与 USER_PROFILE/PRD 一致）', () => {
    const p = loadProfileFromFile(`${REPO_CONFIG_DIR}/profile.example.yaml`);
    expect(p.candidate.experience_years).toBe(7);
    expect(p.candidate.ai_product_years).toBe(3);
    expect(p.target.cities).toEqual(['深圳', '杭州']);
    expect(p.exclude.cities).toContain('北京');
    expect(p.application.minimum_match_score).toBe(75);
    expect(p.evidence.projects).toContain('LLM与RAG智能客服');
  });

  it('messages.example.yaml：t1/t2/t3 全部已批准且 slots 白名单合规', () => {
    const m = loadMessagesFromFile(`${REPO_CONFIG_DIR}/messages.example.yaml`);
    const t1 = m.greeting_templates.find((t) => t.template_id === 't1');
    expect(t1?.approved).toBe(true);
    expect(t1?.text).toContain('AI产品0-1落地');
    expect(m.greeting_templates.filter((t) => t.approved)).toHaveLength(3);
    const t2 = m.greeting_templates.find((t) => t.template_id === 't2');
    expect(t2?.slots).toContain('jd_core_requirement');
    const t3 = m.greeting_templates.find((t) => t.template_id === 't3');
    expect(t3?.slots).toEqual(['job_title', 'jd_core_requirement', 'evidence_project']);
    expect(m.auto_send_intents).toContain('request_resume');
    expect(m.needs_human_intents).toContain('salary_discussion');
  });

  it('schedule.example.yaml：默认扫描/重试/阈值就位', () => {
    const s = loadScheduleFromFile(`${REPO_CONFIG_DIR}/schedule.example.yaml`);
    expect(s.scan_interval_minutes).toBe(30);
    expect(s.retry.max_attempts).toBe(1);
    expect(s.no_reply_days).toBe(5);
    expect(s.score_buckets.hot).toBeGreaterThan(s.score_buckets.apply);
  });

  it('loadAppConfig 在无 profile.yaml 时退回 example（开箱演示）', () => {
    const { config, files } = loadAppConfig(REPO_CONFIG_DIR);
    expect(config.profile.target.job_titles.length).toBeGreaterThanOrEqual(5);
    expect(files.profileFile.endsWith('profile.example.yaml')).toBe(true);
  });
});

describe('config-loader: Zod strict 未知键与格式校验', () => {
  it('顶层未知键报错', () => {
    expect(parseOk(profileSchema, 'candidate:\n  experience_years: 7\n  ai_product_years: 3\nbogus_key: 1\n')).toBe(false);
  });
  it('嵌套未知键报错（target 下多字段）', () => {
    const text = [
      'candidate: { experience_years: 7, ai_product_years: 3 }',
      'target:',
      '  cities: [深圳]',
      '  job_titles: [AI产品经理]',
      '  bogus: 1',
      '',
    ].join('\n');
    expect(parseOk(profileSchema, text)).toBe(false);
  });
  it('时间格式必须 HH:MM', () => {
    const bad = 'weekdays_only: true\nstart_time: "9:30"\n';
    expect(parseOk(scheduleSchema, bad)).toBe(false);
    const good = 'weekdays_only: true\nstart_time: "09:30"\n';
    expect(parseOk(scheduleSchema, good)).toBe(true);
  });
  it('messages 中意图取值必须在领域枚举内', () => {
    const bad = 'greeting_templates:\n  - template_id: t1\n    approved: true\n    text: "你好"\nauto_send_intents: [not_an_intent]\n';
    expect(parseOk(messagesSchema, bad)).toBe(false);
  });
});

describe('config-loader: 跨文件一致性校验', () => {
  function base(): AppConfig {
    const { config } = loadAppConfig(REPO_CONFIG_DIR);
    return config;
  }

  it('示例配置通过跨文件校验', () => {
    expect(() => validateCrossConstraints(base())).not.toThrow();
  });

  it('score_buckets 顺序错误时抛 ConfigError', () => {
    const cfg = base();
    cfg.schedule.score_buckets = { hot: 65, apply: 75, review: 80 };
    expect(() => validateCrossConstraints(cfg)).toThrow(ConfigError);
  });

  it('auto_send 与 needs_human 意图重叠时抛 ConfigError', () => {
    const cfg = base();
    cfg.messages.auto_send_intents = ['request_resume', 'salary_discussion'];
    expect(() => validateCrossConstraints(cfg)).toThrow(/salary_discussion/);
  });

  it('report_time 早于 end_time 时抛 ConfigError', () => {
    const cfg = base();
    cfg.profile.application.report_time = '17:00';
    expect(() => validateCrossConstraints(cfg)).toThrow(ConfigError);
  });
});
