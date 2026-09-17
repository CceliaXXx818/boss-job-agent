// tab-messaging.js —— V0.5：与内容脚本通信的可靠性封装（可测试、无 chrome 依赖）
//
// 为什么需要它（真实事故）：
//   MV3 里 `chrome.tabs.sendMessage` 在"目标页面还没注入 content script"时会抛
//   `Could not establish connection. Receiving end does not exist.`。
//   详情页/打招呼页比列表页更重，而 Autopilot 的执行标签是 **inactive**（会被 Chrome 节流），
//   固定 sleep 几秒后直接发消息就会命中这个错误；内部重试若仍然"只等固定时间"，就会连续失败
//   并被引擎升级为 PAUSED。
//
// 正确做法（本模块）：
//   1. 先 ping 轻量消息（pageHealth）确认 content script 已就绪，再发真正的业务消息；
//   2. 把"接收端不存在 / 端口关闭 / 扩展上下文失效"这类错误视为**可重试**；
//   3. 兜底：若仍不可达，reload 一次目标标签（reload 会重新注入 content script）再等；
//   4. 重试次数有硬上界，不做无限重试；
//   5. 错误信息翻译成用户能看懂的话。
//
// 所有外部能力（send/ping/sleep/reload、以及风险检查）都由调用方注入 → 可在 Node 里完整测试。

/** 可重试的消息错误特征（Chrome 在不同版本/场景下的措辞不同，这里全部覆盖） */
export const RETRYABLE_ERROR_MARKERS = Object.freeze([
  'Receiving end does not exist',
  'Could not establish connection',
  // 注意：Chrome 在不同版本/场景下措辞不同，这里必须同时覆盖 port / channel 两种说法。
  // 真实事故：只写了 "message port closed"，而实际报的是 "message channel closed"，
  // 导致可重试判断没命中、直接升级成工具失败。
  'The message port closed',
  'message port closed before a response',
  'message channel closed',
  'before a response was received',
  'A listener indicated an asynchronous response',
  // bfcache：导航时旧页面被移入 back/forward cache，端口随之关闭（真实事故）
  'back/forward cache',
  'moved into back/forward cache',
  'Extension context invalidated',
  'No tab with id',
]);

export const DEFAULT_TIMING = Object.freeze({
  /** 等待内容脚本就绪：最多轮询次数 */
  readyTries: 20,
  /** 等待内容脚本就绪：每次间隔（毫秒）。20 × 800ms ≈ 16s 上限 */
  readyMs: 800,
  /** 单条消息的重试次数（含首次） */
  messageTries: 3,
  /** 单条消息重试之间的间隔（毫秒），实际按倍数退避 */
  messageRetryMs: 800,
  /** 触发 reload 兜底前已失败的次数 */
  reloadAfterFailures: 2,
});

/**
 * 错误归类（决定上层怎么处理）：
 *   transport —— 消息根本没送到/通道断了（内容脚本未注入、页面跳转、扩展重载）→ 属于"工具是否可用"的信号
 *   page      —— 内容脚本正常回了 {ok:false}（页面布局异常 / 解析失败 / 内容为空）→ 属于"这个页面的问题"
 *                 不应该因为这个页面的问题把整个 Autopilot 暂停
 */
export function classifyMessageError(message, stage = null) {
  if (stage === 'content_error') return 'page';
  const text = String(message ?? '');
  if (isRetryableMessageError(text)) return 'transport';
  if (/详情解析失败|详情内容为空|解析失败|未找到|为空/.test(text)) return 'page';
  return 'unknown';
}

export function isRetryableMessageError(message) {
  const text = String(message ?? '');
  return RETRYABLE_ERROR_MARKERS.some((marker) => text.includes(marker));
}

/** 把底层错误翻译成用户能看懂的一句话 */
export function friendlyMessageError(message) {
  const text = String(message ?? '');
  if (text.includes('Receiving end does not exist') || text.includes('Could not establish connection')) {
    return '页面内容脚本未就绪（页面可能还在加载，或该标签已不在 BOSS 域下）';
  }
  if (text.includes('back/forward cache')) {
    return '页面在导航中被切换（旧页面进入 bfcache），消息通道关闭';
  }
  if (
    text.includes('message port closed') ||
    text.includes('message channel closed') ||
    text.includes('before a response was received') ||
    text.includes('A listener indicated an asynchronous response')
  ) {
    return '页面脚本未能在超时前回复（页面可能正在跳转，或该页布局异常导致解析失败）';
  }
  if (text.includes('Extension context invalidated')) {
    return '扩展刚被重新加载（请重新加载后重试；已打开的页面需要刷新）';
  }
  if (text.includes('No tab with id')) {
    return '执行标签已不存在（可能被手动关闭）';
  }
  return text || '未知错误';
}

/** 把"页面没就绪"的现场格式化成一句可读证据（url/标题/可见文字），便于定位"刷不开" */
export function describePageState(page) {
  if (!page) return '（拿不到页面信息：内容脚本无响应）';
  const parts = [
    `标题「${String(page.title ?? '').slice(0, 30) || '空'}」`,
    `readyState=${page.readyState ?? '?'}`,
    `loading=${page.loading === undefined ? '?' : page.loading}`,
    `可见文字 ${page.textLength ?? 0} 字`,
  ];
  const preview = String(page.bodyPreview ?? '').slice(0, 80);
  if (preview) parts.push(`现场：「${preview}」`);
  return parts.join('｜');
}

/** 连续页面级失败后是否应把执行标签切到前台（后台标签渲染/交互可能受限） */
export function shouldBringTabToFront({ consecutivePageFailures = 0, alreadyFront = false } = {}) {
  return !alreadyFront && Number(consecutivePageFailures) >= 2;
}

/** 执行标签是否该重建（同一标签反复导航后可能退化/卡死） */
export function shouldRecycleTab({ navigations = 0, threshold = 40 } = {}) {
  return Number(navigations) >= Number(threshold);
}

/**
 * ping 目标标签，判断 content script 是否已就绪。
 * @returns {Promise<object|null>} pageHealth 响应，或 null
 */
export async function pingTab({ send, tabId, payload = { type: 'pageHealth' } }) {
  try {
    return (await send(tabId, payload)) ?? null;
  } catch {
    return null;
  }
}

/**
 * 等待内容脚本就绪。
 * @param {{send: Function, sleep: Function, tabId: number, checkRisk?: Function|null, isUsable?: Function|null, tries?: number, delayMs?: number}} input
 *        checkRisk：可选，返回 `{risk, reason}` 时立即中止等待（例如页面已跳到登录/验证页）
 *        isUsable：可选，判断"内容是否真的可用"（例如 `page.loading === false`）——能应答 ≠ 内容可用
 * @returns {Promise<{ok: boolean, page?: object|null, risk?: string, reason?: string, timeout?: boolean}>}
 */
export async function waitForContentReady({
  send,
  sleep,
  tabId,
  checkRisk = null,
  isUsable = null,
  tries = DEFAULT_TIMING.readyTries,
  delayMs = DEFAULT_TIMING.readyMs,
}) {
  let lastPage = null;
  for (let i = 0; i < Math.max(1, tries); i++) {
    const page = await pingTab({ send, tabId });
    if (page) lastPage = page;
    // 能应答 ≠ 内容可用：isUsable 用来要求"页面已脱离加载态"
    if (page && (!isUsable || isUsable(page))) return { ok: true, page };
    if (checkRisk) {
      const risk = await checkRisk(tabId);
      if (risk?.risk) return { ok: false, risk: risk.risk, reason: risk.reason };
    }
    if (i < tries - 1) await sleep(delayMs);
  }
  return {
    ok: false,
    timeout: true,
    page: lastPage, // 失败也要把"最后看到的页面状态"带回去，便于给出可定位的错误信息
    reason: isUsable ? '页面加载超时（内容始终未就绪）' : '等待页面响应超时（内容脚本未注入）',
  };
}

/**
 * 发送业务消息：内部处理"接收端不存在"，最多重试 messageTries 次，必要时 reload 一次兜底。
 *
 * @param {{
 *   send: Function, sleep: Function, tabId: number, message: object,
 *   reload?: Function|null, checkRisk?: Function|null, waitReady?: Function|null,
 *   tries?: number, retryMs?: number, reloadAfterFailures?: number
 * }} input
 * @returns {Promise<{ok: boolean, response?: any, error?: string, risk?: string, reason?: string, attempts?: number, reloaded?: boolean}>}
 */
export async function sendMessageReliably({
  send,
  sleep,
  tabId,
  message,
  reload = null,
  checkRisk = null,
  waitReady = null,
  tries = DEFAULT_TIMING.messageTries,
  retryMs = DEFAULT_TIMING.messageRetryMs,
  reloadAfterFailures = DEFAULT_TIMING.reloadAfterFailures,
}) {
  let attempts = 0;
  let failures = 0;
  let reloaded = false;
  let lastError = null;

  while (attempts < Math.max(1, tries)) {
    attempts++;
    try {
      const response = await send(tabId, message);
      return { ok: true, response, attempts, reloaded };
    } catch (e) {
      lastError = e?.message ?? String(e);
      // 不可重试的错误（例如权限/域名不匹配）直接返回，避免无意义重试
      if (!isRetryableMessageError(lastError)) {
        return { ok: false, error: friendlyMessageError(lastError), attempts, reloaded };
      }
      failures++;

      // 每次都先确认目标是否已经变成了风险页（登录/验证），能给出更准确的原因
      if (checkRisk) {
        const risk = await checkRisk(tabId);
        if (risk?.risk) return { ok: false, risk: risk.risk, reason: risk.reason, attempts, reloaded };
      }

      // 兜底：reload 一次（reload 会重新注入 content script），然后再等就绪
      if (!reloaded && reload && failures >= reloadAfterFailures) {
        reloaded = true;
        try {
          await reload(tabId);
          await sleep(retryMs);
          await waitForContentReady({ send, sleep, tabId, checkRisk });
        } catch {
          /* reload 失败继续走下面的等待 */
        }
      }
      // 关键：重试前先确认"新的页面已经就绪"，否则会把消息又发给已经进入 bfcache 的旧页面
      if (waitReady) {
        try {
          await waitReady();
        } catch {
          /* 等待失败就继续按退避重试 */
        }
      }
      if (attempts < tries) await sleep(retryMs * attempts);
    }
  }

  return { ok: false, error: friendlyMessageError(lastError), attempts, reloaded };
}
