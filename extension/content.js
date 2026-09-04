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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'scrape') {
    const rows = cardRows();
    sendResponse({ ok: true, url: location.href, count: rows.length, rows });
  } else if (msg?.type === 'greet') {
    sendResponse({ ok: true, ...clickGreet(msg.labels ?? []) });
  } else if (msg?.type === 'diagnose') {
    sendResponse({ ok: true, ...diagnose() });
  }
  return false;
});
