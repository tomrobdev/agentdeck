//! The tray icon, its menu and the dock badge, kept up to date from what `daemon_client` reads, so they stay fresh while
//! the window is hidden. `tray_view` words the read; it decides nothing: the state and what needs a person come from the
//! daemon's headline, and the words follow `describeState` in `app/src/api/format.ts`.

use crate::daemon_client::{self, AttentionWhy, HeadlineState, Read};
use crate::open::open_in_dashboard;
use tauri::{
    App, AppHandle, Manager, Wry,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};

const TRAY_ID: &str = "main";
/// Menu ids that start with this open the rest of the id, an `agentdeck://` URL.
const OPEN_PREFIX: &str = "open:";
/// Longer task titles are cut, so the menu stays narrow.
const TITLE_CHARS: usize = 48;

/// The time `tray_view` words: now, and the local zone's offset from UTC, both in seconds.
#[derive(Debug, Clone, Copy)]
pub struct Clock {
    pub now: i64,
    pub utc_offset: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Toggle {
    Pause,
    Resume,
    /// Start the daemon through launchd; offered while it is offline.
    Start,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttentionItem {
    pub label: String,
    pub url: String,
}

/// Everything the tray shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayView {
    /// The disabled first line of the menu.
    pub status: String,
    pub tooltip: String,
    pub attention: Vec<AttentionItem>,
    /// Pause or Resume; Start while the daemon is offline; none while connecting.
    pub toggle: Option<Toggle>,
    /// The dock badge: how many tasks need a person, or none when nothing does.
    pub badge: Option<i64>,
}

pub fn tray_view(read: &Read, clock: Clock) -> TrayView {
    let (status, attention, toggle, badge) = match read {
        Read::Connecting => ("Connecting…".to_string(), Vec::new(), None, None),
        Read::Offline => (
            "Daemon offline".to_string(),
            Vec::new(),
            Some(Toggle::Start),
            None,
        ),
        Read::Online(s) => {
            let h = &s.headline;
            let status = match h.state {
                HeadlineState::Paused => "Paused".to_string(),
                HeadlineState::RateLimited => match h.until {
                    Some(until) => format!("Rate limited · {}", rel_time(until, clock.now)),
                    None => "Rate limited".to_string(),
                },
                HeadlineState::Hold => match h.until {
                    Some(until) => format!("On hold · until {}", when(until, clock.utc_offset)),
                    None => "On hold".to_string(),
                },
                HeadlineState::Working => {
                    format!("Working · {}/{} slots", s.running, s.max_concurrent)
                }
                HeadlineState::Idle => "Idle".to_string(),
            };
            let attention = h
                .attention
                .iter()
                .map(|t| AttentionItem {
                    label: format!("#{} {} ({})", t.id, short(&t.title), why_label(t.why)),
                    url: format!("agentdeck://tasks/{}", t.id),
                })
                .collect();
            let toggle = if s.paused {
                Toggle::Resume
            } else {
                Toggle::Pause
            };
            let badge = (h.need_you > 0).then_some(h.need_you);
            (status, attention, Some(toggle), badge)
        }
    };
    TrayView {
        tooltip: format!("AgentDeck: {status}"),
        status,
        attention,
        toggle,
        badge,
    }
}

fn why_label(why: AttentionWhy) -> &'static str {
    match why {
        AttentionWhy::Blocked => "blocked",
        AttentionWhy::Review => "in review",
        AttentionWhy::Proposed => "proposed",
    }
}

fn short(title: &str) -> String {
    if title.chars().count() <= TITLE_CHARS {
        return title.to_string();
    }
    let cut: String = title.chars().take(TITLE_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

/// How long until `until`, as `relTime` words it: "now", "12m", "2.5h".
fn rel_time(until: i64, now: i64) -> String {
    let mins = ((until - now) as f64 / 60.0).round() as i64;
    if mins <= 0 {
        "now".to_string()
    } else if mins < 90 {
        format!("{mins}m")
    } else {
        format!("{:.1}h", mins as f64 / 60.0)
    }
}

/// A local weekday and time, as `when` words it: "Tue 14:30".
fn when(at: i64, utc_offset: i64) -> String {
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let local = at + utc_offset;
    let day = local.div_euclid(86_400);
    let secs = local.rem_euclid(86_400);
    // 1970-01-01 was a Thursday.
    let weekday = DAYS[(day + 4).rem_euclid(7) as usize];
    format!("{weekday} {:02}:{:02}", secs / 3600, secs % 3600 / 60)
}

fn clock() -> Clock {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Clock {
        now,
        utc_offset: local_offset(now),
    }
}

/// The local zone's offset from UTC at `at`, from the C library, as no crate here has it.
#[cfg(unix)]
fn local_offset(at: i64) -> i64 {
    use std::ffi::{c_char, c_int, c_long};
    // `struct tm` as macOS and glibc lay it out.
    #[repr(C)]
    struct Tm {
        tm_sec: c_int,
        tm_min: c_int,
        tm_hour: c_int,
        tm_mday: c_int,
        tm_mon: c_int,
        tm_year: c_int,
        tm_wday: c_int,
        tm_yday: c_int,
        tm_isdst: c_int,
        tm_gmtoff: c_long,
        tm_zone: *const c_char,
    }
    unsafe extern "C" {
        fn localtime_r(time: *const i64, out: *mut Tm) -> *mut Tm;
    }
    let mut tm = std::mem::MaybeUninit::<Tm>::zeroed();
    // SAFETY: localtime_r only writes to `tm`, which is big enough, and returns null on failure.
    let filled = unsafe { localtime_r(&at, tm.as_mut_ptr()) };
    if filled.is_null() {
        return 0;
    }
    // SAFETY: localtime_r succeeded, so it filled `tm`.
    #[allow(clippy::unnecessary_cast)] // c_long is i64 here, but not on every target.
    let offset = unsafe { tm.assume_init() }.tm_gmtoff as i64;
    offset
}

#[cfg(not(unix))]
fn local_offset(_at: i64) -> i64 {
    0
}

fn build_menu(app: &AppHandle, view: &TrayView) -> tauri::Result<Menu<Wry>> {
    let item = |id: String, text: &str, enabled: bool| {
        MenuItem::with_id(app, id, text, enabled, None::<&str>)
    };
    let menu = Menu::new(app)?;
    menu.append(&item("status".into(), &view.status, false)?)?;
    if !view.attention.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        for task in &view.attention {
            menu.append(&item(
                format!("{OPEN_PREFIX}{}", task.url),
                &task.label,
                true,
            )?)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    match view.toggle {
        Some(Toggle::Pause) => menu.append(&item("pause".into(), "Pause", true)?)?,
        Some(Toggle::Resume) => menu.append(&item("resume".into(), "Resume", true)?)?,
        Some(Toggle::Start) => menu.append(&item("start-daemon".into(), "Start daemon", true)?)?,
        None => {}
    }
    menu.append(&item("show".into(), "Show AgentDeck", true)?)?;
    menu.append(&item("quit".into(), "Quit AgentDeck", true)?)?;
    Ok(menu)
}

fn show(app: &AppHandle, view: &TrayView) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(build_menu(app, view)?))?;
        tray.set_tooltip(Some(&view.tooltip))?;
    }
    if let Some(window) = app.get_webview_window("main") {
        window.set_badge_count(view.badge)?;
    }
    Ok(())
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id.as_ref();
    if let Some(url) = id.strip_prefix(OPEN_PREFIX) {
        open_in_dashboard(app, url);
        return;
    }
    match id {
        "pause" | "resume" => {
            let paused = id == "pause";
            let what = id.to_string();
            // Off the main thread; the change comes back through the event stream.
            std::thread::spawn(move || {
                if let Err(e) = daemon_client::set_paused(paused) {
                    eprintln!("tray: couldn't {what} the daemon: {e}");
                }
            });
        }
        "start-daemon" => {
            std::thread::spawn(|| {
                if let Err(e) = crate::service::start() {
                    eprintln!("tray: couldn't start the daemon: {e}");
                }
            });
        }
        "show" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Build the tray icon and its menu, then keep both and the dock badge up to date from the daemon.
pub fn setup(app: &mut App) -> tauri::Result<()> {
    let view = tray_view(&Read::Connecting, clock());
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip(&view.tooltip)
        .menu(&build_menu(app.handle(), &view)?)
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu_event)
        .build(app)?;
    let handle = app.handle().clone();
    let mut last = view;
    daemon_client::watch(move |read| {
        let view = tray_view(&read, clock());
        if view == last {
            return;
        }
        if let Err(e) = show(&handle, &view) {
            eprintln!("tray: couldn't update: {e}");
        }
        if let Err(e) = crate::app_menu::update(&handle, view.toggle) {
            eprintln!("menu: couldn't update: {e}");
        }
        last = view;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon_client::{AttentionTask, Headline, Status};

    // Tue 2026-11-03 12:00:00 UTC.
    const NOW: i64 = 1_793_707_200;
    const UTC: Clock = Clock {
        now: NOW,
        utc_offset: 0,
    };

    fn status(state: HeadlineState) -> Status {
        Status {
            headline: Headline {
                state,
                until: None,
                need_you: 0,
                attention: Vec::new(),
            },
            paused: false,
            running: 0,
            max_concurrent: 3,
        }
    }

    fn view(s: Status) -> TrayView {
        tray_view(&Read::Online(s), UTC)
    }

    #[test]
    fn working_shows_the_slots() {
        let mut s = status(HeadlineState::Working);
        s.running = 2;
        let v = view(s);
        assert_eq!(v.status, "Working · 2/3 slots");
        assert_eq!(v.tooltip, "AgentDeck: Working · 2/3 slots");
        assert_eq!(v.toggle, Some(Toggle::Pause));
    }

    #[test]
    fn idle() {
        assert_eq!(view(status(HeadlineState::Idle)).status, "Idle");
    }

    #[test]
    fn paused_offers_resume() {
        let mut s = status(HeadlineState::Paused);
        s.paused = true;
        let v = view(s);
        assert_eq!(v.status, "Paused");
        assert_eq!(v.toggle, Some(Toggle::Resume));
    }

    #[test]
    fn a_hold_says_until_when_in_local_time() {
        let mut s = status(HeadlineState::Hold);
        s.headline.until = Some(NOW + 2 * 3600 + 30 * 60);
        assert_eq!(view(s.clone()).status, "On hold · until Tue 14:30");
        let berlin = Clock {
            now: NOW,
            utc_offset: 3600,
        };
        assert_eq!(
            tray_view(&Read::Online(s.clone()), berlin).status,
            "On hold · until Tue 15:30"
        );
        s.headline.until = Some(NOW + 12 * 3600);
        assert_eq!(view(s.clone()).status, "On hold · until Wed 00:00");
        s.headline.until = None;
        assert_eq!(view(s).status, "On hold");
    }

    #[test]
    fn a_rate_limit_says_how_long() {
        let mut s = status(HeadlineState::RateLimited);
        s.headline.until = Some(NOW + 12 * 60);
        assert_eq!(view(s.clone()).status, "Rate limited · 12m");
        s.headline.until = Some(NOW + 150 * 60);
        assert_eq!(view(s.clone()).status, "Rate limited · 2.5h");
        s.headline.until = Some(NOW - 60);
        assert_eq!(view(s.clone()).status, "Rate limited · now");
        s.headline.until = None;
        assert_eq!(view(s).status, "Rate limited");
    }

    #[test]
    fn offline_offers_start_and_connecting_has_no_toggle() {
        let v = tray_view(&Read::Offline, UTC);
        assert_eq!(v.status, "Daemon offline");
        assert_eq!(v.tooltip, "AgentDeck: Daemon offline");
        assert_eq!((v.toggle, v.badge), (Some(Toggle::Start), None));
        assert!(v.attention.is_empty());
        let v = tray_view(&Read::Connecting, UTC);
        assert_eq!(v.status, "Connecting…");
        assert_eq!((v.toggle, v.badge), (None, None));
    }

    #[test]
    fn one_item_per_attention_task() {
        let mut s = status(HeadlineState::Idle);
        s.headline.attention = vec![
            AttentionTask {
                id: 181,
                title: "Shared text helpers".into(),
                why: AttentionWhy::Blocked,
            },
            AttentionTask {
                id: 90,
                title: "A".repeat(60),
                why: AttentionWhy::Review,
            },
            AttentionTask {
                id: 7,
                title: "Try the planner".into(),
                why: AttentionWhy::Proposed,
            },
        ];
        let v = view(s);
        let labels: Vec<_> = v.attention.iter().map(|a| a.label.as_str()).collect();
        let long = format!("#90 {}… (in review)", "A".repeat(47));
        assert_eq!(
            labels,
            [
                "#181 Shared text helpers (blocked)",
                long.as_str(),
                "#7 Try the planner (proposed)"
            ]
        );
        assert_eq!(v.attention[0].url, "agentdeck://tasks/181");
    }

    #[test]
    fn the_badge_counts_who_needs_you_and_hides_at_zero() {
        let mut s = status(HeadlineState::Working);
        s.headline.need_you = 4;
        assert_eq!(view(s.clone()).badge, Some(4));
        s.headline.need_you = 0;
        assert_eq!(view(s).badge, None);
    }

    #[test]
    fn local_offset_is_within_a_day() {
        assert!(local_offset(NOW).abs() < 86_400);
    }
}
