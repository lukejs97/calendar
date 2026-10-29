//! Desktop only: the menu bar (on Windows, notification area) icon and its
//! small window, the quick-add keyboard shortcut, and staying open in the
//! menu bar when the main window is closed.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    App, AppHandle, Emitter, LogicalPosition, Manager, Monitor, PhysicalPosition, PhysicalSize, Rect, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// The menu bar icon's ID.
const TRAY: &str = "minuteman";
/// What's beside the icon now, to skip setting it again.
static MENU_BAR_TEXT: Mutex<Option<String>> = Mutex::new(None);

/// The menu bar window's label.
pub const FLYOUT: &str = "flyout";
/// Opens New event from anywhere: ⌥⌘N on a Mac, Ctrl+Alt+N on Windows.
pub const QUICK_ADD_SHORTCUT: &str = "CommandOrControl+Alt+N";

/// When the small window last hid itself because you clicked elsewhere.
static HIDDEN_ON_BLUR: Mutex<Option<Instant>> = Mutex::new(None);
/// Where the menu bar icon is (from its last click or hover), to open the
/// small window under it.
static TRAY_RECT: Mutex<Option<Rect>> = Mutex::new(None);
/// Whether the small window has been detached: a window of its own that stays
/// where you put it, and stays open when you click elsewhere.
static DETACHED: AtomicBool = AtomicBool::new(false);
/// When the app last moved the small window itself, to tell that from you
/// dragging it.
static PLACED: Mutex<Option<Instant>> = Mutex::new(None);
/// Room between the menu bar and the window (points).
const GAP: f64 = 4.0;

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
        .min_inner_size(320.0, 360.0)
        .resizable(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .initialization_script("window.__MINUTEMAN_FLYOUT__ = true;")
        .build()?;
    let window = flyout.clone();
    flyout.on_window_event(move |event| match event {
        // Like a menu: it goes away when you click elsewhere (unless detached).
        WindowEvent::Focused(false) if !DETACHED.load(Ordering::Relaxed) && window.is_visible().unwrap_or(false) => {
            let _ = window.hide();
            *HIDDEN_ON_BLUR.lock().expect("not poisoned") = Some(Instant::now());
        }
        // Dragged somewhere: detached, like a popover pulled off its icon.
        WindowEvent::Moved(_) if !DETACHED.load(Ordering::Relaxed) && window.is_visible().unwrap_or(false) => {
            let placed = *PLACED.lock().expect("not poisoned");
            if !placed.is_some_and(|at| at.elapsed() < Duration::from_millis(500)) {
                set_flyout_detached(window.app_handle(), true);
                let _ = window.emit("flyout-detached", ());
            }
        }
        _ => {}
    });
    Ok(())
}

fn create_tray(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Minuteman", true, None::<&str>)?;
    let new = MenuItem::with_id(app, "new", "New Event…", true, Some(QUICK_ADD_SHORTCUT))?;
    let quit = MenuItem::with_id(app, "quit", "Quit Minuteman", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &new, &quit])?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    TrayIconBuilder::with_id(TRAY)
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
            if let TrayIconEvent::Click { rect, .. }
            | TrayIconEvent::Enter { rect, .. }
            | TrayIconEvent::Move { rect, .. } = &event
            {
                *TRAY_RECT.lock().expect("not poisoned") = Some(*rect);
            }
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

/// Shows the small window under the menu bar icon (or where you left it, if
/// detached); `new_event` also opens New event in it.
pub fn show_flyout(app: &AppHandle, new_event: bool) {
    let Some(flyout) = app.get_webview_window(FLYOUT) else { return };
    if !DETACHED.load(Ordering::Relaxed) {
        place_under_icon(app, &flyout);
    }
    let _ = flyout.show();
    let _ = flyout.set_focus();
    let _ = flyout.emit(if new_event { "flyout-new" } else { "flyout-shown" }, ());
}

/// Detaches the small window (it stays put, and open, until you close it),
/// or puts it back under the menu bar icon.
pub fn set_flyout_detached(app: &AppHandle, detached: bool) {
    DETACHED.store(detached, Ordering::Relaxed);
    let Some(flyout) = app.get_webview_window(FLYOUT) else { return };
    // Detached, it's an ordinary window, which others can go in front of.
    let _ = flyout.set_always_on_top(!detached);
    if !detached {
        place_under_icon(app, &flyout);
    }
}

/// Moves the window just under the menu bar icon (on Windows, just above the
/// notification area icon), on the screen the icon is on.
///
/// Windows are placed in points on a Mac (the same on every screen) and in
/// pixels on Windows. The icon's place comes in its screen's pixels, and on a
/// Mac with screens of different scales that alone doesn't say which screen
/// (a pixel spot on one can be a pixel spot on another), so on a Mac the
/// screen is the one the pointer is on: when you click the icon, the icon's.
fn place_under_icon(app: &AppHandle, flyout: &WebviewWindow) {
    let mac = cfg!(target_os = "macos");
    let monitors = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten();
    // Pixels per unit of placement on screen `m`.
    let unit = |m: &Monitor| if mac { m.scale_factor() } else { 1.0 };
    let tray = *TRAY_RECT.lock().expect("not poisoned");
    let icon_pixels = tray.map(|rect| (rect.position.to_physical::<f64>(1.0), rect.size.to_physical::<f64>(1.0)));

    let screen = if mac {
        // The pointer comes in the main screen's pixels.
        let pointer = app.cursor_position().ok().zip(primary.as_ref()).map(|(at, main)| {
            PhysicalPosition::new(at.x / main.scale_factor(), at.y / main.scale_factor())
        });
        pointer.and_then(|at| monitors.iter().find(|m| contains(m, unit(m), at)))
    } else {
        icon_pixels.and_then(|(at, _)| monitors.iter().find(|m| contains(m, 1.0, at)))
    };
    let Some(screen) = screen.cloned().or(primary) else { return };
    let unit = unit(&screen);

    let Ok(size) = flyout.outer_size() else { return };
    let size = size.to_logical::<f64>(flyout.scale_factor().unwrap_or(1.0));
    // The window's size in this screen's units.
    let (width, height) = if mac {
        (size.width, size.height)
    } else {
        (size.width * screen.scale_factor(), size.height * screen.scale_factor())
    };
    let area = screen.work_area();
    let (left, top) = (area.position.x as f64 / unit, area.position.y as f64 / unit);
    let (right, bottom) = (left + area.size.width as f64 / unit, top + area.size.height as f64 / unit);
    let gap = GAP * screen.scale_factor() / unit;

    // The icon, if it's on this screen.
    let icon = icon_pixels
        .map(|(at, size)| (at.x / unit, at.y / unit, size.width / unit, size.height / unit))
        .filter(|&(x, y, ..)| contains(&screen, unit, PhysicalPosition::new(x, y)));
    let (x, y) = match icon {
        Some((x, y, icon_width, icon_height)) => {
            let x = x + icon_width / 2.0 - width / 2.0;
            // Under the icon if it's at the top of the screen, else above it.
            let y = if y < (top + bottom) / 2.0 { y + icon_height + gap } else { y - height - gap };
            (x, y)
        }
        // Not clicked or hovered yet, or on another screen: the top right corner.
        None => (right - width - gap, top + gap),
    };
    let x = x.min(right - width - gap).max(left + gap);
    let y = y.min(bottom - height).max(top);
    *PLACED.lock().expect("not poisoned") = Some(Instant::now());
    if mac {
        let _ = flyout.set_position(LogicalPosition::new(x, y));
    } else {
        let _ = flyout.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    }
}

/// Whether `at` (in pixels over `unit`) is on screen `monitor`.
fn contains(monitor: &Monitor, unit: f64, at: PhysicalPosition<f64>) -> bool {
    let (origin, size): (&PhysicalPosition<i32>, &PhysicalSize<u32>) = (monitor.position(), monitor.size());
    let (x, y) = (origin.x as f64 / unit, origin.y as f64 / unit);
    let (width, height) = (size.width as f64 / unit, size.height as f64 / unit);
    at.x >= x && at.x < x + width && at.y >= y && at.y < y + height
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

/// Puts `text` (the next event) beside the menu bar icon, or nothing. On
/// Windows, where icons have no text, it's the icon's tooltip instead.
pub fn set_menu_bar_text(app: &AppHandle, text: Option<String>) {
    let mut shown = MENU_BAR_TEXT.lock().expect("not poisoned");
    if *shown == text {
        return;
    }
    let Some(tray) = app.tray_by_id(TRAY) else { return };
    if cfg!(target_os = "macos") {
        let _ = tray.set_title(text.as_deref());
    } else {
        let _ = tray.set_tooltip(Some(text.as_deref().unwrap_or("Minuteman")));
    }
    *shown = text;
}
