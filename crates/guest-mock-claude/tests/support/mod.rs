//! Shared harness for guest-mock-claude integration tests.

#[cfg(target_os = "linux")]
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::process::{ChildStdin, Command, ExitStatus, Output, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread::JoinHandle;
use std::time::Duration;

#[cfg(unix)]
use guest_mock_claude::process_group_child::observe_child_exit_without_reaping;
use guest_mock_claude::process_group_child::{self, ProcessGroupChild};
use serde_json::Value;

pub const ACTIVE_INPUT_READY_RESULT: &str = "READY_FOR_ACTIVE_INPUT";
const CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
const EVENT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_STREAM_JSON_EVENTS: usize = 32;
pub const MOCK_CAPTURE_LIMIT_BYTES: usize = 1024 * 1024;
pub const LARGE_MOCK_OUTPUT_BYTES: usize = MOCK_CAPTURE_LIMIT_BYTES + 1024;
pub const STDOUT_TRUNCATION_MARKER: &str = "[stdout truncated after 1048576 bytes]";
pub const STDERR_TRUNCATION_MARKER: &str = "[stderr truncated after 1048576 bytes]";

pub struct StreamJsonChild {
    child: Option<ProcessGroupChild>,
    stdin: Option<ChildStdin>,
    pub rx: Receiver<Result<Value, String>>,
    stdout_thread: Option<JoinHandle<()>>,
}

impl StreamJsonChild {
    pub fn stdin_mut(&mut self) -> Result<&mut ChildStdin, Box<dyn std::error::Error>> {
        self.stdin
            .as_mut()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "stdin closed"))
            .map_err(Into::into)
    }

    pub fn close_stdin(&mut self) {
        self.stdin.take();
    }

    pub fn wait(mut self) -> Result<(ExitStatus, String), Box<dyn std::error::Error>> {
        self.close_stdin();
        let child = self.child.take().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "mock child already reaped")
        })?;
        let stdout_thread = self
            .stdout_thread
            .take()
            .ok_or_else(|| std::io::Error::other("stdout reader thread already joined"))?;
        wait_child(child, stdout_thread)
    }
}

impl Drop for StreamJsonChild {
    fn drop(&mut self) {
        self.close_stdin();
        if let Some(child) = self.child.take() {
            child.terminate();
        }
        if let Some(stdout_thread) = self.stdout_thread.take() {
            let _ = stdout_thread.join();
        }
    }
}

pub fn mock_claude() -> Command {
    Command::new(env!("CARGO_BIN_EXE_guest-mock-claude"))
}

pub fn spawn_managed_mock_child(command: &mut Command) -> std::io::Result<ProcessGroupChild> {
    ProcessGroupChild::spawn(command)
}

fn missing_child_pipe(pipe_name: &str) -> std::io::Error {
    std::io::Error::other(format!("mock child missing {pipe_name} pipe"))
}

fn child_exit_timed_out(error: &(dyn std::error::Error + 'static)) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::TimedOut)
}

pub fn run_mock_output(command: &mut Command) -> Result<Output, Box<dyn std::error::Error>> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    wait_child_output(spawn_managed_mock_child(command)?)
}

pub fn expected_history_path(home: &std::path::Path, session_id: &str) -> std::path::PathBuf {
    let project_name = "home-user-workspace";
    home.join(".claude")
        .join("projects")
        .join(format!("-{project_name}"))
        .join(format!("{session_id}.jsonl"))
}

pub fn parse_jsonl(output: &[u8]) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let stdout = String::from_utf8(output.to_vec())?;
    stdout
        .lines()
        .map(|line| Ok(serde_json::from_str::<Value>(line)?))
        .collect()
}

pub fn init_session_id(events: &[Value]) -> Result<String, Box<dyn std::error::Error>> {
    let session_id = events
        .iter()
        .find(|event| {
            event.get("type").and_then(Value::as_str) == Some("system")
                && event.get("subtype").and_then(Value::as_str) == Some("init")
        })
        .and_then(|event| event.get("session_id"))
        .and_then(Value::as_str)
        .ok_or("missing init session_id")?;
    Ok(session_id.to_string())
}

pub fn event_kind(event: &Value) -> String {
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    match event_type {
        "system" | "result" => {
            let subtype = event.get("subtype").and_then(Value::as_str).unwrap_or("");
            format!("{event_type}/{subtype}")
        }
        "assistant" | "user" => {
            let content_type = event
                .pointer("/message/content/0/type")
                .and_then(Value::as_str)
                .unwrap_or("");
            format!("{event_type}/{content_type}")
        }
        _ => event_type.to_string(),
    }
}

pub fn tool_result_content(events: &[Value]) -> Result<&str, Box<dyn std::error::Error>> {
    match events.iter().find_map(|event| {
        if event.get("type").and_then(Value::as_str) != Some("user") {
            return None;
        }
        event
            .pointer("/message/content/0/content")
            .and_then(Value::as_str)
    }) {
        Some(content) => Ok(content),
        None => Err("missing tool result content".into()),
    }
}

pub fn result_content(events: &[Value]) -> Result<&str, Box<dyn std::error::Error>> {
    match events.iter().find_map(|event| {
        if event.get("type").and_then(Value::as_str) != Some("result") {
            return None;
        }
        event.get("result").and_then(Value::as_str)
    }) {
        Some(content) => Ok(content),
        None => Err("missing result content".into()),
    }
}

pub fn stream_json_user_frame(prompt: &str) -> String {
    stream_json_user_frame_with_uuid(prompt, "mock-test-user-1")
}

pub fn stream_json_user_frame_with_uuid(prompt: &str, uuid: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": prompt,
            },
            "uuid": uuid,
            "parent_tool_use_id": null,
        })
    )
}

pub fn spawn_stream_json_child(
    home: &std::path::Path,
    replay_user_messages: bool,
) -> Result<StreamJsonChild, Box<dyn std::error::Error>> {
    let mut command = mock_claude();
    command.env("HOME", home).args([
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
    ]);
    if replay_user_messages {
        command.arg("--replay-user-messages");
    }
    command
        .arg("--")
        .arg("printf argv-wrong")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = spawn_managed_mock_child(&mut command)?;
    let Some(stdin) = child.take_stdin() else {
        child.terminate();
        return Err(missing_child_pipe("stdin").into());
    };
    let Some(stdout) = child.take_stdout() else {
        child.terminate();
        return Err(missing_child_pipe("stdout").into());
    };
    let (tx, rx) = mpsc::channel();
    let stdout_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    let _ = tx.send(Err(format!("read stdout line: {error}")));
                    break;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            let event = serde_json::from_str::<Value>(&line)
                .map_err(|error| format!("parse stdout JSONL: {error}; line={line:?}"));
            if tx.send(event).is_err() {
                break;
            }
        }
    });

    Ok(StreamJsonChild {
        child: Some(child),
        stdin: Some(stdin),
        rx,
        stdout_thread: Some(stdout_thread),
    })
}

fn recv_event(rx: &Receiver<Result<Value, String>>) -> Result<Value, Box<dyn std::error::Error>> {
    match rx.recv_timeout(EVENT_TIMEOUT) {
        Ok(Ok(event)) => Ok(event),
        Ok(Err(message)) => Err(std::io::Error::other(message).into()),
        Err(error) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!("timed out waiting for mock event: {error}"),
        )
        .into()),
    }
}

pub fn recv_until_result(
    rx: &Receiver<Result<Value, String>>,
    result: &str,
) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let mut events = Vec::new();
    for _ in 0..MAX_STREAM_JSON_EVENTS {
        let event = recv_event(rx)?;
        let matches_result = event.get("type").and_then(Value::as_str) == Some("result")
            && event.get("result").and_then(Value::as_str) == Some(result);
        events.push(event);
        if matches_result {
            return Ok(events);
        }
    }

    Err(std::io::Error::other(format!(
        "mock did not emit result {result:?} within {MAX_STREAM_JSON_EVENTS} events"
    ))
    .into())
}

fn wait_child(
    mut child: ProcessGroupChild,
    stdout_thread: JoinHandle<()>,
) -> Result<(ExitStatus, String), Box<dyn std::error::Error>> {
    let child_stderr = child.take_stderr();
    let stderr_thread = std::thread::spawn(move || -> Result<String, std::io::Error> {
        let mut stderr = String::new();
        if let Some(mut child_stderr) = child_stderr {
            child_stderr.read_to_string(&mut stderr)?;
        }
        Ok(stderr)
    });

    let status = match wait_child_status_and_cleanup_group(child) {
        Err(error) if child_exit_timed_out(error.as_ref()) => return Err(error),
        result => result,
    };
    let stdout_result = stdout_thread
        .join()
        .map_err(|_| std::io::Error::other("stdout reader thread panicked"));
    let stderr_result = stderr_thread
        .join()
        .map_err(|_| std::io::Error::other("stderr reader thread panicked"));

    let status = status?;
    stdout_result?;
    let stderr = stderr_result??;
    Ok((status, stderr))
}

#[cfg(unix)]
fn wait_child_status_and_cleanup_group(
    child: ProcessGroupChild,
) -> Result<ExitStatus, Box<dyn std::error::Error>> {
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    let wait_thread = std::thread::spawn(move || {
        let result = observe_child_exit_without_reaping(pid);
        let _ = tx.send(result);
    });

    let child_observed = match rx.recv_timeout(CHILD_EXIT_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            process_group_child::terminate_child_by_pid(pid);
            rx.recv_timeout(CHILD_EXIT_TIMEOUT).map_err(|error| {
                std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("mock child did not exit after SIGKILL: {error}"),
                )
            })?
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(std::io::Error::other(
            "mock child wait thread exited without observing status",
        )),
    };

    wait_thread
        .join()
        .map_err(|_| std::io::Error::other("child wait thread panicked"))?;
    if let Err(error) = child_observed {
        child.terminate();
        return Err(error.into());
    }
    process_group_child::terminate_process_group(pid);
    Ok(child.wait_direct_child()?)
}

#[cfg(not(unix))]
fn wait_child_status_and_cleanup_group(
    child: ProcessGroupChild,
) -> Result<ExitStatus, Box<dyn std::error::Error>> {
    wait_child_status(child)
}

#[cfg(not(unix))]
fn wait_child_status(child: ProcessGroupChild) -> Result<ExitStatus, Box<dyn std::error::Error>> {
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    let wait_thread = std::thread::spawn(move || {
        let result = child.wait_direct_child();
        let _ = tx.send(result);
    });

    let child_result = match rx.recv_timeout(CHILD_EXIT_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            process_group_child::terminate_child_by_pid(pid);
            rx.recv_timeout(CHILD_EXIT_TIMEOUT).map_err(|error| {
                std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("mock child did not exit after SIGKILL: {error}"),
                )
            })?
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(std::io::Error::other(
            "mock child wait thread exited without status",
        )),
    };

    wait_thread
        .join()
        .map_err(|_| std::io::Error::other("child wait thread panicked"))?;
    Ok(child_result?)
}

pub fn wait_child_output(
    mut child: ProcessGroupChild,
) -> Result<Output, Box<dyn std::error::Error>> {
    let Some(mut child_stdout) = child.take_stdout() else {
        child.terminate();
        return Err(missing_child_pipe("stdout").into());
    };
    let Some(mut child_stderr) = child.take_stderr() else {
        child.terminate();
        return Err(missing_child_pipe("stderr").into());
    };
    let stdout_thread = std::thread::spawn(move || -> Result<Vec<u8>, std::io::Error> {
        let mut stdout = Vec::new();
        child_stdout.read_to_end(&mut stdout)?;
        Ok(stdout)
    });
    let stderr_thread = std::thread::spawn(move || -> Result<Vec<u8>, std::io::Error> {
        let mut stderr = Vec::new();
        child_stderr.read_to_end(&mut stderr)?;
        Ok(stderr)
    });

    let status = match wait_child_status_and_cleanup_group(child) {
        Err(error) if child_exit_timed_out(error.as_ref()) => return Err(error),
        result => result,
    };
    let stdout_result = stdout_thread
        .join()
        .map_err(|_| std::io::Error::other("stdout reader thread panicked"));
    let stderr_result = stderr_thread
        .join()
        .map_err(|_| std::io::Error::other("stderr reader thread panicked"));

    let status = status?;
    let stdout = stdout_result??;
    let stderr = stderr_result??;

    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

pub fn mock_stream_json_shell_output(
    home: &std::path::Path,
    prompt: &str,
) -> Result<Output, Box<dyn std::error::Error>> {
    let mut command = mock_claude();
    command
        .env("HOME", home)
        .args(["--output-format", "stream-json", "--", prompt])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    wait_child_output(spawn_managed_mock_child(&mut command)?)
}

#[cfg(target_os = "linux")]
pub fn kill_pid_file(pid_file: &std::path::Path) {
    if let Ok(pid) = fs::read_to_string(pid_file).map(|value| value.trim().to_string())
        && let Ok(pid) = pid.parse::<libc::pid_t>()
    {
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}
