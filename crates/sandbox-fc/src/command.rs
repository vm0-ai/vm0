use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tracing::trace;

/// Error from a failed command.
#[derive(Debug, thiserror::Error)]
#[error("command failed: {command}\n{detail}")]
pub struct CommandError {
    pub command: String,
    pub detail: String,
}

/// Outcome for best-effort commands where callers intentionally ignore
/// non-zero exits but still need to know whether cleanup timed out or failed to
/// spawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IgnoredCommandOutcome {
    Success,
    NonZero,
    SpawnError,
    WaitError,
    Timeout,
}

impl IgnoredCommandOutcome {
    pub fn completed_without_timeout(self) -> bool {
        matches!(self, Self::Success | Self::NonZero)
    }
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
#[cfg_attr(not(test), allow(dead_code))]
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

/// Execute a command with a bounded runtime.
///
/// This helper is intended for host lifecycle operations where an unbounded
/// subprocess can block resource cleanup. On timeout the child is killed and
/// waited before returning.
pub async fn exec_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<String, CommandError> {
    let cmd_display = format_command_display(program, args);
    trace!(command = %cmd_display, timeout_ms = timeout.as_millis() as u64, "exec_with_timeout");

    let output = command_output_with_timeout(program, args, timeout)
        .await
        .map_err(|detail| CommandError {
            command: cmd_display.clone(),
            detail,
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
#[cfg_attr(not(test), allow(dead_code))]
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

/// Execute a best-effort command with a bounded runtime.
pub async fn exec_ignore_errors_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> IgnoredCommandOutcome {
    let cmd_display = format_command_display(program, args);
    trace!(command = %cmd_display, timeout_ms = timeout.as_millis() as u64, "exec_ignore_errors_with_timeout");

    match command_output_with_timeout(program, args, timeout).await {
        Ok(o) if o.status.success() => IgnoredCommandOutcome::Success,
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            trace!(command = %cmd_display, stderr = %stderr.trim(), "command failed (ignored)");
            IgnoredCommandOutcome::NonZero
        }
        Err(detail) if detail.starts_with("timed out ") => {
            trace!(command = %cmd_display, detail, "command timed out (ignored)");
            IgnoredCommandOutcome::Timeout
        }
        Err(detail) if detail.starts_with("wait failed: ") => {
            trace!(command = %cmd_display, detail, "command wait failed (ignored)");
            IgnoredCommandOutcome::WaitError
        }
        Err(detail) => {
            trace!(command = %cmd_display, detail, "command failed to spawn (ignored)");
            IgnoredCommandOutcome::SpawnError
        }
    }
}

async fn command_output_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> std::result::Result<std::process::Output, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout pipe unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "stderr pipe unavailable".to_string())?;

    let stdout_task = tokio::spawn(read_pipe(stdout));
    let stderr_task = tokio::spawn(read_pipe(stderr));

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            abort_pipe_tasks(stdout_task, stderr_task).await;
            return Err(format!("wait failed: {e}"));
        }
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            abort_pipe_tasks(stdout_task, stderr_task).await;
            return Err(format!("timed out after {}ms", timeout.as_millis()));
        }
    };

    let stdout = collect_pipe(stdout_task).await?;
    let stderr = collect_pipe(stderr_task).await?;
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

async fn read_pipe<R>(mut pipe: R) -> std::io::Result<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut output = Vec::new();
    pipe.read_to_end(&mut output).await?;
    Ok(output)
}

async fn collect_pipe(
    task: tokio::task::JoinHandle<std::io::Result<Vec<u8>>>,
) -> std::result::Result<Vec<u8>, String> {
    task.await
        .map_err(|e| format!("pipe read task failed: {e}"))?
        .map_err(|e| format!("pipe read failed: {e}"))
}

async fn abort_pipe_tasks(
    stdout_task: tokio::task::JoinHandle<std::io::Result<Vec<u8>>>,
    stderr_task: tokio::task::JoinHandle<std::io::Result<Vec<u8>>>,
) {
    stdout_task.abort();
    stderr_task.abort();
    let _ = stdout_task.await;
    let _ = stderr_task.await;
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

    #[tokio::test]
    async fn exec_with_timeout_returns_timeout() {
        let err = exec_with_timeout("sh", &["-c", "sleep 2"], Duration::from_millis(50))
            .await
            .unwrap_err();

        assert!(
            err.detail.contains("timed out"),
            "detail was: {}",
            err.detail
        );
    }

    #[tokio::test]
    async fn exec_ignore_errors_with_timeout_reports_timeout() {
        let outcome =
            exec_ignore_errors_with_timeout("sh", &["-c", "sleep 2"], Duration::from_millis(50))
                .await;

        assert_eq!(outcome, IgnoredCommandOutcome::Timeout);
    }

    #[tokio::test]
    async fn exec_with_timeout_kills_child_before_followup_command() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("marker");
        let script = format!("sleep 1; touch {}", marker.display());

        let _ = exec_ignore_errors_with_timeout("sh", &["-c", &script], Duration::from_millis(50))
            .await;

        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(!marker.exists());
    }
}
