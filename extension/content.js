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

// 打招呼完整动作：点"打招呼/立即沟通" → 等待面板 → 若需再点"发送"则发送
async function greetFull(labels) {
  const first = clickGreet(labels);
  if (!first.clicked) return { ok: false, stage: 'no_greet_button', detail: first.text };
  await sleepInPage(2200);
  // 发送按钮（排除“发送简历/附件/照片”等）
  const SEND_EXCLUDE = /简历|附件|照片|图片|文件/;
  const sendBtn = visibleTextCandidates(document).find((el) => {
    const t = (el.textContent ?? '').trim();
    return /发送/.test(t) && t.length <= 10 && !SEND_EXCLUDE.test(t);
  });
  if (sendBtn) {
    sendBtn.click();
    await sleepInPage(800);
    return { ok: true, stage: 'sent', detail: `点击了“打招呼”(${first.text})并点击“发送”` };
  }
  // 无独立发送按钮：尝试在输入框内回车（若有文本）
  const editor = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).find((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 40 && rect.height > 20;
  });
  if (editor) {
    const text = editor.textContent ?? editor.value ?? '';
    if (text.trim().length > 0) {
      editor.focus();
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      await sleepInPage(800);
      return { ok: true, stage: 'sent_by_enter', detail: '在输入框内回车发送' };
    }
    return { ok: false, stage: 'editor_empty', detail: '进入了打招呼界面但输入框为空，未发送（请人工检查）' };
  }
  return { ok: false, stage: 'need_manual', detail: '已点打招呼但未找到发送按钮，停在此界面（请人工确认）' };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'scrape') {
    const rows = cardRows();
    sendResponse({ ok: true, url: location.href, count: rows.length, rows });
  } else if (msg?.type === 'greet') {
    sendResponse({ ok: true, ...clickGreet(msg.labels ?? []) });
  } else if (msg?.type === 'greetFull') {
    greetFull(msg.labels ?? []).then((r) => sendResponse({ ok: true, ...r }));
    return true; // 异步响应
  } else if (msg?.type === 'diagnose') {
    sendResponse({ ok: true, ...diagnose() });
  }
  return false;
});
