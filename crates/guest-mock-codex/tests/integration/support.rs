use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::time::Duration;
use std::{io::Seek, io::Write};

use guest_mock_codex::find_session_file;
use serde_json::Value;

pub(crate) const BIN: &str = env!("CARGO_BIN_EXE_guest-mock-codex");
const CLI_RUN_TIMEOUT: Duration = Duration::from_secs(10);
const CLI_RUN_KILL_TIMEOUT: Duration = Duration::from_secs(5);

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

fn output_with_timeout(mut cmd: Command, args: &[&str]) -> std::io::Result<Output> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = cmd.spawn()?;
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    let wait_thread = std::thread::spawn(move || {
        let result = child.wait_with_output();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(CLI_RUN_TIMEOUT) {
        Ok(result) => {
            wait_thread
                .join()
                .map_err(|_| std::io::Error::other("guest-mock-codex CLI wait thread panicked"))?;
            result
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            // SAFETY: this is test cleanup for the child process spawned by this helper.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
            match rx.recv_timeout(CLI_RUN_KILL_TIMEOUT) {
                Ok(Ok(output)) => {
                    wait_thread.join().map_err(|_| {
                        std::io::Error::other("guest-mock-codex CLI wait thread panicked")
                    })?;
                    Err(cli_run_timeout_error(args, Some(&output), None))
                }
                Ok(Err(err)) => {
                    wait_thread.join().map_err(|_| {
                        std::io::Error::other("guest-mock-codex CLI wait thread panicked")
                    })?;
                    Err(cli_run_timeout_error(args, None, Some(&err)))
                }
                Err(mpsc::RecvTimeoutError::Timeout) => Err(cli_run_timeout_error_after_kill(args)),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    wait_thread.join().map_err(|_| {
                        std::io::Error::other("guest-mock-codex CLI wait thread panicked")
                    })?;
                    Err(std::io::Error::other(
                        "guest-mock-codex CLI wait thread exited without output",
                    ))
                }
            }
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            wait_thread
                .join()
                .map_err(|_| std::io::Error::other("guest-mock-codex CLI wait thread panicked"))?;
            Err(std::io::Error::other(
                "guest-mock-codex CLI wait thread exited without output",
            ))
        }
    }
}

fn cli_run_timeout_error(
    args: &[&str],
    output: Option<&Output>,
    wait_error: Option<&std::io::Error>,
) -> std::io::Error {
    let mut message =
        format!("guest-mock-codex CLI timed out after {CLI_RUN_TIMEOUT:?}: args={args:?}");
    if let Some(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        message.push_str(&format!(
            "; status={:?}; stdout={stdout:?}; stderr={stderr:?}",
            output.status
        ));
    }
    if let Some(err) = wait_error {
        message.push_str(&format!("; wait_with_output after kill failed: {err}"));
    }
    std::io::Error::new(std::io::ErrorKind::TimedOut, message)
}

fn cli_run_timeout_error_after_kill(args: &[&str]) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        format!(
            "guest-mock-codex CLI timed out after {CLI_RUN_TIMEOUT:?} and did not exit within \
             {CLI_RUN_KILL_TIMEOUT:?} after SIGKILL: args={args:?}"
        ),
    )
}

pub(crate) fn require_session_file(codex_home: &Path) -> std::io::Result<PathBuf> {
    find_session_file(codex_home)?.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("session file not found under {codex_home:?}"),
        )
    })
}
