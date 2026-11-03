use tauri::{
    App, Manager, Wry,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

/// The disabled first menu item that shows the daemon's state.
struct StatusItem(MenuItem<Wry>);

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Called by the dashboard whenever the daemon's state changes.
#[tauri::command]
pub fn set_tray_status(app: tauri::AppHandle, status: String) {
    if let Some(item) = app.try_state::<StatusItem>() {
        let _ = item.0.set_text(&status);
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("AgentDeck: {status}")));
    }
}

/// Build the tray icon and its menu: the status line, Show and Quit.
pub fn setup(app: &mut App) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Connecting…", false, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show AgentDeck", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit AgentDeck", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &show, &quit])?;
    app.manage(StatusItem(status));
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("AgentDeck")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}
