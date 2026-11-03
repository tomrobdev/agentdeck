//! The small window under the tray icon, labelled `tray` (declared in `tauri.conf.json`). It loads the dashboard at
//! `#/tray` (`app/src/components/layout/TrayView.vue`), which reads the daemon itself; this file only shows, places and
//! hides the window, and opens a task in the main window for it.

use crate::open::open_in_dashboard;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, PhysicalPosition, Rect, Runtime};
use tauri_plugin_positioner::{Position, WindowExt};

pub const LABEL: &str = "tray";

/// A click on the tray icon takes focus from the window before the click arrives, so the window has just hidden itself.
/// A click this soon after that is the same click, and closes the window instead of opening it again.
const SAME_CLICK: Duration = Duration::from_millis(300);

/// When the window last hid itself on losing focus.
#[derive(Default)]
pub struct LastBlur(Mutex<Option<Instant>>);

/// Whether a click on the icon at `now` should open the window, given whether it is open and when it last lost focus.
fn should_open(visible: bool, last_blur: Option<Instant>, now: Instant) -> bool {
    !visible && last_blur.is_none_or(|at| now.saturating_duration_since(at) >= SAME_CLICK)
}

/// A left-click on the tray icon: open the window under `icon`, or close it if it is open.
pub fn toggle<R: Runtime>(app: &AppHandle<R>, icon: Rect) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let last_blur = app
        .try_state::<LastBlur>()
        .and_then(|s| s.0.lock().ok().and_then(|mut slot| slot.take()));
    if !should_open(visible, last_blur, Instant::now()) {
        let _ = window.hide();
        return;
    }
    if let Err(e) = window.move_window(Position::TrayCenter) {
        eprintln!("tray window: couldn't place it: {e}");
    }
    // On macOS the positioner puts the window's top at the icon's top, over the menu bar: move it just below the icon.
    let bottom = icon.position.to_physical::<f64>(1.0).y + icon.size.to_physical::<f64>(1.0).height;
    if let Ok(at) = window.outer_position()
        && (at.y as f64) < bottom
    {
        let _ = window.set_position(PhysicalPosition::new(at.x as f64, bottom));
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// The window lost focus: hide it, and note when, for `toggle`.
pub fn on_blur<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(LABEL)
        && window.is_visible().unwrap_or(false)
    {
        let _ = window.hide();
        if let Some(state) = app.try_state::<LastBlur>()
            && let Ok(mut slot) = state.0.lock()
        {
            *slot = Some(Instant::now());
        }
    }
}

/// From the tray window: open an `agentdeck://` URL in the main window, and hide the tray window.
#[tauri::command]
pub fn open_from_tray(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("agentdeck://") {
        return Err(format!("not an agentdeck:// link: {url}"));
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
    open_in_dashboard(&app, &url);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_click_opens_a_closed_window() {
        let now = Instant::now();
        assert!(should_open(false, None, now));
        assert!(should_open(false, Some(now - Duration::from_secs(2)), now));
    }

    #[test]
    fn a_click_closes_an_open_window() {
        assert!(!should_open(true, None, Instant::now()));
    }

    #[test]
    fn the_click_that_took_focus_away_does_not_reopen_it() {
        let now = Instant::now();
        let blur = now - Duration::from_millis(50);
        assert!(!should_open(false, Some(blur), now));
    }
}
