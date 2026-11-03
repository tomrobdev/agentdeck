mod dialogs;
mod open;
mod terminal;
mod tray;

use tauri::WindowEvent;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_deep_link::DeepLinkExt;

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
        .manage(open::PendingUrl::default())
        .invoke_handler(tauri::generate_handler![
            dialogs::pick_folder,
            open::take_open_url,
            tray::set_tray_status,
            terminal::cmux_installed,
            terminal::run_template
        ])
        .setup(|app| {
            tray::setup(app)?;
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
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
