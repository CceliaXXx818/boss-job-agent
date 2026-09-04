// BOSS 自动投递助手 · 编排页逻辑（纯 JS，MV3）
// 只在你已登录的 BOSS 标签页里操作：搜索(URL)→抓列表→筛选排序→打招呼(限额)。
const $ = (id) => document.getElementById(id);

const CITY_CODE = { '101210100': '杭州', '101280600': '深圳' };
const CITY_NAMES = Object.values(CITY_CODE);
const EXCLUDE_TOKENS = ['数据标注', 'AI运营', '训练运营', '销售', '驻外', '外派', '纯运营', '标注'];
const BOOST_TOKENS = [
  'Agent', '大模型', 'LLM', 'RAG', 'Prompt', 'Conversational', '智能客服', '对话',
  '智能外呼', '智能质检', 'Workflow', 'Function Calling', 'AI Native',
];

let selectedRows = [];
let stopped = false;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const logEl = $('log');
function log(msg) {
  logEl.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}
function setStatus(s) {
  $('status').textContent = s;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayKey = () => new Date().toISOString().slice(0, 10);

async function refreshQuota() {
  const cap = Number($('cap').value);
  const key = `greet-${todayKey()}`;
  const st = await chrome.storage.local.get(key);
  const done = Number(st[key] ?? 0);
  $('quota').textContent = `今日已发 ${done} / ${cap}`;
}

function parseList(str) {
  return str.split(',').map((s) => s.trim()).filter(Boolean);
}

async function jobTab() {
  const tabs = await chrome.tabs.query({ url: ['https://*.zhipin.com/*'] });
  const pick = tabs.find((t) => /\/web\/geek\//.test(t.url)) ?? tabs[0];
  if (!pick) throw new Error('未找到已打开的 BOSS 标签页。请先在你的 Chrome 里打开一个 BOSS 页面。');
  return pick;
}

async function sendTab(tabId, payload) {
  return await chrome.tabs.sendMessage(tabId, payload);
}

async function waitList(tabId) {
  for (let i = 0; i < 15; i++) {
    await sleep(2500);
    try {
      const r = await sendTab(tabId, { type: 'scrape' });
      if (r?.count > 0) return r;
    } catch { /* 页面可能仍在加载 */ }
  }
  throw new Error('等待岗位列表超时（请人工确认该标签是 BOSS 岗位列表页）');
}

async function gotoSearch(tabId, city, query) {
  const url = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(query)}&city=${city}`;
  await chrome.tabs.update(tabId, { url });
  await sleep(4000);
  const res = await waitList(tabId);
  if (/\/chengshi\/|\/shenzhen\/|\/hangzhou\//.test(res.url)) {
    throw new Error(`搜索被 BOSS 跳转到城市页（${res.url}），请人工确认登录后重试`);
  }
  return res;
}

function filterRank(rawRows) {
  const keep = [];
  for (const r of rawRows) {
    const blob = (r.title + ' ' + (r.tags || '') + ' ' + r.company).toLowerCase();
    if (EXCLUDE_TOKENS.some((t) => blob.includes(t))) continue;
    let score = 0;
    const upper = (r.title + ' ' + (r.tags || '')).toUpperCase();
    for (const t of BOOST_TOKENS) if (upper.includes(t.toUpperCase())) score += 2;
    const tags = (r.tags || '').split('|');
    if (tags.some((t) => t.includes('5-10年'))) score += 2;
    if (tags.some((t) => t.includes('3-5年'))) score += 1;
    if (tags.some((t) => t.includes('硕士'))) score += 1;
    if (tags.some((t) => t.includes('本科'))) score += 1;
    if (tags.some((t) => t.includes('大专'))) score -= 1;
    keep.push({ ...r, score });
  }
  keep.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh'));
  return keep;
}

function renderRows(rows) {
  const tb = document.querySelector('#tbl tbody');
  tb.innerHTML = rows
    .map(
      (r, i) =>
        `<tr><td><input type="checkbox" data-i="${i}" ${i < Number($('cap').value) ? 'checked' : ''}></td>` +
        `<td>${r.title}</td><td>${r.company}</td><td>${r.area}</td><td>${r.tags || ''}</td>` +
        `<td>${r.score}</td><td class="${r.__status === '已打招呼' ? 'ok' : r.__status ? 'warn' : 'skip'}">${r.__status ?? '待处理'}</td></tr>`,
    )
    .join('');
}

function checkedRows() {
  return [...document.querySelectorAll('#tbl tbody input:checked')].map((cb) => selectedRows[Number(cb.dataset.i)]);
}

$('run').onclick = async () => {
  try {
    stopped = false;
    setStatus('搜索中…');
    const tab = await jobTab();
    const cities = parseList($('city').value);
    const queries = parseList($('query').value);
    const seen = new Map();
    for (const city of cities) {
      for (const q of queries) {
        log(`搜索 ${CITY_CODE[city] ?? city} · ${q}`);
        const res = await gotoSearch(tab.id, city, q);
        for (const r of res.rows) if (!seen.has(r.jobId)) seen.set(r.jobId, r);
      }
    }
    selectedRows = filterRank([...seen.values()]);
    log(`共抓取 ${selectedRows.length} 个不同岗位，已过滤并排序`);
    renderRows(selectedRows);
    setStatus(`完成：${selectedRows.length} 条`);
  } catch (e) {
    setStatus('失败：' + e.message);
    log('失败：' + e.message);
  }
};

const GREET_LABELS = ['打招呼', '立即沟通', '和TA聊聊', '开聊', '立即开聊', '聊一下'];

async function greetOne(tabId, row) {
  const url = 'https://www.zhipin.com' + row.href;
  await chrome.tabs.update(tabId, { url });
  await sleep(4000);
  const text = $('greetText').value.trim();
  const r = await sendTab(tabId, { type: 'greetFull', labels: GREET_LABELS, text });
  return r ?? { ok: false, stage: 'content_no_response', detail: 'content 无响应' };
}

$('greet').onclick = async () => {
  const cap = Number($('cap').value);
  const exec = $('exec').checked;
  if (!exec) {
    setStatus('请勾选“实际执行打招呼”后再运行（了解风险）');
    return;
  }
  const rows = checkedRows();
  if (!rows.length) {
    setStatus('没有勾选岗位，先执行①自动勾选前 N 个或手动勾选');
    return;
  }
  try {
    stopped = false;
    const tab = await jobTab();
    const key = `greet-${todayKey()}`;
    const st = await chrome.storage.local.get(key);
    let done = Number(st[key] ?? 0);
    for (const row of rows.slice(0, cap)) {
      if (stopped || done >= cap) break;
      log(`打招呼：${row.title}（${row.company}）`);
      const r = await greetOne(tab.id, row);
      const sent = r?.ok === true && (r.stage === 'sent' || r.stage === 'sent_by_enter');
      if (sent) {
        done += 1;
        await chrome.storage.local.set({ [key]: done });
        await refreshQuota();
        log(`  ✓ ${r.detail}（今日 ${done}/${cap}）`);
        row.__status = '已打招呼';
      } else {
        const why = r?.detail ?? r?.stage ?? '未知';
        log(`  ✗ 未完成发送：${why}。停在当前页，请人工处理。`);
        row.__status = '需人工';
        break; // 停在出错岗位，不自动跳下一个
      }
      renderRows(selectedRows);
      await sleep(1500);
    }
    setStatus(stopped ? '已暂停' : '打招呼流程结束');
    await refreshQuota();
  } catch (e) {
    setStatus('失败：' + e.message);
    log('失败：' + e.message);
  }
};

$('cap').addEventListener('change', refreshQuota);
refreshQuota();

const detailMap = new Map();

function renderDetailTable() {
  const tb = document.querySelector('#dtbl tbody');
  if (!detailMap.size) {
    tb.innerHTML = '<tr><td colspan="6" class="skip">先点 ③ 抓取详情</td></tr>';
    return;
  }
  tb.innerHTML = [...detailMap.values()]
    .map(
      (d) =>
        `<tr data-href="${escapeHtml('https://www.zhipin.com' + (d.href ?? ''))}" style="cursor:pointer">` +
        `<td>${escapeHtml(d.title)}</td>` +
        `<td>${escapeHtml(d.salaryRaw || d.salary)}</td>` +
        `<td>${escapeHtml(d.asciiSalary || '字体加密待解码')}</td>` +
        `<td>${escapeHtml((d.tags || []).join(' / '))}</td>` +
        `<td>${escapeHtml((d.companyMeta || []).join(' / '))}</td>` +
        `<td>${escapeHtml((d.descPreview || '').slice(0, 160))}</td></tr>`,
    )
    .join('');
  tb.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.onclick = () => chrome.tabs.create({ url: tr.dataset.href });
  });
}

$('detail').onclick = async () => {
  const rows = checkedRows();
  if (!rows.length) return setStatus('没有勾选岗位，请先 ① 并勾选');
  try {
    stopped = false;
    const tab = await jobTab();
    for (const row of rows) {
      if (stopped) break;
      log(`抓详情：${row.title}`);
      await chrome.tabs.update(tab.id, { url: 'https://www.zhipin.com' + row.href });
      await sleep(4200);
      try {
        const r = await sendTab(tab.id, { type: 'detailScrape' });
        detailMap.set(row.jobId, { ...row, ...(r ?? {}) });
        log(`  ✓ ${r?.name || row.title}（薪资解析：${r?.asciiSalary || '未取到'}）`);
      } catch (e) {
        log('  ✗ 详情读取失败：' + (e?.message ?? e));
      }
      renderDetailTable();
    }
    renderDetailTable();
    setStatus('详情抓取完成');
  } catch (e) {
    setStatus('失败：' + e.message);
    log('失败：' + e.message);
  }
};

function toCSVDetail() {
  const keys = ['title', 'salary', 'asciiSalary', 'company', 'area', 'tags', 'companyMeta', 'descPreview', 'jobId', 'href'];
  const esc = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
  const lines = [];
  for (const d of detailMap.values()) {
    lines.push(keys.map((k) => esc(Array.isArray(d[k]) ? d[k].join(' / ') : d[k])).join(','));
  }
  return ['岗位,薪资(原文),薪资(解析),公司,地区,经验学历标签,公司规模融资,JD摘要,JobId,链接', ...lines].join('\n');
}

$('dcsv').onclick = () => {
  if (!detailMap.size) return setStatus('先执行 ③ 抓详情');
  const blob = new Blob(['\ufeff' + toCSVDetail()], { type: 'text/csv;charset=utf-8' });
  chrome.downloads.download({ url: URL.createObjectURL(blob), filename: 'boss-jobs-detail.csv' });
  setStatus('已开始下载 boss-jobs-detail.csv');
};

$('stop').onclick = () => {
  stopped = true;
  $('stop').disabled = true;
  setStatus('暂停中（当前动作完成后停止）');
};
