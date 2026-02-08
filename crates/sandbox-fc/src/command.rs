use tokio::process::Command;
use tracing::trace;

/// Shorthand for `exec_command(&format!(...), Privilege::Sudo).await`.
///
/// # Safety (shell injection)
///
/// All callers format arguments from controlled sources only: hex-formatted
/// indices, calculated IP addresses, and compile-time constants. No
/// user-supplied strings are interpolated into shell commands.
macro_rules! sudo {
    ($($arg:tt)*) => {
        $crate::command::exec_command(
            &format!($($arg)*),
            $crate::command::Privilege::Sudo,
        ).await
    };
}
pub(crate) use sudo;

/// Error from a failed shell command.
#[derive(Debug, thiserror::Error)]
#[error("command failed: {command}\n{detail}")]
pub struct CommandError {
    pub command: String,
    pub detail: String,
}

/// How a shell command should be executed.
#[derive(Debug, Clone, Copy)]
pub enum Privilege {
    /// Run via `sudo sh -c <cmd>`.
    Sudo,
    /// Run via `sh -c <cmd>` as the current user.
    User,
}

/// Execute a shell command.
///
/// Returns trimmed stdout on success.
pub async fn exec_command(cmd: &str, privilege: Privilege) -> Result<String, CommandError> {
    trace!(cmd, ?privilege, "exec_command");

    let output = match privilege {
        Privilege::Sudo => Command::new("sudo").args(["sh", "-c", cmd]).output().await,
        Privilege::User => Command::new("sh").args(["-c", cmd]).output().await,
    };

    let output = output.map_err(|e| CommandError {
        command: cmd.to_string(),
        detail: e.to_string(),
    })?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(CommandError {
            command: cmd.to_string(),
            detail: stderr,
        })
    }
}

/// Execute a shell command, ignoring any errors.
pub async fn exec_command_ignore_errors(cmd: &str, privilege: Privilege) {
    trace!(cmd, ?privilege, "exec_command_ignore_errors");

    let (prog, args): (&str, &[&str]) = match privilege {
        Privilege::Sudo => ("sudo", &["sh", "-c", cmd]),
        Privilege::User => ("sh", &["-c", cmd]),
    };

    match Command::new(prog).args(args).output().await {
        Ok(output) if !output.status.success() => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            trace!(cmd, stderr = %stderr.trim(), "command failed (ignored)");
        }
        Err(e) => {
            trace!(cmd, error = %e, "command failed to spawn (ignored)");
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn exec_command_returns_trimmed_stdout() {
        let output = exec_command("echo '  hello  '", Privilege::User)
            .await
            .unwrap();
        assert_eq!(output, "hello");
    }

    #[tokio::test]
    async fn exec_command_captures_multiline_output() {
        let output = exec_command("printf 'a\\nb\\nc'", Privilege::User)
            .await
            .unwrap();
        assert_eq!(output, "a\nb\nc");
    }

    #[tokio::test]
    async fn exec_command_returns_error_on_failure() {
        let err = exec_command("exit 1", Privilege::User).await.unwrap_err();
        assert_eq!(err.command, "exit 1");
    }

    #[tokio::test]
    async fn exec_command_error_contains_stderr() {
        let err = exec_command("echo oops >&2; exit 1", Privilege::User)
            .await
            .unwrap_err();
        assert!(err.detail.contains("oops"), "detail was: {}", err.detail);
    }

    #[tokio::test]
    async fn exec_command_ignore_errors_does_not_panic_on_failure() {
        exec_command_ignore_errors("exit 1", Privilege::User).await;
    }

    #[tokio::test]
    async fn exec_command_ignore_errors_does_not_panic_on_success() {
        exec_command_ignore_errors("true", Privilege::User).await;
    }
}
