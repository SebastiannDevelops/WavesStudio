# Waves Studio

Pure static site — no backend, no serverless functions, no build step
required to deploy. Every Roblox stat (name, live CCU, visits, icon,
thumbnail) is fetched straight from the browser via
[roproxy.com](https://roproxy.com), a free community-run CORS-enabled
mirror of Roblox's own APIs. `games.roblox.com` and friends don't send
CORS headers, so a direct fetch() from a browser gets blocked — roproxy
mirrors the exact same endpoints with CORS allowed, which is what removes
the need for any backend of your own.

## Add your games

Open `index.html`, find `GAME_PLACE_IDS` near the top of the `<script>`
tag, and list your Roblox place IDs:

```js
const GAME_PLACE_IDS = [
  126884695634,
  987654321000,
];
```

That's the only file with games in it. Name, live CCU, visits, icon, and
thumbnail are all resolved automatically for the homepage cards, the hero
background wall, and the "View All" modal.

## Deploy to Vercel

1. Push this folder to a GitHub repo (or drag-and-drop it at vercel.com/new).
2. Import the repo in Vercel. Framework preset: **Other**.
3. In Build & Development Settings, turn OFF (or leave blank) both **Build
   Command** and **Output Directory** — there's no build to run, `index.html`
   is served as-is. (`dist/output.css` is already compiled and committed;
   you only need `npm run build` locally if you edit `src/input.css`.)
4. Deploy. Done — no environment variables, no CLI.

Since there's no backend, this also deploys fine on GitHub Pages, Netlify,
Cloudflare Pages, or literally any static host — just upload the folder.

## What's in here

```
index.html          the whole site — fetches live data via roproxy.com
                     directly from the browser on load, and every 45s after
logo.png
tailwind.config.js  \_ compile src/input.css -> dist/output.css. Only
src/input.css        | needed again if you edit input.css or add Tailwind
dist/output.css     /  classes not already used somewhere in index.html.
package.json
```

## A couple of honest notes

- **roproxy.com is an unofficial, third-party service**, not run by
  Roblox. It's widely used in the Roblox dev community and normally
  reliable, but if it's ever down, the site falls back to `FALLBACK_GAMES`
  in `index.html` instead of breaking.
- **"Peak"** on each card is the highest CCU *this specific browser* has
  seen for that game, saved in `localStorage`. Roblox has no public
  endpoint for a real rolling peak, so this is the honest zero-backend
  approximation — it starts equal to the live count and grows the more the
  site gets visited/left open, but it isn't a true global peak across every
  visitor.
