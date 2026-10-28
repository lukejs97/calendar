# Calendar

A free, personal calendar app in the style of Fantastical, built on Google
Calendar with [Tauri v2](https://tauri.app/) (a Rust core plus a TypeScript web UI).
It runs on Windows and macOS.

**Phase 1** (this): sign in with Google, and see all your calendars in Day,
Week, Month, Year and Agenda views.

**Add events**: click **+** in the top bar (or press `N`) and type something
like "Lunch with Sam tomorrow 1pm at Cafe Roma" or "Conference Nov 12-14 in
Berlin". A preview shows what the app understood; pick the calendar and click
**Add**. Accounts added before this feature existed need adding again once
(Accounts → Add account) to give permission.

**More than one Google account**: click **Accounts** in the top bar, then
**Add account**, and pick the other account in your browser. Events from all
accounts appear together. Remove an account from the same dialog. While the
Google project is in **Testing**, add the extra account as a test user first
([docs/google-cloud-setup.md](docs/google-cloud-setup.md#6-publish-the-app-in-production)).

**Todoist** (optional): click **Todoist** in the top bar and paste your API
token from Todoist → Settings → Integrations → Developer. Tasks with a due
date then appear with a checkbox in every view, overdue ones on today. Ticking
one completes it in Todoist. The token is kept in your OS keychain.

Keyboard: `D` `W` `M` `Y` `A` switch views, `T` jumps to today, `N` adds an
event, `←` `→` go back and forward. Click an event to open it in Google Calendar. Click a date
(in the week header, month grid or year view) to open that day.

To work on the UI without the Rust side, run `npm run dev` and open
<http://localhost:1420> in a browser. It shows sample events (from
`src/dev-mock.ts`, which isn't included in real builds).
For what comes next and how the code is organized, see [docs/architecture.md](docs/architecture.md).

## Prerequisites

- Node.js 20+
- Rust (via [rustup](https://rustup.rs/))
- Windows: Microsoft C++ Build Tools ("Desktop development with C++") and
  WebView2. WebView2 comes with Windows 11.
- macOS: Xcode Command Line Tools (`xcode-select --install`)

Details: <https://tauri.app/start/prerequisites/>

## Setup

1. Do the one-time Google setup in [docs/google-cloud-setup.md](docs/google-cloud-setup.md).
2. Copy `src-tauri/.env.example` to `src-tauri/.env` and fill in your client ID and secret.
3. Install and run:

   ```bash
   npm install
   npm run tauri dev
   ```

   The first run compiles all the Rust dependencies, which takes a few minutes.
   Later runs are quick.

To build an installer: `npm run tauri build`. Output goes to `src-tauri/target/release/bundle/`.

### Installing on a Mac without developer tools

GitHub can build the Mac app for you (`.github/workflows/build-macos.yml`):

1. Once: in the repo on GitHub, Settings → Secrets and variables → Actions →
   **New repository secret**. Add `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET` with the values from `src-tauri/.env`.
2. Actions tab → **Build macOS app** → **Run workflow**. It takes about
   10–15 minutes.
3. Open the finished run, download **Calendar-macOS** under Artifacts, unzip
   it, open the `.dmg` and drag Calendar to Applications.
4. The first time, macOS blocks it because the app isn't notarized (Apple's
   paid check): System Settings → Privacy & Security → **Open Anyway**.
5. When asked whether Calendar may use its keychain item, choose
   **Always Allow**.

The build runs for Apple Silicon and Intel Macs. Private repos get free monthly
Actions minutes; a Mac build uses a small share of them.

## Where things are stored

- **Refresh tokens:** one per Google account, together in one entry in your OS
  keychain under the service `com.mycalendar.app`. On Windows that's Credential
  Manager → Windows Credentials (`google-accounts.com.mycalendar.app`). On
  macOS it's Keychain Access. (Older versions used `google-refresh-token`; the
  app moves it over the first time it runs.)
- **Access tokens:** in memory only.
- **Removing an account** (Accounts → Remove) deletes its token from the
  keychain and asks Google to revoke it.

On macOS, unsigned development builds may ask for Keychain access after each
rebuild. Click "Always Allow".

## Glossary

- **OAuth**: the standard way for an app to get permission to use your Google
  account without ever seeing your password. You sign in on Google's own page,
  and Google gives the app tokens.
- **Client ID / client secret**: identify *the app* (not you) to Google.
- **Scope**: one specific permission, e.g. "read your calendars".
- **Consent screen**: Google's "Calendar wants to access your account" page.
- **Access token**: a short-lived (about 1 hour) pass sent with each API request.
- **Refresh token**: a long-lived key the app uses to get new access tokens
  without asking you to sign in again. Treat it like a password, which is why
  it goes in the keychain.
- **PKCE** ("pixie", Proof Key for Code Exchange): before sign-in the app makes
  a random secret and sends Google only its hash. When the app trades Google's
  one-time code for tokens, it reveals the secret. Another program that
  intercepted the code can't use it, because it doesn't have the secret.
- **Loopback redirect**: after you approve, Google sends your browser to
  `http://127.0.0.1:<port>`. That's your own computer, where the app is briefly
  listening, so the app receives the one-time code.
- **Keychain**: the operating system's encrypted password store.
- **Tauri command**: a Rust function the TypeScript UI can call. `invoke("get_agenda")` runs `get_agenda` in `src-tauri/src/lib.rs`.
- **Web view**: the built-in browser engine that draws the UI (WebView2 on
  Windows, WebKit on macOS). It's why Tauri apps are small.
