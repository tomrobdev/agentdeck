use tauri_plugin_dialog::DialogExt;

/// Show the native folder picker. Gives the chosen folder's path, or None when the person cancels.
/// An async command runs off the main thread, so waiting on the dialog does not freeze the window.
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    let picked = app.dialog().file().blocking_pick_folder()?;
    picked
        .into_path()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}
