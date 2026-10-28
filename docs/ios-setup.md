# iPhone (iOS) setup — done on the Mac

The code is ready for iOS, but iPhone apps can only be built on a Mac with
Xcode. This guide is for you **and** for Claude Code running on the Mac.

## What's already done (on the Windows PC)

- **App ID** (bundle ID) is `com.lukesassa.calendar` (`src-tauri/tauri.conf.json`).
- **Google iOS sign-in client** "Calendar iOS" exists in the Google Cloud
  project `calendar-app-513002`, for bundle ID `com.lukesassa.calendar`.
  Client ID (not a secret):
  `454006958306-jt3q1gtalsp37n0r1bkkn6nputgu3ab4.apps.googleusercontent.com`
- **Sign-in flow for iOS** (`src-tauri/src/google/auth.rs`): opens Google in
  Safari; Google sends the browser to
  `com.googleusercontent.apps.454006958306-jt3q1gtalsp37n0r1bkkn6nputgu3ab4:/oauth2redirect`;
  iOS opens the app with that link (Tauri's deep-link plugin, configured under
  `plugins → deep-link` in `tauri.conf.json`), and the app finishes signing in.
  iOS clients have no client secret; PKCE protects the sign-in.
- **Phone layout**: safe areas for the notch/home bar, swipe left/right to
  move between days/weeks, larger tap targets, Agenda as the first view.

**Not yet verified** (the first iOS build will tell):

1. The iOS-only Rust code (`#[cfg(mobile)]` parts of `google/auth.rs` and
   `lib.rs`) has never been compiled. Fix any compile errors.
2. The `keyring` crate's `apple-native` feature is expected to use the iOS
   Keychain. If it doesn't build or work on iOS, switch `secrets.rs` to an
   iOS-capable store.
3. The deep-link plugin should add the URL scheme to the app's Info.plist
   (`CFBundleURLTypes`). Check `src-tauri/gen/apple/` after `ios init`.

## 1. Install the tools (once)

1. **Xcode** from the Mac App Store (large download). Open it once, accept
   the license, and let it install its components. Also install an iOS
   Simulator if it offers (Xcode → Settings → Components).
2. **Homebrew** (a free package manager for macOS), if not installed:
   see <https://brew.sh>.
3. In Terminal:

   ```bash
   brew install node cocoapods gh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
   ```

   (Restart Terminal after installing Rust.) Full list:
   <https://tauri.app/start/prerequisites/#ios>

## 2. Get the code onto the Mac

The project is in a **private** GitHub repo, `lukejs97/calendar`:

```bash
gh auth login
gh repo clone lukejs97/calendar
cd calendar
npm install
```

## 3. Create `src-tauri/.env`

`.env` is deliberately not in GitHub. For iPhone builds it needs only the iOS
client ID:

```
GOOGLE_IOS_CLIENT_ID=454006958306-jt3q1gtalsp37n0r1bkkn6nputgu3ab4.apps.googleusercontent.com
```

To also run the **Mac desktop** version, copy the whole `.env` from the Windows
PC (it holds the desktop client secret, so move it privately, e.g. AirDrop or
a Bitwarden secure note, not email or GitHub).

## 4. Set up the Xcode project and signing

1. Xcode → Settings → Accounts → **+** → sign in with your Apple ID. This
   creates a free "Personal Team".
2. Find your **Team ID** (10 characters) there, or at
   <https://developer.apple.com/account> → Membership.
3. Add it to `src-tauri/tauri.conf.json` under `bundle → iOS`:

   ```json
   "iOS": { "minimumSystemVersion": "16.0", "developmentTeam": "ABCDE12345" }
   ```

4. Generate the Xcode project:

   ```bash
   npm run tauri ios init
   ```

## 5. Run it

- **Simulator** (free, no limits):

  ```bash
  npm run tauri ios dev
  ```

  Pick an iPhone simulator when asked.
- **Your iPhone**: plug it in, then on the phone turn on
  Settings → Privacy & Security → **Developer Mode** (it restarts). Run
  `npm run tauri ios dev` and pick the phone. The first time, trust the
  developer on the phone: Settings → General → VPN & Device Management.
  In dev mode the phone loads the UI from the Mac, so keep both on the same
  Wi-Fi. For a standalone install, build with `npm run tauri ios build`
  (see `npm run tauri ios build -- --help` for signing/export options).

With a free Apple ID, apps installed on a real iPhone **stop opening after
7 days**; rebuild/reinstall from the Mac to renew. Apple's paid developer
program ($99/year) removes that limit.

## 6. Test sign-in

1. Tap **Sign in with Google**. Safari opens Google's page.
2. Pick `lukesassa9@gmail.com` (it's a test user of the Google project), tap
   **Continue** on the "hasn't verified this app" screen, allow calendar access.
3. Safari asks to open "Calendar"; tap **Open**. The agenda should load.

Then connect Todoist (top bar → Todoist) by pasting the API token.

## Prompt for Claude Code on the Mac

> Read docs/ios-setup.md. The iOS code was written on Windows and has never
> been built. Help me through steps 1–6: install what's missing, run
> `npm run tauri ios init`, fix any iOS build errors (especially the
> `#[cfg(mobile)]` code in src-tauri/src/google/auth.rs and lib.rs, keyring on
> iOS, and the deep-link URL scheme in Info.plist), and get it running in the
> Simulator, then on my iPhone. Don't change the desktop behavior.
