mod app_menu;
mod daemon_client;
mod dialogs;
mod notifications;
mod open;
mod service;
mod shortcuts;
mod terminal;
mod tray;
mod tray_window;

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
                // The tray window is placed under the icon each time it opens.
                .with_denylist(&[tray_window::LABEL])
                .build(),
        )
        .plugin(tauri_plugin_positioner::init())
        .manage(open::PendingUrl::default())
        .manage(tray_window::LastBlur::default())
        .invoke_handler(tauri::generate_handler![
            daemon_client::api_token,
            dialogs::pick_folder,
            open::take_open_url,
            service::start_daemon,
            terminal::cmux_installed,
            terminal::run_template,
            tray_window::open_from_tray
        ])
        .setup(|app| {
            app_menu::setup(app.handle())?;
            let mut tray = tray::setup(app)?;
            let mut notifications = notifications::setup(app.handle());
            daemon_client::watch(move |read| {
                tray(&read);
                notifications(&read);
            });
            shortcuts::register(app.handle());
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    open::open_in_dashboard(&handle, url.as_str());
                }
            });
            Ok(())
        })
        // Closing a window hides it to the tray; the daemon keeps working either way.
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                // Hiding is not quitting, so save the size and position now.
                let _ = window.app_handle().save_window_state(window_state_flags());
                let _ = window.hide();
                api.prevent_close();
            }
            // Clicking anywhere else closes the tray window.
            WindowEvent::Focused(false) if window.label() == tray_window::LABEL => {
                tray_window::on_blur(window.app_handle());
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
