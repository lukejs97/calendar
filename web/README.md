# Minuteman on the web

The website version of Minuteman: the same screens as the desktop app, served
by one free **Cloudflare Worker** (a small server running on Cloudflare's
network), which also does what the desktop app's Rust side does.

```
browser ──► Worker (web/src) ──► Google Calendar, Todoist
  │           │
  │           └─ KV store: Google refresh tokens + Todoist token, encrypted
  └─ only an HttpOnly session cookie (page scripts can't read it)
```

- `src/index.ts`: routes, sign-in pages, sessions, security headers
- `src/commands.ts`: `/api/<command>`, same names and arguments as the desktop
  app's Rust commands (`src-tauri/src/lib.rs`)
- `src/google.ts`, `src/todoist.ts`, `src/agenda.ts`: ports of the Rust
  engine (`google/*.rs`, `todoist.rs`, `agenda.rs`, `search.rs`). Keep them in
  step when the desktop behavior changes.
- `src/zone.ts`: the server runs in UTC, so the browser sends its time zone
  (`X-Time-Zone`) and "today"/midnight are worked out in it.
- `../src/web-bridge.ts`: in the browser, sends the app's commands here.

**Not on the web:** the menu bar window, the quick-add shortcut, alerts while
the site is closed, and offline mode. Signing out of one browser (Settings → This
browser → Sign out) doesn't affect other devices; removing an account under
Settings → Google accounts removes it everywhere.

**Free-plan limits:** Cloudflare's free plan allows 100,000 requests a day
and 50 outside requests per request. Each Google calendar is one outside
request, so a page needs roughly (calendars + 3) of them. If a view ever fails
with a limit error, the $5/month Workers plan raises it.

## Google sign-in client (once)

Google Cloud Console → project `calendar-app-513002` → Google Auth Platform →
Clients → **Create client** → **Web application**, named "Minuteman web".
Authorized redirect URIs:

- `http://localhost:8787/auth/google/callback` (testing on your PC)
- `https://minuteman.<your-subdomain>.workers.dev/auth/google/callback` (the live site)

Copy the client ID and secret.

## Run it on your PC

1. `cd web && npm install`
2. Put the client ID and secret in `web/.dev.vars` (git-ignored):

   ```
   GOOGLE_CLIENT_ID=…
   GOOGLE_CLIENT_SECRET=…
   TOKEN_KEY=…   # 32 random bytes, base64
   MINUTEMAN_ROUTES_API_KEY=…   # optional; leave-by traffic. Never commit this file.
   ```

   Make a TOKEN_KEY with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
3. `npm run dev`, then open <http://localhost:8787>.

## Put it online (once)

1. `npx wrangler login` signs in to your (free) Cloudflare account.
2. `npx wrangler kv namespace create STORE`, then put the id it prints in
   `wrangler.jsonc` (`kv_namespaces`).
3. Set the secrets; each command asks for the value:

   ```
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put TOKEN_KEY
   npx wrangler secret put MINUTEMAN_ROUTES_API_KEY
   ```

   The Routes key is optional. Without it, Settings → Leave from still saves
   a default address, and leave-by times stay hidden. With it, the Worker
   asks Google for traffic and counts every attempt against the same free-tier
   cap as the desktop app (80 a day and 2,500 a month unless you lower them).
   Also set a per-day quota of 160 on the Routes API in Google Cloud so the
   desktop app and the website together cannot be billed
   ([docs/google-cloud-setup.md](../docs/google-cloud-setup.md)). The key is
   never sent to the browser.

   Use a **new** TOKEN_KEY for the live site, not the one in `.dev.vars`.
4. `npm run deploy`. It prints the site's address,
   `https://minuteman.<your-subdomain>.workers.dev`. Add that address's
   `/auth/google/callback` to the Google client's redirect URIs (above).

To update the site later: `npm run deploy` again, or let GitHub do it
(no computer needed): add a `CLOUDFLARE_API_TOKEN` repository secret, made
in Cloudflare → My Profile → API Tokens → Create Token → **Edit Cloudflare
Workers**, then Actions → **Deploy web app** → **Run workflow**
(`.github/workflows/deploy-web.yml`). It deploys the branch you pick.

Only the Google accounts in `ALLOWED_EMAILS` (`wrangler.jsonc`) can sign in.
Once signed in, you can add other Google accounts of yours under Settings → Google
accounts.
