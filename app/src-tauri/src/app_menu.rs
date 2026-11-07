//! The macOS menu bar. Items that open something send an `agentdeck://` URL through `open_in_dashboard`, so the dashboard
//! decides what each means (`parseAppUrl`); Pause, Resume, Start and Restart act on the daemon, as the tray does. The Edit menu is
//! the predefined one: without it ⌘C and ⌘V stop working in the web view. ⌘K lives here too, so in the desktop app the
//! dashboard's own key handler stays off and a press can't toggle the palette twice.

use crate::daemon_client;
use crate::open::open_in_dashboard;
use crate::service;
use crate::tray::Toggle;
use std::sync::Mutex;
use tauri::{
    AppHandle, Manager, Wry,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
};

const TOGGLE: &str = "daemon-toggle";
const RESTART: &str = "daemon-restart";

/// A menu item that opens a URL: its id, label, URL and key.
type Link = (
    &'static str,
    &'static str,
    &'static str,
    Option<&'static str>,
);

const LINKS: [Link; 8] = [
    (
        "settings",
        "Settings…",
        "agentdeck://settings",
        Some("CmdOrCtrl+,"),
    ),
    ("new", "New Task", "agentdeck://new", Some("CmdOrCtrl+N")),
    ("repos", "Add Repo…", "agentdeck://repos", None),
    ("queue", "Queue", "agentdeck://queue", Some("CmdOrCtrl+1")),
    (
        "insights",
        "Insights",
        "agentdeck://insights",
        Some("CmdOrCtrl+2"),
    ),
    (
        "palette",
        "Command Palette",
        "agentdeck://palette",
        Some("CmdOrCtrl+K"),
    ),
    ("daemon", "Daemon…", "agentdeck://daemon", None),
    ("show", "Show AgentDeck", "agentdeck://", None),
];

/// The Pause/Resume/Start item and what the last status read made it.
struct PauseItem(MenuItem<Wry>, Mutex<Option<Toggle>>);

/// The link a menu id opens, if it is a link.
fn url_for(id: &str) -> Option<&'static str> {
    LINKS.iter().find(|l| l.0 == id).map(|l| l.2)
}

/// The item's label and whether it works, for the last read: Start while the daemon is offline, off until the first read.
fn pause_item(toggle: Option<Toggle>) -> (&'static str, bool) {
    match toggle {
        Some(Toggle::Resume) => ("Resume", true),
        Some(Toggle::Pause) => ("Pause", true),
        Some(Toggle::Start) => ("Start", true),
        None => ("Pause", false),
    }
}

fn link(app: &AppHandle, id: &str) -> tauri::Result<MenuItem<Wry>> {
    let (_, text, _, accel) = LINKS.iter().find(|l| l.0 == id).expect("known link id");
    MenuItem::with_id(app, id, text, true, *accel)
}

fn build(app: &AppHandle) -> tauri::Result<(Menu<Wry>, MenuItem<Wry>)> {
    let sep = || PredefinedMenuItem::separator(app);
    let (text, enabled) = pause_item(None);
    let pause = MenuItem::with_id(app, TOGGLE, text, enabled, None::<&str>)?;
    let restart = MenuItem::with_id(app, RESTART, "Restart", true, None::<&str>)?;

    let app_menu = Submenu::with_items(
        app,
        "AgentDeck",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &sep()?,
            &link(app, "settings")?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[&link(app, "new")?, &link(app, "repos")?],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &link(app, "queue")?,
            &link(app, "insights")?,
            &sep()?,
            &link(app, "palette")?,
        ],
    )?;
    let daemon = Submenu::with_items(
        app,
        "Daemon",
        true,
        &[&pause, &restart, &sep()?, &link(app, "daemon")?],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &sep()?,
            &link(app, "show")?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let menu = Menu::with_items(app, &[&app_menu, &file, &edit, &view, &daemon, &window])?;
    Ok((menu, pause))
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id.as_ref();
    if let Some(url) = url_for(id) {
        open_in_dashboard(app, url);
        return;
    }
    let (what, call): (&str, fn() -> Result<(), String>) = match id {
        TOGGLE => {
            let toggle = app
                .try_state::<PauseItem>()
                .and_then(|p| p.1.lock().ok().and_then(|t| *t));
            match toggle {
                Some(Toggle::Resume) => ("resume", || daemon_client::set_paused(false)),
                Some(Toggle::Pause) => ("pause", || daemon_client::set_paused(true)),
                Some(Toggle::Start) => ("start", service::start),
                None => return,
            }
        }
        RESTART => ("restart", daemon_client::restart),
        _ => return,
    };
    // Off the main thread; the change comes back through the event stream.
    std::thread::spawn(move || {
        if let Err(e) = call() {
            eprintln!("menu: couldn't {what} the daemon: {e}");
        }
    });
}

/// Set the menu bar of the app.
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let (menu, pause) = build(app)?;
    app.manage(PauseItem(pause, Mutex::new(None)));
    app.set_menu(menu)?;
    app.on_menu_event(on_menu_event);
    Ok(())
}

/// Word the Daemon menu's Pause/Resume/Start item after the last status read.
pub fn update(app: &AppHandle, toggle: Option<Toggle>) -> tauri::Result<()> {
    if let Some(item) = app.try_state::<PauseItem>() {
        let (text, enabled) = pause_item(toggle);
        item.0.set_text(text)?;
        item.0.set_enabled(enabled)?;
        if let Ok(mut slot) = item.1.lock() {
            *slot = toggle;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_link_is_an_agentdeck_url() {
        for (id, _, url, _) in LINKS {
            assert!(url.starts_with("agentdeck://"), "{id}");
            assert_eq!(url_for(id), Some(url));
        }
        assert_eq!(url_for(RESTART), None);
        assert_eq!(url_for(TOGGLE), None);
    }

    #[test]
    fn the_palette_key_is_the_menus() {
        let palette = LINKS.iter().find(|l| l.0 == "palette").unwrap();
        assert_eq!(palette.3, Some("CmdOrCtrl+K"));
    }

    #[test]
    fn the_toggle_follows_the_last_read() {
        assert_eq!(pause_item(Some(Toggle::Pause)), ("Pause", true));
        assert_eq!(pause_item(Some(Toggle::Resume)), ("Resume", true));
        assert_eq!(pause_item(Some(Toggle::Start)), ("Start", true));
        assert_eq!(pause_item(None), ("Pause", false));
    }
}
