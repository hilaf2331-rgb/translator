// ==UserScript==
// @name         Comic Translator (EN → HE)
// @namespace    https://github.com/hilaf2331-rgb/translator
// @version      1.3.1
// @updateURL    https://raw.githubusercontent.com/hilaf2331-rgb/translator/claude/chrome-extension-comics-hj43e8/comic-translator.user.js
// @downloadURL  https://raw.githubusercontent.com/hilaf2331-rgb/translator/claude/chrome-extension-comics-hj43e8/comic-translator.user.js
// @description  Translates speech bubbles in comics / webtoons into Hebrew with Gemini (or Claude), drawn right on top of the images. Works on any site.
// @match        *://*/*
// @run-at       document-idle
// @inject-into  content
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.addStyle
// @connect      generativelanguage.googleapis.com
// @connect      api.anthropic.com
// @connect      *
// ==/UserScript==

(async function () {
  'use strict';

  // ---------- Settings ----------
  const GEMINI_MODEL = 'gemini-3.8-flash'; // used with a Google key (starts with AQ.)
  const CLAUDE_MODEL = 'claude-opus-5';     // used with an Anthropic key (starts with sk-ant-)
  const SOURCE_LANG = 'English';
  const TARGET_LANG = 'Hebrew';
  const TRANSLATE_SFX = false;      // translate sound effects ("BOOM", "SLAM") too?
  const MIN_IMG_WIDTH = 250;        // ignore small images (icons, avatars, ads)
  const MIN_IMG_HEIGHT = 250;
  const MIN_SHOWN_WIDTH = 150;      // ...and images shown smaller than this on screen
  const MAX_EDGE = 1568;            // long edge of each piece sent to the model (px)
  const CHUNK_OVERLAP = 200;        // overlap between pieces of a tall webtoon strip (px, in sent scale)
  const MAX_PARALLEL = 2;           // images translated at the same time
  const CACHE_LIMIT = 400;          // translated images remembered across visits

  const isTop = window === window.top;
  // Inside an embedded reader (iframe) the on/off switch follows the main site's address.
  const host = isTop ? location.hostname : topHostname();
  const KEY_API = 'apiKey';
  const KEY_SITES = 'enabledSites';
  const KEY_CACHE = 'cache';

  function topHostname() {
    try { return window.top.location.hostname; } catch (_) { /* cross-origin */ }
    const ao = location.ancestorOrigins;
    const origin = (ao && ao.length && ao[ao.length - 1]) || document.referrer;
    try { return new URL(origin).hostname; } catch (_) { return location.hostname; }
  }

  // Tiny frames are ads / trackers, never readers.
  if (!isTop && (innerWidth < MIN_SHOWN_WIDTH || innerHeight < 200)) return;

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
  const CSS = `
    .ct-layer { position: absolute; pointer-events: none; z-index: 2147483000; overflow: hidden; margin: 0; padding: 0; }
    .ct-inner { position: absolute; }
    .ct-bubble {
      position: absolute; pointer-events: auto; box-sizing: border-box;
      display: flex; align-items: center; justify-content: center; text-align: center;
      background: #fff; color: #111; border-radius: 12px; padding: 2px 4px; margin: 0;
      direction: rtl; overflow: hidden; line-height: 1.15; font-weight: 600; letter-spacing: 0;
      font-family: -apple-system, "Segoe UI", Arial, sans-serif; text-transform: none;
      box-shadow: 0 0 0 1px rgba(0,0,0,.08); white-space: normal; word-break: break-word;
    }
    .ct-bubble.ct-hidden { opacity: 0; }
    .ct-status {
      position: absolute; pointer-events: none; top: 6px; left: 6px; max-width: 90%;
      background: rgba(0,0,0,.65); color: #fff; font: 12px -apple-system, Arial, sans-serif;
      padding: 3px 8px; border-radius: 10px; direction: rtl;
    }
    #ct-ui {
      position: fixed; bottom: 18px; left: 14px; z-index: 2147483647;
      display: flex; gap: 8px; align-items: center; direction: rtl;
      font: 14px -apple-system, Arial, sans-serif;
    }
    #ct-ui button {
      border: none; border-radius: 22px; height: 44px; min-width: 44px; padding: 0 14px; margin: 0;
      font: 600 15px -apple-system, Arial, sans-serif; color: #fff; background: #555;
      box-shadow: 0 2px 8px rgba(0,0,0,.3); opacity: .9;
    }
    #ct-ui button.ct-on { background: #7b3fe4; }
    #ct-ui button.ct-gear { background: #333; padding: 0; width: 44px; }
  `;
  // GM.addStyle gets past sites whose security policy blocks added <style> tags;
  // our own <style> is a backup that we put back if the site's code removes it.
  try { if (typeof GM.addStyle === 'function') await GM.addStyle(CSS); } catch (_) { /* backup below */ }
  const style = document.createElement('style');
  style.textContent = CSS;
  const mountStyle = () => (document.head || document.documentElement).appendChild(style);
  mountStyle();

  // ---------- Floating buttons (main page only) ----------
  const ui = document.createElement('div');
  const toggleBtn = document.createElement('button');
  if (isTop) {
    ui.id = 'ct-ui';
    const gearBtn = document.createElement('button');
    gearBtn.className = 'ct-gear';
    gearBtn.textContent = '⚙';
    ui.append(toggleBtn, gearBtn);
    // Inline basics so the buttons stay visible even if the site strips our stylesheet.
    ui.style.cssText = 'position:fixed;bottom:18px;left:14px;z-index:2147483647;display:flex;gap:8px;';
    document.documentElement.appendChild(ui);
    renderToggle();
    // Some sites re-render the page and wipe out elements they don't know; put ours back.
    setInterval(() => {
      if (!ui.isConnected && !ui.dataset.hiddenByUser) document.documentElement.appendChild(ui);
      if (!style.isConnected) mountStyle();
    }, 1000);

    toggleBtn.addEventListener('click', async () => {
      if (!enabled && !(await store.get(KEY_API, ''))) {
        if (!(await askForKey())) return;
      }
      enabledSites = JSON.parse(await store.get(KEY_SITES, '[]')).filter((h) => h !== host);
      if (!enabled) enabledSites.push(host);
      await store.set(KEY_SITES, JSON.stringify(enabledSites));
      setEnabled(!enabled);
    });

    gearBtn.addEventListener('click', async () => {
      const choice = prompt(
        'הגדרות:\n1 – החלפת מפתח API\n2 – ניקוי תרגומים שמורים\n3 – הסתרת הכפתורים עד רענון הדף',
        '1'
      );
      if (choice === '1') askForKey();
      else if (choice === '2') { cache = {}; saveCache(); alert('נוקה.'); }
      else if (choice === '3') { ui.dataset.hiddenByUser = '1'; ui.remove(); }
    });
  } else {
    // Frames have no buttons: follow the switch pressed on the main page.
    setInterval(async () => {
      const on = JSON.parse(await store.get(KEY_SITES, '[]')).includes(host);
      if (on !== enabled) setEnabled(on);
    }, 2000);
  }

  function renderToggle() {
    toggleBtn.textContent = enabled ? 'תרגום: פועל' : 'תרגם';
    toggleBtn.classList.toggle('ct-on', enabled);
  }

  function setEnabled(on) {
    enabled = on;
    if (isTop) renderToggle();
    if (enabled) startWatching();
    else stopAll();
  }

  async function askForKey() {
    const key = prompt('הדביקי כאן את מפתח ה-API של Gemini מ-Google AI Studio (מתחיל ב-AQ.):', '');
    if (!key || !/^(AQ\.|AIza|sk-ant-)/.test(key.trim())) {
      if (key !== null) alert('המפתח לא נראה תקין. מפתח של Gemini מתחיל ב-AQ.');
      return false;
    }
    await store.set(KEY_API, key.trim());
    return true;
  }

  // ---------- Comic elements: <img>, <canvas>, or a CSS background image ----------
  const bgInfo = new WeakMap(); // element -> { url, w, h } once its background image has loaded

  function kindOf(el) {
    if (el instanceof HTMLImageElement) return 'img';
    if (el instanceof HTMLCanvasElement) return 'canvas';
    return 'bg';
  }

  function naturalSize(el) {
    switch (kindOf(el)) {
      case 'img': return el.complete ? { w: el.naturalWidth, h: el.naturalHeight } : { w: 0, h: 0 };
      case 'canvas': return { w: el.width, h: el.height };
      default: {
        const info = bgInfo.get(el);
        return info && info.url === bgUrl(el) ? { w: info.w, h: info.h } : { w: 0, h: 0 };
      }
    }
  }

  function bgUrl(el) {
    const m = /url\(["']?([^"')]+)["']?\)/.exec(getComputedStyle(el).backgroundImage || '');
    return m ? new URL(m[1], location.href).href : null;
  }

  function isComic(el) {
    if (!el.isConnected) return false;
    const { w, h } = naturalSize(el);
    return w >= MIN_IMG_WIDTH && h >= MIN_IMG_HEIGHT && el.getBoundingClientRect().width >= MIN_SHOWN_WIDTH;
  }

  // A canvas has no address, so identify its current picture by a tiny thumbnail.
  function canvasFingerprint(el) {
    try {
      const c = document.createElement('canvas');
      c.width = 12; c.height = 12;
      const g = c.getContext('2d');
      g.drawImage(el, 0, 0, 12, 12);
      const px = g.getImageData(0, 0, 12, 12).data;
      let hash = 0;
      for (let i = 0; i < px.length; i += 4) hash = (hash * 31 + (px[i] >> 3) * 7 + (px[i + 1] >> 3) * 3 + (px[i + 2] >> 3)) | 0;
      return `canvas:${location.host}:${el.width}x${el.height}:${hash}`;
    } catch (_) {
      return `canvas-locked:${el.width}x${el.height}`;
    }
  }

  function keyOf(el) {
    switch (kindOf(el)) {
      case 'img': return el.currentSrc || el.src;
      case 'canvas': return canvasFingerprint(el);
      default: return bgUrl(el);
    }
  }

  // Where the picture is actually drawn inside the element (object-fit / background-size aware),
  // relative to the element's top-left corner, in CSS pixels.
  function contentRect(el, rect) {
    const cs = getComputedStyle(el);
    const bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;
    const pl = parseFloat(cs.paddingLeft) || 0, pt = parseFloat(cs.paddingTop) || 0;
    const boxX = bl + pl, boxY = bt + pt;
    const boxW = rect.width - boxX - (parseFloat(cs.borderRightWidth) || 0) - (parseFloat(cs.paddingRight) || 0);
    const boxH = rect.height - boxY - (parseFloat(cs.borderBottomWidth) || 0) - (parseFloat(cs.paddingBottom) || 0);
    const { w: nw, h: nh } = naturalSize(el);
    if (!nw || !nh) return { x: boxX, y: boxY, w: boxW, h: boxH };

    let fit, pos;
    if (kindOf(el) === 'bg') {
      const [sx, sy = 'auto'] = cs.backgroundSize.split(',')[0].trim().split(/\s+/);
      fit = sx === 'contain' || sx === 'cover' ? sx
        : sx === '100%' && sy === '100%' ? 'fill'
        : sx === '100%' ? 'width'
        : sy === '100%' ? 'height'
        : 'none';
      pos = cs.backgroundPosition.split(',')[0];
    } else {
      fit = cs.objectFit || 'fill';
      pos = cs.objectPosition || '50% 50%';
      if (fit === 'scale-down') fit = nw <= boxW && nh <= boxH ? 'none' : 'contain';
    }

    let w, h;
    switch (fit) {
      case 'contain': { const s = Math.min(boxW / nw, boxH / nh); w = nw * s; h = nh * s; break; }
      case 'cover': { const s = Math.max(boxW / nw, boxH / nh); w = nw * s; h = nh * s; break; }
      case 'width': w = boxW; h = nh * boxW / nw; break;
      case 'height': h = boxH; w = nw * boxH / nh; break;
      case 'none': w = nw; h = nh; break;
      default: w = boxW; h = boxH; // fill
    }
    const [px, py] = parsePosition(pos);
    return { x: boxX + (boxW - w) * px, y: boxY + (boxH - h) * py, w, h };
  }

  function parsePosition(pos) {
    const words = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
    const parts = pos.trim().split(/\s+/).slice(0, 2);
    const vals = parts.map((p) => (p in words ? words[p] : p.endsWith('%') ? parseFloat(p) / 100 : 0));
    if (parts.length === 1) vals.push(0.5);
    if (parts[0] === 'top' || parts[0] === 'bottom') vals.reverse();
    return vals;
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

  function isReadable(source) {
    try {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      const g = c.getContext('2d');
      g.drawImage(source, 0, 0, 1, 1);
      g.getImageData(0, 0, 1, 1); // throws if the picture is locked (cross-origin)
      return true;
    } catch (_) {
      return false;
    }
  }

  async function bitmapFromUrl(src) {
    // 1) Page fetch: works for same-site images, blob: URLs, and CDNs that allow it.
    try {
      const r = await fetch(src);
      if (r.ok) return await createImageBitmap(await r.blob());
    } catch (_) { /* fall through */ }
    // 2) Userscript request: not bound by the browser's cross-site rules.
    //    Many comic CDNs only serve images when they come "from" the reader page.
    const r = await gmRequest({
      method: 'GET', url: src, responseType: 'blob',
      headers: { Referer: location.href },
    });
    if (r.status < 200 || r.status >= 300) throw new Error('image HTTP ' + r.status);
    let blob = r.response;
    if (!(blob instanceof Blob)) blob = new Blob([blob]);
    return await createImageBitmap(blob);
  }

  async function loadBitmap(el) {
    switch (kindOf(el)) {
      case 'img':
        if (isReadable(el)) return await createImageBitmap(el);
        return await bitmapFromUrl(el.currentSrc || el.src);
      case 'canvas':
        if (!isReadable(el)) throw new Error('האתר נועל את התמונה, אי אפשר לקרוא אותה');
        return await createImageBitmap(el);
      default:
        return await bitmapFromUrl(bgUrl(el));
    }
  }

  // Cut a (possibly very tall) image into pieces the model can read clearly.
  function slice(bitmap) {
    const W = bitmap.width, H = bitmap.height;
    const scale = Math.min(1, MAX_EDGE / W);
    const sw = Math.round(W * scale);
    const totalH = Math.round(H * scale);
    const pieceH = Math.min(MAX_EDGE, totalH);
    const pieces = [];
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

  // Which AI is used is decided by the key you paste: Google keys start with "AQ." (older ones "AIza"),
  // Anthropic keys with "sk-ant-". Google's new AQ. keys only work in the x-goog-api-key header.
  const providerOf = (key) => (key.startsWith('sk-ant-') ? 'claude' : 'gemini');

  function buildPrompt(piece, coords) {
    return (
      `This is a ${piece.w}x${piece.h} px piece of a comic page` +
      (piece.first && piece.last ? '' : ' (a vertical webtoon strip, cut into pieces)') +
      `. Find every speech bubble, thought bubble and narration/caption box that contains ${SOURCE_LANG} text` +
      (TRANSLATE_SFX ? ', plus sound effects' : '; skip sound effects and background signs that are not important to the story') +
      `.\nFor each one return ${coords} of the text area inside the bubble, and a natural, fluent ${TARGET_LANG} ` +
      `translation that fits the character's tone (casual speech stays casual). Use proper gender forms in ` +
      `${TARGET_LANG} based on who is speaking and to whom, when it is visible in the art. ` +
      `Skip bubbles cut off at the very top or bottom edge of the image. ` +
      `If the image is not a comic or has no such text, return an empty list.`
    );
  }

  async function callApi(url, headers, body) {
    const r = await gmRequest({
      method: 'POST', url,
      headers: { 'content-type': 'application/json', ...headers },
      data: JSON.stringify(body),
      timeout: 120000,
    });
    let res;
    try { res = JSON.parse(r.responseText); } catch (_) { res = null; }
    if (r.status !== 200) throw new Error(res?.error?.message || 'API HTTP ' + r.status);
    return res;
  }

  // ----- Gemini (default) -----
  // Gemini reports boxes as [y_min, x_min, y_max, x_max] scaled to 0..1000, its native format.
  const GEMINI_SCHEMA = {
    type: 'OBJECT',
    required: ['bubbles'],
    properties: {
      bubbles: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          required: ['box_2d', 'translation'],
          properties: {
            box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
            translation: { type: 'STRING' },
          },
        },
      },
    },
  };

  async function geminiPiece(piece, apiKey) {
    const res = await callApi(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      { 'x-goog-api-key': apiKey },
      {
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: piece.data } },
            { text: buildPrompt(piece, 'box_2d as [y_min, x_min, y_max, x_max] normalized to 0-1000') },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_SCHEMA,
          thinkingConfig: { thinkingLevel: 'low' },
        },
      }
    );
    const cand = res.candidates?.[0];
    if (!cand?.content?.parts) return []; // blocked or empty
    const text = cand.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
    return (JSON.parse(text).bubbles || [])
      .filter((b) => Array.isArray(b.box_2d) && b.box_2d.length === 4)
      .map(({ box_2d: [y0, x0, y1, x1], translation }) => ({
        x: (x0 / 1000) * piece.w,
        y: (y0 / 1000) * piece.h,
        w: ((x1 - x0) / 1000) * piece.w,
        h: ((y1 - y0) / 1000) * piece.h,
        translation,
      }));
  }

  // ----- Claude (used when an Anthropic key is pasted) -----
  const CLAUDE_SCHEMA = {
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

  async function claudePiece(piece, apiKey) {
    const res = await callApi(
      'https://api.anthropic.com/v1/messages',
      {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      {
        model: CLAUDE_MODEL,
        max_tokens: 8000,
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: CLAUDE_SCHEMA },
        },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: piece.data } },
            { type: 'text', text: buildPrompt(piece, 'the box in pixel coordinates of this image (x, y = top-left corner, w, h = size)') },
          ],
        }],
      }
    );
    if (res.stop_reason === 'refusal') return [];
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text).bubbles || [];
  }

  // Bubbles in pixel coordinates of the piece.
  function translatePiece(piece, apiKey) {
    return providerOf(apiKey) === 'claude' ? claudePiece(piece, apiKey) : geminiPiece(piece, apiKey);
  }

  // Returns bubbles as fractions (0..1) of the whole picture.
  async function translateElement(el) {
    const apiKey = await store.get(KEY_API, '');
    if (!apiKey) throw new Error('חסר מפתח API');
    const bitmap = await loadBitmap(el);
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
  // Layers hang off <html> (not <body>) so a positioned/transformed body can't shift them.
  const layers = new Map(); // element -> { layer, inner }

  function layerFor(el) {
    let entry = layers.get(el);
    if (!entry) {
      const layer = document.createElement('div');
      layer.className = 'ct-layer';
      const inner = document.createElement('div');
      inner.className = 'ct-inner';
      layer.appendChild(inner);
      document.documentElement.appendChild(layer);
      entry = { layer, inner };
      layers.set(el, entry);
      positionLayer(el, entry);
    }
    return entry;
  }

  function removeLayer(el) {
    layers.get(el)?.layer.remove();
    layers.delete(el);
  }

  function positionLayer(el, { layer, inner }) {
    if (!el.isConnected) { layer.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) { layer.style.display = 'none'; return; }
    // <html> is almost always unpositioned, so the layer is placed in page coordinates.
    let ox = -scrollX, oy = -scrollY;
    const html = document.documentElement;
    if (getComputedStyle(html).position !== 'static') {
      const d = html.getBoundingClientRect();
      ox = d.left + html.clientLeft; oy = d.top + html.clientTop;
    }
    layer.style.display = '';
    layer.style.left = r.left - ox + 'px';
    layer.style.top = r.top - oy + 'px';
    layer.style.width = r.width + 'px';
    layer.style.height = r.height + 'px';
    const c = contentRect(el, r);
    inner.style.left = c.x + 'px';
    inner.style.top = c.y + 'px';
    inner.style.width = c.w + 'px';
    inner.style.height = c.h + 'px';
  }

  let rafPending = false;
  function repositionAll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      for (const [el, entry] of layers) {
        if (!el.isConnected) { removeLayer(el); continue; }
        positionLayer(el, entry);
        entry.inner.querySelectorAll('.ct-bubble').forEach(fitText);
      }
    });
  }
  addEventListener('resize', repositionAll);
  // Capture phase also catches scrolling inside the reader's own scroll box.
  document.addEventListener('scroll', repositionAll, { capture: true, passive: true });
  const resizeObs = new ResizeObserver(repositionAll);
  const isOurs = (n) => n instanceof Element && !!n.closest('.ct-layer, #ct-ui');
  new MutationObserver((records) => {
    if (records.some((r) => !isOurs(r.target))) repositionAll();
  }).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'],
  });

  function setStatus(el, text) {
    const { layer } = layerFor(el);
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

  function drawBubbles(el, bubbles) {
    const { inner } = layerFor(el);
    inner.querySelectorAll('.ct-bubble').forEach((e) => e.remove());
    const PAD = 0.006; // grow each box a little so it covers the original lettering
    for (const b of bubbles) {
      const div = document.createElement('div');
      div.className = 'ct-bubble';
      div.style.left = (b.x - PAD) * 100 + '%';
      div.style.top = (b.y - PAD / 4) * 100 + '%';
      div.style.width = (b.w + PAD * 2) * 100 + '%';
      div.style.height = (b.h + PAD / 2) * 100 + '%';
      div.textContent = b.t;
      // Tap a bubble to peek at the original text.
      div.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); div.classList.toggle('ct-hidden'); });
      inner.appendChild(div);
    }
    resizeObs.observe(el);
    repositionAll();
  }

  // ---------- Queue ----------
  // state: element -> { key, error } for the picture currently shown in it
  let state = new WeakMap();
  const queue = [];
  let running = 0;

  // Looks at an element and translates it if it now shows a new comic picture.
  // Readers that flip pages by swapping the picture in the same element are handled here.
  function check(el, retryErrors) {
    if (!enabled || !isComic(el)) return;
    const key = keyOf(el);
    if (!key || key.startsWith('canvas-locked')) {
      if (key && !state.has(el)) { state.set(el, { key, error: true }); setStatus(el, 'שגיאה: האתר נועל את התמונה'); }
      return;
    }
    const cur = state.get(el);
    if (cur && cur.key === key && !(cur.error && retryErrors)) return;
    state.set(el, { key });
    const hit = cache[key];
    if (hit) {
      hit.t = Date.now();
      setStatus(el, null);
      drawBubbles(el, hit.b);
      return;
    }
    if (layers.has(el)) drawBubbles(el, []); // clear the previous page's bubbles
    setStatus(el, 'ממתין לתרגום…');
    if (!queue.some((q) => q.el === el)) queue.push({ el, key });
    else queue.find((q) => q.el === el).key = key;
    pump();
  }

  async function pump() {
    while (enabled && running < MAX_PARALLEL && queue.length) {
      const { el, key } = queue.shift();
      if (state.get(el)?.key !== key) continue; // page changed while waiting
      running++;
      setStatus(el, 'מתרגם…');
      translateElement(el)
        .then((bubbles) => {
          cache[key] = { t: Date.now(), b: bubbles };
          saveCache();
          if (!enabled || state.get(el)?.key !== key) return;
          setStatus(el, null);
          drawBubbles(el, bubbles);
        })
        .catch((err) => {
          console.warn('[comic-translator]', err);
          if (state.get(el)?.key === key) state.set(el, { key, error: true });
          if (enabled) setStatus(el, 'שגיאה: ' + err.message);
          if (/api.key|authentication|permission|x-api-key/i.test(err.message)) {
            alert('מפתח ה-API לא עובד. אפשר להחליף אותו דרך כפתור ⚙');
          }
        })
        .finally(() => { running--; pump(); });
    }
  }

  // ---------- Watching the page ----------
  let io = null;
  let scanner = null;
  const nearView = new Set();       // watched elements within ~1.5 screens of the viewport
  let watched = new WeakSet();
  let bgChecked = new WeakSet();

  // Finds elements in the page and in open shadow roots (some readers hide their images there).
  function* deepQuery(root, selector) {
    yield* root.querySelectorAll(selector);
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) yield* deepQuery(host.shadowRoot, selector);
    }
  }

  function watch(el) {
    if (watched.has(el)) return;
    watched.add(el);
    io.observe(el);
  }

  function loadBackground(el) {
    const url = bgUrl(el);
    if (!url || bgInfo.get(el)?.url === url) return;
    const probe = new Image();
    probe.onload = () => {
      bgInfo.set(el, { url, w: probe.naturalWidth, h: probe.naturalHeight });
      if (probe.naturalWidth >= MIN_IMG_WIDTH && probe.naturalHeight >= MIN_IMG_HEIGHT) {
        watch(el);
        if (nearView.has(el)) check(el);
      }
    };
    probe.src = url;
  }

  function scan() {
    for (const el of deepQuery(document, 'img, canvas')) watch(el);
    // Background-image pictures: only look at big elements, once each (unless their style changes).
    for (const el of deepQuery(document, 'div, span, a, figure, section, li')) {
      if (bgChecked.has(el) && !nearView.has(el)) continue;
      bgChecked.add(el);
      if (el.offsetWidth < MIN_SHOWN_WIDTH || el.offsetHeight < 150) continue;
      loadBackground(el);
    }
    // Pictures already on screen may have changed (lazy loading finished, page flipped, canvas redrawn).
    for (const el of nearView) {
      if (kindOf(el) === 'bg') loadBackground(el);
      check(el);
    }
  }

  // Any picture finishing loading → re-check it right away (load doesn't bubble, so listen in capture).
  function onLoad(e) {
    const el = e.target;
    if (el instanceof HTMLImageElement) {
      watch(el);
      if (nearView.has(el)) check(el);
    }
  }

  function startWatching() {
    if (io) return;
    // Start ~1.5 screens ahead so the translation is ready by the time you scroll to it.
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { nearView.add(e.target); check(e.target, true); }
        else nearView.delete(e.target);
      }
    }, { rootMargin: '150% 0px 150% 0px' });
    document.addEventListener('load', onLoad, true);
    scan();
    scanner = setInterval(scan, 1500);
  }

  function stopAll() {
    io?.disconnect(); io = null;
    clearInterval(scanner);
    document.removeEventListener('load', onLoad, true);
    queue.length = 0;
    nearView.clear();
    state = new WeakMap();
    for (const el of [...layers.keys()]) removeLayer(el);
    watched = new WeakSet(); // they belonged to the old observer
    bgChecked = new WeakSet();
  }

  if (enabled) startWatching();
})();
