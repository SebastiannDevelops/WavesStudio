/**
 * Waves Studio — Roblox stats proxy + playtime aggregator (Cloudflare Worker)
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * Roblox's public APIs (games.roblox.com, apis.roblox.com) do not send
 * Access-Control-Allow-Origin headers, so a browser fetch() straight from
 * your site will always be blocked by CORS. This Worker runs server-side
 * (no CORS restrictions apply there), calls Roblox on your site's behalf,
 * and re-serves the result with CORS enabled so index.html can read it.
 *
 * It also solves the "playtime hours" problem: Roblox has no single API
 * that returns "total hours played". The only real way to get that is to
 * sample concurrent players (CCU) repeatedly over time and add it up — that
 * requires something that keeps running even when nobody has the site open,
 * which a static HTML file can't do. The Cron Trigger below is that "always
 * running" piece.
 *
 * DEPLOY (free tier is enough for this)
 * 1. Install Wrangler:            npm install -g wrangler
 * 2. Log in:                      wrangler login
 * 3. Create the KV namespace:     wrangler kv namespace create PLAYTIME
 *    -> copy the returned `id` into wrangler.toml
 * 4. Edit GAME_PLACE_IDS below with your real Roblox place IDs.
 * 5. Deploy:                      wrangler deploy
 * 6. Copy the printed *.workers.dev URL into PROXY_BASE_URL in index.html.
 */

// Place IDs (the number in a roblox.com/games/<this>/... URL) for every
// game you want counted toward the studio-wide Playtime Hours chart.
const GAME_PLACE_IDS = [
  126884695634, // replace with your real place IDs
];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

async function placeIdToUniverseId(placeId) {
  const res = await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
  if (!res.ok) throw new Error(`universe lookup failed for place ${placeId}`);
  const data = await res.json();
  return data.universeId;
}

async function fetchGamesData(universeIds) {
  const res = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeIds.join(',')}`);
  if (!res.ok) throw new Error('games lookup failed');
  const data = await res.json();
  return data.data; // [{ id, name, playing, visits, ... }, ...]
}

async function fetchIcon(universeId) {
  const res = await fetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&size=512x512&format=Png&isCircular=false`);
  if (!res.ok) throw new Error('icon lookup failed');
  const data = await res.json();
  const entry = data.data && data.data[0];
  return entry && entry.state === 'Completed' ? entry.imageUrl : null;
}

async function fetchThumbnails(universeId, count = 6) {
  const res = await fetch(`https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${universeId}&countPerUniverse=${count}&defaults=true&size=768x432&format=Png&isCircular=false`);
  if (!res.ok) throw new Error('thumbnail lookup failed');
  const data = await res.json();
  const entry = data.data && data.data[0];
  if (!entry || !entry.thumbnails) return [];
  return entry.thumbnails
    .filter((t) => t.state === 'Completed' && t.imageUrl)
    .map((t) => t.imageUrl);
}

// Batched variants used by /games — one API call for every universe instead
// of one call per game, since thumbnails.roblox.com accepts a comma-joined
// list of universeIds just like games.roblox.com does.
async function fetchIconsBatch(universeIds) {
  if (!universeIds.length) return {};
  const res = await fetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeIds.join(',')}&size=512x512&format=Png&isCircular=false`);
  if (!res.ok) return {};
  const data = await res.json();
  const map = {};
  (data.data || []).forEach((e) => { if (e.state === 'Completed') map[e.targetId] = e.imageUrl; });
  return map;
}

async function fetchThumbnailsBatch(universeIds, countPerUniverse = 4) {
  if (!universeIds.length) return {};
  const res = await fetch(`https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${universeIds.join(',')}&countPerUniverse=${countPerUniverse}&defaults=true&size=768x432&format=Png&isCircular=false`);
  if (!res.ok) return {};
  const data = await res.json();
  const map = {};
  (data.data || []).forEach((entry) => {
    map[entry.universeId] = (entry.thumbnails || [])
      .filter((t) => t.state === 'Completed' && t.imageUrl)
      .map((t) => t.imageUrl);
  });
  return map;
}

// Highest CCU the Cron Trigger has recorded for this game in the last 7
// days (see `scheduled()` below, which is what actually writes these keys).
// Nothing else exposes a real "peak" — it's built from the same repeated
// sampling used for the playtime chart, just kept per-game instead of
// studio-wide.
async function readWeeklyPeak(env, placeId) {
  let peak = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const v = Number(await env.PLAYTIME.get(`peak:${placeId}:${d}`)) || 0;
    if (v > peak) peak = v;
  }
  return peak;
}

export default {
  /* ---------------- HTTP endpoints (called from index.html) ---------------- */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // GET /stats?placeId=123456  -> { placeId, universeId, playing, visits }
    if (url.pathname === '/stats') {
      const placeId = url.searchParams.get('placeId');
      if (!placeId) return json({ error: 'placeId query param required' }, 400);
      try {
        const universeId = await placeIdToUniverseId(placeId);
        const [game] = await fetchGamesData([universeId]);
        if (!game) return json({ error: 'game not found' }, 404);
        return json({ placeId, universeId, playing: game.playing, visits: game.visits });
      } catch (err) {
        return json({ error: String(err.message || err) }, 502);
      }
    }

    // GET /playtime -> { days: [{ date: 'YYYY-MM-DD', points: [ccuSample, ...] }, x7] }
    if (url.pathname === '/playtime') {
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        const raw = await env.PLAYTIME.get(`day:${d}`);
        days.push({ date: d, points: raw ? JSON.parse(raw) : [] });
      }
      return json({ days });
    }

    // GET /thumbnail?placeId=123456 -> { placeId, universeId, icon, thumbnails: [urls...] }
    // `icon` is the square game icon; `thumbnails` are the wide (768x432, same
    // 16:9 shape as a Roblox store thumbnail) promotional images for that game.
    // These are plain image URLs — once resolved, index.html loads them with a
    // normal <img src>, which doesn't need CORS at all (only the JSON lookup
    // that finds the URL does, which is why this has to happen here).
    if (url.pathname === '/thumbnail') {
      const placeId = url.searchParams.get('placeId');
      if (!placeId) return json({ error: 'placeId query param required' }, 400);
      try {
        const universeId = await placeIdToUniverseId(placeId);
        const [icon, thumbnails] = await Promise.all([
          fetchIcon(universeId).catch(() => null),
          fetchThumbnails(universeId).catch(() => []),
        ]);
        return json({ placeId, universeId, icon, thumbnails });
      } catch (err) {
        return json({ error: String(err.message || err) }, 502);
      }
    }

    // GET /games -> { games: [{ placeId, universeId, name, playing, visits, peak, icon, thumbnails }, ...] }
    // The ONE endpoint the homepage grid, the "View All" modal, and the hero
    // wall all read from. Driven entirely by GAME_PLACE_IDS at the top of
    // this file — add/remove a place ID there and it shows up (or
    // disappears) here automatically, nowhere else to edit.
    if (url.pathname === '/games') {
      try {
        const resolved = await Promise.all(GAME_PLACE_IDS.map(async (placeId) => {
          try {
            return { placeId, universeId: await placeIdToUniverseId(placeId) };
          } catch (err) {
            console.error(`Failed to resolve universe for place ${placeId}:`, err);
            return { placeId, universeId: null };
          }
        }));
        const validIds = resolved.filter((r) => r.universeId).map((r) => r.universeId);

        const [gamesData, iconMap, thumbMap, peaks] = await Promise.all([
          validIds.length ? fetchGamesData(validIds) : Promise.resolve([]),
          fetchIconsBatch(validIds),
          fetchThumbnailsBatch(validIds),
          Promise.all(resolved.map((r) => (r.universeId ? readWeeklyPeak(env, r.placeId) : Promise.resolve(0)))),
        ]);
        const gamesByUniverse = Object.fromEntries(gamesData.map((g) => [String(g.id), g]));

        const games = resolved.map(({ placeId, universeId }, i) => {
          const g = universeId ? gamesByUniverse[String(universeId)] : null;
          const playing = g ? g.playing : 0;
          return {
            placeId,
            universeId,
            name: g ? g.name : null,
            playing,
            visits: g ? g.visits : 0,
            peak: Math.max(peaks[i] || 0, playing), // in case the Cron hasn't run yet
            icon: universeId ? (iconMap[universeId] || null) : null,
            thumbnails: universeId ? (thumbMap[universeId] || []) : [],
          };
        });

        return json({ games });
      } catch (err) {
        return json({ error: String(err.message || err) }, 502);
      }
    }

    return json({ error: 'not found' }, 404);
  },

  /* -------- Cron Trigger: polls CCU across all games, accumulates today -------- */
  async scheduled(event, env) {
    const resolved = await Promise.all(GAME_PLACE_IDS.map(async (placeId) => {
      try {
        return { placeId, universeId: await placeIdToUniverseId(placeId) };
      } catch (err) {
        console.error(`Failed to resolve universe for place ${placeId}:`, err);
        return { placeId, universeId: null };
      }
    }));
    const valid = resolved.filter((r) => r.universeId);
    if (!valid.length) return;

    const gamesData = await fetchGamesData(valid.map((r) => r.universeId));
    const byUniverse = Object.fromEntries(gamesData.map((g) => [String(g.id), g]));
    const today = new Date().toISOString().slice(0, 10);

    let totalCCU = 0;
    for (const { placeId, universeId } of valid) {
      const playing = (byUniverse[String(universeId)] || {}).playing || 0;
      totalCCU += playing;

      // Per-game rolling peak: highest CCU seen today for this specific game.
      const peakKey = `peak:${placeId}:${today}`;
      const existingPeak = Number(await env.PLAYTIME.get(peakKey)) || 0;
      if (playing > existingPeak) {
        await env.PLAYTIME.put(peakKey, String(playing), { expirationTtl: 60 * 60 * 24 * 8 });
      }
    }

    // Studio-wide playtime sample (unchanged) — one number per tick, summed
    // across every game, which is what the Playtime Hours chart reads.
    const key = `day:${today}`;
    const existingRaw = await env.PLAYTIME.get(key);
    const existing = existingRaw ? JSON.parse(existingRaw) : [];
    existing.push(totalCCU);
    await env.PLAYTIME.put(key, JSON.stringify(existing), { expirationTtl: 60 * 60 * 24 * 30 });
  },
};
