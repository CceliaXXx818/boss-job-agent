import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';

/**
 * DeepSeek Chat API 客户端 —— 结构化 JSON 输出 + Zod 校验。
 * 只做"让模型输出规范 JSON"这一件事：不缓存、不含业务规则。
 */

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/chat/completions';
export const DEFAULT_MODEL = 'deepseek-chat';

export class ModelOutputError extends Error {
  constructor(message: string, readonly issues?: unknown) {
    super(message);
    this.name = 'ModelOutputError';
  }
}

export class ModelCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelCredentialError';
  }
}

/** 读取 API Key：优先环境变量，其次仓库根 .env（git 忽略）。不打印/不外泄 Key。 */
export function resolveApiKey(): string {
  const env = process.env.DEEPSEEK_API_KEY?.trim();
  if (env) return env;
  try {
    const text = readFileSync(join(process.cwd(), '.env'), 'utf8');
    const m = text.match(/^DEEPSEEK_API_KEY\s*=\s*(\S+)\s*$/m);
    if (m?.[1]) return m[1];
  } catch {
    /* .env 缺失时回落到下方错误 */
  }
  throw new ModelCredentialError('缺少 DEEPSEEK_API_KEY（环境变量或根目录 .env），无法调用模型。');
}

export interface ModelClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

export class ModelClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: ModelClientOptions = {}) {
    this.apiKey = opts.apiKey ?? resolveApiKey();
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /**
   * 要求模型只输出符合 schema 的 JSON；失败重试一次并附错误说明。
   * @param schema Zod schema（校验/类型）
   */
  async chatJson<S extends z.ZodType>(schema: S, system: string, user: string): Promise<z.infer<S>> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      {
        role: 'system',
        content:
          '你是一个严格的结构化标注引擎。只输出符合要求的一个 JSON 对象：不要任何前后缀、解释或 markdown 代码块。\n' +
          system,
      },
      { role: 'user', content: user },
    ];
    let attempt = 0;
    while (attempt < 2) {
      attempt++;
      const res = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0,
          max_tokens: 2000,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        throw new ModelOutputError(`模型 API ${res.status}: ${detail}`);
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const raw = body.choices?.[0]?.message?.content ?? '';
      const parsed = parseJsonLenient(raw);
      const result = schema.safeParse(parsed);
      if (result.success) return result.data as z.infer<S>;
      if (attempt < 2) {
        messages.push({
          role: 'user',
          content: `上次输出不符合 schema：${JSON.stringify(result.error.issues).slice(0, 500)}。请重新输出唯一一个合规 JSON 对象。`,
        });
      } else {
        throw new ModelOutputError('模型连续两次输出不符合 schema。', result.error.issues);
      }
    }
    throw new ModelOutputError('模型连续两次输出不符合 schema。');
  }
}

function parseJsonLenient(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new ModelOutputError(`模型输出不是 JSON：${raw.slice(0, 200)}`, e);
  }
}
