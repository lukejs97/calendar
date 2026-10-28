# Calendar

A free, personal calendar app in the style of Fantastical, built on Google
Calendar with [Tauri v2](https://tauri.app/) (a Rust core plus a TypeScript web UI).
It runs on Windows and macOS.

**Phase 1** (this): sign in with Google, and see the next 14 days from all your
calendars as an agenda list.
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

## Where things are stored

- **Refresh token:** in your OS keychain under the service `com.mycalendar.app`.
  On Windows that's Credential Manager → Windows Credentials
  (`google-refresh-token.com.mycalendar.app`). On macOS it's Keychain Access.
- **Access token:** in memory only.
- **Sign out** deletes the keychain entry and asks Google to revoke the token.

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
