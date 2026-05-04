use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;
use tracing::trace;

type PipeReadTask = JoinHandle<std::io::Result<Vec<u8>>>;

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
    let mut kill_guard = ProcessGroupKillGuard::new(child_pid);

    let stdout = child
        .stdout
        .take()
        .ok_or(CommandRunError::PipeUnavailable("stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or(CommandRunError::PipeUnavailable("stderr"))?;

    let mut pipe_tasks = PipeTasks::new(
        tokio::spawn(read_pipe(stdout)),
        tokio::spawn(read_pipe(stderr)),
    );
    let deadline = tokio::time::Instant::now() + timeout;

    let status = match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            kill_child_tree(&mut child).await;
            pipe_tasks.abort_all().await;
            return Err(CommandRunError::Wait(e));
        }
        Err(_) => {
            kill_child_tree(&mut child).await;
            pipe_tasks.abort_all().await;
            return Err(CommandRunError::Timeout(timeout.as_millis()));
        }
    };

    let (stdout, stderr) = pipe_tasks
        .collect_with_deadline(deadline, timeout, child_pid)
        .await?;
    kill_guard.disarm();
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

struct ProcessGroupKillGuard {
    pid: Option<u32>,
}

impl ProcessGroupKillGuard {
    fn new(pid: Option<u32>) -> Self {
        Self { pid }
    }

    fn disarm(&mut self) {
        self.pid = None;
    }
}

impl Drop for ProcessGroupKillGuard {
    fn drop(&mut self) {
        kill_process_group_by_optional_pid(self.pid);
    }
}

struct PipeTasks {
    stdout: Option<PipeReadTask>,
    stderr: Option<PipeReadTask>,
}

#[derive(Clone, Copy)]
enum PipeKind {
    Stdout,
    Stderr,
}

impl PipeKind {
    fn name(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

impl PipeTasks {
    fn new(stdout: PipeReadTask, stderr: PipeReadTask) -> Self {
        Self {
            stdout: Some(stdout),
            stderr: Some(stderr),
        }
    }

    async fn collect_with_deadline(
        &mut self,
        deadline: tokio::time::Instant,
        timeout: Duration,
        child_pid: Option<u32>,
    ) -> std::result::Result<(Vec<u8>, Vec<u8>), CommandRunError> {
        let stdout = self
            .collect_one(PipeKind::Stdout, deadline, timeout, child_pid)
            .await?;
        let stderr = self
            .collect_one(PipeKind::Stderr, deadline, timeout, child_pid)
            .await?;

        Ok((stdout, stderr))
    }

    async fn collect_one(
        &mut self,
        kind: PipeKind,
        deadline: tokio::time::Instant,
        timeout: Duration,
        child_pid: Option<u32>,
    ) -> std::result::Result<Vec<u8>, CommandRunError> {
        let result = match tokio::time::timeout_at(
            deadline,
            self.pipe_mut(kind)
                .ok_or(CommandRunError::PipeUnavailable(kind.name()))?,
        )
        .await
        {
            Ok(result) => result,
            Err(_) => {
                kill_process_group_by_optional_pid(child_pid);
                self.abort_all().await;
                return Err(CommandRunError::Timeout(timeout.as_millis()));
            }
        };

        self.take_pipe(kind);
        match collect_pipe_result(result) {
            Ok(output) => Ok(output),
            Err(e) => {
                self.abort_all().await;
                Err(e)
            }
        }
    }

    fn pipe_mut(&mut self, kind: PipeKind) -> Option<&mut PipeReadTask> {
        match kind {
            PipeKind::Stdout => self.stdout.as_mut(),
            PipeKind::Stderr => self.stderr.as_mut(),
        }
    }

    fn take_pipe(&mut self, kind: PipeKind) -> Option<PipeReadTask> {
        match kind {
            PipeKind::Stdout => self.stdout.take(),
            PipeKind::Stderr => self.stderr.take(),
        }
    }

    async fn abort_all(&mut self) {
        self.abort_stdout().await;
        self.abort_stderr().await;
    }

    async fn abort_stdout(&mut self) {
        if let Some(task) = self.stdout.take() {
            abort_pipe_task(task).await;
        }
    }

    async fn abort_stderr(&mut self) {
        if let Some(task) = self.stderr.take() {
            abort_pipe_task(task).await;
        }
    }
}

impl Drop for PipeTasks {
    fn drop(&mut self) {
        if let Some(task) = self.stdout.take() {
            task.abort();
        }
        if let Some(task) = self.stderr.take() {
            task.abort();
        }
    }
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

async fn abort_pipe_task(task: PipeReadTask) {
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
    async fn exec_with_timeout_returns_trimmed_stdout() {
        let output = exec_with_timeout("echo", &["hello"], Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(output, "hello");
    }

    #[tokio::test]
    async fn exec_with_timeout_captures_multiline_output() {
        let output = exec_with_timeout("printf", &["a\\nb\\nc"], Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(output, "a\nb\nc");
    }

    #[tokio::test]
    async fn exec_with_timeout_returns_error_on_failure() {
        let err = exec_with_timeout("false", &[], Duration::from_secs(1))
            .await
            .unwrap_err();
        assert!(
            err.command.contains("false"),
            "command was: {}",
            err.command
        );
    }

    #[tokio::test]
    async fn exec_with_timeout_error_contains_stderr() {
        let err = exec_with_timeout(
            "bash",
            &["-c", "echo oops >&2; exit 1"],
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert!(err.detail.contains("oops"), "detail was: {}", err.detail);
    }

    #[tokio::test]
    async fn exec_with_timeout_passes_multiple_args() {
        let output = exec_with_timeout("printf", &["%s-%s", "a", "b"], Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(output, "a-b");
    }

    #[tokio::test]
    async fn exec_ignore_errors_with_timeout_reports_nonzero() {
        let outcome = exec_ignore_errors_with_timeout("false", &[], Duration::from_secs(1)).await;
        assert_eq!(outcome, IgnoredCommandOutcome::NonZero);
    }

    #[tokio::test]
    async fn exec_ignore_errors_with_timeout_reports_success() {
        let outcome = exec_ignore_errors_with_timeout("true", &[], Duration::from_secs(1)).await;
        assert_eq!(outcome, IgnoredCommandOutcome::Success);
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
        assert_timeout_kills_grandchild("(sleep 5; touch \"$2\") & echo $! > \"$1\"; wait").await;
    }

    #[tokio::test]
    async fn exec_with_timeout_bounds_pipe_drain_after_parent_exits() {
        assert_timeout_kills_grandchild("(sleep 5; touch \"$2\") & echo $! > \"$1\"").await;
    }

    #[tokio::test]
    async fn exec_with_timeout_aborts_only_remaining_pipe_reader() {
        assert_timeout_kills_grandchild("(exec 1>&-; sleep 5; touch \"$2\") & echo $! > \"$1\"")
            .await;
    }

    async fn assert_timeout_kills_grandchild(script: &str) {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let marker = dir.path().join("marker");
        let pid_file = pid_file.to_str().unwrap();
        let marker = marker.to_str().unwrap();

        let outcome = exec_ignore_errors_with_timeout(
            "sh",
            &["-c", script, "_", pid_file, marker],
            Duration::from_millis(250),
        )
        .await;

        assert_eq!(outcome, IgnoredCommandOutcome::Timeout);
        let pid = read_pid_file(pid_file).await;
        assert_pid_not_running(pid).await;
        assert!(!std::path::Path::new(marker).exists());
    }

    #[tokio::test]
    async fn exec_with_timeout_cancel_kills_child_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let marker = dir.path().join("marker");
        let pid_file = pid_file.to_str().unwrap().to_string();
        let marker = marker.to_str().unwrap().to_string();

        let command = tokio::spawn({
            let pid_file = pid_file.clone();
            let marker = marker.clone();
            async move {
                exec_ignore_errors_with_timeout(
                    "sh",
                    &[
                        "-c",
                        "(sleep 5; touch \"$2\") & echo $! > \"$1\"; wait",
                        "_",
                        &pid_file,
                        &marker,
                    ],
                    Duration::from_secs(10),
                )
                .await
            }
        });

        let pid = read_pid_file(&pid_file).await;
        command.abort();
        let _ = command.await;

        assert_pid_not_running(pid).await;
        assert!(!std::path::Path::new(&marker).exists());
    }

    #[tokio::test]
    async fn collect_with_deadline_cancel_aborts_pending_pipe_readers() {
        let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
        let (dropped_tx, mut dropped_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut pipe_tasks = PipeTasks::new(
            pending_pipe_task("stdout", started_tx.clone(), dropped_tx.clone()),
            pending_pipe_task("stderr", started_tx, dropped_tx),
        );

        let mut started = [
            recv_pipe_start(&mut started_rx).await,
            recv_pipe_start(&mut started_rx).await,
        ];
        started.sort_unstable();
        assert_eq!(started, ["stderr", "stdout"]);

        {
            let collect = pipe_tasks.collect_with_deadline(
                tokio::time::Instant::now() + Duration::from_secs(30),
                Duration::from_secs(30),
                None,
            );
            tokio::pin!(collect);
            tokio::select! {
                biased;
                result = &mut collect => panic!("pipe collection completed unexpectedly: {result:?}"),
                _ = tokio::task::yield_now() => {}
            }
        }
        drop(pipe_tasks);

        let mut dropped = [
            recv_pipe_drop(&mut dropped_rx).await,
            recv_pipe_drop(&mut dropped_rx).await,
        ];
        dropped.sort_unstable();
        assert_eq!(dropped, ["stderr", "stdout"]);
    }

    struct PipeDropNotify {
        name: &'static str,
        dropped: tokio::sync::mpsc::UnboundedSender<&'static str>,
    }

    impl Drop for PipeDropNotify {
        fn drop(&mut self) {
            let _ = self.dropped.send(self.name);
        }
    }

    fn pending_pipe_task(
        name: &'static str,
        started: tokio::sync::mpsc::UnboundedSender<&'static str>,
        dropped: tokio::sync::mpsc::UnboundedSender<&'static str>,
    ) -> PipeReadTask {
        tokio::spawn(async move {
            let _notify = PipeDropNotify { name, dropped };
            let _ = started.send(name);
            std::future::pending::<std::io::Result<Vec<u8>>>().await
        })
    }

    async fn recv_pipe_start(
        started: &mut tokio::sync::mpsc::UnboundedReceiver<&'static str>,
    ) -> &'static str {
        tokio::time::timeout(Duration::from_secs(1), started.recv())
            .await
            .expect("pipe task did not start")
            .expect("pipe task start channel closed")
    }

    async fn recv_pipe_drop(
        dropped: &mut tokio::sync::mpsc::UnboundedReceiver<&'static str>,
    ) -> &'static str {
        tokio::time::timeout(Duration::from_secs(1), dropped.recv())
            .await
            .expect("pipe reader was not aborted")
            .expect("pipe reader drop channel closed")
    }

    async fn read_pid_file(path: &str) -> u32 {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        loop {
            match std::fs::read_to_string(path) {
                Ok(pid) => match pid.trim().parse() {
                    Ok(pid) => return pid,
                    Err(_) if pid.trim().is_empty() => {}
                    Err(e) => panic!("pid file {path} contains invalid pid: {e}"),
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => panic!("read pid file {path}: {e}"),
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "pid file was not written: {path}"
            );
            tokio::task::yield_now().await;
        }
    }

    async fn assert_pid_not_running(pid: u32) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while process_is_running(pid) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "process {pid} was still running after command timeout"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[cfg(target_os = "linux")]
    fn process_is_running(pid: u32) -> bool {
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return false;
        };
        let Some((_, after_comm)) = stat.rsplit_once(") ") else {
            return false;
        };
        !after_comm.starts_with('Z')
    }

    #[cfg(all(unix, not(target_os = "linux")))]
    fn process_is_running(pid: u32) -> bool {
        let pid = nix::unistd::Pid::from_raw(i32::try_from(pid).expect("pid fits in i32"));
        match nix::sys::signal::kill(pid, None) {
            Ok(()) => true,
            Err(nix::errno::Errno::ESRCH) => false,
            Err(_) => true,
        }
    }

    #[cfg(not(unix))]
    fn process_is_running(_pid: u32) -> bool {
        false
    }
}
