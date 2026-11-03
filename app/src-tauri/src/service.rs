//! Starts the daemon through launchd when it is down. It mirrors `restart()` in `daemon/src/adapters/service.ts`, which
//! is also where the label and the plist path come from. Installing and uninstalling the service stay with the CLI.

use std::path::{Path, PathBuf};
use std::process::Command;

/// The launchd label; keep in step with `LABEL` in `daemon/src/adapters/service.ts`.
const LABEL: &str = "dev.agentdeck.daemon";
const NOT_INSTALLED: &str = "The service isn't installed: run agentdeck install";

fn plist_path(home: &str) -> PathBuf {
    Path::new(home)
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist"))
}

/// The `launchctl` arguments that start the daemon, or why none can. Pure: the caller reads the state and runs them.
fn launchctl_args(
    installed: bool,
    loaded: bool,
    uid: &str,
    plist: &Path,
) -> Result<Vec<String>, String> {
    if !installed {
        return Err(NOT_INSTALLED.into());
    }
    let domain = format!("gui/{uid}");
    Ok(if loaded {
        vec!["kickstart".into(), "-k".into(), format!("{domain}/{LABEL}")]
    } else {
        vec!["bootstrap".into(), domain, plist.display().to_string()]
    })
}

fn uid() -> Result<String, String> {
    let out = Command::new("/usr/bin/id")
        .arg("-u")
        .output()
        .map_err(|e| format!("Couldn't run id: {e}"))?;
    let uid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || uid.is_empty() {
        return Err("Couldn't read the user id".into());
    }
    Ok(uid)
}

/// Start the daemon through launchd. Returns once launchctl has done its part; the dashboard sees the daemon come up.
pub fn start() -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "HOME isn't set".to_string())?;
    let plist = plist_path(&home);
    let uid = uid()?;
    let installed = plist.is_file();
    let loaded = Command::new("/bin/launchctl")
        .args(["print", &format!("gui/{uid}/{LABEL}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let args = launchctl_args(installed, loaded, &uid, &plist)?;
    let out = Command::new("/bin/launchctl")
        .args(&args)
        .output()
        .map_err(|e| format!("Couldn't run launchctl: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(format!("launchctl {} failed: {why}", args[0]))
}

/// Start the daemon through launchd (the dashboard's "Start the daemon" button).
#[tauri::command]
pub async fn start_daemon() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(start)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plist() -> PathBuf {
        plist_path("/Users/tom")
    }

    #[test]
    fn not_installed_is_an_error() {
        assert_eq!(
            launchctl_args(false, false, "501", &plist()),
            Err("The service isn't installed: run agentdeck install".to_string())
        );
        assert!(launchctl_args(false, true, "501", &plist()).is_err());
    }

    #[test]
    fn installed_but_not_loaded_bootstraps_the_plist() {
        assert_eq!(
            launchctl_args(true, false, "501", &plist()).unwrap(),
            [
                "bootstrap",
                "gui/501",
                "/Users/tom/Library/LaunchAgents/dev.agentdeck.daemon.plist"
            ]
        );
    }

    #[test]
    fn loaded_is_kickstarted() {
        assert_eq!(
            launchctl_args(true, true, "501", &plist()).unwrap(),
            ["kickstart", "-k", "gui/501/dev.agentdeck.daemon"]
        );
    }
}
