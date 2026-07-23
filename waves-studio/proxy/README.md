# Waves Studio — Roblox stats proxy

## Why this folder exists

`games.roblox.com` and `apis.roblox.com` don't send an
`Access-Control-Allow-Origin` header, so a browser `fetch()` straight from
`index.html` to Roblox will always fail with a CORS error — this is a
long-standing, well-documented Roblox limitation, not a bug in your code.
`worker.js` is a small server-side relay that calls Roblox on your site's
behalf (servers aren't subject to CORS) and re-serves the result with CORS
enabled, so your frontend can read it.

It also solves "Playtime Hours." Roblox has no API that returns total hours
played — the only way to get that number is to sample concurrent players
(CCU) repeatedly over time and add it up. That needs something that keeps
running even when nobody has your site open in a tab, which a static HTML
page can't do by itself. The Worker's **Cron Trigger** is that always-on
piece: every 10 minutes it polls CCU across all your games and appends the
sample to that day's bucket in Cloudflare KV.

## Deploy (free tier is enough)

```bash
npm install -g wrangler
wrangler login

# Create the KV store the Worker reads/writes playtime samples to
wrangler kv namespace create PLAYTIME
# -> copy the printed "id" into wrangler.toml

# Edit GAME_PLACE_IDS in worker.js with your real Roblox place IDs
# (the number in https://www.roblox.com/games/<this>/Your-Game-Name)

wrangler deploy
# -> prints something like https://waves-studio-proxy.yourname.workers.dev
```

Copy that URL into `PROXY_BASE_URL` near the top of the `<script>` in
`index.html`:

```js
const PROXY_BASE_URL = 'https://waves-studio-proxy.yourname.workers.dev';
```

That's it. **`GAME_PLACE_IDS` in `worker.js` is the only place your games are
defined** — `index.html` has no game list of its own anymore. It calls
`/games` once, gets back everything the proxy could resolve, and builds the
homepage's 3 "Featured" cards, the "View All" modal (one card per place ID,
automatically — add a 4th ID and a 4th card appears, no HTML edits), and the
hero wall from that single response. Leave `PROXY_BASE_URL` empty and the
site falls back to a small built-in demo list (`FALLBACK_GAMES` in
`index.html`) instead — nothing breaks if you skip deploying this.

⚠️ If you open `index.html` by double-clicking it (a `file://` URL) with
`PROXY_BASE_URL` set, some browsers block `fetch()` from `file://` pages
entirely regardless of CORS headers. Serve the folder over `http://`
instead — even `npx serve .` from this folder is enough — while testing.

## Endpoints

- `GET /games` → `{ games: [{ placeId, universeId, name, playing, visits, peak, icon, thumbnails }, ...] }` — one entry per ID in `GAME_PLACE_IDS`, in order. This is the only endpoint `index.html` calls on page load.
- `GET /stats?placeId=126884695634` → `{ placeId, universeId, playing, visits }` — single-game version, kept around in case you need it elsewhere.
- `GET /thumbnail?placeId=126884695634` → `{ placeId, universeId, icon, thumbnails: [urls...] }` — single-game version of the media lookup `/games` already does in bulk.
- `GET /playtime` → `{ days: [{ date: "2026-07-19", points: [1234, 1300, ...] }, ×7] }`

## "Peak" is real, not fabricated

Roblox's API only exposes *current* CCU, not a rolling peak — so `peak` is
built the same way the Playtime chart is: the Cron Trigger records the
highest CCU it has seen **per game** each day (`peak:{placeId}:{date}` in
KV), and `/games` reports the max of the last 7 days. Right after your
first deploy that history is empty, so `peak` briefly just equals the
current `playing` count until the Cron has ticked a few times.
