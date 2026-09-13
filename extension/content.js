// BOSS 岗位助手 · content script（只读，纯 JS）
// 结构已按真实页面校准（2026）：li.job-card-box > a.job-name / span.job-salary /
// ul.tag-list li / span.boss-name / span.company-location
// 仅读取 DOM；不点击、不提交、不改页面。

function pick(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function textOf(el) {
  return el?.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

function findContainer(a) {
  const sels = ['.job-card-box', '.job-card-wrapper', 'li[class*="job-card"]', '.job-card'];
  for (const sel of sels) {
    const c = a.closest(sel);
    if (c) return c;
  }
  let node = a;
  for (let i = 0; i < 4; i++) {
    node = node.parentElement;
    if (node && node.textContent && node.textContent.length < 400) return node;
  }
  return a;
}

function cardRows() {
  const anchors = Array.from(document.querySelectorAll('a.job-name, a[href*="/job_detail/"]')).slice(0, 60);
  const rows = [];
  const seen = new Set();
  for (const a of anchors) {
    const href = a.getAttribute('href') ?? '';
    const m = href.match(/\/job_detail\/([0-9A-Za-z_-]+)/);
    const jobId = m ? m[1] : href;
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    const box = findContainer(a);
    const title = textOf(box.querySelector('.job-name') ?? a);
    const salary = textOf(box.querySelector('.job-salary'));
    const tags = Array.from(box.querySelectorAll('.tag-list li')).map((li) => textOf(li)).filter(Boolean);
    const company = textOf(box.querySelector('.boss-name'));
    const area = textOf(box.querySelector('.company-location'));
    rows.push({
      title,
      salary,
      company,
      area,
      jobId,
      href: href.split('?')[0] ?? href,
      tags: tags.join('|'),
    });
  }
  return rows;
}

function diagnose() {
  const a = document.querySelector('a.job-name, a[href*="/job_detail/"]');
  let sampleHtml = '';
  const sampleClasses = [];
  if (a) {
    const box = findContainer(a);
    sampleHtml = box.outerHTML.slice(0, 2000);
    let n = box;
    for (let i = 0; i < 4 && n; i++) {
      const c = n.getAttribute?.('class');
      if (c) sampleClasses.push(c.slice(0, 160));
      n = n.parentElement;
    }
  }
  return { url: location.href, sampleHtml, sampleClasses };
}

function clickGreet(labels) {
  const cands = Array.from(document.querySelectorAll('button, a, span, div[role="button"]'))
    .filter((el) => {
      const t = (el.textContent ?? '').trim();
      return t && t.length <= 12 && labels.some((l) => t === l || t.startsWith(l));
    })
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 20;
    });
  if (!cands.length) return { clicked: false, text: '未找到打招呼按钮' };
  const el = cands[0];
  const text = (el.textContent ?? '').trim();
  el.click();
  return { clicked: true, text };
}

const sleepInPage = (ms) => new Promise((r) => setTimeout(r, ms));

const GREET_LABELS_ALL = ['打招呼', '立即沟通', '和TA聊聊', '开聊', '开始沟通', '打个招呼', '马上沟通', '立即开聊', '聊一聊', '投个简历', '发消息'];

function getEditor() {
  return Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).find((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 40 && rect.height > 20;
  }) ?? null;
}

function visibleLeafTexts() {
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('button,a,span,div,i,em')) {
    if (el.children.length !== 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const t = (el.textContent ?? '').trim();
    if (t && t.length <= 14 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
      if (out.length >= 40) break;
    }
  }
  return out;
}

// 尝试找到并点击“进入聊天”入口（多个文案变体，逐个试）
async function clickEntrance() {
  const editorBefore = getEditor();
  if (editorBefore) return { clicked: true, opened: true };
  for (const label of GREET_LABELS_ALL) {
    const cand = Array.from(document.querySelectorAll('button,a,span,div')).find((el) => {
      if (el.children.length !== 0) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const t = (el.textContent ?? '').trim();
      return t === label || t.startsWith(label);
    });
    if (cand) {
      cand.click();
      await sleepInPage(1800);
      if (getEditor()) return { clicked: true, opened: true, via: label };
    }
  }
  return { clicked: false, opened: false };
}

function visibleTextCandidates(root) {
  return Array.from(root.querySelectorAll('button, a, span, div[role="button"]')).filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 20 && rect.height > 20;
  });
}

// 打招呼完整动作：进入聊天 → 若给了话术则填入输入框 → 点发送/回车
async function greetFull(labels, text) {
  const entrance = await clickEntrance();
  await sleepInPage(1600);
  const editor = getEditor();

  // 填充话术：用浏览器原生插入文本（触发真实 input 事件，BOSS 编辑器才能启用发送）
  async function setEditorText(el, value) {
    el.focus();
    if (el.isContentEditable) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, value);
    } else {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const now = (el.value ?? el.textContent ?? '').trim();
    if (now !== value.trim()) {
      el.textContent = value; // 兜底直接写入
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  if (editor && text && text.length > 0) {
    await setEditorText(editor, text);
    await sleepInPage(900);
  }

  // 聊天区域：输入框就近的 chat/dialog/panel/editor 容器
  const chatArea =
    (editor &&
      (editor.closest('[class*="chat"],[class*="dialog"],[class*="panel"],[class*="editor"],[class*="talk"]') ??
        editor.parentElement?.parentElement)) ||
    document;
  const chatControls = () => Array.from(chatArea.querySelectorAll('button,a,span,i,em,div,svg,img'));
  // 控件快照：任何可见、带 class/text/aria 的元素（图标按钮也能看到）
  const snapshot = () =>
    chatControls()
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        const t = (el.textContent ?? '').trim().slice(0, 12);
        return {
          tag: el.tagName.toLowerCase(),
          cls: String(el.className ?? '').slice(0, 36),
          text: t,
          aria: (el.getAttribute('aria-label') ?? '').slice(0, 12),
          xy: `${Math.round(r.x)},${Math.round(r.y)}`,
          wh: `${Math.round(r.width)}x${Math.round(r.height)}`,
        };
      })
      .filter((c) => c.text || c.cls || c.aria)
      .slice(-18);
  const debugText = () => {
    const list = snapshot();
    return list.length ? JSON.stringify(list) : '（聊天区域内未捕获到任何可见控件）';
  };

  // 发送按钮：只认“发送”文本的最内层叶子节点（避免点到外层容器），或 aria/class 命中的叶子；兜底右下角
  const isLeaf = (el) => el.children.length === 0 && el.tagName !== 'SVG' && el.tagName !== 'svg';
  const isSendLike = (el) => {
    if (!isLeaf(el)) return false;
    const t = (el.textContent ?? '').trim();
    if (t === '发送' || t === '发 送') return true;
    if (/发送|send/i.test((el.getAttribute('aria-label') ?? '') + (el.title ?? ''))) return true;
    if (/send|发送/.test(el.className ?? '')) return true;
    return false;
  };
  const bottomRight = () => {
    if (!editor) return null;
    const er = editor.getBoundingClientRect();
    return chatControls()
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.right >= er.right - 6 && r.top >= er.top - 100 && r.bottom <= er.bottom + 70;
      })
      .sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      })[0] ?? null;
  };
  const isEnabled = (el) => {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if ((el.className || '').includes('disabled')) return false;
    return true;
  };
  const editorText = () => (editor?.value ?? editor?.textContent ?? '').trim();

  let sendBtnNow = null;
  for (let i = 0; i < 8; i++) {
    sendBtnNow = chatControls().find(isSendLike) || bottomRight();
    if (sendBtnNow && isEnabled(sendBtnNow)) break;
    await sleepInPage(500);
  }

  if (sendBtnNow && isEnabled(sendBtnNow)) {
    sendBtnNow.click();
    await sleepInPage(1200);
    if (editor && editorText().length === 0) {
      return { ok: true, stage: 'sent', detail: text ? '已填入自定义话术并成功发送' : '已发送（平台默认话术）' };
    }
    if (editor) {
      editor.focus();
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      await sleepInPage(1200);
      if (editorText().length === 0) return { ok: true, stage: 'sent_by_enter', detail: '点击发送后经回车兜底发送成功' };
    }
    return {
      ok: false,
      stage: 'send_clicked_but_not_cleared',
      detail: '点了发送但内容未清空。现场按钮：' + debugText(),
    };
  }

  if (editor && editorText().length > 0) {
    editor.focus();
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    await sleepInPage(1200);
    if (editorText().length === 0) return { ok: true, stage: 'sent_by_enter', detail: '已通过回车发送' };
    return {
      ok: false,
      stage: 'editor_still_has_text',
      detail: '回车后内容仍在。现场按钮：' + debugText(),
    };
  }

  const topTexts = visibleLeafTexts();
  const detailTail = () =>
    debugText() + ' || 页面可见文字：' + (topTexts.join(' | ') || '无');
  return {
    ok: false,
    stage: entrance.opened ? 'chat_no_send' : 'no_chat_entrance',
    detail:
      (entrance.opened
        ? '已进入聊天但未找到可发送的输入/按钮。现场按钮：'
        : '未找到“进入聊天”入口，也未发现输入框。现场按钮：') + detailTail(),
  };
}

function uniqueKeep(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = x.trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

// 纯函数：单次读取当前视口内容
function detailScrape() {
  const bodyText = document.body?.innerText ?? '';
  // JD 正文：优先大块描述容器，去掉“岗位描述来自BOSS直聘”类前缀
  const descSel = [
    '[class*="job-sec-text"]',
    '[class*="job-desc"]',
    '[class*="job-intro"]',
    '[class*="job-detail"] .desc',
    '[class*="job-description"]',
    '.description',
  ];
  let desc = '';
  for (const s of descSel) {
    const el = document.querySelector(s);
    const t = (el?.textContent ?? '').trim();
    if (t.length > desc.length) desc = t;
  }
  if (!desc) desc = bodyText.slice(0, 4000);
  desc = desc
    .replace(/来自BOSS直聘/g, '')
    .replace(/岗位\s*描述/g, '')
    .replace(/\(?\(?s{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 薪资
  const asciiHit = bodyText.match(/(\d{2,3}\s*[-~至—]\s*\d{2,3})\s*[Kk万Ww]/) ?? null;
  const salaryRaw =
    (document.querySelector('[class*="salary"], [class*="job-salary"], .job-salary, [class*="pay"]')?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim() || '';

  // 经验/学历：只认明确表述（全页去重，顺序按出现）
  const expEdu = uniqueKeep(
    bodyText
      .split('\n')
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          l.length <= 20 &&
          (/(经验不限|^\d+-\d+年|^\d+年以内|^\d+年以上|应届|在校)/.test(l) ||
            /^(本科|硕士|大专|博士|中专)(及以下|及以上)?$/.test(l.replace(/\s/g, ''))),
      ),
  ).slice(0, 4);

  // 公司规模/融资：强关键词（行级匹配）
  const meta = uniqueKeep(
    bodyText
      .split('\n')
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          l.length <= 30 &&
          /(未融资|不需要融资|天使轮|[ABCDEF]轮(及以上)?|已上市|新三板|战略融资|股权融资|[0-9]{2,4}\s*[-~到至]?\s*[0-9]{2,4}\s*人|[0-9]{2,4}\s*人以上)/.test(
            l.replace(/\s/g, ''),
          ),
      ),
  ).slice(0, 5);

  const name =
    (document.querySelector('[class*="job-name"],.job-name,.name,[class*="job-title"]')?.textContent ?? '').trim().slice(0, 80) || '';
  return {
    url: location.href,
    name,
    salaryRaw: salaryRaw || '',
    asciiSalary: asciiHit ? asciiHit[1] + 'K' : '',
    expEdu,
    companyMeta: meta,
    descFull: desc.replace(/\s+/g, ' ').slice(0, 1600),
  };
}

// 滚动到页面各处（触发懒加载）后合并两次读取
async function detailScrapeFull() {
  const first = detailScrape();
  try {
    for (let y = 0; y < document.body.scrollHeight; y += 900) window.scrollTo(0, y);
    window.scrollTo(0, document.body.scrollHeight);
    await sleepInPage(1400);
    const second = detailScrape();
    return {
      ...second,
      name: second.name || first.name,
      salaryRaw: second.salaryRaw || first.salaryRaw,
      asciiSalary: second.asciiSalary || first.asciiSalary,
      expEdu: uniqueKeep([...first.expEdu, ...second.expEdu]).slice(0, 4),
      companyMeta: uniqueKeep([...first.companyMeta, ...second.companyMeta]).slice(0, 5),
      descFull: second.descFull.length >= first.descFull.length ? second.descFull : first.descFull,
    };
  } catch {
    return first;
  }
}


// ---------- V0.4.1 Browser Context：从当前 BOSS 页面读取真实城市信息 ----------
function bossContext() {
  const url = location.href;
  const u = new URL(url);
  const codeFromUrl = u.searchParams.get('city') || u.searchParams.get('cityCode') || '';
  // DOM 候选项：优先 class 含 city 的可见叶子文本
  const candidates = [];
  for (const el of document.querySelectorAll('[class*="city"],[class*="City"],[data-city]')) {
    const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const cls = String(el.className ?? '').slice(0, 60);
    const r = el.getBoundingClientRect();
    if (!t || t.length > 12 || r.width <= 0) continue;
    candidates.push({ text: t, cls, y: Math.round(r.y) });
  }
  candidates.sort((a, b) => a.y - b.y);
  return {
    url,
    title: document.title,
    codeFromUrl,
    domCandidates: candidates.slice(0, 8),
    // 顶部可见文字，供无候选时人工校准
    topTexts: visibleLeafTexts().slice(0, 20),
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'scrape') {
    const rows = cardRows();
    sendResponse({ ok: true, url: location.href, count: rows.length, rows });
  } else if (msg?.type === 'greet') {
    sendResponse({ ok: true, ...clickGreet(msg.labels ?? []) });
  } else if (msg?.type === 'bossContext') {
    sendResponse({ ok: true, ...bossContext() });
  } else if (msg?.type === 'detailScrape') {
    detailScrapeFull().then((r) => sendResponse({ ok: true, ...r }));
    return true; // 异步（滚动后二次读取）
  } else if (msg?.type === 'greetFull') {
    greetFull(msg.labels ?? [], msg.text ?? '').then((r) => sendResponse({ ok: true, ...r }));
    return true; // 异步响应
  } else if (msg?.type === 'diagnose') {
    sendResponse({ ok: true, ...diagnose() });
  }
  return false;
});
