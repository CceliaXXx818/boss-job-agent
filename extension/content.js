// BOSS 岗位助手 · content script（只读，纯 JS）
// 仅读取当前页面 DOM；不模拟点击、不提交表单、不改动页面。

// 常见岗位卡片容器选择器（多版本兼容，逐一尝试）
const CARD_SELECTORS = [
  '.search-job-result .job-card-wrapper',
  '.job-list-box .job-card-wrapper',
  'li.job-card-wrapper',
  '[class*="job-card-wrapper"]',
  '.job-card',
  'li[class*="job-card"]',
];

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

function cardRows() {
  const anchors = Array.from(document.querySelectorAll('a[href*="/job_detail/"]')).slice(0, 60);
  const rows = [];
  const seen = new Set();
  for (const a of anchors) {
    const href = a.getAttribute('href') ?? '';
    const m = href.match(/\/job_detail\/([0-9A-Za-z_-]+)/);
    const jobId = m ? m[1] : href;
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    // 容器：优先已知卡片类，其次回退父链
    let container = null;
    for (const sel of CARD_SELECTORS) {
      container = a.closest(sel);
      if (container) break;
    }
    let node = container ?? a;
    for (let i = 0; i < 4 && node && !container; i++) {
      node = node.parentElement;
      if (!container && node && node.textContent && node.textContent.length < 400) container = node;
    }
    const box = container ?? a;
    const title = pick(
      () =>
        textOf(box.querySelector('[class*="job-name"],[class*="job-title"],.job-name,.job-title')) ||
        (box.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean)[0] ||
        '',
      '',
    );
    const salary = textOf(box.querySelector('.salary,[class*="salary"]'));
    const company = textOf(box.querySelector('[class*="company-name"],.company-name,[class*="brand-name"]'));
    const area = textOf(box.querySelector('[class*="job-area"],.job-area,[class*="location"]'));
    const lines = (box.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 12);
    rows.push({
      title,
      salary,
      company,
      area,
      jobId,
      href: href.split('?')[0] ?? href,
      lines: lines.join(' | '),
    });
  }
  return rows;
}

function diagnose() {
  const anchors = Array.from(document.querySelectorAll('a[href*="/job_detail/"]')).slice(0, 2);
  let sampleHtml = '';
  const sampleClasses = [];
  for (const a of anchors) {
    let box = null;
    for (const sel of CARD_SELECTORS) {
      box = a.closest(sel);
      if (box) break;
    }
    const target = box ?? a;
    sampleHtml = target.outerHTML.slice(0, 1800);
    let n = target;
    for (let i = 0; i < 4 && n; i++) {
      const c = n.getAttribute?.('class');
      if (c) sampleClasses.push(c.slice(0, 160));
      n = n.parentElement;
    }
    break;
  }
  return { url: location.href, sampleHtml, sampleClasses };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'scrape') {
    const rows = cardRows();
    sendResponse({ ok: true, url: location.href, count: rows.length, rows });
  } else if (msg?.type === 'diagnose') {
    sendResponse({ ok: true, ...diagnose() });
  }
  return false;
});
