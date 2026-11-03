mod daemon_client;
mod dialogs;
mod open;
mod shortcuts;
mod terminal;
mod tray;

use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// The window state to keep: size and position, not whether it is visible (the tray decides that).
fn window_state_flags() -> StateFlags {
    StateFlags::all() - StateFlags::VISIBLE
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(shortcuts::plugin())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .build(),
        )
        .manage(open::PendingUrl::default())
        .invoke_handler(tauri::generate_handler![
            dialogs::pick_folder,
            open::take_open_url,
            terminal::cmux_installed,
            terminal::run_template
        ])
        .setup(|app| {
            tray::setup(app)?;
            shortcuts::register(app.handle());
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    open::open_in_dashboard(&handle, url.as_str());
                }
            });
            Ok(())
        })
        // Closing the window hides it to the tray; the daemon keeps working either way.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Hiding is not quitting, so save the size and position now.
                let _ = window.app_handle().save_window_state(window_state_flags());
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
