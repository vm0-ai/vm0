use std::io;
use std::process::{ExitStatus, Output, Stdio};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::child_cleanup::kill_and_reap_child_on_drop;

const COMMAND_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const BOUNDED_COMMAND_CHILD_LABEL: &str = "bounded command";

#[derive(Debug)]
pub(crate) enum BoundedCommandOutcome<T> {
    Exited(T),
    TimedOut,
}

#[derive(Debug)]
pub(crate) enum BoundedCommandError {
    Spawn(io::Error),
    Wait(io::Error),
    Lifecycle(String),
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum CommandOutputCapture {
    Stderr,
    StdoutAndStderr,
}

pub(crate) async fn run_bounded(
    mut command: Command,
    program: &str,
    timeout: Duration,
) -> Result<BoundedCommandOutcome<ExitStatus>, BoundedCommandError> {
    let mut child = BoundedChild::spawn(&mut command).map_err(BoundedCommandError::Spawn)?;

    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => Ok(BoundedCommandOutcome::Exited(status)),
        Ok(Err(error)) => {
            kill_and_reap_child(program, &mut child)
                .await
                .map_err(BoundedCommandError::Lifecycle)?;
            Err(BoundedCommandError::Wait(error))
        }
        Err(_) => {
            kill_and_reap_child(program, &mut child)
                .await
                .map_err(BoundedCommandError::Lifecycle)?;
            Ok(BoundedCommandOutcome::TimedOut)
        }
    }
}

pub(crate) async fn run_output_bounded(
    mut command: Command,
    program: &str,
    capture: CommandOutputCapture,
    timeout: Duration,
) -> Result<BoundedCommandOutcome<Output>, BoundedCommandError> {
    match capture {
        CommandOutputCapture::Stderr => {
            command.stdout(Stdio::null()).stderr(Stdio::piped());
        }
        CommandOutputCapture::StdoutAndStderr => {
            command.stdout(Stdio::piped()).stderr(Stdio::piped());
        }
    }

    let mut child = BoundedChild::spawn(&mut command).map_err(BoundedCommandError::Spawn)?;
    let mut output_tasks = match child.output_tasks(capture) {
        Ok(output_tasks) => output_tasks,
        Err(stream) => {
            return match kill_and_reap_child(program, &mut child).await {
                Ok(()) => Err(BoundedCommandError::Lifecycle(format!(
                    "{program} {stream} pipe unavailable"
                ))),
                Err(cleanup_error) => Err(BoundedCommandError::Lifecycle(format!(
                    "{program} {stream} pipe unavailable and failed to stop child: {cleanup_error}"
                ))),
            };
        }
    };

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            let cleanup_result = kill_and_reap_child(program, &mut child).await;
            output_tasks.abort();
            cleanup_result.map_err(BoundedCommandError::Lifecycle)?;
            return Err(BoundedCommandError::Wait(error));
        }
        Err(_) => {
            let cleanup_result = kill_and_reap_child(program, &mut child).await;
            output_tasks.abort();
            cleanup_result.map_err(BoundedCommandError::Lifecycle)?;
            return Ok(BoundedCommandOutcome::TimedOut);
        }
    };

    let (stdout, stderr) = output_tasks.collect(program).await?;
    Ok(BoundedCommandOutcome::Exited(Output {
        status,
        stdout,
        stderr,
    }))
}

struct BoundedChild {
    child: Option<Child>,
}

impl BoundedChild {
    fn spawn(command: &mut Command) -> io::Result<Self> {
        command.spawn().map(|child| Self { child: Some(child) })
    }

    async fn wait(&mut self) -> io::Result<ExitStatus> {
        let result = match self.child.as_mut() {
            Some(child) => child.wait().await,
            None => Err(io::Error::other("bounded command child is not owned")),
        };
        if result.is_ok() {
            self.child = None;
        }
        result
    }

    fn start_kill(&mut self) -> io::Result<()> {
        match self.child.as_mut() {
            Some(child) => child.start_kill(),
            None => Err(io::Error::other("bounded command child is not owned")),
        }
    }

    fn output_tasks(
        &mut self,
        capture: CommandOutputCapture,
    ) -> Result<ChildOutputTasks, &'static str> {
        match self.child.as_mut() {
            Some(child) => ChildOutputTasks::from_child(child, capture),
            None => Err("child"),
        }
    }
}

impl Drop for BoundedChild {
    fn drop(&mut self) {
        kill_and_reap_child_on_drop(BOUNDED_COMMAND_CHILD_LABEL, &mut self.child);
    }
}

enum ChildOutputTasks {
    Stderr(JoinHandle<io::Result<Vec<u8>>>),
    StdoutAndStderr {
        stdout: JoinHandle<io::Result<Vec<u8>>>,
        stderr: JoinHandle<io::Result<Vec<u8>>>,
    },
}

impl ChildOutputTasks {
    fn from_child(
        child: &mut tokio::process::Child,
        capture: CommandOutputCapture,
    ) -> Result<Self, &'static str> {
        match capture {
            CommandOutputCapture::Stderr => {
                let stderr = child.stderr.take().ok_or("stderr")?;
                Ok(Self::Stderr(tokio::spawn(read_child_output(stderr))))
            }
            CommandOutputCapture::StdoutAndStderr => {
                let stdout = child.stdout.take().ok_or("stdout")?;
                let stderr = child.stderr.take().ok_or("stderr")?;
                Ok(Self::StdoutAndStderr {
                    stdout: tokio::spawn(read_child_output(stdout)),
                    stderr: tokio::spawn(read_child_output(stderr)),
                })
            }
        }
    }

    async fn collect(&mut self, program: &str) -> Result<(Vec<u8>, Vec<u8>), BoundedCommandError> {
        let deadline = Instant::now() + COMMAND_CLEANUP_TIMEOUT;
        match self {
            Self::Stderr(stderr_task) => {
                let result = tokio::time::timeout_at(
                    deadline,
                    wait_child_output_task(program, "stderr", stderr_task),
                )
                .await;
                match result {
                    Ok(stderr) => Ok((Vec::new(), stderr?)),
                    Err(_) => {
                        stderr_task.abort();
                        Err(output_task_timeout(program, "stderr"))
                    }
                }
            }
            Self::StdoutAndStderr {
                stdout: stdout_task,
                stderr: stderr_task,
            } => {
                let result = tokio::time::timeout_at(deadline, async {
                    tokio::try_join!(
                        wait_child_output_task(program, "stdout", stdout_task),
                        wait_child_output_task(program, "stderr", stderr_task),
                    )
                })
                .await;
                match result {
                    Ok(Ok(output)) => Ok(output),
                    Ok(Err(error)) => {
                        stdout_task.abort();
                        stderr_task.abort();
                        Err(error)
                    }
                    Err(_) => {
                        let stream = if stdout_task.is_finished() {
                            "stderr"
                        } else {
                            "stdout"
                        };
                        stdout_task.abort();
                        stderr_task.abort();
                        Err(output_task_timeout(program, stream))
                    }
                }
            }
        }
    }

    fn abort(&self) {
        match self {
            Self::Stderr(stderr) => stderr.abort(),
            Self::StdoutAndStderr { stdout, stderr } => {
                stdout.abort();
                stderr.abort();
            }
        }
    }
}

impl Drop for ChildOutputTasks {
    fn drop(&mut self) {
        self.abort();
    }
}

async fn read_child_output<R>(mut reader: R) -> io::Result<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut output = Vec::new();
    reader.read_to_end(&mut output).await?;
    Ok(output)
}

async fn wait_child_output_task(
    program: &str,
    stream: &str,
    task: &mut JoinHandle<io::Result<Vec<u8>>>,
) -> Result<Vec<u8>, BoundedCommandError> {
    child_output_task_result(program, stream, task.await)
}

fn child_output_task_result(
    program: &str,
    stream: &str,
    result: Result<io::Result<Vec<u8>>, tokio::task::JoinError>,
) -> Result<Vec<u8>, BoundedCommandError> {
    match result {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(BoundedCommandError::Lifecycle(format!(
            "read {program} {stream}: {error}"
        ))),
        Err(error) => Err(BoundedCommandError::Lifecycle(format!(
            "{program} {stream} task failed: {error}"
        ))),
    }
}

fn output_task_timeout(program: &str, stream: &str) -> BoundedCommandError {
    BoundedCommandError::Lifecycle(format!(
        "{program} {stream} task did not finish within {}ms after child exit",
        COMMAND_CLEANUP_TIMEOUT.as_millis()
    ))
}

async fn kill_and_reap_child(program: &str, child: &mut BoundedChild) -> Result<(), String> {
    let kill_error = child.start_kill().err();
    let deadline = Instant::now() + COMMAND_CLEANUP_TIMEOUT;
    match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => Err(format!("wait killed {program}: {error}")),
        Err(_) => {
            let kill_detail = kill_error
                .map(|error| format!("; kill failed first: {error}"))
                .unwrap_or_default();
            Err(format!(
                "killed {program} did not exit within {}ms{kill_detail}",
                COMMAND_CLEANUP_TIMEOUT.as_millis()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    use crate::process::read_process_stat;
    #[cfg(target_os = "linux")]
    use std::path::Path;

    #[cfg(target_os = "linux")]
    const PROCESS_OBSERVATION_TIMEOUT: Duration = Duration::from_secs(2);

    #[cfg(target_os = "linux")]
    fn pid_recording_command(pid_path: &Path) -> Command {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("printf '%s' \"$$\" > \"$1.tmp\"; mv \"$1.tmp\" \"$1\"; exec sleep 60")
            .arg("sh")
            .arg(pid_path);
        command
    }

    #[cfg(target_os = "linux")]
    async fn wait_for_recorded_process(pid_path: &Path) -> io::Result<(u32, u64)> {
        let deadline = std::time::Instant::now() + PROCESS_OBSERVATION_TIMEOUT;
        loop {
            match tokio::fs::read_to_string(pid_path).await {
                Ok(raw_pid) => {
                    let pid = raw_pid.trim().parse::<u32>().map_err(io::Error::other)?;
                    if let Some(stat) = read_process_stat(pid).await {
                        return Ok((pid, stat.starttime));
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            if std::time::Instant::now() >= deadline {
                return Err(io::Error::other(format!(
                    "timed out waiting for command pid in {}",
                    pid_path.display()
                )));
            }
            tokio::task::yield_now().await;
        }
    }

    #[cfg(target_os = "linux")]
    async fn wait_for_process_exit(pid: u32, starttime: u64) -> io::Result<()> {
        let deadline = std::time::Instant::now() + PROCESS_OBSERVATION_TIMEOUT;
        while matches!(read_process_stat(pid).await, Some(stat) if stat.starttime == starttime) {
            if std::time::Instant::now() >= deadline {
                return Err(io::Error::other(format!(
                    "timed out waiting for process {pid} to be reaped"
                )));
            }
            tokio::task::yield_now().await;
        }
        Ok(())
    }

    #[tokio::test]
    async fn status_command_times_out_after_reaping_child() {
        let mut command = Command::new("sleep");
        command.arg("60");

        let outcome = run_bounded(command, "sleep", Duration::from_millis(1))
            .await
            .unwrap();

        assert!(matches!(outcome, BoundedCommandOutcome::TimedOut));
    }

    #[tokio::test]
    async fn output_command_times_out_after_reaping_child() {
        let mut command = Command::new("sleep");
        command.arg("60");

        let outcome = run_output_bounded(
            command,
            "sleep",
            CommandOutputCapture::StdoutAndStderr,
            Duration::from_millis(1),
        )
        .await
        .unwrap();

        assert!(matches!(outcome, BoundedCommandOutcome::TimedOut));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn output_command_timeout_reaps_recorded_child() -> io::Result<()> {
        let temp_dir = tempfile::tempdir()?;
        let pid_path = temp_dir.path().join("pid");
        let command = pid_recording_command(&pid_path);
        let task = tokio::spawn(run_output_bounded(
            command,
            "sh",
            CommandOutputCapture::StdoutAndStderr,
            Duration::from_secs(1),
        ));
        let (pid, starttime) = match wait_for_recorded_process(&pid_path).await {
            Ok(process) => process,
            Err(error) => {
                task.abort();
                let _ = task.await;
                return Err(error);
            }
        };

        let outcome = task.await.unwrap().unwrap();

        assert!(matches!(outcome, BoundedCommandOutcome::TimedOut));
        wait_for_process_exit(pid, starttime).await
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn output_command_cancellation_reaps_recorded_child() -> io::Result<()> {
        let temp_dir = tempfile::tempdir()?;
        let pid_path = temp_dir.path().join("pid");
        let command = pid_recording_command(&pid_path);
        let task = tokio::spawn(run_output_bounded(
            command,
            "sh",
            CommandOutputCapture::StdoutAndStderr,
            Duration::from_secs(60),
        ));
        let (pid, starttime) = match wait_for_recorded_process(&pid_path).await {
            Ok(process) => process,
            Err(error) => {
                task.abort();
                let _ = task.await;
                return Err(error);
            }
        };

        task.abort();
        assert!(matches!(task.await, Err(error) if error.is_cancelled()));
        wait_for_process_exit(pid, starttime).await
    }

    #[tokio::test]
    async fn output_command_captures_requested_streams() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf stdout; printf stderr >&2"]);

        let outcome = run_output_bounded(
            command,
            "sh",
            CommandOutputCapture::StdoutAndStderr,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        let BoundedCommandOutcome::Exited(output) = outcome else {
            panic!("command unexpectedly timed out");
        };

        assert!(output.status.success());
        assert_eq!(output.stdout, b"stdout");
        assert_eq!(output.stderr, b"stderr");

        let mut command = Command::new("sh");
        command.args(["-c", "printf stdout; printf stderr >&2"]);
        let outcome = run_output_bounded(
            command,
            "sh",
            CommandOutputCapture::Stderr,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        let BoundedCommandOutcome::Exited(output) = outcome else {
            panic!("command unexpectedly timed out");
        };

        assert!(output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(output.stderr, b"stderr");
    }

    #[tokio::test(start_paused = true)]
    async fn output_tasks_share_one_cleanup_deadline() {
        let stdout = tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(1_500)).await;
            Ok(Vec::new())
        });
        let stderr = tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(60)).await;
            Ok(Vec::new())
        });
        let mut tasks = ChildOutputTasks::StdoutAndStderr { stdout, stderr };
        let started_at = Instant::now();

        let error = tasks.collect("test-command").await.unwrap_err();

        assert_eq!(Instant::now() - started_at, COMMAND_CLEANUP_TIMEOUT);
        assert!(
            matches!(error, BoundedCommandError::Lifecycle(message) if message.contains("stderr task did not finish"))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn output_task_failure_is_not_masked_by_open_sibling() {
        let stdout = tokio::spawn(async { Err(io::Error::other("read failed")) });
        let stderr = tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(60)).await;
            Ok(Vec::new())
        });
        let mut tasks = ChildOutputTasks::StdoutAndStderr { stdout, stderr };
        let started_at = Instant::now();

        let error = tasks.collect("test-command").await.unwrap_err();

        assert_eq!(Instant::now() - started_at, Duration::ZERO);
        assert!(
            matches!(error, BoundedCommandError::Lifecycle(message) if message.contains("read test-command stdout: read failed"))
        );
    }
}
