import { z } from 'zod';
import {
  DEFAULT_AUTO_SEND_INTENTS,
  DEFAULT_NEEDS_HUMAN_INTENTS,
  HR_INTENTS,
} from '@job-agent/domain';

/**
 * Zod 配置 Schema —— ARCHITECTURE §6.1。
 * 全部使用 strict 对象：未知键直接报错（防笔误导致规则静默失效）。
 * 枚举取值以 @job-agent/domain（DATA_MODEL §3）为唯一来源。
 */

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 问候模板允许替换的字段白名单（TOOL_SPEC §6） */
export const GREETING_SLOTS = ['hr_name', 'job_title', 'jd_core_requirement', 'evidence_project'] as const;
export type GreetingSlot = (typeof GREETING_SLOTS)[number];

/** 从领域枚举构造 zod 枚举（取值以 domain 为准，类型放宽为 string 由运行时保证） */
function domainEnum(values: readonly string[]) {
  return z.enum([...values] as [string, ...string[]]);
}

const hrIntentEnum = domainEnum(HR_INTENTS);

// ---------- profile ----------

export const profileSchema = z.strictObject({
  candidate: z.strictObject({
    experience_years: z.number().int().nonnegative(),
    ai_product_years: z.number().int().nonnegative(),
    summary: z.string().optional(),
  }),
  target: z.strictObject({
    cities: z.array(z.string()).min(1),
    job_titles: z.array(z.string()).min(1),
    preferred_skills: z.array(z.string()).default([]),
  }),
  exclude: z.strictObject({
    cities: z.array(z.string()).default([]),
    job_types: z.array(z.string()).default([]),
    work_modes: z.array(z.string()).default([]),
  }),
  application: z.strictObject({
    minimum_match_score: z.number().min(0).max(100).default(75),
    daily_minimum: z.number().int().min(0).default(10),
    daily_maximum: z.number().int().min(1).default(30),
    weekdays_only: z.boolean().default(true),
    start_time: z.string().regex(TIME_PATTERN, '时间须为 HH:MM').default('09:30'),
    end_time: z.string().regex(TIME_PATTERN, '时间须为 HH:MM').default('17:30'),
    report_time: z.string().regex(TIME_PATTERN, '时间须为 HH:MM').default('18:00'),
  }),
  evidence: z.strictObject({
    projects: z.array(z.string()).default([]),
  }),
});
export type ProfileConfig = z.infer<typeof profileSchema>;

// ---------- messages ----------

export const messagesSchema = z.strictObject({
  greeting_templates: z
    .array(
      z.strictObject({
        template_id: z.string().min(1),
        approved: z.boolean(),
        text: z.string().min(1),
        slots: z.array(z.enum([...GREETING_SLOTS] as [string, ...string[]])).default([]),
        rotation_weight: z.number().int().positive().default(1),
      }),
    )
    .min(1),
  preset_replies: z.record(
    z.string(),
    z.strictObject({
      text: z.string().min(1),
      approved: z.boolean(),
    }),
  ),
  auto_send_intents: z.array(hrIntentEnum).default([...DEFAULT_AUTO_SEND_INTENTS]),
  needs_human_intents: z.array(hrIntentEnum).default([...DEFAULT_NEEDS_HUMAN_INTENTS]),
});
export type MessagesConfig = z.infer<typeof messagesSchema>;
export type GreetingTemplate = MessagesConfig['greeting_templates'][number];
export type PresetReply = MessagesConfig['preset_replies'][string];

// ---------- schedule ----------

export const scheduleSchema = z.strictObject({
  weekdays_only: z.boolean().default(true),
  weekdays: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
  start_time: z.string().regex(TIME_PATTERN, '时间须为 HH:MM').default('09:30'),
  end_time: z.string().regex(TIME_PATTERN, '时间须为 HH:MM').default('17:30'),
  report_time: z.string().regex(TIME_PATTERN, '时间须为 HH:MM').default('18:00'),
  timezone: z.string().min(1).default('Asia/Shanghai'),
  scan_interval_minutes: z.number().int().min(5).default(30),
  daily_minimum: z.number().int().min(0).default(10),
  daily_maximum: z.number().int().min(1).default(30),
  minimum_match_score: z.number().min(0).max(100).default(75),
  score_buckets: z
    .strictObject({
      hot: z.number().min(0).max(100).default(80),
      apply: z.number().min(0).max(100).default(75),
      review: z.number().min(0).max(100).default(65),
    })
    .default({ hot: 80, apply: 75, review: 65 }),
  no_reply_days: z.number().int().positive().default(5),
  same_company_cooldown_days: z.number().int().nonnegative().default(30),
  max_job_detail_per_session: z.number().int().positive().default(15),
  retry: z
    .strictObject({
      max_attempts: z.number().int().min(0).default(1),
      timeout_ms: z.number().int().positive().default(30_000),
    })
    .default({ max_attempts: 1, timeout_ms: 30_000 }),
});
export type ScheduleConfig = z.infer<typeof scheduleSchema>;

export interface AppConfig {
  profile: ProfileConfig;
  messages: MessagesConfig;
  schedule: ScheduleConfig;
}
