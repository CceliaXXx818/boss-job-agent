// @job-agent/harness-profile —— dsh 自定义插件（纯 JS，无需构建）。
// 路径 B 最小实证：用官方扩展 API（ctx.tools.register）把一个受信工具注册进
// headless Agent 会话，让模型以工具调用方式使用它。
// 说明：这里刻意不使用本仓库 TS 业务模块（避免引入编译链）；
// 业务工具映射（19 工具 → SQLite/agent-core）是 B2 的工作。

const echoTool = {
  name: 'job_agent_echo',
  description:
    '最小实证工具：把传入的 text 原样作为规范化值返回。用于验证 Harness 中自定义工具注册、调用与结果回传链路。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', description: '要回显的文本' },
    },
    required: ['text'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '原样回显的文本' },
      },
    },
    render(_args, value) {
      return [{ type: 'text', text: String(value?.text ?? '') }];
    },
  },
  execute(args) {
    const text = args && typeof args === 'object' && 'text' in args ? String(args.text) : '';
    return { text };
  },
};

export default {
  name: 'job-agent-tools',
  inject: ['tools'],
  apply(ctx) {
    let disposer;
    const logger = ctx.get('logger');
    try {
      disposer = ctx.tools.register(echoTool);
      logger?.info?.('[job-agent-tools] registered job_agent_echo');
    } catch (e) {
      logger?.warn?.(`[job-agent-tools] register failed: ${e?.message ?? e}`);
      throw e;
    }
    return () => disposer?.();
  },
};
