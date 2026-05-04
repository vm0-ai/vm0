use std::io;
use std::process::{Child, Command, Stdio};

/// Maximum length for command preview in logs
const COMMAND_PREVIEW_MAX_LEN: usize = 100;

fn get_exec_user() -> Option<&'static str> {
    #[cfg(debug_assertions)]
    {
        None
    }

    #[cfg(not(debug_assertions))]
    {
        // Default user for command execution (UID 1000, matching E2B sandbox)
        Some("user")
    }
}

/// Shell-escape a value by wrapping in single quotes and escaping embedded `'`.
fn shell_escape_value(val: &str) -> String {
    format!("'{}'", val.replace('\'', "'\\''"))
}

/// Prepend environment variable exports to a command string.
///
/// Returns the command unchanged when `env` is empty. Otherwise produces
/// `export KEY='value' KEY2='value2'; command` so the variables are
/// available for shell expansion in the command.
pub(crate) fn prepend_env(command: &str, env: &[(&str, &str)]) -> String {
    if env.is_empty() {
        return command.to_string();
    }
    let mut parts = String::from("export ");
    for (i, (key, val)) in env.iter().enumerate() {
        if i > 0 {
            parts.push(' ');
        }
        parts.push_str(key);
        parts.push('=');
        parts.push_str(&shell_escape_value(val));
    }
    parts.push_str("; ");
    parts.push_str(command);
    parts
}

/// Build a Command to execute a shell command as the appropriate user.
///
/// When `sudo` is true the command runs as root, bypassing `su - user` and
/// the PAM overhead that comes with it.
///
/// In release builds the guest-init process is already root, so `sh -c`
/// suffices. In debug builds the process is a normal user, so `sudo sh -c`
/// is needed to elevate.
pub(crate) fn build_exec_command(command: &str, sudo: bool) -> Command {
    match get_exec_user() {
        Some(user) => {
            if sudo {
                // Release: already root — run directly
                let mut c = Command::new("sh");
                c.arg("-c").arg(command);
                c
            } else {
                let mut c = Command::new("su");
                c.arg("-").arg(user).arg("-c").arg(command);
                c
            }
        }
        None => {
            if sudo {
                // Debug: not root — elevate with sudo
                let mut c = Command::new("sudo");
                c.arg("sh").arg("-c").arg(command);
                c
            } else {
                let mut c = Command::new("sh");
                c.arg("-c").arg(command);
                c
            }
        }
    }
}

/// Truncate a command string for logging, preserving UTF-8 boundaries
pub(crate) fn truncate_preview(s: &str) -> String {
    if s.len() <= COMMAND_PREVIEW_MAX_LEN {
        return s.to_string();
    }
    // Find a safe UTF-8 boundary at or before the max length
    let end = s
        .char_indices()
        .take_while(|(i, _)| *i < COMMAND_PREVIEW_MAX_LEN)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(COMMAND_PREVIEW_MAX_LEN);
    format!("{}...", &s[..end])
}

/// Spawn a command as the leader of a new process group on Unix.
///
/// Timeout killing targets the process group by child PID, so every child path
/// that uses the shared wait helpers must preserve this spawn invariant.
pub(crate) fn spawn_in_own_process_group(command: &mut Command) -> io::Result<Child> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0).spawn()
    }
    #[cfg(not(unix))]
    {
        command.spawn()
    }
}

/// Spawn `command` with stdout/stderr piped — used by both buffered exec and
/// streaming spawn-watch.
pub(crate) fn spawn_with_pipes(command: &str, sudo: bool) -> io::Result<Child> {
    let mut command = build_exec_command(command, sudo);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    spawn_in_own_process_group(&mut command)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use crate::wait::{WaitOutcome, wait_with_kill_timeout};

    struct TempDirGuard(PathBuf);

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn wait_for_path(path: &std::path::Path, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if path.exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        path.exists()
    }

    #[test]
    fn shell_escape_simple() {
        assert_eq!(shell_escape_value("hello"), "'hello'");
    }

    #[test]
    fn shell_escape_with_single_quotes() {
        assert_eq!(shell_escape_value("it's"), "'it'\\''s'");
    }

    #[test]
    fn shell_escape_empty() {
        assert_eq!(shell_escape_value(""), "''");
    }

    #[test]
    fn prepend_env_empty() {
        assert_eq!(prepend_env("echo hi", &[]), "echo hi");
    }

    #[test]
    fn prepend_env_single() {
        assert_eq!(
            prepend_env("echo hi", &[("FOO", "bar")]),
            "export FOO='bar'; echo hi"
        );
    }

    #[test]
    fn prepend_env_multiple() {
        let result = prepend_env("cmd", &[("A", "1"), ("B", "2")]);
        assert_eq!(result, "export A='1' B='2'; cmd");
    }

    #[test]
    fn prepend_env_with_special_chars() {
        let result = prepend_env("cmd", &[("KEY", "it's a \"test\"")]);
        assert_eq!(result, "export KEY='it'\\''s a \"test\"'; cmd");
    }

    #[test]
    fn truncate_preview_short_string() {
        let s = "echo hello";
        assert_eq!(truncate_preview(s), "echo hello");
    }

    #[test]
    fn truncate_preview_exact_limit() {
        let s = "x".repeat(COMMAND_PREVIEW_MAX_LEN);
        assert_eq!(truncate_preview(&s), s);
    }

    #[test]
    fn truncate_preview_over_limit() {
        let s = "y".repeat(COMMAND_PREVIEW_MAX_LEN + 50);
        let result = truncate_preview(&s);
        // Single-byte ASCII: truncates to exactly COMMAND_PREVIEW_MAX_LEN + "..."
        assert_eq!(
            result,
            format!("{}{}", "y".repeat(COMMAND_PREVIEW_MAX_LEN), "...")
        );
    }

    #[test]
    fn truncate_preview_multibyte_utf8() {
        // Each '🔥' is 4 bytes. Fill to just over the limit.
        let emoji = "🔥".repeat(COMMAND_PREVIEW_MAX_LEN / 4 + 5);
        let result = truncate_preview(&emoji);
        assert!(result.ends_with("..."));
        // Must not panic from slicing in the middle of a UTF-8 sequence
        assert!(result.is_char_boundary(result.len() - 3));
    }

    #[test]
    fn build_exec_command_normal() {
        let cmd = build_exec_command("echo hello", false);
        let prog = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into()).collect();
        // In debug builds: sh -c "echo hello"
        // In release builds: su - user -c "echo hello"
        assert!(
            (prog == "sh" && args == ["-c", "echo hello"])
                || (prog == "su" && args == ["-", "user", "-c", "echo hello"]),
            "unexpected command: {prog} {args:?}"
        );
    }

    #[test]
    fn build_exec_command_sudo() {
        let cmd = build_exec_command("reboot", true);
        let prog = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into()).collect();
        // In debug builds: sudo sh -c "reboot"
        // In release builds: sh -c "reboot"
        assert!(
            (prog == "sudo" && args == ["sh", "-c", "reboot"])
                || (prog == "sh" && args == ["-c", "reboot"]),
            "unexpected sudo command: {prog} {args:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn spawn_in_own_process_group_timeout_kills_background_child() {
        let dir = std::env::temp_dir().join(format!(
            "vsock-guest-pg-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let _guard = TempDirGuard(dir.clone());
        let ready = dir.join("ready");
        let survived = dir.join("survived");
        let ready_arg = shell_escape_value(ready.to_str().unwrap());
        let survived_arg = shell_escape_value(survived.to_str().unwrap());
        let script =
            format!("trap '' HUP; (sleep 1; touch {survived_arg}) & touch {ready_arg}; wait");

        let mut command = build_exec_command(&script, false);
        command.stdout(Stdio::null()).stderr(Stdio::null());
        let child = spawn_in_own_process_group(&mut command).unwrap();
        assert!(
            wait_for_path(&ready, Duration::from_secs(2)),
            "background child should be started before timeout kill is tested"
        );

        let outcome = wait_with_kill_timeout(child, 100);
        assert!(matches!(outcome, WaitOutcome::TimedOut));

        std::thread::sleep(Duration::from_millis(1500));
        assert!(
            !survived.exists(),
            "timeout kill should terminate background children in the process group"
        );
    }
}
