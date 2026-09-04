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
  await sleep(3500);
  const r = await sendTab(tabId, { type: 'greet', labels: GREET_LABELS });
  return r ?? { clicked: false, text: 'content 无响应' };
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
      if (r?.clicked) {
        done += 1;
        await chrome.storage.local.set({ [key]: done });
        log(`  ✓ 已点击「${r.text}」（今日 ${done}/${cap}）`);
        row.__status = '已打招呼';
      } else {
        log(`  ✗ 未找到可点击的打招呼按钮（${r?.text ?? ''}）。停在当前页，请人工处理。`);
        row.__status = '需人工';
        break; // 停在出错岗位，不自动跳到下一个
      }
      renderRows(selectedRows);
      await sleep(1500);
    }
    setStatus(stopped ? '已暂停' : '打招呼流程结束');
  } catch (e) {
    setStatus('失败：' + e.message);
    log('失败：' + e.message);
  }
};

$('stop').onclick = () => {
  stopped = true;
  $('stop').disabled = true;
  setStatus('暂停中（当前动作完成后停止）');
};
