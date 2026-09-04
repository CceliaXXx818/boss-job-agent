import { describe, expect, it } from 'vitest';
import { HarnessBindingError, registerJobAgentTools, TOOL_NAMES, WRITE_TOOL_NAMES } from './index';
import { echoTool, registerSpikeTool } from './spike';

describe('dsh-integration 占位（TOOL_SPEC §2 一致性 + fail-closed）', () => {
  it('工具清单与 TOOL_SPEC 一致：19 个且唯一', () => {
    expect(TOOL_NAMES).toHaveLength(19);
    expect(new Set(TOOL_NAMES).size).toBe(19);
  });

  it('写/控制工具都在清单内', () => {
    for (const w of WRITE_TOOL_NAMES) {
      expect(TOOL_NAMES).toContain(w);
    }
  });

  it('未完成真实注册前全量注册一律拒绝（fail-closed）', () => {
    expect(() => registerJobAgentTools({})).toThrow(HarnessBindingError);
  });
});

describe('dsh-integration spike（HARNESS_BINDING U1 实证）', () => {
  it('defineTool 产物可经 ctx.tools.register 注册并返回 disposer', () => {
    let registered = '';
    let disposed = false;
    const host = {
      tools: {
        register(def: { name: string }) {
          registered = def.name;
          return () => {
            disposed = true;
          };
        },
      },
    };
    const dispose = registerSpikeTool(host);
    expect(registered).toBe('job_agent_ping');
    expect(echoTool.name).toBe('job_agent_ping');
    dispose();
    expect(disposed).toBe(true);
  });
});
