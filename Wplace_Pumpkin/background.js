// background.js (Manifest V3 service worker)
// 功能：顺序打开 URL 并点击 / 查找 Claim；提取页面链接；持久化 claimed 编号；后台每 30 分钟自动检测并过滤已 claimed。
// 包含：启动时从 storage 恢复、storage.onChanged 同步、notifyClaimed 持久化、alarms 周期任务。

let urls = [];
let running = false;
let savedPoint = null; // {x,y,viewportWidth,viewportHeight,timestamp}
let openForeground = true;

// 持久化 claimed 编号集合
let claimedNumbersSet = new Set();

// 自动提取相关状态
let autoExtractEnabled = false;
let lastAutoExtractLinks = []; // [{ href, id|null }, ...]

// 简单 sleep
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- storage helpers ----
async function loadClaimedFromStorage() {
  try {
    const data = await chrome.storage.local.get(['claimedNumbers']);
    if (data && Array.isArray(data.claimedNumbers)) {
      claimedNumbersSet = new Set(data.claimedNumbers.map(n => Number(n)).filter(n => !Number.isNaN(n)));
    } else {
      claimedNumbersSet = new Set();
    }
    console.log('[background] claimed loaded', Array.from(claimedNumbersSet).slice(0,200));
  } catch (e) {
    console.warn('[background] loadClaimedFromStorage error', e && e.message);
    claimedNumbersSet = new Set();
  }
}

async function saveClaimedToStorage() {
  try {
    await chrome.storage.local.set({ claimedNumbers: Array.from(claimedNumbersSet) });
    console.log('[background] claimed saved', Array.from(claimedNumbersSet).slice(0,200));
  } catch (e) {
    console.warn('[background] saveClaimedToStorage error', e && e.message);
  }
}

// 在启动时立即恢复
loadClaimedFromStorage().then(() => {
  console.log('[background] restored claimedNumbers on SW start:', Array.from(claimedNumbersSet).slice(0,200));
}).catch(e => console.warn('[background] restore failed', e && e.message));

// 监听 storage 改变，保持内存同步（若被外部修改）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.claimedNumbers) {
    const newArr = Array.isArray(changes.claimedNumbers.newValue) ? changes.claimedNumbers.newValue : [];
    claimedNumbersSet = new Set(newArr.map(n => Number(n)).filter(n => !Number.isNaN(n)));
    console.log('[background] claimedNumbers updated from storage.onChanged', Array.from(claimedNumbersSet).slice(0,200));
  }
});

// ---- scripting helpers ----
async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    console.warn('inject content.js failed', e && e.message);
  }
}

async function sendCommandToTab(tabId, cmd, payload = {}) {
  await injectContentScript(tabId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (c, p) => {
        window.dispatchEvent(new CustomEvent('sequential_clicker_command', { detail: Object.assign({ cmd: c }, p) }));
      },
      args: [cmd, payload]
    });
  } catch (e) {
    console.warn('sendCommandToTab failed', e && e.message);
  }
}

// 轮询读取 tab 上的 window[varName]
async function pollWindowVar(tabId, varName, timeoutMs = 5000, interval = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (name) => {
          try { return window[name] || null; } catch (e) { return { __error: String(e) }; }
        },
        args: [varName]
      });
      const val = res && res.result !== undefined ? res.result : null;
      if (val) return val;
    } catch (e) {
      // ignore and retry
    }
    await sleep(interval);
  }
  return null;
}

// 等待 tab 加载完成或超时
function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function check() {
      chrome.tabs.get(tabId, (tab) => {
        if (!tab) return reject(new Error('tab not found/closed'));
        if (tab.status === 'complete' || Date.now() > deadline) return resolve();
        setTimeout(check, 250);
      });
    }
    check();
  });
}

// 检查 Claim 按钮（直接从页面读取）
async function checkClaimFound(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          const cands = Array.from(document.querySelectorAll('button.btn.btn-primary'));
          for (const b of cands) {
            if ((b.innerText || '').includes('Claim')) return { found: true, text: (b.innerText || '').trim() };
          }
          const other = Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').includes('Claim'));
          if (other) return { found: true, text: (other.innerText||'').trim() };
          return { found: false };
        } catch (e) {
          return { found: false, error: String(e) };
        }
      }
    });
    return res && res.result ? res.result : null;
  } catch (e) {
    return { found: false, error: String(e) };
  }
}

// ---- 主处理流程（点击流程） ----
async function processUrls(list) {
  running = true;
  for (let i = 0; i < list.length && running; i++) {
    const url = list[i];
    console.log(`[sequential_clicker] processing ${i + 1}/${list.length}: ${url}`);
    let tabId = null;
    try {
      const created = await chrome.tabs.create({ url, active: openForeground });
      tabId = created.id;
      await waitForTabComplete(tabId, 30000).catch(() => {});
      await sleep(300);
      await injectContentScript(tabId);

      if (!savedPoint) {
        await sendCommandToTab(tabId, 'installCapture');
        const pt = await pollWindowVar(tabId, '__sequential_clicker_point', 0x7fffffff, 300);
        if (pt && pt.x !== undefined && pt.y !== undefined) {
          savedPoint = pt;
          console.log('[sequential_clicker] captured point', savedPoint);
        } else {
          console.warn('[sequential_clicker] failed to capture point on tab', tabId);
        }
      }

      if (savedPoint) {
        if (openForeground) {
          try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
        }
        await sleep(200);
        await sendCommandToTab(tabId, 'clickAt', { point: savedPoint });
        const res = await pollWindowVar(tabId, '__sequential_clicker_last_result', 5000, 200);
        if (res) {
          console.log('[sequential_clicker] click result from tab:', res);
        } else {
          await sleep(1000);
        }
        const claimCheck = await checkClaimFound(tabId);
        console.log('[sequential_clicker] claim check:', claimCheck);
      } else {
        console.warn('[sequential_clicker] no savedPoint, skipping click for', url);
      }

    } catch (err) {
      console.error('[sequential_clicker] error processing url', url, err && err.message);
    } finally {
      if (tabId !== null) {
        try { await chrome.tabs.remove(tabId); } catch (e) { /* ignore */ }
      }
      await sleep(400);
    }
  }
  running = false;
  console.log('[sequential_clicker] finished or stopped');
}

// ---- 从活动标签页提取 claimed 编号 ----
async function getClaimedNumbersFromActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) return { ok: false, error: 'no_active_tab' };
    const tabId = tabs[0].id;

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          const nodes = Array.from(document.querySelectorAll('[data-tip]')).filter(el => {
            const dt = el.getAttribute && el.getAttribute('data-tip');
            return typeof dt === 'string' && /\bClaimed:\s*#/.test(dt);
          });
          const nums = new Set();
          const re = /#\s*([0-9]{1,6})/g;
          for (const n of nodes) {
            const dt = n.getAttribute('data-tip') || '';
            let m;
            while ((m = re.exec(dt)) !== null) {
              const v = parseInt(m[1], 10);
              if (!Number.isNaN(v)) nums.add(v);
            }
          }
          return { ok: true, claimed: Array.from(nums).sort((a,b)=>a-b) };
        } catch (e) {
          return { ok: false, error: 'page_eval_error: ' + String(e) };
        }
      }
    });

    if (!Array.isArray(results) || results.length === 0) return { ok: false, error: 'no_result_from_executeScript' };
    const res = results[0] && results[0].result;
    if (!res) return { ok: false, error: 'empty_result' };
    return res.ok ? { ok: true, claimed: res.claimed || [] } : { ok: false, error: res.error || 'unknown' };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---- 提取当前页面的 Open live 链接并尝试解析对应编号（返回 {ok, links:[{href,id|null},...]}) ----
async function extractLinksFromActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) return { ok: false, error: 'no_active_tab' };
    const tabId = tabs[0].id;

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          function parseFoundAt(text) {
            const m = text.match(/Found at\s*(\d{1,2}):(\d{2})/i);
            if (!m) return null;
            const hh = parseInt(m[1], 10);
            const mm = parseInt(m[2], 10);
            if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
            return { hh: hh % 24, mm };
          }

          function findNumberNear(node) {
            let ancestor = node;
            for (let up = 0; up < 7 && ancestor; up++) {
              try {
                const txt = (ancestor.textContent || '').trim();
                const m = txt.match(/\b([0-9]{1,4})\b/);
                if (m) {
                  const v = parseInt(m[1], 10);
                  if (!Number.isNaN(v)) return v;
                }
              } catch (e) {}
              ancestor = ancestor.parentElement;
            }
            let sib = node.previousElementSibling || node.nextElementSibling;
            let attempts = 0;
            while (sib && attempts < 6) {
              try {
                const txt = (sib.textContent || '').trim();
                const m = txt.match(/\b([0-9]{1,4})\b/);
                if (m) {
                  const v = parseInt(m[1], 10);
                  if (!Number.isNaN(v)) return v;
                }
              } catch (e) {}
              sib = sib.nextElementSibling;
              attempts++;
            }
            return null;
          }

          const timeNodes = Array.from(document.querySelectorAll('div, span, p')).filter(el => {
            const txt = (el.textContent || '').trim();
            return /\bFound at\s*\d{1,2}:\d{2}\b/i.test(txt);
          });

          const now = new Date();
          const results = [];

          for (const node of timeNodes) {
            const parsed = parseFoundAt(node.textContent || '');
            if (!parsed) continue;

            let ancestor = node;
            let anchor = null;
            for (let up = 0; up < 7 && ancestor; up++) {
              try {
                anchor = ancestor.querySelector && ancestor.querySelector('a[href^="https://wplace.live/?lat="]');
              } catch (e) {
                anchor = null;
              }
              if (anchor) break;
              ancestor = ancestor.parentElement;
            }

            if (!anchor) {
              let sib = node.nextElementSibling;
              let attempts = 0;
              while (sib && attempts < 6 && !anchor) {
                try {
                  anchor = sib.querySelector && sib.querySelector('a[href^="https://wplace.live/?lat="]');
                } catch (e) {
                  anchor = null;
                }
                sib = sib.nextElementSibling;
                attempts++;
              }
            }

            if (!anchor) continue;

            let id = null;
            try {
              id = findNumberNear(anchor) || findNumberNear(node);
            } catch (e) {
              id = null;
            }

            const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsed.hh, parsed.mm, 0, 0);
            let diffMinutes = (now.getTime() - candidate.getTime()) / (60 * 1000);
            if (diffMinutes < -12 * 60) {
              candidate.setTime(candidate.getTime() - 24 * 60 * 60 * 1000);
              diffMinutes = (now.getTime() - candidate.getTime()) / (60 * 1000);
            }

            if (Math.abs(diffMinutes) <= 60) {
              results.push({ href: anchor.href, id: (id === null ? null : id) });
            }
          }

          const uniqMap = new Map();
          for (const r of results) {
            if (r && r.href) uniqMap.set(r.href, r);
          }
          return { ok: true, links: Array.from(uniqMap.values()) };
        } catch (e) {
          return { ok: false, error: 'page_eval_error: ' + String(e) };
        }
      }
    });

    if (!Array.isArray(results) || results.length === 0) {
      return { ok: false, error: 'no_result_from_executeScript' };
    }

    const res = results[0] && results[0].result;
    if (!res) return { ok: false, error: 'empty_result' };
    if (res.ok) return { ok: true, links: Array.isArray(res.links) ? res.links : [] };
    return { ok: false, error: res.error || 'unknown_page_error' };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---- 自动后台提取逻辑（合并持久化 claimed 与页面 claimed，然后过滤） ----
async function runAutoExtractOnce() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) {
      console.log('[autoExtract] no active tab');
      return;
    }

    const tab = tabs[0];
    try {
      const url = new URL(tab.url || '');
      if (!/wplace\.live/i.test(url.hostname)) {
        console.log('[autoExtract] active tab not wplace, skipping', url.hostname);
        return;
      }
    } catch (e) {
      // ignore parse error, continue
    }

    // 获取页面 claimed（若失败，仍使用持久化集合）
    const claimedResp = await getClaimedNumbersFromActiveTab();
    const claimedSet = new Set(Array.from(claimedNumbersSet)); // 持久化为基础
    if (claimedResp.ok && Array.isArray(claimedResp.claimed)) {
      for (const v of claimedResp.claimed) {
        claimedSet.add(Number(v));
      }
    }

    // 提取页面 links（带 id）
    const extractResp = await extractLinksFromActiveTab();
    if (!extractResp.ok) {
      console.warn('[autoExtract] extract failed', extractResp.error);
      return;
    }

    // 过滤：若解析到 id 且被 claimedSet 包含 => 跳过；若 id 为 null => 保留
    const filtered = (extractResp.links || []).filter(item => {
      if (!item || !item.href) return false;
      if (item.id === null || item.id === undefined) return true;
      return !claimedSet.has(Number(item.id));
    });

    lastAutoExtractLinks = filtered;
    console.log('[autoExtract] extracted', (extractResp.links || []).length, 'filtered ->', filtered.length);
    // 可选：把 lastAutoExtractLinks 写入 storage 或触发通知（此处仅保存在内存）
  } catch (err) {
    console.error('[autoExtract] error', err && err.message);
  }
}

// ---- 使用 chrome.alarms 管理周期任务（更可靠于 MV3） ----
function startAutoExtractAlarms() {
  if (autoExtractEnabled) return;
  runAutoExtractOnce().catch(()=>{});
  chrome.alarms.create('autoExtractAlarm', { periodInMinutes: 30 });
  autoExtractEnabled = true;
  console.log('[autoExtract] started (alarms)');
}

function stopAutoExtractAlarms() {
  if (!autoExtractEnabled) return;
  chrome.alarms.clear('autoExtractAlarm');
  autoExtractEnabled = false;
  console.log('[autoExtract] stopped (alarms cleared)');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm) return;
  if (alarm.name === 'autoExtractAlarm') {
    runAutoExtractOnce().catch((e) => console.error('[autoExtract] alarm run error', e && e.message));
  }
});

// ---- message handling between popup / content and background ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  // start clicking list
  if (msg.type === 'start') {
    if (running) return sendResponse({ ok: false, reason: 'already_running' });
    urls = Array.isArray(msg.urls) ? msg.urls.slice() : [];
    openForeground = !!msg.openForeground;
    processUrls(urls).catch(e => console.error(e));
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'stop') {
    running = false;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'getState') {
    sendResponse({ running, savedPoint, autoExtractEnabled, lastAutoExtractLinks });
    return true;
  }

  if (msg.type === 'extractLinks') {
    (async () => {
      const resp = await extractLinksFromActiveTab();
      sendResponse(resp);
    })();
    return true;
  }

  if (msg.type === 'getClaimed') {
    (async () => {
      const resp = await getClaimedNumbersFromActiveTab();
      sendResponse(resp);
    })();
    return true;
  }

  if (msg.type === 'getClaimedPersistent') {
    sendResponse({ ok: true, claimed: Array.from(claimedNumbersSet).sort((a,b)=>a-b) });
    return true;
  }

  if (msg.type === 'enableAutoExtract') {
    startAutoExtractAlarms();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'disableAutoExtract') {
    stopAutoExtractAlarms();
    sendResponse({ ok: true });
    return true;
  }

  // content 或 popup 通知：某 id 已被 claim（content 里成功点击后发送）
  if (msg.type === 'notifyClaimed') {
    (async () => {
      try {
        const id = Number(msg.id);
        if (!Number.isNaN(id) && id > 0) {
          if (!claimedNumbersSet.has(id)) {
            claimedNumbersSet.add(id);
            await saveClaimedToStorage();
            // 若 lastAutoExtractLinks 中存在该 id，移除它
            lastAutoExtractLinks = lastAutoExtractLinks.filter(item => !(item.id !== null && Number(item.id) === id));
            console.log('[background] notifyClaimed added', id);
            sendResponse({ ok: true, added: true, id });
          } else {
            console.log('[background] notifyClaimed already present', id);
            sendResponse({ ok: true, added: false, id });
          }
        } else {
          sendResponse({ ok: false, error: 'invalid_id' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  return false;
});

// ---- lifecycle: onInstalled 恢复 alarms 状态（如需默认启用可在此启动） ----
chrome.runtime.onInstalled.addListener(() => {
  // 若需安装后自动启用 autoExtract，可取消注释下一行
  // startAutoExtractAlarms();
  console.log('[background] onInstalled fired');
});

console.log('[background] service worker started');
