// BOSS 岗位助手 · popup
let currentRows = [];
const statusEl = document.getElementById('status');
const tbl = document.getElementById('tbl');

function setStatus(s) {
  statusEl.textContent = s;
}

async function send(tabId, payload) {
  return await chrome.tabs.sendMessage(tabId, payload);
}

async function activeZhipinTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('zhipin.com')) {
    setStatus('当前不是 BOSS(zhipin.com) 页面。请先打开 BOSS 岗位列表页。');
    return null;
  }
  return tab;
}

document.getElementById('auto').onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('auto.html') });
};

document.getElementById('scrape').onclick = async () => {
  const tab = await activeZhipinTab();
  if (!tab) return;
  setStatus('抓取中…');
  try {
    const res = await send(tab.id, { type: 'scrape' });
    if (!res?.ok) throw new Error('页面无响应');
    currentRows = res.rows;
    setStatus(`已抓取 ${res.count} 条（页面：${res.url}）`);
    renderTable(currentRows);
  } catch (e) {
    setStatus('抓取失败：' + (e?.message ?? e) + '（请刷新该页面后重试）');
  }
};

function renderTable(rows) {
  const head = '<tr><th>岗位</th><th>薪资</th><th>公司</th><th>地区</th></tr>';
  tbl.innerHTML =
    head +
    rows
      .slice(0, 50)
      .map((r) => `<tr><td>${escapeHtml(r.title)}</td><td>${escapeHtml(r.salary)}</td><td>${escapeHtml(r.company)}</td><td>${escapeHtml(r.area)}</td></tr>`)
      .join('');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toCSV(rows) {
  const keys = ['title', 'salary', 'company', 'area', 'jobId', 'href', 'tags'];
  const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
  return [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n');
}

document.getElementById('csv').onclick = () => {
  if (!currentRows.length) return setStatus('先点「抓取」');
  const blob = new Blob(['\ufeff' + toCSV(currentRows)], { type: 'text/csv;charset=utf-8' });
  chrome.downloads.download({ url: URL.createObjectURL(blob), filename: 'boss-jobs.csv' });
  setStatus('已开始下载 boss-jobs.csv');
};
document.getElementById('json').onclick = () => {
  if (!currentRows.length) return setStatus('先点「抓取」');
  const blob = new Blob([JSON.stringify({ url: currentRows.url, rows: currentRows }, null, 1)], { type: 'application/json' });
  chrome.downloads.download({ url: URL.createObjectURL(blob), filename: 'boss-jobs.json' });
  setStatus('已开始下载 boss-jobs.json');
};

document.getElementById('diag').onclick = async () => {
  const tab = await activeZhipinTab();
  if (!tab) return;
  const res = await send(tab.id, { type: 'diagnose' });
  if (!res?.ok) return setStatus('诊断失败');
  const text = `URL: ${res.url}\n\nCLASSES:\n${(res.sampleClasses ?? []).join('\n')}\n\nHTML:\n${res.sampleHtml}`;
  await navigator.clipboard.writeText(text).catch(() => {});
  setStatus('结构诊断已复制到剪贴板，粘贴发给我即可（含 URL/类名/HTML 片段）');
};
