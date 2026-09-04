import {
  DEFAULT_AUTO_SEND_INTENTS,
  DEFAULT_NEEDS_HUMAN_INTENTS,
} from '@job-agent/domain';
import type { HrIntent, PolicyBucket } from '@job-agent/domain';

/**
 * HR 意图规则分类器 —— TOOL_SPEC §5 矩阵的规则版（确定性优先，A3）。
 * 规则未命中返回 unknown（配置默认 needs_human，绝不擅自外发）。
 * 模型分类（classify_hr_message）仅用于规则未命中的兜底深判，P1 暂由 unknown 承接。
 */

export interface Rule {
  intent: HrIntent;
  pattern: RegExp;
  note: string;
}

/** 有序规则表：先匹配先得（specialized 在前）。 */
export const RULES: readonly Rule[] = [
  { intent: 'sensitive_data_request', pattern: /身份证|银行卡|验证码|登录密码|户口本|护照号|征信报告/i, note: '索要敏感资料' },
  { intent: 'request_online_submit', pattern: /在线简历|投递(一下|个)?(在线)?简历|点击(投递|发送)|投递一下[!！。～~哈呀谢谢]*$/i, note: '要求投递在线简历' },
  { intent: 'request_resume', pattern: /(发|给|传|投)(一?下|个|一?份)?(你|我)?的?(简历|附件)|(简历|附件)(方便|可以|麻烦|请|能)?(发|给|传)|简历(发我|给我|发一下|看看|看一下|有吗)|(发|给)我一份?(简历|附件)|看(看|下|一下)(你的?)?(简历|附件)|发份|发下简历|pdf|附件简历/i, note: '索要简历' },
  { intent: 'offer_background_check', pattern: /背调|offer|劳动合同|合同(细节|条款)?|入职(材料|资料|体检)|毕业证|离职证明|offer\s*评审/i, note: 'Offer/背调/合同→人工' },
  { intent: 'salary_discussion', pattern: /薪资|薪酬|工资|待遇期望|薪资要求|期望(薪|待遇|薪资)|目前(薪|待遇|薪资)|月薪/i, note: '薪资话题→人工' },
  { intent: 'interview_invitation', pattern: /面试|到面|面谈|约(个)?时间|几号(方便|有空)|安排.{0,4}(面试|面谈)/i, note: '邀约面试→人工' },
  { intent: 'relocation_request', pattern: /(长期)?驻外|外派|常驻|长期出差|(去|来)(北京|上海)|base\s*(北京|上海)|异地工作|外派到/i, note: '要求异地/驻外→人工' },
  { intent: 'reason_for_leaving', pattern: /离职原因|为什么(离开|离职|跳槽|换工作)|上家|跳槽原因|离开(的)?原因|辞职|为什么(走|换)/i, note: '离职原因→人工' },
  { intent: 'location_confirm', pattern: /接受(深圳|杭州)|(深圳|杭州).{0,5}(可以|接受|ok|OK|方便|愿意|办公|工作)|能来(深圳|杭州)|在(深圳|杭州).{0,4}(办公|工作|可以)|城市(倾向|偏好)|base(哪里|在)?|来(深圳|杭州)/i, note: '地点确认→预设应答' },
  { intent: 'start_date_question', pattern: /到岗|入职时间|什么时候能(入职|到岗|来|上班)|(几号|多久|啥时候)(能|可以)?(入职|到岗|来|到|上班)|最快(入职|到岗)|什么时候(上班|入职)|多久能(上班|入职)|能(什么|啥)时候(来|入职|到岗|上班)/i, note: '到岗时间→预设应答' },
  { intent: 'availability_check', pattern: /目前(在)?职|在职|离职状态|(在|还)上一家|还在(原)?(公司|单位)|还(在|有)?上班|在找工作|空窗期|现公司|还在职|还(在|待).{0,3}(这家)?公司/i, note: '在职状态→预设应答' },
  { intent: 'greeting_smalltalk', pattern: /^(您好|你好|哈喽|hi|hello|在吗|在么|您好呀|你好呀){1,3}[!！?？。~～\s,.，、哈呀呢啊]*$/i, note: '寒暄→预设应答' },
];

export interface ClassifyResult {
  intent: HrIntent;
  method: 'rule';
  confidence: 1;
  matchedRule?: string;
}

export function classifyByRule(text: string): ClassifyResult {
  for (const r of RULES) {
    if (r.pattern.test(text)) {
      return { intent: r.intent, method: 'rule', confidence: 1, matchedRule: r.note };
    }
  }
  return { intent: 'unknown', method: 'rule', confidence: 1, matchedRule: '规则未命中' };
}

/** 意图 → 策略桶。auto_reply_preset 集合 = TOOL_SPEC §5 预设应答行。 */
export const PRESET_REPLY_INTENTS: ReadonlySet<HrIntent> = new Set([
  'availability_check',
  'start_date_question',
  'location_confirm',
  'greeting_smalltalk',
]);

export interface PolicyConfig {
  autoSendIntents: readonly HrIntent[];
  needsHumanIntents: readonly HrIntent[];
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  autoSendIntents: DEFAULT_AUTO_SEND_INTENTS,
  needsHumanIntents: DEFAULT_NEEDS_HUMAN_INTENTS,
};

export function policyBucketFor(intent: HrIntent, cfg: PolicyConfig = DEFAULT_POLICY_CONFIG): PolicyBucket {
  if (cfg.autoSendIntents.includes(intent)) return 'auto_send_resume';
  if (PRESET_REPLY_INTENTS.has(intent)) return 'auto_reply_preset';
  if (cfg.needsHumanIntents.includes(intent)) return 'needs_human';
  return 'needs_human'; // 未知意图默认需人工（安全优先）
}
