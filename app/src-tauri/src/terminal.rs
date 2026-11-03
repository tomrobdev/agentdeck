const CMUX_BIN: &str = "/Applications/cmux.app/Contents/Resources/bin/cmux";

/// Whether cmux is installed (its binary is not on a GUI app's PATH, so the dashboard asks here).
#[tauri::command]
pub fn cmux_installed() -> bool {
    std::path::Path::new(CMUX_BIN).is_file()
}

/// Fill a template's placeholders. An argument holding `{command}` is dropped, with the flag before
/// it, when there is no command to run.
fn fill_template(
    template: &[String],
    title: &str,
    cwd: &str,
    command: Option<&str>,
) -> Vec<String> {
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
            arg = arg
                .replace("{title}", title)
                .replace("{cwd}", cwd)
                .replace("{command}", cmd);
        } else {
            arg = arg.replace("{title}", title).replace("{cwd}", cwd);
        }
        out.push(arg);
    }
    out
}

/// Run a command template (a terminal's, an editor's) as an argv list: the program, then its
/// arguments, with `{title}`, `{cwd}` and `{command}` filled in. Nothing goes through a shell.
/// `cmux` is found at its install path when it is not on PATH.
#[tauri::command]
pub async fn run_template(
    template: Vec<String>,
    title: Option<String>,
    cwd: String,
    command: Option<String>,
) -> Result<(), String> {
    let title = title.unwrap_or_default();
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("{cwd} is not a directory"));
    }
    let mut argv = fill_template(&template, &title, &cwd, command.as_deref());
    if argv.is_empty() {
        return Err("The command is empty".into());
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

#[cfg(test)]
mod tests {
    use super::fill_template;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn fills_cwd_for_an_editor_template() {
        let out = fill_template(&args(&["code", "{cwd}"]), "", "/work/tree", None);
        assert_eq!(out, args(&["code", "/work/tree"]));
    }

    #[test]
    fn fills_title() {
        let out = fill_template(&args(&["--name", "{title}"]), "Task 1", "/w", None);
        assert_eq!(out, args(&["--name", "Task 1"]));
    }

    #[test]
    fn fills_cwd() {
        let out = fill_template(&args(&["--dir={cwd}"]), "t", "/work/tree", None);
        assert_eq!(out, args(&["--dir=/work/tree"]));
    }

    #[test]
    fn fills_command() {
        let out = fill_template(&args(&["--exec", "{command}"]), "t", "/w", Some("ls -la"));
        assert_eq!(out, args(&["--exec", "ls -la"]));
    }

    #[test]
    fn fills_all_placeholders_in_one_argument() {
        let out = fill_template(&args(&["{title}@{cwd}: {command}"]), "T", "/w", Some("go"));
        assert_eq!(out, args(&["T@/w: go"]));
    }

    #[test]
    fn drops_command_with_its_flag_when_there_is_none() {
        let out = fill_template(
            &args(&["term", "--exec", "{command}", "x"]),
            "t",
            "/w",
            None,
        );
        assert_eq!(out, args(&["term", "x"]));
    }

    #[test]
    fn drops_command_alone_when_previous_is_not_a_flag() {
        let out = fill_template(&args(&["term", "open", "{command}"]), "t", "/w", None);
        assert_eq!(out, args(&["term", "open"]));
    }

    #[test]
    fn keeps_a_placeholder_typed_inside_the_command() {
        let out = fill_template(&args(&["-e", "{command}"]), "T", "/w", Some("echo {title}"));
        assert_eq!(out, args(&["-e", "echo {title}"]));
    }
}
