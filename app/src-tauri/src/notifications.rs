//! Shows the daemon's notifications as AgentDeck's own while the app runs. The app tells the daemon every 30 s that it
//! is running (`POST /api/app/seen`), and for 90 s after each time the daemon leaves desktop notifications to it
//! (`appDelivers` in `daemon/src/domain/notification.ts`). The daemon still records every notification, and this file
//! shows the rows it hasn't seen yet. A click opens the notification's task in the dashboard.

use crate::daemon_client::{self, NotificationRow, Read};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use tauri::AppHandle;

/// How often the app tells the daemon it is running; the daemon counts it as running for 90 s after each time.
const SEEN_EVERY: Duration = Duration::from_secs(30);

/// Picks out the notifications that weren't there before. The first read only sets where to start from, so the ones
/// sent before the app started aren't shown again.
#[derive(Debug, Default)]
pub struct NewRows {
    newest: Option<i64>,
}

impl NewRows {
    /// The rows newer than any seen before, oldest first.
    pub fn take(&mut self, rows: &[NotificationRow]) -> Vec<NotificationRow> {
        let newest = rows.iter().map(|r| r.id).max().unwrap_or(0);
        let Some(seen) = self.newest else {
            self.newest = Some(newest);
            return Vec::new();
        };
        let mut new: Vec<NotificationRow> = rows.iter().filter(|r| r.id > seen).cloned().collect();
        new.sort_by_key(|r| r.id);
        self.newest = Some(seen.max(newest));
        new
    }
}

/// What a click on a notification opens: its task, or the queue when it has none.
pub fn click_url(task_id: Option<i64>) -> String {
    match task_id {
        Some(id) => format!("agentdeck://tasks/{id}"),
        None => "agentdeck://queue".to_string(),
    }
}

/// Get ready to show notifications. Returns what shows the new ones on each read of the daemon. Once the first read
/// has set where to start from, the app tells the daemon every 30 s that it is running, and learns from its answer
/// whether desktop notifications are on.
pub fn setup(app: &AppHandle) -> impl FnMut(&Read) + Send + 'static {
    native::prepare();
    let app = app.clone();
    let desktop = Arc::new(AtomicBool::new(false));
    let mut rows = NewRows::default();
    let mut seen_started = false;
    move |read: &Read| {
        let Read::Online(status) = read else {
            return;
        };
        let new = rows.take(&status.notifications);
        if !seen_started {
            seen_started = true;
            let desktop = Arc::clone(&desktop);
            thread::spawn(move || {
                loop {
                    if let Ok(on) = daemon_client::app_seen() {
                        desktop.store(on, Ordering::Relaxed);
                    }
                    thread::sleep(SEEN_EVERY);
                }
            });
        }
        if desktop.load(Ordering::Relaxed) {
            for row in new {
                native::show(&app, row);
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::click_url;
    use crate::daemon_client::NotificationRow;
    use crate::open::open_in_dashboard;
    use mac_notification_sys::{Notification, NotificationResponse};
    use std::ffi::{c_char, c_void};
    use std::thread;
    use tauri::AppHandle;

    /// The app's bundle id (`identifier` in `tauri.conf.json`), so notifications come under AgentDeck's name.
    const BUNDLE_ID: &str = "dev.agentdeck.app";

    pub fn prepare() {
        if let Err(e) = mac_notification_sys::set_application(BUNDLE_ID) {
            eprintln!("notifications: couldn't show them as {BUNDLE_ID}: {e}");
        }
        present_while_frontmost();
    }

    /// macOS keeps an app's notifications out of sight while the app is frontmost, unless its notification delegate
    /// says to show them. The crate's delegate (`NotificationCenterDelegate` in its `objc/notify.m`) doesn't, so this
    /// adds that method to it before the first notification sets it up. Without it, "Send a test notification" in
    /// Settings would show nothing.
    fn present_while_frontmost() {
        #[link(name = "objc")]
        unsafe extern "C" {
            fn objc_getClass(name: *const c_char) -> *mut c_void;
            fn sel_registerName(name: *const c_char) -> *const c_void;
            fn class_addMethod(
                class: *mut c_void,
                name: *const c_void,
                imp: *const c_void,
                types: *const c_char,
            ) -> bool;
        }
        extern "C" fn should_present(
            _this: *mut c_void,
            _cmd: *const c_void,
            _center: *mut c_void,
            _note: *mut c_void,
        ) -> bool {
            true
        }
        // SAFETY: the names are NUL-terminated C strings, the class is checked before use, and `should_present` has the
        // signature of `-userNotificationCenter:shouldPresentNotification:` (self, _cmd, two objects, returning BOOL).
        unsafe {
            let class = objc_getClass(c"NotificationCenterDelegate".as_ptr());
            if class.is_null() {
                return;
            }
            let selector =
                sel_registerName(c"userNotificationCenter:shouldPresentNotification:".as_ptr());
            let _ = class_addMethod(
                class,
                selector,
                should_present as *const c_void,
                c"B@:@@".as_ptr(),
            );
        }
    }

    /// Show `row` and wait on a thread of its own for a click, which opens its task.
    pub fn show(app: &AppHandle, row: NotificationRow) {
        let app = app.clone();
        thread::spawn(move || {
            let response = Notification::new()
                .title("AgentDeck")
                .subtitle(&row.title)
                .message(&row.body)
                .wait_for_click(true)
                .send();
            match response {
                Ok(NotificationResponse::Click | NotificationResponse::ActionButton(_)) => {
                    open_in_dashboard(&app, &click_url(row.task_id));
                }
                Ok(_) => {}
                Err(e) => eprintln!("notifications: couldn't show #{}: {e}", row.id),
            }
        });
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use crate::daemon_client::NotificationRow;
    use tauri::AppHandle;

    pub fn prepare() {}

    pub fn show(_app: &AppHandle, _row: NotificationRow) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: i64) -> NotificationRow {
        NotificationRow {
            id,
            title: format!("#{id} done"),
            body: "Ready.".into(),
            task_id: Some(id),
        }
    }

    fn ids(rows: Vec<NotificationRow>) -> Vec<i64> {
        rows.into_iter().map(|r| r.id).collect()
    }

    #[test]
    fn the_first_read_only_sets_where_to_start() {
        let mut rows = NewRows::default();
        assert_eq!(ids(rows.take(&[row(5), row(4), row(3)])), Vec::<i64>::new());
        assert_eq!(ids(rows.take(&[row(5), row(4), row(3)])), Vec::<i64>::new());
    }

    #[test]
    fn later_reads_pick_out_exactly_the_newer_rows_oldest_first() {
        let mut rows = NewRows::default();
        rows.take(&[row(5), row(4)]);
        assert_eq!(
            ids(rows.take(&[row(7), row(6), row(5), row(4)])),
            vec![6, 7]
        );
        assert_eq!(ids(rows.take(&[row(7), row(6), row(5)])), Vec::<i64>::new());
        assert_eq!(ids(rows.take(&[row(8), row(7), row(6)])), vec![8]);
    }

    #[test]
    fn with_none_at_first_every_later_row_is_new() {
        let mut rows = NewRows::default();
        rows.take(&[]);
        assert_eq!(ids(rows.take(&[row(2), row(1)])), vec![1, 2]);
    }

    #[test]
    fn an_empty_read_keeps_where_it_was() {
        let mut rows = NewRows::default();
        rows.take(&[row(4)]);
        rows.take(&[]);
        assert_eq!(ids(rows.take(&[row(4)])), Vec::<i64>::new());
    }

    #[test]
    fn a_click_opens_the_task_or_the_queue() {
        assert_eq!(click_url(Some(12)), "agentdeck://tasks/12");
        assert_eq!(click_url(None), "agentdeck://queue");
    }
}
