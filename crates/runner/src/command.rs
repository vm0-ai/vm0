use tokio::process::Command;
use tracing::trace;

use crate::error::{RunnerError, RunnerResult};

/// How a command should be executed.
#[derive(Debug, Clone, Copy)]
pub enum Privilege {
    /// Prefix with `sudo`.
    Sudo,
    /// Run as the current user.
    User,
}

/// Format a human-readable display string for a command invocation.
fn format_cmd_display(program: &str, args: &[&str], privilege: Privilege) -> String {
    let mut parts = Vec::with_capacity(args.len() + 2);
    if matches!(privilege, Privilege::Sudo) {
        parts.push("sudo");
    }
    parts.push(program);
    parts.extend_from_slice(args);
    parts.join(" ")
}

/// Execute a command, returning trimmed stdout on success.
pub async fn exec(program: &str, args: &[&str], privilege: Privilege) -> RunnerResult<String> {
    let cmd_display = format_cmd_display(program, args, privilege);
    trace!(command = %cmd_display, "exec");

    let output = match privilege {
        Privilege::Sudo => {
            let mut sudo_args = vec![program];
            sudo_args.extend_from_slice(args);
            Command::new("sudo").args(&sudo_args).output().await
        }
        Privilege::User => Command::new(program).args(args).output().await,
    };

    let output = output.map_err(|e| RunnerError::Internal(format!("{cmd_display}: {e}")))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(RunnerError::Internal(format!("{cmd_display}\n{stderr}")))
    }
}

/// Execute a command, ignoring any errors.
pub async fn exec_ignore_errors(program: &str, args: &[&str], privilege: Privilege) {
    let cmd_display = format_cmd_display(program, args, privilege);
    trace!(command = %cmd_display, "exec_ignore_errors");

    let output = match privilege {
        Privilege::Sudo => {
            let mut sudo_args = vec![program];
            sudo_args.extend_from_slice(args);
            Command::new("sudo").args(&sudo_args).output().await
        }
        Privilege::User => Command::new(program).args(args).output().await,
    };

    match output {
        Ok(o) if !o.status.success() => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            trace!(command = %cmd_display, stderr = %stderr.trim(), "command failed (ignored)");
        }
        Err(e) => {
            trace!(command = %cmd_display, error = %e, "command failed to spawn (ignored)");
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_cmd_display_user() {
        let cmd_display = format_cmd_display(
            "mksquashfs",
            &["/tmp/x", "/out", "-comp", "xz"],
            Privilege::User,
        );
        assert_eq!(cmd_display, "mksquashfs /tmp/x /out -comp xz");
    }

    #[test]
    fn format_cmd_display_sudo() {
        let cmd_display = format_cmd_display(
            "mount",
            &["-t", "squashfs", "/dev/loop0", "/mnt"],
            Privilege::Sudo,
        );
        assert_eq!(cmd_display, "sudo mount -t squashfs /dev/loop0 /mnt");
    }

    #[tokio::test]
    async fn exec_returns_trimmed_stdout() {
        let output = exec("echo", &["hello"], Privilege::User).await.unwrap();
        assert_eq!(output, "hello");
    }

    #[tokio::test]
    async fn exec_returns_error_on_failure() {
        let err = exec("false", &[], Privilege::User).await.unwrap_err();
        assert!(err.to_string().contains("false"));
    }

    #[tokio::test]
    async fn exec_ignore_errors_does_not_panic() {
        exec_ignore_errors("false", &[], Privilege::User).await;
    }
}
