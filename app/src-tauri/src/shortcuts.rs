//! Global shortcuts: keys that work while another app is in front. They only bring the dashboard forward;
//! what a link means is the dashboard's call (see `open.rs`).

use crate::open::open_in_dashboard;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

/// The shortcuts, in one place: ⌃⌥A shows the dashboard, ⌃⌥N opens New task. Each opens an `agentdeck://` URL.
const MODIFIERS: Modifiers = Modifiers::CONTROL.union(Modifiers::ALT);
const SHORTCUTS: [(Code, &str); 2] = [
    (Code::KeyA, "agentdeck://"),
    (Code::KeyN, "agentdeck://new"),
];

fn shortcut(code: Code) -> Shortcut {
    Shortcut::new(Some(MODIFIERS), code)
}

/// The URL a shortcut opens, if it is one of ours.
fn url_for(pressed: &Shortcut) -> Option<&'static str> {
    SHORTCUTS
        .iter()
        .find(|(code, _)| &shortcut(*code) == pressed)
        .map(|(_, url)| *url)
}

/// The plugin, with its handler.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(
            |app: &AppHandle, pressed: &Shortcut, event: ShortcutEvent| {
                if event.state() == ShortcutState::Pressed
                    && let Some(url) = url_for(pressed)
                {
                    open_in_dashboard(app, url);
                }
            },
        )
        .build()
}

/// Register the shortcuts. One another app holds is logged and skipped: the app still starts.
pub fn register(app: &AppHandle) {
    for (code, _) in SHORTCUTS {
        let s = shortcut(code);
        if let Err(err) = app.global_shortcut().register(s) {
            eprintln!("agentdeck: shortcut {s} not registered: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_shortcut_has_its_own_url() {
        assert_eq!(url_for(&shortcut(Code::KeyA)), Some("agentdeck://"));
        assert_eq!(url_for(&shortcut(Code::KeyN)), Some("agentdeck://new"));
        assert_eq!(url_for(&shortcut(Code::KeyB)), None);
    }
}
