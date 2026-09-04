import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

/**
 * 最小工具注册 spike（P1H / HARNESS_BINDING U1 实证）——
 * 用官方扩展 API（dsh-tools 0.1.1-rc.2）定义一个受信工具：
 *  - ctx.tools.register(defineTool({ ... }))：schema 自动流入组装结果；
 *  - 参数 schema 用 defineTool 规范（required 逐属性声明）；
 *  - 输出对象必须显式 additionalProperties:false（H4 隐藏校验的代码层落实）；
 *  - execute 只返回 output.schema 声明的规范 JSON 值，并转发 exec.signal。
 */

const echoTool: ToolDefinition = defineTool({
  name: 'job_agent_ping',
  description: '最小 spike 工具：原样回显文本，验证 DeepSeek Harness 工具注册与执行流水线。',
  parameters: {
    text: {
      type: 'string',
      required: true,
      description: '要回显的文本',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '原样回显的文本' },
      },
    },
    render(_args: { text: string }, value: { text: string }): ContentBlock[] {
      return [{ type: 'text', text: value.text }];
    },
  },
  async execute(args: unknown, exec: unknown) {
    const signal = (exec as { signal?: AbortSignal }).signal;
    if (signal?.aborted) throw new Error('aborted');
    const { text } = args as { text?: string };
    return { text: text ?? '' };
  },
});

/** 工具宿主的最小结构（真实 ctx 由 dsh 组合注入，键为 ctx.tools） */
export interface ToolsHost {
  tools: { register(definition: ToolDefinition): () => void };
}

/** 注册 spike 工具；返回随 fiber 释放的 disposer。 */
export function registerSpikeTool(host: ToolsHost): () => void {
  return host.tools.register(echoTool);
}

export { echoTool };
