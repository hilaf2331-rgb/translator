// Comic Translator – image helper (Cloudflare Worker)
//
// Some comic sites only hand out their images to requests that come "from" the reader page.
// Safari doesn't let extensions send that information, so this tiny server downloads the
// image on the script's behalf and passes it back.
//
// It only passes along images (nothing else), and keeps no logs or copies.
// Setup instructions (Hebrew) are in README.md, section "שרת עזר לתמונות".

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const params = new URL(request.url).searchParams;
    const target = params.get('url');
    const page = params.get('ref');
    if (!target || !/^https?:\/\//i.test(target)) {
      return new Response('Comic Translator image helper is running ✓', { headers: cors });
    }

    const base = {
      'User-Agent': request.headers.get('User-Agent') ||
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    // Image servers check different things: try "from the reader page", "from the site", then plain.
    const referers = [];
    if (page) {
      referers.push(page);
      try { referers.push(new URL(page).origin + '/'); } catch (_) { /* ignore */ }
    }
    referers.push(null);

    let last = null;
    for (const ref of referers) {
      const headers = { ...base };
      if (ref) headers.Referer = ref;
      const r = await fetch(target, { headers, cf: { cacheTtl: 3600, cacheEverything: true } });
      const type = r.headers.get('content-type') || '';
      if (r.ok && type.startsWith('image/')) {
        return new Response(r.body, {
          headers: { ...cors, 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' },
        });
      }
      last = r;
    }
    const status = last && !last.ok ? last.status : 415; // 415 = the server answered, but not with an image
    return new Response('image server said ' + (last ? last.status : '?'), { status, headers: cors });
  },
};
