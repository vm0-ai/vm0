use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use guest_mock_codex::find_session_file;
use serde_json::Value;

pub(crate) const BIN: &str = env!("CARGO_BIN_EXE_guest-mock-codex");
const CLI_RUN_TIMEOUT: Duration = Duration::from_secs(10);
const CLI_RUN_KILL_TIMEOUT: Duration = Duration::from_secs(5);
const CHILD_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(1);

#[derive(Debug)]
pub(crate) struct RunOutput {
    pub(crate) events: Vec<Value>,
    pub(crate) status: i32,
    pub(crate) stderr: String,
}

pub(crate) fn run(codex_home: &Path, args: &[&str]) -> std::io::Result<RunOutput> {
    run_with_env(codex_home, args, &[])
}

pub(crate) fn run_with_stdin(
    codex_home: &Path,
    args: &[&str],
    stdin: &str,
) -> std::io::Result<RunOutput> {
    run_with_env_and_stdin(codex_home, args, &[], Some(stdin))
}

pub(crate) fn run_with_stdin_and_env(
    codex_home: &Path,
    args: &[&str],
    stdin: &str,
    env: &[(&str, &str)],
) -> std::io::Result<RunOutput> {
    run_with_env_and_stdin(codex_home, args, env, Some(stdin))
}

pub(crate) fn run_with_env(
    codex_home: &Path,
    args: &[&str],
    env: &[(&str, &str)],
) -> std::io::Result<RunOutput> {
    run_with_env_and_stdin(codex_home, args, env, None)
}

fn run_with_env_and_stdin(
    codex_home: &Path,
    args: &[&str],
    env: &[(&str, &str)],
    stdin: Option<&str>,
) -> std::io::Result<RunOutput> {
    let mut cmd = Command::new(BIN);
    cmd.env("CODEX_HOME", codex_home).args(args);
    cmd.env_remove("MOCK_CODEX_FIXTURE");
    for (k, v) in env {
        cmd.env(k, v);
    }
    match stdin {
        Some(stdin) => {
            let mut file = tempfile::tempfile()?;
            file.write_all(stdin.as_bytes())?;
            file.rewind()?;
            cmd.stdin(Stdio::from(file));
        }
        None => {
            cmd.stdin(Stdio::null());
        }
    }
    let output = output_with_timeout(cmd, args)?;

    let stdout = String::from_utf8(output.stdout)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let stderr = String::from_utf8(output.stderr)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut events = Vec::new();
    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        events.push(v);
    }

    Ok(RunOutput {
        events,
        status: output.status.code().unwrap_or(-1),
        stderr,
    })
}

fn output_with_timeout(cmd: Command, args: &[&str]) -> std::io::Result<Output> {
    output_with_timeout_before_kill(cmd, args, CLI_RUN_TIMEOUT, CLI_RUN_KILL_TIMEOUT, |_| {})
}

fn output_with_timeout_before_kill(
    mut cmd: Command,
    args: &[&str],
    run_timeout: Duration,
    kill_timeout: Duration,
    before_kill: impl FnOnce(u32),
) -> std::io::Result<Output> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("guest-mock-codex CLI stdout pipe missing"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| std::io::Error::other("guest-mock-codex CLI stderr pipe missing"))?;
    let stdout_reader = OutputReader::spawn(stdout);
    let stderr_reader = OutputReader::spawn(stderr);
    let output_deadline = Instant::now() + run_timeout + kill_timeout;

    match wait_child_with_timeout_before_kill(child, run_timeout, kill_timeout, before_kill) {
        ChildWaitOutcome::Exited(status) => {
            collect_output(status, stdout_reader, stderr_reader, output_deadline)
        }
        ChildWaitOutcome::TimedOut(status) => {
            let output = collect_output(status, stdout_reader, stderr_reader, output_deadline)
                .map_err(|error| cli_run_timeout_error(args, run_timeout, None, Some(&error)))?;
            Err(cli_run_timeout_error(
                args,
                run_timeout,
                Some(&output),
                None,
            ))
        }
        ChildWaitOutcome::ReapTimedOut => Err(cli_run_timeout_error_after_kill(
            args,
            run_timeout,
            kill_timeout,
        )),
        ChildWaitOutcome::KillFailed(error) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!(
                "guest-mock-codex CLI timed out after {run_timeout:?} and failed to kill the \
                 child: args={args:?}; error={error}"
            ),
        )),
        ChildWaitOutcome::ReapFailed(error) => {
            Err(cli_run_timeout_error(args, run_timeout, None, Some(&error)))
        }
        ChildWaitOutcome::WaitFailed(error) => Err(std::io::Error::other(format!(
            "guest-mock-codex CLI child wait failed: args={args:?}; error={error}"
        ))),
    }
}

fn cli_run_timeout_error(
    args: &[&str],
    run_timeout: Duration,
    output: Option<&Output>,
    cleanup_error: Option<&std::io::Error>,
) -> std::io::Error {
    let mut message =
        format!("guest-mock-codex CLI timed out after {run_timeout:?}: args={args:?}");
    if let Some(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        message.push_str(&format!(
            "; status={:?}; stdout={stdout:?}; stderr={stderr:?}",
            output.status
        ));
    }
    if let Some(error) = cleanup_error {
        message.push_str(&format!("; cleanup after timeout failed: {error}"));
    }
    std::io::Error::new(std::io::ErrorKind::TimedOut, message)
}

fn cli_run_timeout_error_after_kill(
    args: &[&str],
    run_timeout: Duration,
    kill_timeout: Duration,
) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        format!(
            "guest-mock-codex CLI timed out after {run_timeout:?} and did not exit within \
             {kill_timeout:?} after SIGKILL: args={args:?}"
        ),
    )
}

pub(crate) enum ChildWaitOutcome {
    Exited(ExitStatus),
    TimedOut(ExitStatus),
    ReapTimedOut,
    KillFailed(std::io::Error),
    ReapFailed(std::io::Error),
    WaitFailed(std::io::Error),
}

pub(crate) fn wait_child_with_timeout(
    child: Child,
    timeout: Duration,
    kill_timeout: Duration,
) -> ChildWaitOutcome {
    wait_child_with_timeout_before_kill(child, timeout, kill_timeout, |_| {})
}

fn wait_child_with_timeout_before_kill(
    mut child: Child,
    timeout: Duration,
    kill_timeout: Duration,
    before_kill: impl FnOnce(u32),
) -> ChildWaitOutcome {
    // This function alone owns exit observation and signaling. The child only
    // moves to another waiter after signaling authority has been consumed.
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return ChildWaitOutcome::Exited(status),
            Ok(None) => {}
            Err(error) => {
                // A wait error can mean another actor reaped the child without
                // caching its status here, so a later numeric-PID kill is unsafe.
                spawn_child_reaper(child);
                return ChildWaitOutcome::WaitFailed(error);
            }
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        std::thread::sleep(remaining.min(CHILD_WAIT_POLL_INTERVAL));
    }

    before_kill(child.id());
    let kill_result = child.kill();
    let reaper_rx = spawn_child_reaper(child);
    if let Err(error) = kill_result {
        return ChildWaitOutcome::KillFailed(error);
    }

    match reaper_rx.recv_timeout(kill_timeout) {
        Ok(Ok(status)) => ChildWaitOutcome::TimedOut(status),
        Ok(Err(error)) => ChildWaitOutcome::ReapFailed(error),
        Err(mpsc::RecvTimeoutError::Timeout) => ChildWaitOutcome::ReapTimedOut,
        Err(mpsc::RecvTimeoutError::Disconnected) => ChildWaitOutcome::ReapFailed(
            std::io::Error::other("child reaper exited without status"),
        ),
    }
}

fn spawn_child_reaper(mut child: Child) -> Receiver<std::io::Result<ExitStatus>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait());
    });
    rx
}

struct OutputReader {
    rx: Receiver<std::io::Result<Vec<u8>>>,
}

impl OutputReader {
    fn spawn(mut pipe: impl Read + Send + 'static) -> Self {
        let (tx, rx) = mpsc::channel();
        let _ = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.read_to_end(&mut bytes).map(|_| bytes);
            let _ = tx.send(result);
        });
        Self { rx }
    }

    fn finish(self, stream: &str, deadline: Instant) -> std::io::Result<Vec<u8>> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let result = match self.rx.recv_timeout(remaining) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("{stream} did not close before the child output deadline"),
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(std::io::Error::other(format!(
                    "{stream} reader exited without output"
                )));
            }
        };
        result.map_err(|error| {
            std::io::Error::new(error.kind(), format!("read child {stream}: {error}"))
        })
    }
}

fn collect_output(
    status: ExitStatus,
    stdout_reader: OutputReader,
    stderr_reader: OutputReader,
    deadline: Instant,
) -> std::io::Result<Output> {
    let stdout = stdout_reader.finish("stdout", deadline)?;
    let stderr = stderr_reader.finish("stderr", deadline)?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

pub(crate) fn require_session_file(codex_home: &Path) -> std::io::Result<PathBuf> {
    find_session_file(codex_home)?.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("session file not found under {codex_home:?}"),
        )
    })
}

#[cfg(unix)]
#[cfg(test)]
mod tests {
    use super::*;
    use std::process::ChildStdin;

    #[test]
    fn child_timeout_exit_stays_bound_to_the_original_child() {
        let (child, stdin) = stdin_controlled_child(23);
        let pid = child.id();

        let outcome = wait_child_with_timeout_before_kill(
            child,
            Duration::ZERO,
            Duration::from_secs(1),
            move |observed_pid| {
                assert_eq!(observed_pid, pid);
                drop(stdin);
                observe_child_exit_without_reaping(observed_pid).unwrap();
            },
        );

        assert!(matches!(outcome, ChildWaitOutcome::TimedOut(status) if status.code() == Some(23)));
        assert_child_reaped(pid);
    }

    #[test]
    fn child_timeout_kills_and_reaps_a_hung_child() {
        let child = Command::new("sh")
            .args(["-c", "exec sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();

        let outcome =
            wait_child_with_timeout(child, Duration::from_millis(5), Duration::from_secs(1));

        assert!(matches!(outcome, ChildWaitOutcome::TimedOut(status) if !status.success()));
        assert_child_reaped(pid);
    }

    #[test]
    fn output_with_timeout_drains_large_stdout_and_stderr() {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "head -c 262144 /dev/zero & head -c 262144 /dev/zero >&2 & wait",
        ]);

        let output = output_with_timeout_before_kill(
            command,
            &["large-output"],
            Duration::from_secs(2),
            Duration::from_secs(1),
            |_| {},
        )
        .unwrap();

        assert_eq!(output.stdout, vec![0; 262_144]);
        assert_eq!(output.stderr, vec![0; 262_144]);
    }

    #[test]
    fn output_with_timeout_does_not_join_a_descendant_held_pipe() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 1 &"]);
        let started = Instant::now();

        let error = output_with_timeout_before_kill(
            command,
            &["descendant-held-pipe"],
            Duration::from_millis(100),
            Duration::from_millis(30),
            |_| {},
        )
        .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert_eq!(
            error.to_string(),
            "stdout did not close before the child output deadline"
        );
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "output deadline should bound reader completion"
        );
    }

    fn stdin_controlled_child(exit_code: i32) -> (Child, ChildStdin) {
        let mut child = Command::new("sh")
            .args(["-c", &format!("read _ || exit {exit_code}")])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        (child, stdin)
    }

    fn observe_child_exit_without_reaping(pid: u32) -> std::io::Result<()> {
        let pid = libc::pid_t::try_from(pid).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "child PID does not fit in pid_t",
            )
        })?;
        loop {
            let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::uninit();
            // SAFETY: `pid` is the direct child still owned by the helper, and
            // WNOWAIT observes its exit without releasing that identity.
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    info.as_mut_ptr(),
                    libc::WEXITED | libc::WNOWAIT,
                )
            };
            if result == 0 {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    fn assert_child_reaped(pid: u32) {
        let mut status = 0;
        // SAFETY: the lifecycle helper has already returned this direct
        // child's status; WNOHANG only verifies that no waitable child remains.
        let result = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG) };
        assert_eq!(result, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    }
}
