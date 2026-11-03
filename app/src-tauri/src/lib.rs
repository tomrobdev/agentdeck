mod terminal;
mod tray;

use tauri::WindowEvent;
use tauri_plugin_autostart::MacosLauncher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            tray::set_tray_status,
            terminal::cmux_installed,
            terminal::run_template
        ])
        .setup(|app| {
            tray::setup(app)?;
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
