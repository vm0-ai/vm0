use tokio::process::Command;
use tracing::trace;

/// Error from a failed command.
#[derive(Debug, thiserror::Error)]
#[error("command failed: {command}\n{detail}")]
pub struct CommandError {
    pub command: String,
    pub detail: String,
}

/// Format a human-readable display string for a command invocation.
fn format_command_display(program: &str, args: &[&str]) -> String {
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(program);
    parts.extend_from_slice(args);
    parts.join(" ")
}

/// Execute a command.
///
/// Invokes the program binary directly with the given arguments.
/// Returns trimmed stdout on success.
pub async fn exec(program: &str, args: &[&str]) -> Result<String, CommandError> {
    let cmd_display = format_command_display(program, args);
    trace!(command = %cmd_display, "exec");

    let output = Command::new(program).args(args).output().await;

    let output = output.map_err(|e| CommandError {
        command: cmd_display.clone(),
        detail: e.to_string(),
    })?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(CommandError {
            command: cmd_display,
            detail: stderr,
        })
    }
}

/// Execute a command, ignoring any errors.
pub async fn exec_ignore_errors(program: &str, args: &[&str]) {
    let cmd_display = format_command_display(program, args);
    trace!(command = %cmd_display, "exec_ignore_errors");

    let output = Command::new(program).args(args).output().await;

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
    fn format_command_display_simple() {
        let display = format_command_display("mkfs.ext4", &["-F", "-q", "/tmp/x"]);
        assert_eq!(display, "mkfs.ext4 -F -q /tmp/x");
    }

    #[tokio::test]
    async fn exec_returns_trimmed_stdout() {
        let output = exec("echo", &["hello"]).await.unwrap();
        assert_eq!(output, "hello");
    }

    #[tokio::test]
    async fn exec_captures_multiline_output() {
        let output = exec("printf", &["a\\nb\\nc"]).await.unwrap();
        assert_eq!(output, "a\nb\nc");
    }

    #[tokio::test]
    async fn exec_returns_error_on_failure() {
        let err = exec("false", &[]).await.unwrap_err();
        assert!(
            err.command.contains("false"),
            "command was: {}",
            err.command
        );
    }

    #[tokio::test]
    async fn exec_error_contains_stderr() {
        let err = exec("bash", &["-c", "echo oops >&2; exit 1"])
            .await
            .unwrap_err();
        assert!(err.detail.contains("oops"), "detail was: {}", err.detail);
    }

    #[tokio::test]
    async fn exec_passes_multiple_args() {
        let output = exec("printf", &["%s-%s", "a", "b"]).await.unwrap();
        assert_eq!(output, "a-b");
    }

    #[tokio::test]
    async fn exec_ignore_errors_does_not_panic_on_failure() {
        exec_ignore_errors("false", &[]).await;
    }

    #[tokio::test]
    async fn exec_ignore_errors_does_not_panic_on_success() {
        exec_ignore_errors("true", &[]).await;
    }
}
