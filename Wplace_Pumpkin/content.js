// content.js
(() => {
  // 防止多次注入
  if (window.__sequential_clicker_content_installed) return;
  window.__sequential_clicker_content_installed = true;

  // 存储用户录入点与最后操作结果
  window.__sequential_clicker_point = window.__sequential_clicker_point || null;
  window.__sequential_clicker_last_result = window.__sequential_clicker_last_result || null;

  // 注入一次性覆盖层，等待用户在页面上单击以记录 viewport 坐标
  function installCaptureOnce() {
    if (window.__sequential_clicker_capture_installed) return;
    window.__sequential_clicker_capture_installed = true;

    // 清理已存在的 overlay
    const existing = document.getElementById('__sc_overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = '__sc_overlay';
    overlay.style.position = 'fixed';
    overlay.style.left = '0';
    overlay.style.top = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.zIndex = 2147483647;
    overlay.style.background = 'rgba(0,0,0,0.12)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.pointerEvents = 'auto';
    overlay.innerHTML = '<div style="background:#fff;padding:12px 14px;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,0.15);font-size:13px;color:#111;max-width:80%;text-align:center;">请在页面上单击一次以指定自动点击位置。单击后提示消失。</div>';

    function handler(e) {
      // 记录 viewport client 坐标
      const pt = { x: e.clientX, y: e.clientY, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, timestamp: Date.now() };
      window.__sequential_clicker_point = pt;
      window.__sequential_clicker_last_result = { event: 'point_captured', point: pt };
      overlay.removeEventListener('click', handler);
      overlay.remove();
      // 发出事件，让 background 或 popup 可轮询读取
      window.dispatchEvent(new CustomEvent('sequential_clicker_point_captured', { detail: pt }));
    }
    overlay.addEventListener('click', handler, { once: true });
    document.documentElement.appendChild(overlay);
  }

  // 尝试查找并点击 Claim 按钮（优先 class.btn.btn-primary 且包含 Claim 文本）
  function tryFindAndClickClaim() {
    try {
      const candidates = Array.from(document.querySelectorAll('button.btn.btn-primary'));
      for (const b of candidates) {
        const text = (b.innerText || '').trim();
        if (text.includes('Claim')) {
          b.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
          try { b.click(); } catch (e) {
            // fallback: dispatch mouse events
            dispatchMouseEventsOnElement(b);
          }
          window.__sequential_clicker_last_result = { event: 'claim_attempt', found: true, method: 'btn.btn-primary', text: (b.innerText||'').trim(), timestamp: Date.now() };
          return window.__sequential_clicker_last_result;
        }
      }

      // 更宽松的匹配（任意 button 包含 Claim 文本）
      const allBtns = Array.from(document.querySelectorAll('button'));
      for (const b of allBtns) {
        if ((b.textContent || '').includes('Claim')) {
          b.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
          try { b.click(); } catch (e) { dispatchMouseEventsOnElement(b); }
          window.__sequential_clicker_last_result = { event: 'claim_attempt', found: true, method: 'button_text', text: (b.innerText||'').trim(), timestamp: Date.now() };
          return window.__sequential_clicker_last_result;
        }
      }

      // 未找到
      window.__sequential_clicker_last_result = { event: 'claim_attempt', found: false, timestamp: Date.now() };
      return window.__sequential_clicker_last_result;
    } catch (err) {
      window.__sequential_clicker_last_result = { event: 'claim_attempt', found: false, error: String(err), timestamp: Date.now() };
      return window.__sequential_clicker_last_result;
    }
  }

  // 派发一组 PointerEvent/MouseEvent 于元素上（用于更真实的交互）
  function dispatchPointerAndMouseEvents(target, x, y) {
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: window.screenX + x, screenY: window.screenY + y, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    try {
      // Pointer sequence
      const pOver = new PointerEvent('pointerover', base); target.dispatchEvent(pOver);
      const pEnter = new PointerEvent('pointerenter', base); target.dispatchEvent(pEnter);
      const pMove = new PointerEvent('pointermove', base); target.dispatchEvent(pMove);
      const pDown = new PointerEvent('pointerdown', base); target.dispatchEvent(pDown);
      const mDown = new MouseEvent('mousedown', base); target.dispatchEvent(mDown);
      const pUp = new PointerEvent('pointerup', base); target.dispatchEvent(pUp);
      const mUp = new MouseEvent('mouseup', base); target.dispatchEvent(mUp);
      const click = new MouseEvent('click', base); target.dispatchEvent(click);
    } catch (e) {
      // 如果 PointerEvent 构造失败则退回到简单 MouseEvent
      dispatchMouseEventsOnElement(target, x, y);
    }
  }

  function dispatchMouseEventsOnElement(target, x = 0, y = 0) {
    try {
      const mOver = new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y });
      const mMove = new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y });
      const mDown = new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y });
      const mUp = new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y });
      const mClick = new MouseEvent('click', { bubbles: true, clientX: x, clientY: y });
      target.dispatchEvent(mOver);
      target.dispatchEvent(mMove);
      target.dispatchEvent(mDown);
      target.dispatchEvent(mUp);
      target.dispatchEvent(mClick);
    } catch (e) {
      // ignore
    }
  }

  // 更鲁棒的点击：优先 elementFromPoint，尝试微调、滚动并重试
  async function doRobustClick(pt, attempts = 2) {
    try {
      // 尝试聚焦页面
      try { window.focus && window.focus(); } catch (e) {}

      // 小等待，确保页面稳定
      await new Promise(r => setTimeout(r, 50));

      // 尝试直接找到元素
      let target = document.elementFromPoint(pt.x, pt.y);
      if (!target) {
        const offsets = [[0,0],[1,0],[-1,0],[0,1],[0,-1],[2,0],[-2,0],[3,0],[-3,0]];
        for (const off of offsets) {
          target = document.elementFromPoint(pt.x + off[0], pt.y + off[1]);
          if (target) break;
        }
      }

      if (!target) {
        // 回退到 body/document
        target = document.body || document.documentElement;
        if (!target) throw new Error('no target to click');
      } else {
        // 保证在可视范围
        try {
          const r = target.getBoundingClientRect();
          if (r.top > window.innerHeight || r.bottom < 0 || r.left > window.innerWidth || r.right < 0) {
            target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
            await new Promise(r => setTimeout(r, 120));
          }
        } catch (e) {}
      }

      // 多次尝试点击
      let lastErr = null;
      for (let i = 0; i < attempts; i++) {
        try {
          dispatchPointerAndMouseEvents(target, pt.x, pt.y);
          return { ok: true, attempts: i + 1 };
        } catch (err) {
          lastErr = err;
          await new Promise(r => setTimeout(r, 120));
        }
      }
      throw lastErr || new Error('click attempts failed');
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  // 响应外部命令（通过 window.dispatchEvent 触发）
  window.addEventListener('sequential_clicker_command', async (ev) => {
    const cmd = ev.detail && ev.detail.cmd;
    if (!cmd) return;

    if (cmd === 'installCapture') {
      installCaptureOnce();
      // 返回已安装标志
      window.__sequential_clicker_last_result = { event: 'capture_installed', timestamp: Date.now() };
      window.dispatchEvent(new CustomEvent('sequential_clicker_result', { detail: window.__sequential_clicker_last_result }));
      return;
    }

    if (cmd === 'clickAt') {
      const pt = ev.detail && ev.detail.point;
      if (!pt) {
        window.__sequential_clicker_last_result = { event: 'clickAt', ok: false, error: 'no_point_provided', timestamp: Date.now() };
        window.dispatchEvent(new CustomEvent('sequential_clicker_result', { detail: window.__sequential_clicker_last_result }));
        return;
      }

      // 执行 robust click
      const clickRes = await doRobustClick(pt, 2);
      // 等待 1 秒以让页面响应（要求：每次点击要等 1 秒）
      await new Promise(r => setTimeout(r, 1000));
      // 尝试查找并点击 Claim 按钮
      const claimRes = tryFindAndClickClaim();

      const result = { event: 'clickAt', click: clickRes, claim: claimRes, timestamp: Date.now() };
      window.__sequential_clicker_last_result = result;
      // 发出事件并写入全局变量，方便 background.poll
      window.dispatchEvent(new CustomEvent('sequential_clicker_result', { detail: result }));
    }
  });

  // 导出调试 API（可从控制台手动触发）
  window.__sequential_clicker_install = installCaptureOnce;
  window.__sequential_clicker_doClick = async (pt) => {
    const res = await doRobustClick(pt, 2);
    await new Promise(r => setTimeout(r, 1000));
    const claimRes = tryFindAndClickClaim();
    window.__sequential_clicker_last_result = { event: 'manual_click', click: res, claim: claimRes, timestamp: Date.now() };
    return window.__sequential_clicker_last_result;
  };
})();
