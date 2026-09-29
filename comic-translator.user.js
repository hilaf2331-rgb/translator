// ==UserScript==
// @name         Comic Translator (EN → HE)
// @namespace    https://github.com/hilaf2331-rgb/translator
// @version      1.23.0
// @updateURL    https://raw.githubusercontent.com/hilaf2331-rgb/translator/main/comic-translator.user.js
// @downloadURL  https://raw.githubusercontent.com/hilaf2331-rgb/translator/main/comic-translator.user.js
// @description  Translates speech bubbles in comics / webtoons into Hebrew with Gemini (or Claude), drawn right on top of the images. Works on any site.
// @match        *://*/*
// @run-at       document-idle
// @inject-into  content
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.addStyle
// @connect      generativelanguage.googleapis.com
// @connect      aiplatform.googleapis.com
// @connect      api.anthropic.com
// @connect      workers.dev
// @connect      fonts.googleapis.com
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @connect      fonts.gstatic.com
// @connect      *
// ==/UserScript==

(async function () {
  'use strict';

  // ---------- Settings ----------
  const GEMINI_MODEL = 'gemini-3.8-flash'; // used with a Google key (starts with AQ.)
  const CLAUDE_MODEL = 'claude-opus-5';     // used with an Anthropic key (starts with sk-ant-)
  // Language of the comic (⚙ → 8). "auto" lets the model recognise it by itself.
  const SOURCES = [
    { lang: null, label: 'אוטומטי – כל שפה' },
    { lang: 'English', label: 'אנגלית' },
    { lang: 'Korean', label: 'קוריאנית' },
    { lang: 'Japanese', label: 'יפנית' },
    { lang: 'Chinese', label: 'סינית' },
  ];
  const TARGET_LANG = 'Hebrew';
  const TRANSLATE_SFX = false;      // translate sound effects ("BOOM", "SLAM") too?
  const MIN_IMG_WIDTH = 250;        // ignore small images (icons, avatars, ads)
  const MIN_IMG_HEIGHT = 250;
  const MIN_SHOWN_WIDTH = 150;      // ...and images shown smaller than this on screen
  const MAX_EDGE = 1568;            // long edge of each piece sent to the model (px)
  const CHUNK_OVERLAP = 0.35;       // overlap between pieces of a tall webtoon strip (share of a piece's height),
                                    // so every bubble is whole in at least one piece
  const MAX_PARALLEL = 10;           // images translated at the same time
  const LOOK_AHEAD = '800%';        // start translating this far (in screens) before you get there
  const CACHE_LIMIT = 400;          // translated images remembered across visits

  const isTop = window === window.top;
  // Inside an embedded reader (iframe) the on/off switch follows the main site's address.
  const host = isTop ? location.hostname : topHostname();
  const KEY_API = 'apiKey';
  const KEY_SITES = 'enabledSites';
  const KEY_CACHE = 'cache';
  const KEY_PROXY = 'proxyUrl'; // optional image helper (see proxy-worker.js)

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
  const KEY_SOFTEN = 'softenSwears';
  let softenSwears = !!(await store.get(KEY_SOFTEN, false)); // ⚙ → 6
  // Economy mode (⚙ → 7): less "thinking" and smaller pictures, roughly half the cost.
  const KEY_ECONOMY = 'economy';
  let economy = !!(await store.get(KEY_ECONOMY, false));
  const KEY_SOURCE = 'sourceLang';
  let source = SOURCES[Number(await store.get(KEY_SOURCE, 0))] || SOURCES[0];
  // The reader's notes about the story on this site, e.g. who is male/female (⚙ → 9).
  const KEY_NOTES = `notes:${host}`;
  let storyNotes = String(await store.get(KEY_NOTES, ''));
  // Sexual-content filter: Google's default, or "relaxed" = block only clearly explicit (⚙ → 10).
  const KEY_SEXFILTER = 'relaxedSexFilter';
  let relaxedSexFilter = !!(await store.get(KEY_SEXFILTER, false));
  // How names were spelled in Hebrew on this site, so a character keeps one spelling (⚙ → 11).
  const KEY_NAMES = `names:${host}`;
  let glossary = JSON.parse(await store.get(KEY_NAMES, '{}')); // lower-case original -> { o, h }
  const saveGlossary = () => store.set(KEY_NAMES, JSON.stringify(glossary));
  function learnNames(list) {
    let changed = false;
    for (const n of list || []) {
      const o = String(n?.original || '').trim(), h = String(n?.hebrew || '').trim();
      const k = o.toLowerCase();
      if (!o || !h || o.length > 40 || glossary[k]) continue; // the first spelling wins
      glossary[k] = { o, h };
      changed = true;
    }
    const keys = Object.keys(glossary);
    if (keys.length > 150) for (const k of keys.slice(0, keys.length - 150)) delete glossary[k];
    if (changed) saveGlossary();
  }
  const ECONOMY_EDGE = 1024; // long edge of each piece in economy mode (normal: MAX_EDGE)
  // Settings a model turned out not to accept, remembered so we stop sending them.
  const KEY_UNSUPPORTED = 'unsupportedOptions';
  const unsupported = new Set(JSON.parse(await store.get(KEY_UNSUPPORTED, '[]')));

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
    .ct-layer { position: absolute; pointer-events: none; z-index: 10; overflow: hidden; margin: 0; padding: 0; }
    .ct-inner { position: absolute; }
    .ct-bubble {
      position: absolute; pointer-events: auto; box-sizing: border-box;
      display: flex; align-items: center; justify-content: center; text-align: center;
      background: #fff; color: #111; border-radius: 10px; padding: 0 2px; margin: 0;
      direction: rtl; overflow: visible; line-height: 1.22; font-weight: normal; letter-spacing: 0;
      font-family: "CT Comic", "Varela Round", -apple-system, Arial, sans-serif;
      text-transform: none; white-space: normal; word-break: break-word; border: 0;
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
    #ct-ui button.ct-update { background: #e0457b; }
  `;
  // GM.addStyle gets past sites whose security policy blocks added <style> tags;
  // our own <style> is a backup that we put back if the site's code removes it.
  try { if (typeof GM.addStyle === 'function') await GM.addStyle(CSS); } catch (_) { /* backup below */ }
  const style = document.createElement('style');
  style.textContent = CSS;
  const mountStyle = () => (document.head || document.documentElement).appendChild(style);
  mountStyle();

  // ---------- Comic lettering font ----------
  // Hebrew fonts from Google Fonts, only the letters we need (10–25KB), loaded from bytes so it
  // works even on sites that block outside fonts. Chosen in ⚙ → 5.
  const FONTS = [
    { name: 'Gveret Levin', weight: 400, label: 'גברת לוין – כתב יד של קומיקס' },
    { name: 'Fredoka', weight: 600, label: 'פרדוקה – עגול ומודגש' },
    { name: 'Varela Round', weight: 400, label: 'ורלה – עגול ודק' },
    { name: 'Secular One', weight: 400, label: 'סקולר – מודגש וקלאסי' },
    { name: 'Rubik', weight: 600, label: 'רוביק – נקי ומודגש' },
    { name: 'Karantina', weight: 700, label: 'קרנטינה – צר, לבועות קטנות' },
  ];
  const KEY_FONT = 'fontChoice';
  const FONT_FACE = 'CT Comic';
  const FONT_CHARS = Array.from({ length: 0x5eb - 0x5d0 }, (_, i) => String.fromCharCode(0x5d0 + i)).join('') +
    '0123456789.,!?…-־\'"״׳*()[]:;~♡♥ ';

  const toB64 = (buf) => {
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const fromB64 = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)).buffer;

  let fontFace = null;
  async function loadComicFont() {
    try {
      const font = FONTS[Number(await store.get(KEY_FONT, 0))] || FONTS[0];
      const cacheKey = `font:${font.name}:${font.weight}`;
      let b64 = await store.get(cacheKey, '');
      if (!b64) {
        const family = encodeURIComponent(font.name).replace(/%20/g, '+');
        const css = await gmRequest({
          method: 'GET',
          url: `https://fonts.googleapis.com/css2?family=${family}:wght@${font.weight}&text=${encodeURIComponent(FONT_CHARS)}`,
        });
        const url = /url\((https:[^)]+)\)/.exec(css.responseText || '')?.[1];
        if (!url) return;
        const res = await gmRequest({ method: 'GET', url, responseType: 'arraybuffer' });
        let buf = res.response;
        if (buf instanceof Blob) buf = await buf.arrayBuffer();
        if (!buf || res.status !== 200) return;
        b64 = toB64(buf);
        store.set(cacheKey, b64);
      }
      const face = new FontFace(FONT_FACE, fromB64(b64), { weight: '100 900' });
      await face.load();
      if (fontFace) document.fonts.delete(fontFace);
      document.fonts.add(face);
      fontFace = face;
      // Re-fit bubbles on screen now that the real letter shapes are known.
      document.querySelectorAll('.ct-bubble').forEach((el) => delete el.dataset.fitFor);
      repositionAll();
    } catch (err) {
      console.warn('[comic-translator] font', err); // a rounded system font is used instead
    }
  }

  async function askForFont() {
    const cur = Number(await store.get(KEY_FONT, 0)) || 0;
    const list = FONTS.map((f, i) => `${i + 1} – ${f.label}${i === cur ? ' ✓' : ''}`).join('\n');
    const choice = prompt(`איזה פונט לתרגום?\n${list}`, String(cur + 1));
    const i = Number(choice) - 1;
    if (!(i >= 0 && i < FONTS.length)) return;
    await store.set(KEY_FONT, i);
    loadComicFont();
  }

  // ---------- Updates ----------
  // GitHub's file server caches the script for a few minutes, so Userscripts' own update check
  // can miss a new version. Ask GitHub directly (no cache) which commit is newest, read the
  // version from that exact commit, and if it's newer show an "update" button that opens it,
  // so installing is just 🧩 → Userscripts → Install.
  const REPO = 'hilaf2331-rgb/translator';
  const KEY_UPDATE_CHECK = 'lastUpdateCheck';
  const newerThan = (a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    }
    return false;
  };

  async function checkForUpdate(force) {
    try {
      const current = (typeof GM.info === 'object' && GM.info?.script?.version) || '';
      if (!current) return false;
      const last = Number(await store.get(KEY_UPDATE_CHECK, 0));
      if (!force && Date.now() - last < 10 * 60 * 1000) return false; // at most every 10 minutes
      store.set(KEY_UPDATE_CHECK, Date.now());
      const head = await gmRequest({
        method: 'GET',
        url: `https://api.github.com/repos/${REPO}/commits/main`,
        headers: { Accept: 'application/vnd.github.sha' },
      });
      const sha = (head.responseText || '').trim();
      if (head.status !== 200 || !/^[0-9a-f]{40}$/.test(sha)) return false;
      const url = `https://raw.githubusercontent.com/${REPO}/${sha}/comic-translator.user.js`;
      const file = await gmRequest({ method: 'GET', url });
      const latest = /@version\s+([\d.]+)/.exec(file.responseText || '')?.[1];
      if (!latest || !newerThan(latest, current)) return false;
      showUpdateButton(latest, url);
      return true;
    } catch (err) {
      console.warn('[comic-translator] update check', err);
      return false;
    }
  }

  function showUpdateButton(latest, url) {
    if (!isTop || ui.querySelector('.ct-update')) return;
    const btn = document.createElement('button');
    btn.className = 'ct-update';
    btn.textContent = `עדכון ${latest} ⬇`;
    btn.addEventListener('click', () => {
      alert('נפתח דף עם הגרסה החדשה. שם לוחצים על 🧩 ← Userscripts ← Install, ואז חוזרים לכאן ומרעננים.');
      window.open(url, '_blank');
    });
    ui.appendChild(btn);
  }

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
    makeDraggable(ui);
    checkForUpdate(false);
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
      const version = (typeof GM.info === 'object' && GM.info?.script?.version) || '?';
      const choice = prompt(
        `הגדרות (גרסה ${version}):\n1 – החלפת מפתח API\n2 – ניקוי תרגומים שמורים\n3 – הסתרת הכפתורים עד רענון הדף\n4 – כתובת שרת עזר לתמונות\n5 – בחירת פונט\n6 – קללות: ${softenSwears ? 'מעודנות' : 'כמו במקור'} (החלפה)\n7 – מצב חסכוני: ${economy ? 'פועל' : 'כבוי'} (החלפה)\n8 – שפת המקור: ${source.label}\n9 – הערות על הסיפור (מי בן ומי בת)${storyNotes ? ' ✓' : ''}\n10 – מסנן תוכן מיני: ${relaxedSexFilter ? 'מקל' : 'רגיל'} (החלפה)\n11 – שמות הדמויות (${Object.keys(glossary).length})\n12 – בדיקת עדכונים עכשיו`,
        '1'
      );
      if (choice === '1') askForKey();
      else if (choice === '2') { cache = {}; saveCache(); exhausted = {}; store.set(KEY_EXHAUSTED, '{}'); alert('נוקה.'); }
      else if (choice === '3') { ui.dataset.hiddenByUser = '1'; ui.remove(); }
      else if (choice === '4') askForProxy();
      else if (choice === '5') askForFont();
      else if (choice === '9') {
        const txt = prompt(
          'הערות על הסיפור שנשלחות עם כל תמונה באתר הזה, בעברית או באנגלית.\n' +
          'למשל: "שתי הדמויות הראשיות הן גברים" או "ג\'ין-וו הוא בן, מין-ג\'ה היא בת".\nכדי למחוק, מוחקים הכל ולוחצים אישור:',
          storyNotes
        );
        if (txt !== null) {
          storyNotes = txt.trim().slice(0, 500);
          await store.set(KEY_NOTES, storyNotes);
          alert(storyNotes ? 'נשמר ✓ ההערות יחולו על תמונות חדשות.' : 'ההערות נמחקו.');
        }
      }
      else if (choice === '12') {
        const found = await checkForUpdate(true);
        if (!found) alert(`יש לך את הגרסה הכי חדשה (${version}) ✓`);
      }
      else if (choice === '11') {
        const lines = Object.values(glossary).map((g) => `${g.o} = ${g.h}`).join('\n');
        const txt = prompt(
          'איך השמות נכתבים בעברית באתר הזה. שורה לכל שם, בצורה: Tae = טאי\n' +
          'אפשר לתקן כתיב, להוסיף או למחוק שורות. כדי למחוק הכל, מוחקים את כל הטקסט:',
          lines
        );
        if (txt !== null) {
          glossary = {};
          for (const line of txt.split(/\n|;/)) {
            const [o, ...rest] = line.split('=');
            const h = rest.join('=').trim();
            if (o && o.trim() && h) glossary[o.trim().toLowerCase()] = { o: o.trim(), h };
          }
          saveGlossary();
          alert(`נשמר ✓ ${Object.keys(glossary).length} שמות. חל על תמונות חדשות (לתרגם מחדש: ⚙ ← 2).`);
        }
      }
      else if (choice === '10') {
        relaxedSexFilter = !relaxedSexFilter;
        await store.set(KEY_SEXFILTER, relaxedSexFilter);
        alert(relaxedSexFilter
          ? 'מסנן מקל: נחסם רק תוכן מיני מפורש בוודאות גבוהה. תמונות שנחסמו קודם ינסו שוב כשתגללי אליהן.'
          : 'מסנן רגיל (ברירת המחדל של Google).');
        for (const el of nearView) {
          const status = layers.get(el)?.layer.querySelector('.ct-status')?.textContent || '';
          if (status.includes('נחסם')) state.delete(el); // blocked pages weren't cached: try again
        }
        nearView.forEach((el) => check(el));
      }
      else if (choice === '8') {
        const list = SOURCES.map((x, i) => `${i + 1} – ${x.label}${x === source ? ' ✓' : ''}`).join('\n');
        const i = Number(prompt(`מאיזו שפה לתרגם?\n${list}`, String(SOURCES.indexOf(source) + 1))) - 1;
        if (SOURCES[i]) { source = SOURCES[i]; await store.set(KEY_SOURCE, i); alert(`נשמר ✓ שפת המקור: ${source.label}`); }
      }
      else if (choice === '7') {
        economy = !economy;
        await store.set(KEY_ECONOMY, economy);
        alert(economy
          ? 'מצב חסכוני פועל 💰 פחות "חשיבה" ותמונות קטנות יותר, בערך חצי מחיר. אם התרגום נהיה פחות טוב, אפשר לכבות כאן.'
          : 'מצב חסכוני כבוי: חזרה לאיכות המלאה.');
      }
      else if (choice === '6') {
        softenSwears = !softenSwears;
        await store.set(KEY_SOFTEN, softenSwears);
        alert(softenSwears
          ? 'מעכשיו קללות יתורגמו בעדינות. זה חל על תמונות חדשות; לתרגם מחדש את מה שכבר תורגם: ⚙ ← 2.'
          : 'מעכשיו קללות יתורגמו כמו במקור. זה חל על תמונות חדשות; לתרגם מחדש את מה שכבר תורגם: ⚙ ← 2.');
      }
    });
  } else {
    // Frames have no buttons: follow the switch pressed on the main page.
    setInterval(async () => {
      const on = JSON.parse(await store.get(KEY_SITES, '[]')).includes(host);
      if (on !== enabled) setEnabled(on);
    }, 2000);
  }

  // Drag the buttons anywhere (so they never cover a site's own buttons); the spot is remembered.
  async function makeDraggable(box) {
    const KEY_POS = 'uiPos';
    const place = ({ x, y }) => {
      box.style.left = Math.max(0, Math.min(innerWidth - box.offsetWidth, x * innerWidth)) + 'px';
      box.style.top = Math.max(0, Math.min(innerHeight - box.offsetHeight, y * innerHeight)) + 'px';
      box.style.bottom = 'auto';
    };
    let pos = JSON.parse(await store.get(KEY_POS, 'null'));
    if (pos) place(pos);
    addEventListener('resize', () => pos && place(pos));
    for (const b of box.querySelectorAll('button')) b.style.touchAction = 'none';

    let start = null, moved = false;
    box.addEventListener('pointerdown', (e) => {
      const r = box.getBoundingClientRect();
      start = { px: e.clientX, py: e.clientY, x: r.left, y: r.top };
      moved = false;
    });
    addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.px, dy = e.clientY - start.py;
      if (!moved && Math.hypot(dx, dy) < 10) return;
      moved = true;
      pos = { x: (start.x + dx) / innerWidth, y: (start.y + dy) / innerHeight };
      place(pos);
    });
    addEventListener('pointerup', () => {
      if (start && moved) store.set(KEY_POS, JSON.stringify(pos));
      start = null;
    });
    // A drag must not also count as a tap on the button under the finger.
    box.addEventListener('click', (e) => {
      if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; }
    }, true);
  }

  function renderToggle() {
    toggleBtn.textContent = enabled ? 'תרגום: פועל' : 'תרגם';
    toggleBtn.classList.toggle('ct-on', enabled);
  }

  let fontStarted = false;
  function setEnabled(on) {
    enabled = on;
    if (on && !fontStarted) { fontStarted = true; loadComicFont(); }
    if (isTop) renderToggle();
    if (enabled) startWatching();
    else stopAll();
  }

  async function askForProxy() {
    const cur = await store.get(KEY_PROXY, '');
    const url = prompt('הדביקי את כתובת שרת העזר (למשל https://comic-helper.xxx.workers.dev).\nכדי לבטל, מוחקים ולוחצים אישור:', cur);
    if (url === null) return;
    const clean = url.trim().replace(/\/+$/, '');
    if (clean && !/^https:\/\/[^/\s]+/.test(clean)) { alert('הכתובת צריכה להתחיל ב-https://'); return; }
    await store.set(KEY_PROXY, clean);
    proxyHosts.clear();
    store.set(KEY_PROXY_HOSTS, '[]');
    // Let pictures that failed before try again.
    for (const el of nearView) if (state.get(el)?.error) state.delete(el);
    alert(clean ? 'נשמר ✓ תמונות שנכשלו ינסו שוב.' : 'שרת העזר בוטל.');
    if (enabled) nearView.forEach((el) => check(el));
  }

  async function askForKey() {
    const key = prompt('הדביקי כאן את מפתח ה-API של Gemini מ-Google AI Studio (מתחיל ב-AQ.):', '');
    if (!key || !/^(AQ\.|AIza|sk-ant-)/.test(key.trim())) {
      if (key !== null) alert('המפתח לא נראה תקין. מפתח של Gemini מתחיל ב-AQ.');
      return false;
    }
    await store.set(KEY_API, key.trim());
    // A new key starts with a clean slate on Google's quotas.
    try { exhausted = {}; } catch (_) { /* not set up yet */ }
    store.set('quotaExhausted', '{}');
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

  // Image servers that only work through the helper, remembered across visits so the next
  // chapter goes straight there instead of trying (and waiting on) the other ways first.
  const KEY_PROXY_HOSTS = 'proxyHosts';
  const proxyHosts = new Set(JSON.parse(await store.get(KEY_PROXY_HOSTS, '[]')));
  const rememberProxyHost = (h) => {
    if (proxyHosts.has(h)) return;
    proxyHosts.add(h);
    store.set(KEY_PROXY_HOSTS, JSON.stringify([...proxyHosts].slice(-50)));
  };

  async function viaProxy(src) {
    const proxy = await store.get(KEY_PROXY, '');
    if (!proxy) return null;
    const url = `${proxy}/?url=${encodeURIComponent(src)}&ref=${encodeURIComponent(location.href)}`;
    const r = await fetch(url); // the helper allows cross-site reads
    if (!r.ok) throw new Error(`שרת העזר: ${r.status} ${(await r.text()).slice(0, 60)}`);
    return await createImageBitmap(await r.blob());
  }

  async function bitmapFromUrl(src) {
    let imgHost = '';
    try { imgHost = new URL(src).hostname; } catch (_) { /* keep empty */ }
    // A server that already needed the helper: go straight there.
    if (proxyHosts.has(imgHost)) {
      const bmp = await viaProxy(src);
      if (bmp) return bmp;
    }
    // 1) Page fetch: works for same-site images, blob: URLs, and CDNs that allow it.
    try {
      const r = await fetch(src);
      if (r.ok) return await createImageBitmap(await r.blob());
    } catch (_) { /* fall through */ }
    // 2) A fresh copy of the picture asking the server for cross-site permission.
    try {
      const probe = new Image();
      probe.crossOrigin = 'anonymous';
      probe.src = src + (src.includes('?') ? '&' : '?') + 'ct=1';
      await probe.decode();
      if (isReadable(probe)) return await createImageBitmap(probe);
    } catch (_) { /* fall through */ }
    // 3) Userscript requests: not bound by the browser's cross-site rules. Image servers
    //    check different things, so try a few ways of asking.
    const attempts = [
      { Referer: location.href },          // "I'm the reader page"
      { Referer: location.origin + '/' },  // "I'm from this site"
      {},                                   // plain request, like opening the image directly
    ];
    let status = 0;
    for (const headers of attempts) {
      try {
        const r = await gmRequest({ method: 'GET', url: src, responseType: 'blob', headers });
        status = r.status;
        if (r.status < 200 || r.status >= 300) continue;
        let blob = r.response;
        if (!(blob instanceof Blob)) blob = new Blob([blob]);
        return await createImageBitmap(blob);
      } catch (_) { /* try the next way */ }
    }
    // 4) The image helper server, if one is set up (⚙ → 4).
    const bmp = await viaProxy(src);
    if (bmp) { rememberProxyHost(imgHost); return bmp; }
    const err = new Error(`image HTTP ${status || '?'} (${imgHost})`);
    err.blocked = true;
    throw err;
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
    const edge = economy ? ECONOMY_EDGE : MAX_EDGE;
    const scale = Math.min(1, edge / W);
    const sw = Math.round(W * scale);
    const totalH = Math.round(H * scale);
    const pieceH = Math.min(edge, totalH);
    // One horizontal band of the picture, in sent-scale pixels.
    const crop = (y, h) => {
      const canvas = document.createElement('canvas');
      canvas.width = sw; canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, y / scale, W, h / scale, 0, 0, sw, h);
      const data = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
      return { y, h, w: sw, data, first: y === 0, last: y + h >= totalH };
    };
    const pieces = [];
    let y = 0;
    while (true) {
      const h = Math.min(pieceH, totalH - y);
      pieces.push(crop(y, h));
      if (y + h >= totalH) break;
      y += pieceH - Math.round(pieceH * CHUNK_OVERLAP);
    }
    return { pieces, sentW: sw, sentH: totalH, pieceH, crop };
  }

  // Which AI is used is decided by the key you paste: Google keys start with "AQ." (older ones "AIza"),
  // Anthropic keys with "sk-ant-". Google's new AQ. keys only work in the x-goog-api-key header.
  const providerOf = (key) => (key.startsWith('sk-ant-') ? 'claude' : 'gemini');

  function buildPrompt(piece, coords) {
    return (
      `This is a ${piece.w}x${piece.h} px piece of a comic page` +
      (piece.first && piece.last ? '' : ' (a vertical webtoon strip, cut into pieces)') +
      `. Find every speech bubble, thought bubble and narration/caption box that contains ` +
      (source.lang
        ? `${source.lang} text`
        : `text in a language other than ${TARGET_LANG} (for example English, Korean, Japanese or Chinese)`) +
      ` (horizontal or vertical)` +
      (TRANSLATE_SFX ? ', plus sound effects' : '; skip sound effects and background signs that are not important to the story') +
      `.\nFor each one return ${coords} of the text area inside the bubble (covering every letter completely, including the first and last letter of each line and any punctuation, with a small margin), how many lines the original text is written on, the original text as written, ` +
      `and its ${TARGET_LANG} translation. ` +
      // Style: how people actually talk, not dubbed-TV subtitles.
      `Write the ${TARGET_LANG} the way young Israelis really talk and text: short, casual, natural spoken ` +
      `${TARGET_LANG}, with everyday Israeli slang where it fits the character. Never translate word for word: ` +
      `say what the line means and how it feels, the way an Israeli would say it in that situation, and turn ` +
      `English idioms into Hebrew ones (e.g. "make a move" is not "עושה מהלך"). Avoid formal or literary words ` +
      `(אינני, הנני, כיצד, מדוע, אולם, על מנת); use the spoken ones (אני לא, איך, למה, אבל, כדי). ` +
      `For body and sex-related words use the everyday words people actually say, not clinical terms. ` +
      `Use a slang word only when its meaning matches the original exactly (e.g. "unhinged" is מטורף / פסיכי / ` +
      `יצא משליטה, not מחוק, which means wasted); when unsure, pick the plain accurate word. Meaning comes before style. ` +
      `Sounds and interjections (coughing, groans, gasps, sighs, laughs) become the Hebrew sounds Israeli readers ` +
      `know, never letter-by-letter transliterations: coughing/choking ("KEGH", "COUGH") is "אחח... אחח" or ` +
      `"*משתעל*", not "קחח"; a groan of pain is "אאח" / "אוי"; a sigh is "אוף" / "הממ"; surprise is "הא?!"; ` +
      `a scream of pain ("ARGH!", "AAAH!") is "אאאח!", of anger or frustration "אררר!" / "אווף!", of fright "אאא!" ` +
      `(not "ארגח"). If a Hebrew word just spells the English sound in Hebrew letters, it's wrong: use the sound an ` +
      `Israeli would actually make. ` +
      `Flirting and romance should sound natural, not cheesy. Narration boxes can be a little more written ` +
      `but still simple. Keep lines short so they fit the bubble. No nikud. ` +
      `${TARGET_LANG} marks gender in verbs, adjectives and "you": work out who is speaking and to whom from ` +
      `the art (look at the characters in the panel and the bubble tails) and use the matching forms. ` +
      `Do not assume a man and a woman: many comics (e.g. BL or GL) are about two men or two women. ` +
      `Use the characters' names and how they are drawn; only when there is no clue at all, use masculine forms. ` +
      (storyNotes ? `Notes from the reader about this story (trust them): ${storyNotes}. ` : '') +
      // Names: one Hebrew spelling per character across the whole story.
      (Object.keys(glossary).length
        ? `Names already used in this story; always spell them exactly like this: ` +
          Object.values(glossary).slice(-80).map((g) => `${g.o} = ${g.h}`).join(', ') + `. `
        : '') +
      `In "names", list every person or place name you wrote in Hebrew (original spelling and Hebrew spelling). ` +
      (softenSwears
        ? `Tone down profanity and crude slang to mild ${TARGET_LANG} expressions, keeping the emotion. `
        : `Translate profanity, insults and crude slang faithfully, with the same intensity as the original ` +
          `(natural ${TARGET_LANG} swearing, not softened or censored); this is fiction for an adult reader. `) +
      `If a bubble is cut off by the top or bottom edge of the image, still return the box of its visible part. ` +
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
    if (r.status !== 200) {
      const err = new Error(res?.error?.message || 'API HTTP ' + r.status);
      err.status = r.status;
      err.raw = r.responseText || '';
      throw err;
    }
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
          required: ['box_2d', 'lines', 'original', 'translation'],
          properties: {
            box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
            lines: { type: 'INTEGER' },
            original: { type: 'STRING' },
            translation: { type: 'STRING' },
          },
        },
      },
      names: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          required: ['original', 'hebrew'],
          properties: { original: { type: 'STRING' }, hebrew: { type: 'STRING' } },
        },
      },
    },
  };

  // A Google key may be allowed on the Gemini API, on Agent Platform (Vertex AI), or both.
  // Try them in order and remember the one that answers.
  const geminiEndpoints = (model) => [
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent`,
  ];
  const KEY_SERVICE = 'geminiService'; // 0 = Gemini API, 1 = Agent Platform

  async function callGemini(apiKey, body, model = GEMINI_MODEL) {
    const urls = geminiEndpoints(model);
    const saved = Number(await store.get(KEY_SERVICE, 0)) || 0;
    const order = [saved, 1 - saved];
    let firstErr;
    for (const i of order) {
      try {
        const res = await callApi(urls[i], { 'x-goog-api-key': apiKey }, body);
        if (i !== saved) store.set(KEY_SERVICE, i);
        return res;
      } catch (err) {
        firstErr ||= err;
        // Only "this key/API isn't allowed here" is worth trying the other service for.
        if (![401, 403, 404].includes(err.status)) throw err;
      }
    }
    // Report the usual service's answer: the other one is often just "not enabled for this key".
    throw firstErr;
  }

  // imagePart is either the picture itself (inlineData) or a link Google downloads (fileData).
  async function geminiRequest(piece, apiKey, imagePart, model = GEMINI_MODEL) {
    // Economy mode asks for the least thinking and a lower image resolution. If this model
    // rejects either option, drop it, remember that, and try again.
    const minimal = economy && !unsupported.has(`${model}:minimal`);
    const lowRes = economy && !unsupported.has(`${model}:mediaResolution`);
    const thinkingConfig = model.startsWith('gemini-2') // 2.5 models take a token budget instead of a level
      ? { thinkingBudget: 0 }
      : { thinkingLevel: minimal ? 'minimal' : 'low' };
    let res;
    try {
      res = await callGemini(apiKey, geminiBody(piece, imagePart, thinkingConfig, lowRes), model);
    } catch (err) {
      if (err.status !== 400 || !(minimal || lowRes)) throw err;
      const bad = /media/i.test(err.message) ? 'mediaResolution' : /think/i.test(err.message) ? 'minimal' : null;
      if (!bad) throw err;
      unsupported.add(`${model}:${bad}`);
      store.set(KEY_UNSUPPORTED, JSON.stringify([...unsupported]));
      return geminiRequest(piece, apiKey, imagePart, model);
    }
    return parseGemini(res, piece);
  }

  function geminiBody(piece, imagePart, thinkingConfig, lowRes) {
    return {
      contents: [{
        role: 'user',
        parts: [
          imagePart,
          { text: buildPrompt(piece, 'box_2d as [y_min, x_min, y_max, x_max] normalized to 0-1000') },
        ],
      }],
      // Adult fiction has swearing, insults and violence: don't let those filters drop whole pages.
      // Sexual content stays on Google's default filter, so explicit pages are simply declined
      // (shown as "blocked") rather than pushed through.
      safetySettings: [
        ...['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_DANGEROUS_CONTENT']
          .map((category) => ({ category, threshold: 'BLOCK_NONE' })),
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: relaxedSexFilter ? 'BLOCK_ONLY_HIGH' : 'BLOCK_MEDIUM_AND_ABOVE' },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: GEMINI_SCHEMA,
        thinkingConfig,
        ...(lowRes ? { mediaResolution: 'MEDIA_RESOLUTION_MEDIUM' } : {}),
      },
    };
  }

  function parseGemini(res, piece) {
    const cand = res.candidates?.[0];
    const blockedBy = res.promptFeedback?.blockReason ||
      (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'RECITATION'].includes(cand?.finishReason) && cand.finishReason);
    if (blockedBy) { piece.blocked = blockedBy; return []; }
    if (!cand?.content?.parts) return []; // empty
    const text = cand.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
    const parsed = JSON.parse(text);
    learnNames(parsed.names);
    return (parsed.bubbles || [])
      .filter((b) => Array.isArray(b.box_2d) && b.box_2d.length === 4)
      .map(({ box_2d: [y0, x0, y1, x1], lines, original, translation }) => ({
        x: (x0 / 1000) * piece.w,
        y: (y0 / 1000) * piece.h,
        w: ((x1 - x0) / 1000) * piece.w,
        h: ((y1 - y0) / 1000) * piece.h,
        lines,
        translation: fixSounds(original, translation),
      }));
  }

  // ----- Sounds: a fixed Hebrew for bubbles that are only a sound -----
  // Models tend to spell sounds like "ARGH" in Hebrew letters (ארגח). When a bubble is nothing
  // but known sounds, use the sound an Israeli reader expects instead of the model's version.
  const SOUNDS = [
    [/^(A+R+G+H+|A+R+G+|A+G+H+|G+A+H+|A{2,}H*|U+A+G+H+|K+H+|A+C+K+)$/, 'אאאח'], // screams
    [/^(A|O|E)H+$/, 'אה'], // "Ah." / "Oh!" / "Eh?" 
    [/^(U+G+H+|U+R+G+H+|B+L+E+H+|B+L+A+H+)$/, 'אוף'],
    [/^(C+O+U+G+H+|K+E+G+H+|K+E+H+|K+A+H+K+|K+E+H+E+U+K+|C+O+F+|H+A+C+K+|G+E+H+|K+U+H+)$/, 'אחח'],
    [/^(O+W+|O+U+C+H+|O+U+)$/, 'איי'],
    [/^(H+U+H+)$/, 'הא'],
    [/^(H+M+|H+M+M+|U+M+|U+M+M+|E+R+M+|M+M+)$/, 'הממ'],
    [/^((H+A+)+H*|(H+E+)+H*|(K+E+)+K*|(K+U+)+K*)$/, 'חחח'],
    [/^(S+I+G+H+)$/, '*אנחה*'],
    [/^(W+O+W+|W+O+A+H+|W+H+O+A+)$/, 'וואו'],
    [/^(G+A+S+P+)$/, '*נושם בבהלה*'],
  ];
  function fixSounds(original, translation) {
    const text = String(original || '').trim();
    if (!text || text.length > 60) return translation;
    // Split into words and the punctuation between them ("KEGH, KEGH." -> KEGH / KEGH).
    const parts = text.toUpperCase().split(/([^A-Z]+)/);
    let hebrew = '', any = false;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i % 2 === 1) { hebrew += part.replace(/\s+/g, ' '); continue; } // separators as they were
      if (!part) continue;
      const hit = SOUNDS.find(([re]) => re.test(part));
      if (!hit) return translation; // a real word: keep the model's translation
      hebrew += hit[1];
      any = true;
    }
    return any ? hebrew.trim() : translation;
  }

  // ----- Quotas (mostly for Google's free tier) -----
  // A model whose *daily* quota ran out is skipped until tomorrow; a *per-minute* limit means
  // "wait a bit and try again", and we also send fewer pictures at once for the rest of the visit.
  const KEY_EXHAUSTED = 'quotaExhausted';
  const today = () => new Date().toISOString().slice(0, 10);
  let exhausted = JSON.parse(await store.get(KEY_EXHAUSTED, '{}'));
  let slowDown = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function quotaKind(err) {
    if (err.status !== 429) return null;
    const text = (err.raw || '') + ' ' + err.message;
    return /PerDay|per day|daily/i.test(text) ? 'day' : 'minute';
  }
  function retryDelayMs(err) {
    const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(err.raw || '') || /retry in (\d+(?:\.\d+)?)s/i.exec(err.message);
    return Math.min(60, m ? Number(m[1]) + 1 : 20) * 1000;
  }

  async function geminiPiece(piece, apiKey) {
    const part = { inlineData: { mimeType: 'image/jpeg', data: piece.data } };
    // Always the best model: lighter ones translate noticeably worse.
    const QUOTA_MSG = 'הגעת למכסה היומית של Google. אם אין כרטיס אשראי מחובר, מחברים ב-AI Studio; אחרת היא מתחדשת מחר.';
    const models = [GEMINI_MODEL].filter((m) => exhausted[m] !== today());
    if (!models.length) throw new Error(QUOTA_MSG);
    for (const model of models) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await geminiRequest(piece, apiKey, part, model);
        } catch (err) {
          const kind = quotaKind(err);
          if (kind === 'day') {
            exhausted[model] = today();
            store.set(KEY_EXHAUSTED, JSON.stringify(exhausted));
            break; // next model
          }
          if (kind === 'minute' && attempt < 4) {
            slowDown = true;
            await sleep(retryDelayMs(err));
            continue;
          }
          throw err;
        }
      }
    }
    throw new Error(QUOTA_MSG);
  }

  // Last resort for sites whose image server refuses our downloads: hand Gemini the link and
  // let Google fetch the picture. Newer models refuse outside links, so try ones that accept them.
  const URL_MODELS = ['gemini-3-flash-preview'];

  function mimeFromUrl(src) {
    const ext = (/\.(\w+)(?:[?#]|$)/.exec(new URL(src).pathname) || [])[1]?.toLowerCase();
    return { png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' }[ext] || 'image/jpeg';
  }

  async function translateFromUrl(el, apiKey) {
    const src = kindOf(el) === 'img' ? el.currentSrc || el.src : bgUrl(el);
    const { w, h } = naturalSize(el);
    const piece = { w, h, first: true, last: true };
    const part = { fileData: { mimeType: mimeFromUrl(src), fileUri: src } };
    const errors = [];
    for (const model of URL_MODELS) {
      try {
        const bubbles = await geminiRequest(piece, apiKey, part, model);
        return bubbles.map((b) => ({ x: b.x / w, y: b.y / h, w: b.w / w, h: b.h / h, n: b.lines, t: b.translation }));
      } catch (err) {
        errors.push(`${model}: ${err.status || ''} ${err.message}`);
        if (![400, 403, 404].includes(err.status)) break;
      }
    }
    const err = new Error(errors.join(' | '));
    throw err;
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
          required: ['x', 'y', 'w', 'h', 'lines', 'original', 'translation'],
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
            lines: { type: 'integer' },
            original: { type: 'string' },
            translation: { type: 'string' },
          },
        },
      },
      names: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['original', 'hebrew'],
          properties: { original: { type: 'string' }, hebrew: { type: 'string' } },
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
    if (res.stop_reason === 'refusal') { piece.blocked = 'refusal'; return []; }
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = JSON.parse(text);
    learnNames(parsed.names);
    return (parsed.bubbles || []).map((b) => ({ ...b, translation: fixSounds(b.original, b.translation) }));
  }

  // Bubbles in pixel coordinates of the piece.
  function translatePiece(piece, apiKey) {
    return providerOf(apiKey) === 'claude' ? claudePiece(piece, apiKey) : geminiPiece(piece, apiKey);
  }

  // Returns bubbles as fractions (0..1) of the whole picture.
  async function translateElement(el) {
    const apiKey = await store.get(KEY_API, '');
    if (!apiKey) throw new Error('חסר מפתח API');
    let bitmap;
    try {
      bitmap = await loadBitmap(el);
    } catch (err) {
      if (providerOf(apiKey) !== 'gemini' || kindOf(el) === 'canvas') throw err;
      setStatus(el, 'האתר חוסם הורדה, מנסה דרך Google…');
      try {
        return await translateFromUrl(el, apiKey);
      } catch (urlErr) {
        const hint = err.blocked && !(await store.get(KEY_PROXY, ''))
          ? ' — האתר חוסם הורדת תמונות. הפתרון: שרת עזר (⚙ ← 4, הוראות ב-README)'
          : ` / Google → ${urlErr.message}`;
        throw new Error(`${err.message}${hint}`.slice(0, 400));
      }
    }
    const out = await translateBitmap(bitmap, apiKey);
    markEdges(out, bitmap.height);
    return out;
  }

  // Bubbles touching the top/bottom edge of a picture. On sites that cut a chapter into many
  // stacked pictures, those may continue in the next/previous picture (see "Seams").
  function markEdges(bubbles, H) {
    const m = Math.max(0.004, Math.min(0.03, 40 / H));
    for (const b of bubbles) {
      const e = (b.y < m ? 't' : '') + (b.y + b.h > 1 - m ? 'b' : '');
      if (e) b.e = e;
    }
  }

  // Translates a whole picture (cut into pieces if it's tall). Bubbles come back as fractions.
  async function translateBitmap(bitmap, apiKey) {
    const { pieces, sentW, sentH, pieceH, crop } = slice(bitmap);
    const out = [];
    const results = await Promise.all(pieces.map((piece) => translatePiece(piece, apiKey)));
    // A bubble that touches a cut between pieces was only partly visible there (and its
    // translation may be partial), so prefer the neighbouring piece where it is whole.
    const whole = [], cut = [];
    for (const [n, piece] of pieces.entries()) {
      const margin = Math.max(6, piece.h * 0.02);
      for (const b of results[n]) {
        const g = { x: b.x, y: piece.y + b.y, w: b.w, h: b.h, n: b.lines, t: b.translation };
        g.cutTop = !piece.first && b.y < margin;
        g.cutBottom = !piece.last && b.y + b.h > piece.h - margin;
        (g.cutTop || g.cutBottom ? cut : whole).push(g);
      }
    }
    const sameBubble = (a, b) => {
      const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      return ix * iy > 0.4 * Math.min(a.w * a.h, b.w * b.h);
    };
    const kept = [];
    // Whole bubbles first; the same bubble seen whole in two overlapping pieces: keep the larger box.
    for (const g of whole.sort((a, b) => b.w * b.h - a.w * a.h)) {
      if (!kept.some((k) => sameBubble(k, g))) kept.push(g);
    }
    // Halves of a bubble with no whole copy (e.g. the piece that had it whole was blocked, or the
    // bubble is taller than the overlap): join halves that belong together, then translate just
    // that area again so the sentence is translated as one.
    const orphans = cut.filter((c) => !kept.some((k) => sameBubble(k, c))).sort((a, b) => a.y - b.y);
    const groups = [];
    for (const c of orphans) {
      // Halves of one bubble line up: the upper one runs into the bottom of its piece and the
      // lower one starts at the top of a later piece (anything between was in a piece we lost).
      const g = groups.find((u) => {
        const ix = Math.min(u.x + u.w, c.x + c.w) - Math.max(u.x, c.x);
        const gap = c.y - (u.y + u.h);
        return ix > 0.3 * Math.min(u.w, c.w) &&
          (gap < pieceH * 0.06 || (u.cutBottom && c.cutTop && gap < pieceH * 0.7));
      });
      if (!g) { groups.push({ x: c.x, y: c.y, w: c.w, h: c.h, cutBottom: c.cutBottom, parts: [c] }); continue; }
      const x0 = Math.min(g.x, c.x), y0 = Math.min(g.y, c.y);
      g.w = Math.max(g.x + g.w, c.x + c.w) - x0; g.h = Math.max(g.y + g.h, c.y + c.h) - y0;
      g.x = x0; g.y = y0; g.cutBottom = c.cutBottom; g.parts.push(c);
    }
    for (const g of groups) {
      let redone = [];
      if (g.h < pieceH * 0.9) {
        const pad = Math.min(200, (pieceH - g.h) / 2);
        const y0 = Math.max(0, Math.round(g.y - pad));
        const y1 = Math.min(sentH, Math.round(g.y + g.h + pad));
        const piece = crop(y0, y1 - y0);
        const margin = Math.max(6, piece.h * 0.02);
        try {
          redone = (await translatePiece(piece, apiKey))
            // must be whole this time: not running into the crop's own edges
            .filter((b) => (piece.first || b.y >= margin) && (piece.last || b.y + b.h <= piece.h - margin))
            .map((b) => ({ x: b.x, y: piece.y + b.y, w: b.w, h: b.h, n: b.lines, t: b.translation }))
            .filter((b) => sameBubble(b, g));
        } catch (_) { /* keep the halves below */ }
      }
      if (redone.length) {
        for (const b of redone) if (!kept.some((k) => sameBubble(k, b))) kept.push(b);
      } else {
        // Still no whole translation: one box over the whole area (so no original text peeks out
        // between the halves), with the halves' texts in reading order.
        kept.push({ ...g, n: g.parts.reduce((s, p) => s + (p.n || 1), 0),
          t: g.parts.map((p) => p.t.replace(/^\s*(\.\.\.|…)\s*|\s*(\.\.\.|…)\s*$/g, '')).join(' ') });
      }
    }
    for (const g of kept) {
      out.push({ x: g.x / sentW, y: g.y / sentH, w: g.w / sentW, h: g.h / sentH, n: g.n, t: g.t });
    }
    addColors(bitmap, out);
    const blocked = pieces.filter((p) => p.blocked).map((p) => p.blocked);
    if (blocked.length) out.blocked = `${blocked.length === pieces.length ? 'התמונה נחסמה' : 'חלק מהתמונה נחסם'} על ידי ${providerOf(apiKey) === 'claude' ? 'Claude' : 'Google'} (${blocked[0]})`;
    return out;
  }

  // ---------- Seams ----------
  // Many sites cut a chapter into stacked pictures, and a bubble can sit right on the cut: half in
  // one picture, half in the next. Each picture alone would translate its half. So when a
  // picture has a bubble on its edge and another picture sits right against that edge, we
  // stitch the two around the cut, translate that as one picture, and draw the bubbles that
  // cross the cut over both pictures.
  const seams = new Map(); // "keyA||keyB" -> seam

  function neighbor(el, dir) {
    const r = el.getBoundingClientRect();
    if (!r.width) return null;
    for (const o of deepQuery(document, 'img, canvas')) {
      if (o === el || !isComic(o)) continue;
      const q = o.getBoundingClientRect();
      const overlap = Math.min(r.right, q.right) - Math.max(r.left, q.left);
      if (overlap < 0.8 * Math.min(r.width, q.width)) continue;
      const gap = dir === 'below' ? q.top - r.bottom : r.top - q.bottom;
      if (Math.abs(gap) <= 8) return o;
    }
    return null;
  }

  function seamFor(a, b) {
    const key = keyOf(a) + '||' + keyOf(b);
    let sm = seams.get(key);
    if (!sm) {
      sm = { seam: true, a, b, key, fa: 0.5, fb: 0.5, get isConnected() { return a.isConnected && b.isConnected; } };
      seams.set(key, sm);
    }
    return sm;
  }

  function redrawPair(sm) {
    for (const el of [sm.a, sm.b]) if (el._ctBubbles && layers.has(el)) drawBubbles(el, el._ctBubbles);
  }

  function scheduleSeam(sm) {
    if (sm.state) return;
    const hit = cache['seam:' + sm.key];
    if (hit) {
      sm.state = 'done'; sm.fa = hit.fa; sm.fb = hit.fb;
      drawBubbles(sm, hit.b);
      redrawPair(sm);
      return;
    }
    sm.state = 'pending';
    translateSeam(sm)
      .then((res) => {
        if (!res.blocked) { cache['seam:' + sm.key] = { t: Date.now(), b: res.b, fa: res.fa, fb: res.fb }; saveCache(); }
        sm.state = 'done'; sm.fa = res.fa; sm.fb = res.fb;
        if (enabled) { drawBubbles(sm, res.b); redrawPair(sm); }
      })
      .catch((err) => {
        console.warn('[comic-translator] seam', err);
        sm.state = 'failed'; // show each picture's own halves instead
        if (enabled) redrawPair(sm);
      });
  }

  async function translateSeam(sm) {
    const apiKey = await store.get(KEY_API, '');
    const [A, B] = await Promise.all([loadBitmap(sm.a), loadBitmap(sm.b)]);
    const W = A.width, bScale = W / B.width;
    const partA = Math.min(A.height, Math.max(Math.round(A.height * 0.5), 900));
    const partBsrc = Math.min(B.height, Math.max(Math.round(B.height * 0.5), 900));
    const partB = Math.round(partBsrc * bScale);
    const total = partA + partB;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = total;
    const g = canvas.getContext('2d');
    g.drawImage(A, 0, A.height - partA, W, partA, 0, 0, W, partA);
    g.drawImage(B, 0, 0, B.width, partBsrc, 0, partA, W, partB);
    const stitched = await createImageBitmap(canvas);
    const out = await translateBitmap(stitched, apiKey);
    // Keep only bubbles on the cut (or close enough that each picture alone dropped them).
    const seamY = partA / total;
    const mA = (Math.max(0.004, Math.min(0.03, 40 / A.height)) * A.height + 10) / total;
    const mB = (Math.max(0.004, Math.min(0.03, 40 / B.height)) * B.height * bScale + 10) / total;
    const b = out.filter((x) => x.y < seamY + mB && x.y + x.h > seamY - mA);
    return { b, fa: partA / A.height, fb: partBsrc / B.height, blocked: out.blocked };
  }

  // Take each bubble's own colors, so the translation blends into white bubbles, colored
  // bubbles and dark caption boxes alike.
  function addColors(bitmap, bubbles) {
    const S = 32;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true });
    const W = bitmap.width, H = bitmap.height;
    for (const b of bubbles) {
      try {
        // Look at a frame slightly larger than the text box: its edge is the bubble's background.
        const mx = b.w * W * 0.12 + 3, my = b.h * H * 0.12 + 3;
        const sx = Math.max(0, b.x * W - mx), sy = Math.max(0, b.y * H - my);
        const sw = Math.min(W - sx, b.w * W + 2 * mx), sh = Math.min(H - sy, b.h * H + 2 * my);
        g.clearRect(0, 0, S, S);
        g.drawImage(bitmap, sx, sy, sw, sh, 0, 0, S, S);
        const d = g.getImageData(0, 0, S, S).data;
        const ring = [[], [], []];
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            if (x > 1 && x < S - 2 && y > 1 && y < S - 2) continue; // only the outer frame
            const i = (y * S + x) * 4;
            ring[0].push(d[i]); ring[1].push(d[i + 1]); ring[2].push(d[i + 2]);
          }
        }
        const [r, gr, bl] = ring.map((ch) => ch.sort((p, q) => p - q)[ch.length >> 1]); // median
        b.bg = `rgb(${r},${gr},${bl})`;
        b.fg = 0.299 * r + 0.587 * gr + 0.114 * bl > 140 ? '#111' : '#fff';
      } catch (_) { /* keep the default white bubble */ }
    }
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
    let r;
    if (el.seam) {
      // From the part of the upper picture we used, down to the part of the lower one.
      const ra = el.a.getBoundingClientRect(), rb = el.b.getBoundingClientRect();
      const top = ra.top + ra.height * (1 - el.fa), bottom = rb.top + rb.height * el.fb;
      r = { left: ra.left, top, width: ra.width, height: bottom - top };
    } else {
      r = el.getBoundingClientRect();
    }
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
    const c = el.seam ? { x: 0, y: 0, w: r.width, h: r.height } : contentRect(el, r);
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
    // Aim for the size of the original lettering (same number of lines in the same space),
    // then shrink only if the Hebrew needs more room.
    const lines = Number(el.dataset.lines) || 0;
    // (the box is ~1.2× the original text height because of the margin added in drawBubbles)
    let size = lines > 0 ? Math.min(44, (boxH / 1.2 / lines) * 0.95) : Math.min(28, boxH * 0.45);
    size = Math.max(9, size);
    el.style.fontSize = size + 'px';
    while (size > 8 && (el.scrollHeight > boxH + 1 || el.scrollWidth > boxW + 1)) {
      size -= 1;
      el.style.fontSize = size + 'px';
    }
  }

  function drawBubbles(el, bubbles) {
    if (!el.seam) {
      el._ctBubbles = bubbles;
      const hasTop = bubbles.some((b) => b.e?.includes('t'));
      const hasBottom = bubbles.some((b) => b.e?.includes('b'));
      const below = hasBottom && neighbor(el, 'below');
      const above = hasTop && neighbor(el, 'above');
      const sBelow = below ? seamFor(el, below) : null;
      const sAbove = above ? seamFor(above, el) : null;
      bubbles = bubbles.filter((b) =>
        !((b.e?.includes('b') && sBelow && sBelow.state !== 'failed') ||
          (b.e?.includes('t') && sAbove && sAbove.state !== 'failed')));
      if (sBelow) scheduleSeam(sBelow);
      if (sAbove) scheduleSeam(sAbove);
    }
    const { inner } = layerFor(el);
    inner.querySelectorAll('.ct-bubble').forEach((e) => e.remove());
    for (const b of bubbles) {
      const div = document.createElement('div');
      div.className = 'ct-bubble';
      // Grow each box so it surely covers the original lettering (the model's box can be a
      // letter short). The extra area takes the bubble's own color, so it doesn't show.
      const px = Math.min(b.w * 0.08, 0.02), py = Math.min(b.h * 0.10, 0.012); // big boxes: capped
      div.style.left = `calc(${(b.x - px) * 100}% - 3px)`;
      div.style.top = `calc(${(b.y - py) * 100}% - 2px)`;
      div.style.width = `calc(${(b.w + 2 * px) * 100}% + 6px)`;
      div.style.height = `calc(${(b.h + 2 * py) * 100}% + 4px)`;
      div.textContent = b.t;
      if (b.n) div.dataset.lines = b.n;
      const bg = b.bg || '#fff';
      div.style.background = bg;
      div.style.color = b.fg || '#111';
      // Soft edge in the bubble's own color, so no box outline shows.
      div.style.boxShadow = `0 0 3px 3px ${bg}`;
      // Tap a bubble to peek at the original text.
      div.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); div.classList.toggle('ct-hidden'); });
      inner.appendChild(div);
    }
    if (el.seam) { resizeObs.observe(el.a); resizeObs.observe(el.b); } else resizeObs.observe(el);
    repositionAll();
  }

  // ---------- Queue ----------
  // state: element -> { key, error } for the picture currently shown in it
  let state = new WeakMap();
  const queue = [];
  let running = 0;
  let firstDone = false;

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
    // On a site with no names learned yet, let the first picture finish alone, so the names it
    // learns are used by all the others (the same spelling for a character from the start).
    const limit = slowDown ? 2 : (Object.keys(glossary).length || firstDone ? MAX_PARALLEL : 1);
    while (enabled && running < limit && queue.length) {
      // Translate the picture closest to where you are reading first (ones just below come
      // before ones far away or already scrolled past).
      const dist = (q) => {
        const r = q.el.getBoundingClientRect();
        if (r.bottom < 0) return 1e6 - r.bottom; // already scrolled past: only after everything ahead
        return Math.max(0, r.top);
      };
      let best = 0;
      for (let i = 1; i < queue.length; i++) if (dist(queue[i]) < dist(queue[best])) best = i;
      const { el, key } = queue.splice(best, 1)[0];
      if (state.get(el)?.key !== key) continue; // page changed while waiting
      running++;
      setStatus(el, 'מתרגם…');
      translateElement(el)
        .then((bubbles) => {
          if (!bubbles.blocked) { // blocked pages can be retried later, so don't keep them
            cache[key] = { t: Date.now(), b: bubbles };
            saveCache();
          }
          if (!enabled || state.get(el)?.key !== key) return;
          setStatus(el, bubbles.blocked || null);
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
        .finally(() => { running--; firstDone = true; pump(); });
    }
  }

  // ---------- Watching the page ----------
  let io = null;
  let scanner = null;
  const nearView = new Set();       // watched elements within LOOK_AHEAD of the viewport
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
    }, { rootMargin: `${LOOK_AHEAD} 0px ${LOOK_AHEAD} 0px` });
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
    seams.clear();
    watched = new WeakSet(); // they belonged to the old observer
    bgChecked = new WeakSet();
  }

  if (enabled) { fontStarted = true; loadComicFont(); startWatching(); }
})();
