import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { messagesSchema, profileSchema, scheduleSchema } from './schemas';
import type { AppConfig, MessagesConfig, ProfileConfig, ScheduleConfig } from './schemas';

/** 配置加载错误（携带文件名与 Zod issue 摘要） */
export class ConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

/** 解析 YAML 文本；失败抛 ConfigError */
export function parseYamlText(text: string, source = '<yaml>'): unknown {
  try {
    return parse(text) as unknown;
  } catch (e) {
    throw new ConfigError(`YAML 解析失败（${source}）: ${(e as Error).message}`, { cause: e });
  }
}

function parseStrict<S extends z.ZodType>(schema: S, data: unknown, file: string): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first ? first.path.join('.') || '(root)' : '(root)';
    const msg = first ? first.message : '未知错误';
    throw new ConfigError(`配置校验失败 ${file} @${path}: ${msg}`);
  }
  return result.data;
}

function readYamlFile(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`无法读取配置文件 ${file}: ${(e as Error).message}`, { cause: e });
  }
  return parseYamlText(text, file);
}

export function loadProfileFromFile(file: string): ProfileConfig {
  return parseStrict(profileSchema, readYamlFile(file), file);
}

export function loadMessagesFromFile(file: string): MessagesConfig {
  return parseStrict(messagesSchema, readYamlFile(file), file);
}

export function loadScheduleFromFile(file: string): ScheduleConfig {
  return parseStrict(scheduleSchema, readYamlFile(file), file);
}

/** 基础配置目录：优先取 <name>.yaml，缺失时退回 <name>.example.yaml（用于开箱演示） */
function resolveConfigFile(dir: string, name: 'profile' | 'messages' | 'schedule'): string {
  const real = join(dir, `${name}.yaml`);
  try {
    readFileSync(real, 'utf8');
    return real;
  } catch {
    return join(dir, `${name}.example.yaml`);
  }
}

export interface LoadedFiles {
  profileFile: string;
  messagesFile: string;
  scheduleFile: string;
}

export function loadAppConfig(dir = join(process.cwd(), 'config')): { config: AppConfig; files: LoadedFiles } {
  const profileFile = resolveConfigFile(dir, 'profile');
  const messagesFile = resolveConfigFile(dir, 'messages');
  const scheduleFile = resolveConfigFile(dir, 'schedule');
  const profile = loadProfileFromFile(profileFile);
  const messages = loadMessagesFromFile(messagesFile);
  const schedule = loadScheduleFromFile(scheduleFile);
  validateCrossConstraints({ profile, messages, schedule });
  return { config: { profile, messages, schedule }, files: { profileFile, messagesFile, scheduleFile } };
}

/** 跨文件一致性（软规则校验，违反抛错而不是静默跑错配置） */
export function validateCrossConstraints(cfg: AppConfig): void {
  const { profile, schedule, messages } = cfg;
  const start = profile.application.start_time;
  const end = profile.application.end_time;
  const report = profile.application.report_time;
  if (start >= end) {
    throw new ConfigError(`跨文件校验失败: application.end_time(${end}) 须晚于 start_time(${start})`);
  }
  if (report < end) {
    throw new ConfigError(`跨文件校验失败: application.report_time(${report}) 应不早于 end_time(${end})`);
  }
  if (schedule.daily_maximum < schedule.daily_minimum) {
    throw new ConfigError('跨文件校验失败: daily_maximum 不得小于 daily_minimum');
  }
  const b = schedule.score_buckets;
  if (!(b.hot > b.apply && b.apply > b.review)) {
    throw new ConfigError('跨文件校验失败: score_buckets 需满足 hot > apply > review');
  }
  const auto = new Set(messages.auto_send_intents);
  const needsHuman = messages.needs_human_intents;
  for (const h of needsHuman) {
    if (auto.has(h)) {
      throw new ConfigError(`跨文件校验失败: 意图 ${h} 同时出现在 auto_send_intents 与 needs_human_intents`);
    }
  }
}
