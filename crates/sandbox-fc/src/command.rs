use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;
use tracing::trace;

/// Error from a failed command.
#[derive(Debug, thiserror::Error)]
#[error("command failed: {command}\n{detail}")]
pub struct CommandError {
    pub command: String,
    pub detail: String,
}

/// Outcome for best-effort commands where callers intentionally ignore
/// non-zero exits but still need coarse failure classification for cleanup
/// safety decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IgnoredCommandOutcome {
    Success,
    NonZero,
    NotFound,
    SpawnError,
    WaitError,
    PipeError,
    Timeout,
}

impl IgnoredCommandOutcome {
    pub fn completed_without_timeout(self) -> bool {
        matches!(self, Self::Success | Self::NonZero)
    }
}

#[derive(Debug, thiserror::Error)]
enum CommandRunError {
    #[error("spawn failed: {0}")]
    Spawn(std::io::Error),
    #[error("wait failed: {0}")]
    Wait(std::io::Error),
    #[error("pipe read task failed: {0}")]
    PipeTask(tokio::task::JoinError),
    #[error("pipe read failed: {0}")]
    PipeRead(std::io::Error),
    #[error("{0} pipe unavailable")]
    PipeUnavailable(&'static str),
    #[error("timed out after {0}ms")]
    Timeout(u128),
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
/// waited before returning. On Unix, the subprocess runs in its own process
/// group so timeout cleanup also kills grandchildren. The timeout bounds both
/// child exit and stdout/stderr pipe draining.
pub async fn exec_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<String, CommandError> {
    let cmd_display = format_command_display(program, args);
    trace!(command = %cmd_display, timeout_ms = timeout.as_millis() as u64, "exec_with_timeout");

    let output = command_output_with_timeout(program, args, timeout)
        .await
        .map_err(|e| CommandError {
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
        Err(CommandRunError::Timeout(ms)) => {
            trace!(command = %cmd_display, timeout_ms = ms as u64, "command timed out (ignored)");
            IgnoredCommandOutcome::Timeout
        }
        Err(CommandRunError::Wait(e)) => {
            trace!(command = %cmd_display, error = %e, "command wait failed (ignored)");
            IgnoredCommandOutcome::WaitError
        }
        Err(CommandRunError::PipeTask(e)) => {
            trace!(command = %cmd_display, error = %e, "command pipe task failed (ignored)");
            IgnoredCommandOutcome::PipeError
        }
        Err(CommandRunError::PipeRead(e)) => {
            trace!(command = %cmd_display, error = %e, "command pipe read failed (ignored)");
            IgnoredCommandOutcome::PipeError
        }
        Err(CommandRunError::PipeUnavailable(pipe)) => {
            trace!(command = %cmd_display, pipe, "command pipe unavailable (ignored)");
            IgnoredCommandOutcome::PipeError
        }
        Err(CommandRunError::Spawn(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            trace!(command = %cmd_display, error = %e, "command not found (ignored)");
            IgnoredCommandOutcome::NotFound
        }
        Err(CommandRunError::Spawn(e)) => {
            trace!(command = %cmd_display, error = %e, "command failed to spawn (ignored)");
            IgnoredCommandOutcome::SpawnError
        }
    }
}

async fn command_output_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> std::result::Result<std::process::Output, CommandRunError> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(CommandRunError::Spawn)?;
    let child_pid = child.id();

    let stdout = child
        .stdout
        .take()
        .ok_or(CommandRunError::PipeUnavailable("stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or(CommandRunError::PipeUnavailable("stderr"))?;

    let stdout_task = tokio::spawn(read_pipe(stdout));
    let stderr_task = tokio::spawn(read_pipe(stderr));
    let deadline = tokio::time::Instant::now() + timeout;

    let status = match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            kill_child_tree(&mut child).await;
            abort_pipe_tasks(stdout_task, stderr_task).await;
            return Err(CommandRunError::Wait(e));
        }
        Err(_) => {
            kill_child_tree(&mut child).await;
            abort_pipe_tasks(stdout_task, stderr_task).await;
            return Err(CommandRunError::Timeout(timeout.as_millis()));
        }
    };

    let (stdout, stderr) =
        collect_pipes_with_deadline(stdout_task, stderr_task, deadline, timeout, child_pid).await?;
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

async fn collect_pipes_with_deadline(
    mut stdout_task: JoinHandle<std::io::Result<Vec<u8>>>,
    mut stderr_task: JoinHandle<std::io::Result<Vec<u8>>>,
    deadline: tokio::time::Instant,
    timeout: Duration,
    child_pid: Option<u32>,
) -> std::result::Result<(Vec<u8>, Vec<u8>), CommandRunError> {
    let stdout = match tokio::time::timeout_at(deadline, &mut stdout_task).await {
        Ok(result) => match collect_pipe_result(result) {
            Ok(stdout) => stdout,
            Err(e) => {
                abort_pipe_task(stderr_task).await;
                return Err(e);
            }
        },
        Err(_) => {
            kill_process_group_by_optional_pid(child_pid);
            abort_pipe_tasks(stdout_task, stderr_task).await;
            return Err(CommandRunError::Timeout(timeout.as_millis()));
        }
    };

    let stderr = match tokio::time::timeout_at(deadline, &mut stderr_task).await {
        Ok(result) => collect_pipe_result(result)?,
        Err(_) => {
            kill_process_group_by_optional_pid(child_pid);
            abort_pipe_task(stderr_task).await;
            return Err(CommandRunError::Timeout(timeout.as_millis()));
        }
    };

    Ok((stdout, stderr))
}

fn collect_pipe_result(
    result: std::result::Result<std::io::Result<Vec<u8>>, tokio::task::JoinError>,
) -> std::result::Result<Vec<u8>, CommandRunError> {
    result
        .map_err(CommandRunError::PipeTask)?
        .map_err(CommandRunError::PipeRead)
}

async fn kill_child_tree(child: &mut Child) {
    #[cfg(unix)]
    crate::process::kill_process_group(child);
    let _ = child.start_kill();
    let _ = child.wait().await;
}

fn kill_process_group_by_optional_pid(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        crate::process::kill_process_group_by_pid(pid);
    }
    #[cfg(not(unix))]
    let _ = pid;
}

async fn abort_pipe_tasks(
    stdout_task: JoinHandle<std::io::Result<Vec<u8>>>,
    stderr_task: JoinHandle<std::io::Result<Vec<u8>>>,
) {
    abort_pipe_task(stdout_task).await;
    abort_pipe_task(stderr_task).await;
}

async fn abort_pipe_task(task: JoinHandle<std::io::Result<Vec<u8>>>) {
    task.abort();
    let _ = task.await;
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
    async fn exec_ignore_errors_with_timeout_reports_not_found() {
        let outcome = exec_ignore_errors_with_timeout(
            "vm0-definitely-missing-command-for-timeout-test",
            &[],
            Duration::from_millis(50),
        )
        .await;

        assert_eq!(outcome, IgnoredCommandOutcome::NotFound);
    }

    #[tokio::test]
    async fn exec_with_timeout_kills_child_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("marker");
        let marker = marker.to_str().unwrap();

        let _ = exec_ignore_errors_with_timeout(
            "sh",
            &["-c", "(sleep 0.2; touch \"$1\") & wait", "_", marker],
            Duration::from_millis(50),
        )
        .await;

        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!std::path::Path::new(marker).exists());
    }

    #[tokio::test]
    async fn exec_with_timeout_bounds_pipe_drain_after_parent_exits() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("marker");
        let marker = marker.to_str().unwrap();

        let outcome = exec_ignore_errors_with_timeout(
            "sh",
            &["-c", "(sleep 0.2; touch \"$1\") &", "_", marker],
            Duration::from_millis(50),
        )
        .await;

        assert_eq!(outcome, IgnoredCommandOutcome::Timeout);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!std::path::Path::new(marker).exists());
    }

    #[tokio::test]
    async fn exec_with_timeout_aborts_only_remaining_pipe_reader() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("marker");
        let marker = marker.to_str().unwrap();

        let outcome = exec_ignore_errors_with_timeout(
            "sh",
            &["-c", "(exec 1>&-; sleep 0.2; touch \"$1\") &", "_", marker],
            Duration::from_millis(50),
        )
        .await;

        assert_eq!(outcome, IgnoredCommandOutcome::Timeout);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!std::path::Path::new(marker).exists());
    }
}
