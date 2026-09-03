# suno-mcp

An MCP server that gives Poke (or any MCP-compatible agent) tools to generate
music via a Suno API provider.

Suno has no official public API, so this points at a third-party provider
(default: [sunor.cc](https://sunor.cc), pay-as-you-go with free trial
credits). Swap `SUNO_API_BASE` and the request/response shapes in
`src/server.js` if you switch providers later — endpoint paths and field
names vary between them.

## Tools exposed

- **generate_song** — start a generation job from a prompt or lyrics
- **get_song_status** — poll a job by `taskId`, returns the audio URL when done

## 1. Local setup

```bash
npm install
cp .env.example .env
# edit .env: paste your SUNO_API_KEY
npm start
```

Server listens on `http://localhost:3000`, MCP endpoint at `POST /mcp`.

Health check: `GET /healthz`

## 2. Deploy it somewhere public

Poke needs to reach this over the internet, so it has to be deployed, not
just run locally. Any Node host works — a few easy options:

**Railway**
```bash
npm i -g @railway/cli
railway init
railway up
railway variables set SUNO_API_KEY=your_key MCP_SERVER_SECRET=your_secret
```

**Render** — connect the repo, set the build command `npm install`, start
command `npm start`, and add `SUNO_API_KEY` / `MCP_SERVER_SECRET` as
environment variables in the dashboard.

**Fly.io**
```bash
fly launch --no-deploy
fly secrets set SUNO_API_KEY=your_key MCP_SERVER_SECRET=your_secret
fly deploy
```

Whichever you use, set `MCP_SERVER_SECRET` in production — without it,
anyone who finds your URL can call your Suno API key's quota.

## 3. Connect it to Poke

1. In Poke, go to Settings → Connections → **add a Custom MCP integration**.
2. Enter your deployed URL with the `/mcp` path, e.g.
   `https://your-app.up.railway.app/mcp`.
3. If you set `MCP_SERVER_SECRET`, add it as the integration's bearer token /
   auth header in Poke's connection settings.
4. Save, then just ask Poke to make you a song — it'll call `generate_song`,
   and you can ask it to check on progress, which calls `get_song_status`.

## Notes

- Generation is asynchronous — expect `generate_song` to return a `taskId`,
  not a finished track. Poke will naturally say "still rendering" and check
  back if you ask it to.
- Response field names above are illustrative — check your provider's docs
  and adjust the `sunoFetch` calls in `src/server.js` to match exactly.
