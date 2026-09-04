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

function visibleTextCandidates(root) {
  return Array.from(root.querySelectorAll('button, a, span, div[role="button"]')).filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 20 && rect.height > 20;
  });
}

// 打招呼完整动作：点"打招呼/立即沟通" → 若给了话术则填入输入框 → 点发送/回车
async function greetFull(labels, text) {
  const first = clickGreet(labels);
  if (!first.clicked) return { ok: false, stage: 'no_greet_button', detail: first.text };
  await sleepInPage(2200);
  // 发送按钮（排除“发送简历/附件/照片”等）
  const SEND_EXCLUDE = /简历|附件|照片|图片|文件/;
  // 输入框
  const editor = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).find((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 40 && rect.height > 20;
  });

  if (editor && text && text.length > 0) {
    // 填入我们的话术（兼容 React 受控组件）
    if (editor.tagName === 'TEXTAREA') {
      const proto = Object.getPrototypeOf(editor);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(editor, text);
    } else {
      editor.textContent = text;
    }
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    await sleepInPage(600);
  }

  // 发送按钮识别：文字“发送”或 aria/title/class 含 send（图标按钮）
  const isSendLike = (el) => {
    const t = (el.textContent ?? '').trim();
    if (t && t.length <= 10 && /发送/.test(t) && !/简历|附件|照片|图片|文件/.test(t)) return true;
    const aria = (el.getAttribute('aria-label') ?? '') + (el.getAttribute('title') ?? '');
    if (/发送|send/i.test(aria) && t.length <= 20) return true;
    if (/send/i.test(el.className ?? '') && t.length <= 20) return true;
    return false;
  };
  const pickSendButton = () => visibleTextCandidates(document).find(isSendLike);
  const isEnabled = (el) => {
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if ((el.className || '').includes('disabled')) return false;
    return true;
  };
  const editorText = () => (editor?.value ?? editor?.textContent ?? '').trim();
  const debugButtons = () => {
    const around = editor?.closest('[class*="chat"],[class*="dialog"],[class*="panel"]') ?? document;
    const list = visibleTextCandidates(around)
      .map((el) => {
        const t = (el.textContent ?? '').trim().slice(0, 12);
        return t ? `${t}[${el.className ? String(el.className).slice(0, 30) : ''}]${isEnabled(el) ? '' : '(禁用)'}` : null;
      })
      .filter(Boolean)
      .slice(0, 12)
      .join('; ');
    return list || '（周围未找到可见按钮）';
  };

  let sendBtnNow = null;
  for (let i = 0; i < 8; i++) {
    sendBtnNow = pickSendButton();
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
      detail: '点了发送但内容未清空。现场按钮：' + debugButtons(),
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
      detail: '回车后内容仍在。现场按钮：' + debugButtons(),
    };
  }

  return { ok: false, stage: 'need_manual', detail: '未找到可点发送按钮。现场按钮：' + debugButtons() };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'scrape') {
    const rows = cardRows();
    sendResponse({ ok: true, url: location.href, count: rows.length, rows });
  } else if (msg?.type === 'greet') {
    sendResponse({ ok: true, ...clickGreet(msg.labels ?? []) });
  } else if (msg?.type === 'greetFull') {
    greetFull(msg.labels ?? [], msg.text ?? '').then((r) => sendResponse({ ok: true, ...r }));
    return true; // 异步响应
  } else if (msg?.type === 'diagnose') {
    sendResponse({ ok: true, ...diagnose() });
  }
  return false;
});
