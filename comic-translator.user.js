// ==UserScript==
// @name         Comic Translator (EN → HE)
// @namespace    https://github.com/hilaf2331-rgb/translator
// @version      1.0.0
// @description  Translates speech bubbles in comics / webtoons into Hebrew, drawn right on top of the images.
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      *
// ==/UserScript==

(async function () {
  'use strict';

  // ---------- Settings ----------
  const MODEL = 'claude-opus-5';
  const SOURCE_LANG = 'English';
  const TARGET_LANG = 'Hebrew';
  const TRANSLATE_SFX = false;      // translate sound effects ("BOOM", "SLAM") too?
  const MIN_IMG_WIDTH = 250;        // ignore small images (icons, avatars, ads)
  const MIN_IMG_HEIGHT = 250;
  const MAX_EDGE = 1568;            // long edge of each piece sent to the model (px)
  const CHUNK_OVERLAP = 200;        // overlap between pieces of a tall webtoon strip (px, in sent scale)
  const MAX_PARALLEL = 2;           // images translated at the same time
  const CACHE_LIMIT = 400;          // translated images remembered across visits

  const host = location.hostname;
  const KEY_API = 'apiKey';
  const KEY_SITES = 'enabledSites';
  const KEY_CACHE = 'cache';

  // ---------- Storage ----------
  const store = {
    get: (k, d) => GM.getValue(k, d),
    set: (k, v) => GM.setValue(k, v),
  };

  let enabledSites = JSON.parse(await store.get(KEY_SITES, '[]'));
  let enabled = enabledSites.includes(host);
  let cache = JSON.parse(await store.get(KEY_CACHE, '{}'));

  function saveCache() {
    const keys = Object.keys(cache);
    if (keys.length > CACHE_LIMIT) {
      keys.sort((a, b) => cache[a].t - cache[b].t);
      for (const k of keys.slice(0, keys.length - CACHE_LIMIT)) delete cache[k];
    }
    store.set(KEY_CACHE, JSON.stringify(cache));
  }

  // ---------- Styles ----------
  const style = document.createElement('style');
  style.textContent = `
    .ct-layer { position: absolute; pointer-events: none; z-index: 2147483000; }
    .ct-bubble {
      position: absolute; pointer-events: auto; box-sizing: border-box;
      display: flex; align-items: center; justify-content: center; text-align: center;
      background: #fff; color: #111; border-radius: 12px; padding: 2px 4px;
      direction: rtl; overflow: hidden; line-height: 1.15; font-weight: 600;
      font-family: -apple-system, "Segoe UI", Arial, sans-serif;
      box-shadow: 0 0 0 1px rgba(0,0,0,.08);
    }
    .ct-bubble.ct-hidden { opacity: 0; }
    .ct-status {
      position: absolute; pointer-events: none; top: 6px; left: 6px;
      background: rgba(0,0,0,.65); color: #fff; font: 12px -apple-system, Arial, sans-serif;
      padding: 3px 8px; border-radius: 10px; direction: rtl;
    }
    #ct-ui {
      position: fixed; bottom: 18px; left: 14px; z-index: 2147483647;
      display: flex; gap: 8px; align-items: center; direction: rtl;
      font: 14px -apple-system, Arial, sans-serif;
    }
    #ct-ui button {
      border: none; border-radius: 22px; height: 44px; min-width: 44px; padding: 0 14px;
      font: 600 15px -apple-system, Arial, sans-serif; color: #fff; background: #555;
      box-shadow: 0 2px 8px rgba(0,0,0,.3); opacity: .9;
    }
    #ct-ui button.ct-on { background: #7b3fe4; }
    #ct-ui button.ct-gear { background: #333; padding: 0; width: 44px; }
  `;
  document.head.appendChild(style);

  // ---------- Floating buttons ----------
  const ui = document.createElement('div');
  ui.id = 'ct-ui';
  const toggleBtn = document.createElement('button');
  const gearBtn = document.createElement('button');
  gearBtn.className = 'ct-gear';
  gearBtn.textContent = '⚙';
  ui.append(toggleBtn, gearBtn);
  document.body.appendChild(ui);

  function renderToggle() {
    toggleBtn.textContent = enabled ? 'תרגום: פועל' : 'תרגם';
    toggleBtn.classList.toggle('ct-on', enabled);
  }
  renderToggle();

  toggleBtn.addEventListener('click', async () => {
    if (!enabled && !(await store.get(KEY_API, ''))) {
      if (!(await askForKey())) return;
    }
    enabled = !enabled;
    enabledSites = enabledSites.filter((h) => h !== host);
    if (enabled) enabledSites.push(host);
    store.set(KEY_SITES, JSON.stringify(enabledSites));
    renderToggle();
    if (enabled) startWatching();
    else stopAll();
  });

  gearBtn.addEventListener('click', async () => {
    const choice = prompt(
      'הגדרות:\n1 – החלפת מפתח API\n2 – ניקוי תרגומים שמורים\n3 – הסתרת הכפתורים עד רענון הדף',
      '1'
    );
    if (choice === '1') askForKey();
    else if (choice === '2') { cache = {}; saveCache(); alert('נוקה.'); }
    else if (choice === '3') ui.remove();
  });

  async function askForKey() {
    const key = prompt('הדביקי כאן את מפתח ה-API של Anthropic (מתחיל ב-sk-ant-):', '');
    if (!key || !key.trim().startsWith('sk-ant-')) {
      if (key !== null) alert('המפתח לא נראה תקין. הוא אמור להתחיל ב-sk-ant-');
      return false;
    }
    await store.set(KEY_API, key.trim());
    return true;
  }

  // ---------- Networking ----------
  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM.xmlHttpRequest({
        ...opts,
        onload: resolve,
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  async function loadImageBitmap(img) {
    const src = img.currentSrc || img.src;
    // 1) Image already readable (same origin / CORS allowed): draw it directly.
    try {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 1, 1);
      ctx.getImageData(0, 0, 1, 1); // throws if tainted
      return await createImageBitmap(img);
    } catch (_) { /* fall through */ }
    // 2) Page fetch (works when the CDN sends CORS headers).
    try {
      const r = await fetch(src);
      if (r.ok) return await createImageBitmap(await r.blob());
    } catch (_) { /* fall through */ }
    // 3) Userscript request: not bound by CORS. Many comic CDNs check the Referer.
    const r = await gmRequest({
      method: 'GET', url: src, responseType: 'blob',
      headers: { Referer: location.href },
    });
    if (r.status < 200 || r.status >= 300) throw new Error('image HTTP ' + r.status);
    let blob = r.response;
    if (!(blob instanceof Blob)) blob = new Blob([blob]);
    return await createImageBitmap(blob);
  }

  // Cut a (possibly very tall) image into pieces the model can read clearly.
  function slice(bitmap) {
    const W = bitmap.width, H = bitmap.height;
    const scale = Math.min(1, MAX_EDGE / W);
    const sw = Math.round(W * scale);
    const pieceH = Math.min(MAX_EDGE, Math.round(H * scale)); // in sent scale
    const pieces = [];
    const totalH = Math.round(H * scale);
    let y = 0;
    while (true) {
      const h = Math.min(pieceH, totalH - y);
      const canvas = document.createElement('canvas');
      canvas.width = sw; canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, y / scale, W, h / scale, 0, 0, sw, h);
      const data = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
      pieces.push({ y, h, w: sw, data, first: y === 0, last: y + h >= totalH });
      if (y + h >= totalH) break;
      y += pieceH - CHUNK_OVERLAP;
    }
    return { pieces, sentW: sw, sentH: totalH };
  }

  const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['bubbles'],
    properties: {
      bubbles: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y', 'w', 'h', 'translation'],
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
            translation: { type: 'string' },
          },
        },
      },
    },
  };

  function buildPrompt(piece) {
    return (
      `This is a ${piece.w}x${piece.h} px piece of a comic page` +
      (piece.first && piece.last ? '' : ' (a vertical webtoon strip, cut into pieces)') +
      `. Find every speech bubble, thought bubble and narration/caption box that contains ${SOURCE_LANG} text` +
      (TRANSLATE_SFX ? ', plus sound effects' : '; skip sound effects and background signs that are not important to the story') +
      `.\nFor each one return the box of the text area inside the bubble in pixel coordinates of this image ` +
      `(x, y = top-left corner, w, h = size) and a natural, fluent ${TARGET_LANG} translation that fits the character's tone ` +
      `(casual speech stays casual). Use proper gender forms in ${TARGET_LANG} based on who is speaking and to whom, ` +
      `when it is visible in the art. Skip bubbles cut off at the very top or bottom edge of the image. ` +
      `If there is no such text, return an empty list.`
    );
  }

  async function translatePiece(piece, apiKey) {
    const body = {
      model: MODEL,
      max_tokens: 8000,
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: SCHEMA },
      },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: piece.data } },
          { type: 'text', text: buildPrompt(piece) },
        ],
      }],
    };
    const r = await gmRequest({
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      data: JSON.stringify(body),
      timeout: 120000,
    });
    const res = JSON.parse(r.responseText);
    if (r.status !== 200) throw new Error(res?.error?.message || 'API HTTP ' + r.status);
    if (res.stop_reason === 'refusal') return [];
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text).bubbles || [];
  }

  // Returns bubbles as fractions (0..1) of the whole image.
  async function translateImage(img) {
    const apiKey = await store.get(KEY_API, '');
    if (!apiKey) throw new Error('חסר מפתח API');
    const bitmap = await loadImageBitmap(img);
    const { pieces, sentW, sentH } = slice(bitmap);
    const out = [];
    for (const piece of pieces) {
      const bubbles = await translatePiece(piece, apiKey);
      // Keep a bubble only in the piece that "owns" its center, so overlaps don't duplicate it.
      const top = piece.first ? 0 : CHUNK_OVERLAP / 2;
      const bottom = piece.last ? piece.h : piece.h - CHUNK_OVERLAP / 2;
      for (const b of bubbles) {
        const cy = b.y + b.h / 2;
        if (cy < top || cy >= bottom) continue;
        out.push({
          x: b.x / sentW,
          y: (piece.y + b.y) / sentH,
          w: b.w / sentW,
          h: b.h / sentH,
          t: b.translation,
        });
      }
    }
    return out;
  }

  // ---------- Overlays ----------
  const layers = new Map(); // img -> layer element

  function layerFor(img) {
    let layer = layers.get(img);
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'ct-layer';
      document.body.appendChild(layer);
      layers.set(img, layer);
      positionLayer(img, layer);
    }
    return layer;
  }

  function positionLayer(img, layer) {
    const r = img.getBoundingClientRect();
    if (!img.isConnected || r.width === 0) { layer.style.display = 'none'; return; }
    layer.style.display = '';
    layer.style.left = r.left + scrollX + 'px';
    layer.style.top = r.top + scrollY + 'px';
    layer.style.width = r.width + 'px';
    layer.style.height = r.height + 'px';
  }

  let rafPending = false;
  function repositionAll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      for (const [img, layer] of layers) {
        positionLayer(img, layer);
        fitAll(layer);
      }
    });
  }
  addEventListener('resize', repositionAll);
  addEventListener('scroll', repositionAll, { passive: true });
  const resizeObs = new ResizeObserver(repositionAll);
  new MutationObserver(repositionAll).observe(document.body, { childList: true, subtree: true });

  function setStatus(img, text) {
    const layer = layerFor(img);
    let s = layer.querySelector('.ct-status');
    if (!text) { s?.remove(); return; }
    if (!s) { s = document.createElement('div'); s.className = 'ct-status'; layer.appendChild(s); }
    s.textContent = text;
  }

  function fitText(el) {
    const boxH = el.clientHeight, boxW = el.clientWidth;
    if (!boxH || el.dataset.fitFor === boxW + 'x' + boxH) return;
    el.dataset.fitFor = boxW + 'x' + boxH;
    let size = Math.max(10, Math.min(28, boxH * 0.6));
    el.style.fontSize = size + 'px';
    while (size > 8 && (el.scrollHeight > boxH + 1 || el.scrollWidth > boxW + 1)) {
      size -= 1;
      el.style.fontSize = size + 'px';
    }
  }
  function fitAll(layer) { layer.querySelectorAll('.ct-bubble').forEach(fitText); }

  function drawBubbles(img, bubbles) {
    const layer = layerFor(img);
    layer.querySelectorAll('.ct-bubble').forEach((e) => e.remove());
    const PAD = 0.006; // grow each box a little so it covers the original lettering
    for (const b of bubbles) {
      const el = document.createElement('div');
      el.className = 'ct-bubble';
      el.style.left = (b.x - PAD) * 100 + '%';
      el.style.top = (b.y - PAD / 4) * 100 + '%';
      el.style.width = (b.w + PAD * 2) * 100 + '%';
      el.style.height = (b.h + PAD / 2) * 100 + '%';
      el.textContent = b.t;
      // Tap a bubble to peek at the original text.
      el.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); el.classList.toggle('ct-hidden'); });
      layer.appendChild(el);
    }
    resizeObs.observe(img);
    requestAnimationFrame(() => fitAll(layer));
  }

  // ---------- Queue ----------
  const queue = [];
  let seen = new WeakSet();
  let running = 0;

  function cacheKey(img) { return img.currentSrc || img.src; }

  function enqueue(img) {
    if (seen.has(img)) return;
    seen.add(img);
    const hit = cache[cacheKey(img)];
    if (hit) { hit.t = Date.now(); drawBubbles(img, hit.b); return; }
    setStatus(img, 'ממתין לתרגום…');
    queue.push(img);
    pump();
  }

  async function pump() {
    while (enabled && running < MAX_PARALLEL && queue.length) {
      const img = queue.shift();
      running++;
      setStatus(img, 'מתרגם…');
      translateImage(img)
        .then((bubbles) => {
          if (!enabled) return;
          cache[cacheKey(img)] = { t: Date.now(), b: bubbles };
          saveCache();
          setStatus(img, null);
          drawBubbles(img, bubbles);
        })
        .catch((err) => {
          console.warn('[comic-translator]', err);
          seen.delete(img); // allow a retry when it scrolls back into view
          setStatus(img, 'שגיאה: ' + err.message);
          if (/api.key|authentication|x-api-key/i.test(err.message)) {
            alert('מפתח ה-API לא עובד. אפשר להחליף אותו דרך כפתור ⚙');
          }
        })
        .finally(() => { running--; pump(); });
    }
  }

  // ---------- Watching images ----------
  function isComicImage(img) {
    const w = img.naturalWidth, h = img.naturalHeight;
    return img.complete && w >= MIN_IMG_WIDTH && h >= MIN_IMG_HEIGHT && img.getBoundingClientRect().width >= 150;
  }

  let io = null;
  let scanner = null;

  function startWatching() {
    if (io) return;
    // Start ~1.5 screens ahead so the translation is ready by the time you scroll to it.
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && isComicImage(e.target)) enqueue(e.target);
      }
    }, { rootMargin: '150% 0px 150% 0px' });
    const scan = () => {
      document.querySelectorAll('img').forEach((img) => {
        if (img.dataset.ctWatched) return;
        if (!img.complete) { img.addEventListener('load', scan, { once: true }); return; }
        img.dataset.ctWatched = '1';
        io.observe(img);
      });
    };
    scan();
    scanner = setInterval(scan, 1500); // catches lazy-loaded images
  }

  function stopAll() {
    io?.disconnect(); io = null;
    clearInterval(scanner);
    queue.length = 0;
    seen = new WeakSet();
    document.querySelectorAll('img[data-ct-watched]').forEach((i) => delete i.dataset.ctWatched);
    for (const layer of layers.values()) layer.remove();
    layers.clear();
  }

  if (enabled) startWatching();
})();
