use tauri::{
    Manager, WindowEvent, Wry,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_autostart::MacosLauncher;

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
fn set_tray_status(app: tauri::AppHandle, status: String) {
    if let Some(item) = app.try_state::<StatusItem>() {
        let _ = item.0.set_text(&status);
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("AgentDeck: {status}")));
    }
}

const CMUX_BIN: &str = "/Applications/cmux.app/Contents/Resources/bin/cmux";

/// Whether cmux is installed (its binary is not on a GUI app's PATH, so the dashboard asks here).
#[tauri::command]
fn cmux_installed() -> bool {
    std::path::Path::new(CMUX_BIN).is_file()
}

/// Fill a template's placeholders. An argument holding `{command}` is dropped, with the flag before
/// it, when there is no command to run.
fn fill_template(template: &[String], title: &str, cwd: &str, command: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for arg in template {
        let mut arg = arg.clone();
        if arg.contains("{command}") {
            let Some(cmd) = command else {
                if out.last().is_some_and(|prev| prev.starts_with('-')) {
                    out.pop();
                }
                continue;
            };
            // Fill {command} last, so a placeholder typed inside the command stays as typed.
            arg = arg.replace("{title}", title).replace("{cwd}", cwd).replace("{command}", cmd);
        } else {
            arg = arg.replace("{title}", title).replace("{cwd}", cwd);
        }
        out.push(arg);
    }
    out
}

/// Open a terminal from a command template, as an argv list: the program, then its arguments, with
/// `{title}`, `{cwd}` and `{command}` filled in. Nothing goes through a shell. `cmux` is found at
/// its install path when it is not on PATH.
#[tauri::command]
async fn open_terminal(
    template: Vec<String>,
    title: String,
    cwd: String,
    command: Option<String>,
) -> Result<(), String> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("{cwd} is not a directory"));
    }
    let mut argv = fill_template(&template, &title, &cwd, command.as_deref());
    if argv.is_empty() {
        return Err("The terminal command is empty".into());
    }
    let mut program = argv.remove(0);
    if program == "cmux" && cmux_installed() {
        program = CMUX_BIN.to_string();
    }
    tauri::async_runtime::spawn_blocking(move || {
        let out = std::process::Command::new(&program)
            .args(&argv)
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Could not run {program}: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(format!("{program} failed: {}", err.trim()))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![set_tray_status, cmux_installed, open_terminal])
        .setup(|app| {
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
