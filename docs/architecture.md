# Architecture and roadmap

## How the pieces fit

```
┌──────────── Web view (TypeScript, src/) ────────────┐
│ main.ts    app shell: sign-in screen ↔ agenda       │
│ agenda.ts  renders AgendaItem[] grouped by day      │
│ api.ts     typed invoke() wrappers                  │
└───────────────────────┬─────────────────────────────┘
                        │ invoke("get_agenda") etc. (Tauri IPC)
┌───────────────────────┴──── Rust (src-tauri/src/) ──┐
│ lib.rs             commands + shared state          │
│ agenda.rs          AgendaItem model, merge + sort   │
│ google/auth.rs     OAuth PKCE + loopback, tokens    │
│ google/calendar.rs Calendar API v3 client           │
│ secrets.rs         OS keychain                      │
│ error.rs           AppError → { kind, message }     │
└─────────────────────────────────────────────────────┘
```

Design rules:

1. **Tokens never reach the web view.** Every network call and secret lives in
   Rust. The web view gets only agenda data. If a malicious event title ever
   ran script in the web view (the UI only uses `textContent`, so it shouldn't),
   it still couldn't read your tokens.
2. **One model for everything on the agenda.** `AgendaItem` has `source`
   (`google`, later `todoist`) and `kind` (`event`, later `task`). New sources
   add items to the list; the UI doesn't need to know where they came from.
3. **The renderer is reusable.** `renderAgenda` takes data in and puts DOM out.
   The tray flyout will call the same code with a one-day range.

## Phase 2: tray icon and flyout

- Enable Tauri's `tray-icon` feature in `Cargo.toml` and build a `TrayIconBuilder`
  in `lib.rs` `setup`.
- Add a second window, label `flyout`, to `tauri.conf.json`: `decorations: false`,
  `skipTaskbar: true`, `alwaysOnTop: true`, `visible: false`, about 360×480.
  It loads the same `index.html?view=flyout`, and `main.ts` chooses a compact layout.
- On tray click, use `tauri-plugin-positioner` (`Position::TrayBottomCenter`
  on Windows, `TrayCenter` on macOS) to place the window above the taskbar
  or below the menu bar, then show and focus it. Hide it on blur.
- Add `"flyout"` to the `windows` list in `capabilities/default.json`.
- Optionally keep the app running when the main window closes (handle
  `CloseRequested` → hide) so the tray stays available.

## Phase 2: Todoist

- Todoist's personal API token is free (Todoist Settings → Integrations → Developer).
  Store it with `secrets::set(TODOIST_TOKEN, …)`. No OAuth is needed for a personal app.
- Add `src-tauri/src/todoist.rs`, which calls the Todoist API for tasks
  with due dates in the agenda range and maps them to
  `AgendaItem { source: Todoist, kind: Task, … }`.
- Add `Todoist` / `Task` variants to `Source` / `ItemKind` (and the TS
  union types in `api.ts`), and merge in `agenda::load`.
- The UI shows tasks with a checkbox. Completing one becomes a new
  `complete_task` command.

## Phase 3: natural-language creation

- Parsing runs locally and for free: e.g. [`chrono-node`](https://github.com/wanasit/chrono)
  in TypeScript turns "lunch with Sam tomorrow 1pm" into a title and a date.
  Show a live preview before saving, like Fantastical.
- A leading keyword or prefix ("task:", or a toggle) sends the item to Todoist.
  Otherwise it becomes a Google event.
- Add the `calendar.events` scope in `google/auth.rs` and on the consent
  screen. Existing users sign in again once to grant it.
- New Rust commands: `create_event` (POST `calendars/{id}/events`) and
  `create_task` (Todoist).

## Mobile later

- **Tauri v2 mobile:** the Rust core and the web UI are reused as they are. `keyring`'s
  `apple-native` feature also covers iOS. Android needs a different secure
  store (Android Keystore), e.g. via a Tauri plugin, behind the same
  `secrets.rs` functions. The loopback sign-in is replaced by a custom URL scheme or
  app link redirect with an "iOS" or "Android" OAuth client type.
- **PWA alternative:** the TypeScript UI could run in a browser, but OAuth
  and token storage would have to move to browser-safe flows (no client
  secret, no keychain). That's a bigger change, so Tauri mobile is the
  smoother path.
