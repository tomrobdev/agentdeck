//! The one way into the dashboard from outside it: an `agentdeck://` URL. The dashboard decides what a URL means
//! (`parseAppUrl` in `app/src/router.ts`); this file only brings the window forward and hands the URL over.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// The last URL opened and not yet routed. A link that starts the app arrives before the webview listens.
#[derive(Default)]
pub struct PendingUrl(Mutex<Option<String>>);

/// Show and focus the main window, then tell the dashboard to open `url`.
pub fn open_in_dashboard(app: &AppHandle, url: &str) {
    if let Some(pending) = app.try_state::<PendingUrl>()
        && let Ok(mut slot) = pending.0.lock()
    {
        *slot = Some(url.to_string());
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("open-url", url);
}

/// The URL waiting to be routed, if any. The dashboard calls it when it starts listening and after each `open-url`.
#[tauri::command]
pub fn take_open_url(app: AppHandle) -> Option<String> {
    app.try_state::<PendingUrl>()?.0.lock().ok()?.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_url_is_taken_once() {
        let pending = PendingUrl::default();
        *pending.0.lock().unwrap() = Some("agentdeck://new".into());
        assert_eq!(
            pending.0.lock().unwrap().take().as_deref(),
            Some("agentdeck://new")
        );
        assert_eq!(pending.0.lock().unwrap().take(), None);
    }
}
