# Memory Sea · Mirror — Template

> This is not a productivity tool. It is a mirror that reflects the structure of consciousness.

**Live demo: [https://jiyihai.cc.cd/](https://jiyihai.cc.cd/)** (the demo only reads in-memory data; it writes nothing to your machine or the server)

**中文版：[README.md](README.md)**

## Screenshots

![Star map](https://i.imgs.ovh/2026/11/07/9bb118b4fdbe82fd0ea60645cc5d0aee.jpg)

![Small galaxy](https://i.imgs.ovh/2026/11/07/4d5ca04dff748d9409d195cac4bf80a0.jpg)

## About

### Why build this?

It started with one brutal night shift. So much happened that day, so many thoughts, and yet by the end nothing felt left behind — as if swallowed whole by a vast sense of emptiness.

We tried classic journals, bi-directional link notes, tag managers, and eventually realized we were only doing "knowledge filing", not "sorting out the inside". So this nebula came to be.

### What is it?

- **Not an album, a mirror**: it externalizes the invisible network of associations inside you into a rotatable, illuminable sky.
- **Minimal input, maximal output**: you just pour emotions in; the AI splits them into entity nodes and causal links in the background.
- **See your micro-universe**: the observation point at the center (conscious awareness), the rotating clusters (daily life and emotions), and the unlit lonely stars in the dark (the subconscious).

> **A piece of advice**
>
> Don't stare into the mirror for the sake of staring. And definitely don't play with the mirror just to play with it.
>
> A mirror is made to look into, not to fiddle with.
>
> A tool is only a ladder — once you've used it, put it away. If you feel exhausted today, or you just spent half an hour agonizing over node colors, close this page right now. Go eat a real meal, feel the wind on your skin, get a good night's sleep.
>
> **Life itself is the main product.**

> “As long as a brilliant idea can still make you shiver, your universe is still running.”

Make "Memory Sea · Mirror" your own: a single-file page plus a zero-dependency Node service that turns thoughts, people, events and knowledge into a rotatable, clickable 3D nebula.

This is a **blank template**: on first run there is only the "observation point" and 8 layers (Diary, Daily Activity, Body, Emotion, People, Knowledge, Goals, Dream), with a single "Dream" node inside the Dream layer. Everything else is added by you, imported, or written in the diary drawer.

## Architecture

A single-file frontend + zero-dependency Node service + file storage. No database, no build step:

```text
Browser (index.html)
├─ Config     TEMPLATE: title, layers, demo data, pruning params, storage keys
├─ Render     Canvas 2D handwritten 3D projection; 8 views and motion
├─ Interaction select, search, layer filter, add node/layer, manual links, camera
├─ Data       nodes / edges / layers in memory; localStorage cache + PUT /api/graph
└─ Diary      text → POST /api/ai-parse → entities and relations → graph

Node service (server.js)
├─ Static     serves index.html; blocks data/ and hidden files
├─ Gate       login page + cookie session (12h, auto sign-out when idle)
├─ REST API   GET/PUT/DELETE /api/graph, POST /api/ai-parse,
│             POST /api/save-diary-txt, GET /health
├─ Storage    data/graph.json, *.bak (previous), diary_log.md (raw diary text)
└─ LLM proxy  calls DeepSeek server-side; LLM_API_KEY never reaches the frontend

Deploy chain: local docker build → push to Aliyun ACR → Sealos pulls and runs
              (single instance + PVC mounted at /app/data)
```

Data flow: changes go to localStorage first, then `PUT /api/graph` overwrites the server snapshot; the server copies the previous file to `.bak` before saving. The diary drawer also appends the raw text to `data/diary_log.md`.

## Features

- **3D nebula graph**: 8 views (Nebula, Small Galaxy, Cluster, List, Matrix, Sunburst, Mind Map, Reader) with rotate, zoom, pan and center-on-select.
- **Layer management**: 8 default layers (including Dream); add custom layers, show/hide individually, filter by title/description search.
- **Node editing**: add nodes, create links manually, edit description and weight; layers and nodes are stored in the snapshot.
- **AI diary fission**: one diary entry becomes 2–4 entities placed into semantic layers, connected back to the diary node with relations like contains / causes / triggers.
- **Synaptic pruning**: nodes not opened for a long time fade, then hide after the deadline; opening one restores it — a simulation of forgetting.
- **Import / export**: JSON snapshot import and export, Markdown export; the server supports `PUT` of a whole graph.
- **Privacy & gate**: login page + cookie session (12h), auto sign-out when idle, `data/` and hidden files are not reachable over HTTP.
- **Persistent deployment**: Sealos + PVC; restart or redeploy without losing data; single-instance writes to avoid conflicts.

## Quick start

```bash
npm start                 # same as node server.js
# open http://localhost:8787
```

Custom port:

```bash
# Windows PowerShell
$env:PORT=9000; node server.js
# macOS / Linux
PORT=9000 node server.js
```

Enable AI diary fission (Node >= 18):

1. Open `.env` in the project root and set `LLM_API_KEY=your-key` (you can also change `LLM_API_URL`, `LLM_MODEL`).
2. Restart: `npm start`.

`.env` is read by the server only, is listed in `.gitignore`, is never committed and never served to the frontend.

You can also override with environment variables (they take precedence):

```bash
# Windows PowerShell
$env:LLM_API_KEY='your key'; npm start
# macOS / Linux
LLM_API_KEY=your-key npm start
```

Optional: `LLM_API_URL` (default DeepSeek `https://api.deepseek.com/chat/completions`), `LLM_MODEL` (default `deepseek-chat`), `LLM_TIMEOUT_MS` (default 60000).

## Privacy & access control

The site holds private diaries, so set a password before exposing it to the internet:

```bash
# .env or platform environment variables
SITE_USER=your-user       # optional, defaults to admin
SITE_PASS=strong-password # required; without it the gate is off (a warning is printed at startup)
```

- With `SITE_PASS` set, an unauthenticated visit to `/` gets a built-in login page (`POST /api/login` verifies the credentials). On success the server sets an `msm_sess` session cookie (HttpOnly, 12 hours), so refreshes don't ask again. There is no browser Basic Auth dialog anymore.
- Without `SITE_PASS` the service still starts, but the gate is off — local debugging only.
- Nothing under `data/` (`graph.json`, `diary_log.md`, …) can be downloaded by URL; data is only returned in memory through `GET /api/graph`.
- Hidden files such as `.env` are never served.
- Login rate limiting: after 5 wrong passwords from one IP within 15 minutes, the IP is locked for 15 minutes and gets `429` even with the right password. Repeated requests with the same wrong credentials count only once, so browser retries cannot lock you out.
- The frontend signs out after 12 hours without mouse/keyboard activity: it calls `POST /api/logout`, clears the cookie and reloads to the login page.
- Graceful sign-out: the "登出" button in the top-right opens a full-screen frosted overlay ("🌌 The mirror has closed, the starlight is hidden for now" + "🚀 Reconnect"); reconnecting posts to `/api/logout`, destroying the server session and clearing the cookie, then reloads to the login page.
- Public HTTPS is provided by the platform (e.g. Sealos); nothing to do in code.

## Make it your own

Everything configurable lives in the `TEMPLATE` object at the top of `index.html`:

| Field | Meaning |
| --- | --- |
| `title` / `subtitle` / `version` | Page title, header name, version string |
| `hubTitle` / `hubDesc` | Name and description of the center node (observation point) |
| `layers` | Layer list: `id` (internal key — don't change after data exists), `label`, `color`, `desc` (shown when the layer is selected) |
| `demo` | `true` generates a few sample nodes; `false` starts with empty layers (template default) |
| `forgetStartDays` / `forgetHideDays` | Pruning: days before fading, days before hiding (default 30 / 90) |
| `source` | "Source xxx" in the header; leave empty to hide |
| `exportName` | Filename prefix for Markdown / JSON exports |
| `storageKey` / `presetKey` / `tokenKey` | Browser storage keys; use different prefixes when deploying several copies on one domain |

### Adding content

In the UI:

1. **New node**: click "＋ Add node", fill in title, layer, description and weight.
2. **New layer**: click "＋ Add layer", type a name; the layer is saved into the snapshot, so don't change its `id` afterwards.

Or in code — inside the `if (TEMPLATE.demo) { ... }` block of `index.html`:

```js
layer('knowledge', [
  // [title, description, weight (0.3–1), extra fields (optional)]
  ['Compounding', 'Returns that reinforce themselves over time.', 0.8],
  ['Sunk cost', 'A cost already paid and unrecoverable.', 0.6, { flag: '待补' }]
]);
```

### Importing data

The "Data" panel on the left imports JSON (restoring nodes, links and layers) and exports JSON / Markdown. Word and Markdown import are not supported. The server can also accept a whole JSON graph via `PUT /api/graph`.

Import is a **full overwrite**, not a merge: after picking a file a second confirmation dialog compares the current and incoming counts; on confirm the server archives the existing graph into `data/backups/` before writing the new one. Cancelling changes nothing, and no download-backup is made.

Manual linking: select a node → "＋ Link node" → click another node to create a `relates` edge drawn as a dashed line.

## Diary fission (AI)

Click the 📝 button at the bottom-right, write an entry and hit "Launch into the nebula". The page sends the text to `POST /api/ai-parse`, and the server asks the model to split it into 2–4 entities plus relations:

1. A new Diary-layer node (`diary_<timestamp>`) stores the full text.
2. Entities with the same name are reused; new ones are assigned by the AI to Daily Activity / Body / Emotion / People / Knowledge / Goals.
3. The diary node links to each entity with "contains"; entities use AI-detected relation words (causes, triggers, …).
4. New nodes are born at the parent position, scale up in one second and spread out via force repulsion.
5. The result is saved locally and to the server immediately.

Without `LLM_API_KEY` the endpoint returns a clear error and the page shows it — no silent failure.

## Layers

| Layer | What goes in |
| --- | --- |
| Diary | Diary entry nodes |
| Daily Activity | Laundry, commute, cooking, work |
| Body | Insomnia, fatigue, stomach ache, exercise |
| Emotion | Anxiety, joy, rumination, calm |
| People | Family, colleagues, friends |
| Knowledge | Knowledge, ideas, insights, books |
| Goals | Goals, plans, expectations |

The observation point stays the center node and is never filtered.

### Legacy data

If you saved a graph with the old layers (`core`, `events`, `note`, …), old nodes won't appear in the new layers and the left filter will misbehave. Back up and clear `data/graph.json` before testing the new structure:

```powershell
Copy-Item data\graph.json data\graph.old-layers.json
Remove-Item data\graph.json
```

The browser also keeps a cache; clear local data in the page and reload if needed.

## Views

Nebula, Small Galaxy, Cluster, List, Matrix, Sunburst, Mind Map, Reader — 8 in total. "Nebula" is the force-directed default; "Small Galaxy" is the layered orbit view.

## Interactions

| Action | Effect |
| --- | --- |
| Left drag | Rotate the camera |
| Wheel | Zoom around the cursor |
| Middle / right drag, Shift+left drag | Pan |
| Click a node | Select, center, show details on the right |
| Click a layer name | Select and center that layer |
| Layer checkbox | Show / hide that layer |
| Search box | Search title / description; click a result to select and center |
| "Display" panel | Node size, auto-rotate, name labels, all labels, cross-layer links, pruning, reset view |
| "Roam" | Start/stop unconscious roaming: the camera drifts slowly, periodically lights a distant, long-unconnected node, glides it to the center like a click, and shows its tooltip |
| "About" | Opens the About overlay; close with ×, the backdrop, or Esc |
| "Demo" | Local only (localhost / direct file open); loads 1000+ in-memory nodes without touching the server or cache |
| Esc / click empty space | Clear selection |

## Synaptic pruning (forgetting)

Each node records the last time it was opened (`la`). After `forgetStartDays` (30 by default) without opening, the node fades and its links thin; at `forgetHideDays` (90) it hides completely. The hub and layers are never pruned.

Hidden nodes are still reachable via search, List and Reader views; opening one restores brightness and resets the timer. "Display → Synaptic pruning" turns the whole mechanism off.

## Data & API

- Server data: `data/graph.json`; `data/` is in `.gitignore` and is never committed
- Before every save the previous file is copied to `*.bak` (one version only). Writes with `?backup=1` (used by full-overwrite import) additionally archive the old graph into `data/backups/` with a timestamped name
- `GET /api/graph` reads; `PUT` saves; `DELETE` clears (API only, no UI entry)
- `PUT` requires `nodes` / `edges` arrays, a `hub` node, at most 5000 nodes, no self-loops or links to missing nodes
- `POST /api/ai-parse` takes `{ text }` and returns `{ nodes, links }`; requires `LLM_API_KEY`
- `POST /api/save-diary-txt` takes `{ date, content, tags }` and appends the raw text to `data/diary_log.md` (plain-text backup, never overwritten)
- Write token: with `WRITE_TOKEN` set, writes (`PUT`/`DELETE /api/graph`, `POST /api/save-diary-txt`) must send an `x-write-token` header; the page accepts `?token=xxx` once to store it in the browser
- `GET /health` health check
- Access gate: with `SITE_PASS` set, all endpoints above (including `/health`) return `401` JSON when unauthenticated; pages get the login page, `POST /api/login` to sign in, `POST /api/logout` to sign out
- Single instance: never run several replicas writing the same data directory

## Deployment

The flow is "build locally with Docker → push to Aliyun ACR → let Sealos pull and run". Full steps (image build and push, Sealos app and env vars, PVC mount, verification, version updates, data backup, local docker run) are in [DEPLOY.md](DEPLOY.md).

The example uses container port `8787` and data directory `/app/data` (a persistent volume is required). Replace the domain and image address with your own — personal deployment details are not committed to this repository.

## Minimal implementation

- The page is a single `index.html` with no build step, no framework and no CDN dependency.
- The server has zero dependencies, using only Node built-in modules.
- All 3D projection and motion is handwritten Canvas 2D, easy to re-color and re-animate.

## Changelog

The full per-version history is in the Chinese [README.md](README.md#更新记录). Recent highlights:

### v2.4.0 · 2026-11-07 (image tag `2.4`)

- Access gate moved to an in-page login form with cookie sessions; the browser Basic Auth dialog is gone, and "Reconnect" no longer loops the prompt. Sessions last 12 hours and live in server memory.
- Graceful sign-out: "登出" opens a full-screen frosted overlay ("🌌 The mirror has closed, the starlight is hidden for now" + "🚀 Reconnect"); reconnecting calls `/api/logout`, clears the cache and reloads.
- JSON import is explicitly a full overwrite: a second confirmation compares counts, then the server archives the old graph into `data/backups/` before writing. No forced download.
- The List view nests diary entries under their date node, with the entry count shown beside the date.
- Footer reads "记忆海-镜子© 2026 By 路人", where the site name itself links to the open-source repository with a soft glow on hover.
- Inline base64 favicon from `logo.ico`, so single-file deployments keep the icon.
- Login throttling: repeated requests with the same wrong credentials count as one failure, so browser retries can't lock out a legitimate user.

### v2.3.0 · 2026-11-06 (image tag `2.3`)

- Login rate limiting (5 failures per IP / 15 minutes → 15-minute lock, `429` with `Retry-After`).
- Footer with copyright and live uptime counter.
- Mobile fixes: `viewport-fit=cover`, safe-area padding, horizontally scrollable header on narrow screens.
- Atmosphere copy replacing the old auto-generated description strings.
- Silent layout warm-up before the first frame (no more flying lines on load).
- Small Galaxy hub no longer drifts; roaming slowed to a 9–13 s interval.
- Demo data rebalanced to 129 content nodes / 138 light points / 381 links.
