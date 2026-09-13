// settings.js —— V0.5 统一设置（纯逻辑 + storage 包装）
// 原则：默认 Review Mode；Autopilot 必须用户显式授权；配置仅影响"尚未执行的 Action"。

export const MODES = Object.freeze(['review', 'autopilot']);

export const MAX_GREETING_TEMPLATE_LENGTH = 1000;

export const DEFAULT_GREETING_TEMPLATE =
  '您好，我有5年产品经理经验、其中2年专注AI方向，主导过智能客服、知识库问答等产品0-1落地，熟悉大模型应用与Agent工作流，希望进一步交流，谢谢。';

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'review',

  // Autopilot 核心参数（V0.5 §7）
  batchQualifiedTarget: 10,
  minimumAutoGreetingScore: 80,
  dailyGreetingCap: 20,
  maxDiscoveryRounds: 3,
  maxReplanPerRound: 1,

  workingHours: { start: '09:00', end: '18:00' },

  monitorEnabled: true,
  monitorIntervalMinutes: 10,
  autoSendResume: false,
  dailyReportEnabled: true,
  dailyReportTime: '18:00',
  emailReportEnabled: false,

  greetingStrategy: {
    mode: 'template',
    templateId: 'default',
    template: DEFAULT_GREETING_TEMPLATE,
    updatedAt: null,
  },

  // 授权（D6 / §6 / §42）
  consent: {
    autopilot: false,
    autopilotAt: null,
    autoResume: false,
    autoResumeAt: null,
  },

  // Phase 6 才实现二进制；Phase 1 只保留配置形状
  resumeConfig: {
    strategy: 'boss_default', // boss_default | extension_upload
    fileName: null,
    updatedAt: null,
  },
});

export const SETTINGS_KEY = 'jobAgentSettings';

// ---------------- 校验工具 ----------------

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidHHMM(v) {
  return typeof v === 'string' && HHMM_RE.test(v);
}

export function hhmmToMinutes(v) {
  if (!isValidHHMM(v)) return null;
  const [h, m] = v.split(':').map(Number);
  return h * 60 + m;
}

/** 工作时间判断（支持跨夜，如 22:00-06:00） */
export function isWithinWorkingHours(nowHHMM, startHHMM, endHHMM) {
  const now = hhmmToMinutes(nowHHMM);
  const start = hhmmToMinutes(startHHMM);
  const end = hhmmToMinutes(endHHMM);
  if (now === null || start === null || end === null) return true; // 配置异常时不阻断（由校验兜住）
  if (start === end) return true;
  if (start < end) return now >= start && now <= end;
  return now >= start || now <= end;
}

/** 打招呼模板校验（§24） */
export function validateGreetingTemplate(text) {
  const raw = typeof text === 'string' ? text : '';
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: '话术不能为空（或只有空白）', length: 0 };
  if (trimmed.length > MAX_GREETING_TEMPLATE_LENGTH) {
    return { ok: false, reason: `话术过长（${trimmed.length} > ${MAX_GREETING_TEMPLATE_LENGTH}）`, length: trimmed.length };
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(raw)) {
    return { ok: false, reason: '话术包含异常控制字符', length: trimmed.length };
  }
  return { ok: true, length: trimmed.length };
}

const clampInt = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/**
 * 把任意输入规范化为合法 settings（纯函数）。
 * legacy：兼容 V0.4 旧 key（dailyCap / greetText），只读一次迁移。
 */
export function normalizeSettings(raw, legacy = {}) {
  const warnings = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_SETTINGS;

  const mode = MODES.includes(src.mode) ? src.mode : d.mode;

  const workingHours = {
    start: isValidHHMM(src.workingHours?.start) ? src.workingHours.start : d.workingHours.start,
    end: isValidHHMM(src.workingHours?.end) ? src.workingHours.end : d.workingHours.end,
  };
  if (src.workingHours && (!isValidHHMM(src.workingHours.start) || !isValidHHMM(src.workingHours.end))) {
    warnings.push('workingHours 格式非法，已回退默认 09:00-18:00');
  }

  const templateRaw = src.greetingStrategy?.template ?? legacy.greetText ?? d.greetingStrategy.template;
  const templateCheck = validateGreetingTemplate(templateRaw);
  if (!templateCheck.ok) warnings.push(`greeting template 无效：${templateCheck.reason}，已回退默认话术`);

  const legacyCap = Number(legacy.dailyCap);

  const settings = {
    mode,
    batchQualifiedTarget: clampInt(src.batchQualifiedTarget, 1, 50, d.batchQualifiedTarget),
    minimumAutoGreetingScore: clampInt(src.minimumAutoGreetingScore, 0, 100, d.minimumAutoGreetingScore),
    dailyGreetingCap: clampInt(
      src.dailyGreetingCap ?? (Number.isFinite(legacyCap) && legacyCap > 0 ? legacyCap : undefined),
      1,
      100,
      d.dailyGreetingCap,
    ),
    maxDiscoveryRounds: clampInt(src.maxDiscoveryRounds, 1, 10, d.maxDiscoveryRounds),
    maxReplanPerRound: clampInt(src.maxReplanPerRound, 0, 1, d.maxReplanPerRound),
    workingHours,
    monitorEnabled: src.monitorEnabled !== false,
    monitorIntervalMinutes: clampInt(src.monitorIntervalMinutes, 5, 15, d.monitorIntervalMinutes),
    autoSendResume: src.autoSendResume === true, // 默认 OFF，仅显式 true 才开
    dailyReportEnabled: src.dailyReportEnabled !== false,
    dailyReportTime: isValidHHMM(src.dailyReportTime) ? src.dailyReportTime : d.dailyReportTime,
    emailReportEnabled: src.emailReportEnabled === true,
    greetingStrategy: {
      mode: src.greetingStrategy?.mode === 'jd_personalized' ? 'jd_personalized' : 'template',
      templateId: String(src.greetingStrategy?.templateId ?? d.greetingStrategy.templateId),
      template: templateCheck.ok ? templateRaw : d.greetingStrategy.template,
      updatedAt: src.greetingStrategy?.updatedAt ?? null,
    },
    consent: {
      autopilot: src.consent?.autopilot === true,
      autopilotAt: src.consent?.autopilotAt ?? null,
      autoResume: src.consent?.autoResume === true,
      autoResumeAt: src.consent?.autoResumeAt ?? null,
    },
    resumeConfig: {
      strategy: src.resumeConfig?.strategy === 'extension_upload' ? 'extension_upload' : 'boss_default',
      fileName: src.resumeConfig?.fileName ?? null,
      updatedAt: src.resumeConfig?.updatedAt ?? null,
    },
  };

  return { settings, warnings };
}

// ---------------- 授权 ----------------

export function hasAutopilotConsent(settings) {
  return settings?.consent?.autopilot === true && settings?.mode === 'autopilot';
}

export function recordAutopilotConsent(settings, at = new Date().toISOString()) {
  return {
    ...settings,
    mode: 'autopilot',
    consent: { ...settings.consent, autopilot: true, autopilotAt: at },
  };
}

export function revokeAutopilotConsent(settings, at = new Date().toISOString()) {
  return {
    ...settings,
    mode: 'review',
    consent: { ...settings.consent, autopilot: false, autopilotAt: at },
  };
}

export function recordAutoResumeConsent(settings, enabled, at = new Date().toISOString()) {
  return {
    ...settings,
    autoSendResume: enabled === true,
    consent: {
      ...settings.consent,
      autoResume: enabled === true,
      autoResumeAt: enabled === true ? at : settings.consent.autoResumeAt,
    },
  };
}

// ---------------- storage 包装 ----------------

export async function loadSettings() {
  const st = await chrome.storage.local.get([SETTINGS_KEY, 'dailyCap', 'greetText']);
  const { settings } = normalizeSettings(st[SETTINGS_KEY], {
    dailyCap: st.dailyCap,
    greetText: st.greetText,
  });
  return settings;
}

export async function saveSettings(next) {
  const { settings } = normalizeSettings(next);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

export async function patchSettings(patch) {
  const current = await loadSettings();
  return saveSettings({ ...current, ...patch });
}
