//! Desktop only: the menu bar (on Windows, notification area) icon and its
//! small window, the quick-add keyboard shortcut, and staying open in the
//! menu bar when the main window is closed.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_positioner::{Position, WindowExt};

/// The menu bar window's label.
pub const FLYOUT: &str = "flyout";
/// Opens New event from anywhere: ⌥⌘N on a Mac, Ctrl+Alt+N on Windows.
pub const QUICK_ADD_SHORTCUT: &str = "CommandOrControl+Alt+N";

/// When the small window last hid itself because you clicked elsewhere.
static HIDDEN_ON_BLUR: Mutex<Option<Instant>> = Mutex::new(None);

pub fn setup(app: &mut App) -> tauri::Result<()> {
    create_flyout(app)?;
    create_tray(app)?;

    // The shortcut may already belong to another app; then it's just not available.
    let registered = app.global_shortcut().on_shortcut(QUICK_ADD_SHORTCUT, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            show_flyout(app, true);
        }
    });
    if let Err(e) = registered {
        eprintln!("Couldn't register {QUICK_ADD_SHORTCUT}: {e}");
    }

    // Closing the main window keeps the app (and its alerts) running in the
    // menu bar; Quit is in the icon's menu, or ⌘Q.
    if let Some(main) = app.get_webview_window("main") {
        let window = main.clone();
        main.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        });
    }
    Ok(())
}

/// The small window under the menu bar icon: the next few days, and quick add.
/// It loads the same page, which shows the compact layout when it sees
/// `window.__MINUTEMAN_FLYOUT__`.
fn create_flyout(app: &App) -> tauri::Result<()> {
    let flyout = WebviewWindowBuilder::new(app, FLYOUT, WebviewUrl::App("index.html".into()))
        .title("Minuteman")
        .inner_size(380.0, 600.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .initialization_script("window.__MINUTEMAN_FLYOUT__ = true;")
        .build()?;
    // Like a menu: it goes away when you click elsewhere.
    let window = flyout.clone();
    flyout.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event
            && window.is_visible().unwrap_or(false)
        {
            let _ = window.hide();
            *HIDDEN_ON_BLUR.lock().expect("not poisoned") = Some(Instant::now());
        }
    });
    Ok(())
}

fn create_tray(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Minuteman", true, None::<&str>)?;
    let new = MenuItem::with_id(app, "new", "New Event…", true, Some(QUICK_ADD_SHORTCUT))?;
    let quit = MenuItem::with_id(app, "quit", "Quit Minuteman", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &new, &quit])?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    TrayIconBuilder::with_id("minuteman")
        .icon(icon)
        // The app's own logo, in its colours (icons/source/tray.svg).
        .icon_as_template(false)
        .tooltip("Minuteman")
        .menu(&menu)
        // Left click: the small window; right click: the menu.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "new" => show_flyout(app, true),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Remembers where the icon is, to place the window under it.
            tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_flyout(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn toggle_flyout(app: &AppHandle) {
    // Clicking the icon while the window is open first takes focus from it,
    // which hides it; that click should leave it closed, not reopen it.
    let hidden_at = *HIDDEN_ON_BLUR.lock().expect("not poisoned");
    if hidden_at.is_some_and(|at| at.elapsed() < Duration::from_millis(300)) {
        return;
    }
    match app.get_webview_window(FLYOUT) {
        Some(flyout) if flyout.is_visible().unwrap_or(false) => {
            let _ = flyout.hide();
        }
        _ => show_flyout(app, false),
    }
}

/// Shows the small window under the menu bar icon; `new_event` also opens
/// New event in it.
pub fn show_flyout(app: &AppHandle, new_event: bool) {
    let Some(flyout) = app.get_webview_window(FLYOUT) else { return };
    let under_icon = if cfg!(target_os = "macos") { Position::TrayBottomCenter } else { Position::TrayCenter };
    // Before the icon has been clicked or hovered its place isn't known yet.
    if flyout.move_window_constrained(under_icon).is_err() {
        let _ = flyout.move_window(Position::TopRight);
    }
    let _ = flyout.show();
    let _ = flyout.set_focus();
    let _ = flyout.emit(if new_event { "flyout-new" } else { "flyout-shown" }, ());
}

pub fn show_main(app: &AppHandle) {
    if let Some(flyout) = app.get_webview_window(FLYOUT) {
        let _ = flyout.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}
