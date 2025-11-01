// popup.js
document.addEventListener('DOMContentLoaded', () => {
  const urlsEl = document.getElementById('urls');
  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  const statusEl = document.getElementById('status');
  const openFgEl = document.getElementById('openForeground');
  const grabBtn = document.getElementById('grabLinks');
  const getClaimedBtn = document.getElementById('getClaimed');
  const showClaimedBtn = document.getElementById('showClaimed');
  const autoExtractCheckbox = document.getElementById('autoExtract');
  const claimedListEl = document.getElementById('claimedList');

  function setStatus(text) { statusEl.textContent = `状态：${text}`; }

  function sendMessageAsync(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp);
        }
      });
    });
  }

  startBtn.addEventListener('click', async () => {
    const raw = urlsEl.value.trim();
    if (!raw) { setStatus('请先输入或提取 URLs'); return; }
    const list = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (list.length === 0) { setStatus('URLs 列表为空'); return; }
    setStatus(`发送 ${list.length} 个 URL 开始处理...`);
    const resp = await sendMessageAsync({ type: 'start', urls: list, openForeground: !!openFgEl.checked });
    if (resp && resp.ok) setStatus('已开始（扩展正在顺序处理）'); else setStatus('无法开始：' + (resp && (resp.reason || resp.error) ? (resp.reason || resp.error) : '未知'));
  });

  stopBtn.addEventListener('click', async () => {
    const resp = await sendMessageAsync({ type: 'stop' });
    if (resp && resp.ok) setStatus('已请求停止'); else setStatus('停止请求失败');
  });

  // 抓取当前页的 Open live 链接（带 id）
  grabBtn.addEventListener('click', async () => {
    setStatus('正在从当前标签页提取链接...');
    grabBtn.disabled = true;
    try {
      const resp = await sendMessageAsync({ type: 'extractLinks' });
      if (!resp) { setStatus('提取失败（无响应）'); return; }
      if (resp.ok) {
        const list = resp.links || [];
        if (list.length === 0) {
          setStatus('未在当前页找到符合条件的链接');
          urlsEl.value = '';
        } else {
          setStatus(`已提取 ${list.length} 条链接`);
          urlsEl.value = list.map(i => i.id ? `${i.href}  #id=${i.id}` : i.href).join('\n');
        }
      } else {
        setStatus('提取失败：' + (resp.error || 'unknown'));
      }
    } catch (err) {
      setStatus('提取异常，请检查 service worker 控制台');
      console.error(err);
    } finally {
      grabBtn.disabled = false;
    }
  });

  // 从页面读取 data-tip 中的 claimed 编号（临时展示）
  getClaimedBtn.addEventListener('click', async () => {
    setStatus('正在获取页面已 claim 编号...');
    getClaimedBtn.disabled = true;
    try {
      const resp = await sendMessageAsync({ type: 'getClaimed' });
      if (resp && resp.ok) {
        claimedListEl.textContent = `已 claim 列表（页面即时）：${(resp.claimed || []).join(', ') || '无'}`;
        setStatus(`已抓到 ${(resp.claimed||[]).length} 条 claimed 编号`);
      } else {
        setStatus('获取失败：' + (resp && resp.error ? resp.error : 'unknown'));
      }
    } catch (err) {
      setStatus('获取异常，请检查 service worker 控制台');
      console.error(err);
    } finally {
      getClaimedBtn.disabled = false;
    }
  });

  // 显示持久化的已 claim 列表（来自 background 的 storage）
  showClaimedBtn.addEventListener('click', async () => {
    setStatus('读取持久化已claim列表...');
    showClaimedBtn.disabled = true;
    try {
      const resp = await sendMessageAsync({ type: 'getClaimedPersistent' });
      if (resp && resp.ok) {
        claimedListEl.textContent = `已持久化 claim：${(resp.claimed || []).join(', ') || '无'}`;
        setStatus(`持久化已claim ${ (resp.claimed||[]).length } 项`);
      } else {
        setStatus('读取失败：' + (resp && resp.error ? resp.error : 'unknown'));
      }
    } catch (err) {
      setStatus('读取异常，请检查 service worker 控制台');
      console.error(err);
    } finally {
      showClaimedBtn.disabled = false;
    }
  });

  // 自动提取开关
  autoExtractCheckbox.addEventListener('change', async (e) => {
    if (e.target.checked) {
      const resp = await sendMessageAsync({ type: 'enableAutoExtract' });
      if (resp && resp.ok) setStatus('已启用后台每30分钟自动检测');
      else { setStatus('启用失败'); e.target.checked = false; }
    } else {
      const resp = await sendMessageAsync({ type: 'disableAutoExtract' });
      if (resp && resp.ok) setStatus('已禁用后台自动检测'); else { setStatus('禁用失败'); e.target.checked = true; }
    }
  });

  // popup 打开时强制从持久化集合读取并显示
  (async () => {
    try {
      const st = await sendMessageAsync({ type: 'getState' });
      if (st) {
        if (st.savedPoint) {
          setStatus(`已记录点击点 clientX=${st.savedPoint.x}, clientY=${st.savedPoint.y}`);
        }
        if (st.autoExtractEnabled) autoExtractCheckbox.checked = true;
        if (st.lastAutoExtractLinks && Array.isArray(st.lastAutoExtractLinks) && st.lastAutoExtractLinks.length) {
          claimedListEl.textContent = `上次自动提取 ${st.lastAutoExtractLinks.length} 条`;
        }
      }

      // 关键：打开 popup 时立刻读取持久化 claimed 并显示（保证跨页面切换后也能看到）
      const resp = await sendMessageAsync({ type: 'getClaimedPersistent' });
      if (resp && resp.ok) {
        claimedListEl.textContent = `已持久化 claim：${(resp.claimed || []).join(', ') || '无'}`;
      } else {
        claimedListEl.textContent = '已持久化 claim：读取失败';
      }

      // 额外增强（可选但已启用）：将当前页面的即时 claimed 并入持久化集合
      // 从页面读取当前 data-tip 的 claimed 列表并对每个 id 发送 notifyClaimed 以做到跨页面同步
      try {
        const pageResp = await sendMessageAsync({ type: 'getClaimed' });
        if (pageResp && pageResp.ok && Array.isArray(pageResp.claimed) && pageResp.claimed.length) {
          for (const id of pageResp.claimed) {
            // 略过已存在项，后台会去重
            await sendMessageAsync({ type: 'notifyClaimed', id });
          }
          // 重新读取持久化并更新显示
          const updated = await sendMessageAsync({ type: 'getClaimedPersistent' });
          if (updated && updated.ok) {
            claimedListEl.textContent = `已持久化 claim：${(updated.claimed || []).join(', ') || '无'}`;
          }
        }
      } catch (e) {
        // ignore page merge errors
      }
    } catch (e) {
      console.warn('popup init error', e && e.message);
    }
  })();

});
