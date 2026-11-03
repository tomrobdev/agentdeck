//! The shell's one reader of the daemon: it listens to `GET /api/events` and reads `GET /api/status` on each new revision,
//! and at least every 30 s. It decodes only the fields the shell uses; what they mean is decided in the daemon
//! (`daemon/src/domain/daemon/headline.ts`). Plain HTTP on localhost, so ureq runs with no TLS and no proxy.

use serde::Deserialize;
use std::io::Read as _;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

/// Read the status at least this often, even when no revision arrives.
const REFRESH: Duration = Duration::from_secs(30);
/// How long to wait before connecting again after the daemon went away.
const RETRY: Duration = Duration::from_secs(5);
/// The most a status read or a pause may take before the daemon counts as offline.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// The state headline, as `Headline` in `daemon/src/api/contract.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HeadlineState {
    Paused,
    RateLimited,
    Hold,
    Working,
    /// Also any state this shell doesn't know yet, worded as `describeState`'s default is.
    #[serde(other)]
    Idle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionWhy {
    Blocked,
    Review,
    Proposed,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AttentionTask {
    pub id: i64,
    pub title: String,
    pub why: AttentionWhy,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Headline {
    pub state: HeadlineState,
    /// When a rate limit or a hold ends (unix seconds).
    pub until: Option<i64>,
    pub need_you: i64,
    pub attention: Vec<AttentionTask>,
}

/// A sent notification, as `NotificationRow` in `daemon/src/api/contract.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NotificationRow {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub task_id: Option<i64>,
}

/// The part of `Status` (GET /api/status) the shell reads.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Status {
    pub headline: Headline,
    pub paused: bool,
    pub running: i64,
    pub max_concurrent: i64,
    /// The newest notifications, newest first.
    #[serde(default)]
    pub notifications: Vec<NotificationRow>,
}

/// What the shell last read of the daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Read {
    /// Nothing read yet.
    Connecting,
    /// The daemon didn't answer.
    Offline,
    Online(Status),
}

/// `http://127.0.0.1:$AGENTDECK_PORT`, 4317 by default as in `daemon/src/config.ts`.
pub fn base_url() -> String {
    let port = std::env::var("AGENTDECK_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(4317);
    format!("http://127.0.0.1:{port}")
}

fn agent(timeout: Option<Duration>) -> ureq::Agent {
    ureq::Agent::config_builder()
        .proxy(None)
        .timeout_connect(Some(REQUEST_TIMEOUT))
        .timeout_global(timeout)
        .build()
        .into()
}

fn read_status(agent: &ureq::Agent, base: &str) -> Result<Status, String> {
    let body = agent
        .get(format!("{base}/api/status"))
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

/// Pause the daemon (`POST /api/pause`), or resume it (`POST /api/resume`).
pub fn set_paused(paused: bool) -> Result<(), String> {
    let path = if paused { "pause" } else { "resume" };
    agent(Some(REQUEST_TIMEOUT))
        .post(format!("{}/api/{path}", base_url()))
        .send_empty()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Tell the daemon the app is running (`POST /api/app/seen`), so for the next 90 s it leaves desktop notifications
/// to the app. Answers whether desktop notifications are on.
pub fn app_seen() -> Result<bool, String> {
    #[derive(Deserialize)]
    struct AppSeen {
        desktop: bool,
    }
    let body = agent(Some(REQUEST_TIMEOUT))
        .post(format!("{}/api/app/seen", base_url()))
        .send_empty()
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    serde_json::from_str::<AppSeen>(&body)
        .map(|seen| seen.desktop)
        .map_err(|e| e.to_string())
}

/// Turns the bytes of a Server-Sent Events stream into the revisions of its `rev` events. Chunks may split anywhere,
/// even inside a line or a character; comment lines (`: ping`) and other events are skipped.
#[derive(Default)]
pub struct RevParser {
    line: Vec<u8>,
    event: String,
    data: String,
}

impl RevParser {
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<u64> {
        let mut revs = Vec::new();
        for &byte in chunk {
            if byte != b'\n' {
                self.line.push(byte);
                continue;
            }
            let raw = std::mem::take(&mut self.line);
            let line = String::from_utf8_lossy(&raw);
            let line = line.strip_suffix('\r').unwrap_or(&line);
            if line.is_empty() {
                let event = std::mem::take(&mut self.event);
                let data = std::mem::take(&mut self.data);
                if event == "rev"
                    && let Some(rev) = parse_rev(&data)
                {
                    revs.push(rev);
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "event" => self.event = value.to_string(),
                "data" => {
                    if !self.data.is_empty() {
                        self.data.push('\n');
                    }
                    self.data.push_str(value);
                }
                _ => {}
            }
        }
        revs
    }
}

fn parse_rev(data: &str) -> Option<u64> {
    #[derive(Deserialize)]
    struct ChangeEvent {
        rev: u64,
    }
    serde_json::from_str::<ChangeEvent>(data)
        .ok()
        .map(|e| e.rev)
}

enum Signal {
    Rev,
    Down,
}

/// Follow `GET /api/events` until the connection ends, sending a signal for each new revision.
fn follow_events(base: &str, tx: &mpsc::Sender<Signal>) -> Result<(), String> {
    let response = agent(None)
        .get(format!("{base}/api/events"))
        .call()
        .map_err(|e| e.to_string())?;
    let mut reader = response.into_body().into_reader();
    let mut parser = RevParser::default();
    let mut last = None;
    let mut buf = [0u8; 4096];
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("the event stream ended".into());
        }
        for rev in parser.feed(&buf[..n]) {
            if last != Some(rev) {
                last = Some(rev);
                tx.send(Signal::Rev).map_err(|e| e.to_string())?;
            }
        }
    }
}

/// Start reading the daemon on background threads. `on_read` gets each read: the status, or offline when the daemon
/// doesn't answer. While it is down, the event stream is tried again every 5 s.
pub fn watch(mut on_read: impl FnMut(Read) + Send + 'static) {
    let (tx, rx) = mpsc::channel();
    let base = base_url();
    {
        let base = base.clone();
        thread::spawn(move || {
            loop {
                let _ = follow_events(&base, &tx);
                if tx.send(Signal::Down).is_err() {
                    return;
                }
                thread::sleep(RETRY);
            }
        });
    }
    thread::spawn(move || {
        let agent = agent(Some(REQUEST_TIMEOUT));
        loop {
            match rx.recv_timeout(REFRESH) {
                Ok(Signal::Down) => {
                    on_read(Read::Offline);
                    continue;
                }
                Ok(Signal::Rev) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            // Revisions that came in meanwhile need no read of their own.
            while let Ok(signal) = rx.try_recv() {
                if let Signal::Down = signal {
                    on_read(Read::Offline);
                }
            }
            on_read(match read_status(&agent, &base) {
                Ok(status) => Read::Online(status),
                Err(_) => Read::Offline,
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_rev_event() {
        let mut p = RevParser::default();
        assert_eq!(p.feed(b"event: rev\ndata: {\"rev\":7}\n\n"), vec![7]);
    }

    #[test]
    fn parses_events_split_across_chunks() {
        let mut p = RevParser::default();
        assert_eq!(p.feed(b"event: r"), Vec::<u64>::new());
        assert_eq!(p.feed(b"ev\ndata: {\"re"), Vec::<u64>::new());
        assert_eq!(p.feed(b"v\":12}\n"), Vec::<u64>::new());
        assert_eq!(
            p.feed(b"\nevent: rev\ndata: {\"rev\":13}\n\n"),
            vec![12, 13]
        );
    }

    #[test]
    fn skips_pings_and_other_events() {
        let mut p = RevParser::default();
        let stream = b": ping\n\nevent: log\ndata: {\"rev\":1}\n\n: ping\n\nevent: rev\r\ndata: {\"rev\":2}\r\n\r\n";
        assert_eq!(p.feed(stream), vec![2]);
    }

    #[test]
    fn skips_a_rev_event_with_bad_data() {
        let mut p = RevParser::default();
        assert_eq!(
            p.feed(b"event: rev\ndata: nope\n\nevent: rev\ndata: {\"rev\":3}\n\n"),
            vec![3]
        );
    }

    #[test]
    fn decodes_only_the_status_fields_it_uses() {
        let body = r#"{
            "daemon": { "commit": "abc", "started_at": "2026-11-03 10:00:00", "pid": 1 },
            "paused": false, "rate_limited_until": null, "running": 2, "max_concurrent": 3,
            "counts": { "queued": 4 }, "review": 1, "usage": [],
            "notifications": [{ "id": 9, "kind": "done", "title": "Task 3 done: Tray", "body": "Ready.",
              "task_id": 3, "created_at": "2026-11-03 10:00:00" }],
            "headline": { "state": "hold", "until": 1762180200, "need_you": 2,
              "attention": [{ "id": 181, "title": "Shared text helpers", "why": "blocked" }] }
        }"#;
        let status: Status = serde_json::from_str(body).unwrap();
        assert_eq!(status.headline.state, HeadlineState::Hold);
        assert_eq!(status.headline.until, Some(1762180200));
        assert_eq!(status.headline.attention[0].why, AttentionWhy::Blocked);
        assert_eq!((status.running, status.max_concurrent), (2, 3));
        assert_eq!(status.notifications[0].task_id, Some(3));
    }

    #[test]
    fn an_unknown_state_reads_as_idle() {
        let state: HeadlineState = serde_json::from_str("\"dreaming\"").unwrap();
        assert_eq!(state, HeadlineState::Idle);
        let state: HeadlineState = serde_json::from_str("\"rate_limited\"").unwrap();
        assert_eq!(state, HeadlineState::RateLimited);
    }
}
