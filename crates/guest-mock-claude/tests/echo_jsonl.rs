use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::Value;

const ACTIVE_INPUT_READY_RESULT: &str = "READY_FOR_ACTIVE_INPUT";
const CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
const EVENT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_STREAM_JSON_EVENTS: usize = 32;

struct StreamJsonChild {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Result<Value, String>>,
    stdout_thread: JoinHandle<()>,
}

fn mock_claude() -> Command {
    Command::new(env!("CARGO_BIN_EXE_guest-mock-claude"))
}

fn expected_history_path(home: &std::path::Path, session_id: &str) -> std::path::PathBuf {
    let project_name = "home-user-workspace";
    home.join(".claude")
        .join("projects")
        .join(format!("-{project_name}"))
        .join(format!("{session_id}.jsonl"))
}

fn parse_jsonl(output: &[u8]) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let stdout = String::from_utf8(output.to_vec())?;
    stdout
        .lines()
        .map(|line| Ok(serde_json::from_str::<Value>(line)?))
        .collect()
}

fn init_session_id(events: &[Value]) -> Result<String, Box<dyn std::error::Error>> {
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

fn event_kind(event: &Value) -> String {
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

fn stream_json_user_frame(prompt: &str) -> String {
    stream_json_user_frame_with_uuid(prompt, "mock-test-user-1")
}

fn stream_json_user_frame_with_uuid(prompt: &str, uuid: &str) -> String {
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

fn spawn_stream_json_child(
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

    let mut child = command.spawn()?;
    let stdin = child.stdin.take().ok_or("missing stdin")?;
    let stdout = child.stdout.take().ok_or("missing stdout")?;
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
        child,
        stdin,
        rx,
        stdout_thread,
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

fn recv_until_result(
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
    mut child: Child,
    stdout_thread: JoinHandle<()>,
) -> Result<(ExitStatus, String), Box<dyn std::error::Error>> {
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    let wait_thread = std::thread::spawn(move || {
        let result = (|| -> Result<(ExitStatus, String), std::io::Error> {
            let status = child.wait()?;
            let mut stderr = String::new();
            if let Some(mut child_stderr) = child.stderr.take() {
                child_stderr.read_to_string(&mut stderr)?;
            }
            Ok((status, stderr))
        })();
        let _ = tx.send(result);
    });

    let child_result = match rx.recv_timeout(CHILD_EXIT_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            // SAFETY: this is a test cleanup path for the child process that
            // this helper just spawned. The wait thread reaps it below.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
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
    stdout_thread
        .join()
        .map_err(|_| std::io::Error::other("stdout reader thread panicked"))?;
    Ok(child_result?)
}

#[test]
fn echo_jsonl_outputs_valid_payload_unchanged() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let payload = [
        r#"{"type":"system","subtype":"init","cwd":"/home/user/workspace","session_id":"preview-1","tools":["Bash"],"model":"mock-claude"}"#,
        r#"{"type":"assistant","session_id":"preview-1","message":{"role":"assistant","content":[{"type":"text","text":"fixture response"}]}}"#,
        r#"{"type":"result","subtype":"success","session_id":"preview-1","is_error":false,"duration_ms":100,"num_turns":1,"result":"Done.","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}"#,
    ]
    .join("\n");
    let prompt = format!("@ECHO@\n{payload}\n");

    let output = mock_claude()
        .env("HOME", home.path())
        .args(["--output-format", "stream-json", "--", &prompt])
        .output()?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{payload}\n")
    );
    assert!(output.stderr.is_empty());

    let history = fs::read_to_string(expected_history_path(home.path(), "preview-1"))?;
    assert_eq!(history, format!("{payload}\n"));
    Ok(())
}

#[test]
fn echo_jsonl_without_init_skips_history() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let payload = r#"{"type":"assistant","session_id":"preview-no-init","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}"#;
    let prompt = format!("@ECHO@\n{payload}\n");

    let output = mock_claude()
        .env("HOME", home.path())
        .args(["--output-format", "stream-json", "--", &prompt])
        .output()?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{payload}\n")
    );
    assert!(output.stderr.is_empty());
    assert!(!home.path().join(".claude").exists());
    Ok(())
}

#[test]
fn stream_json_shell_writes_matching_session_history() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let output = mock_claude()
        .env("HOME", home.path())
        .args(["--output-format", "stream-json", "--", "printf hello"])
        .output()?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let session_id = init_session_id(&events)?;
    let stdout = String::from_utf8(output.stdout)?;
    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;

    assert_eq!(history, stdout);
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        [
            "system/init",
            "assistant/text",
            "assistant/tool_use",
            "user/tool_result",
            "result/success",
        ]
    );
    assert_eq!(
        events[2]
            .pointer("/message/content/0/input/command")
            .and_then(Value::as_str),
        Some("printf hello")
    );
    assert_eq!(
        events[3]
            .pointer("/message/content/0/content")
            .and_then(Value::as_str),
        Some("hello")
    );
    assert_eq!(
        events[4].get("result").and_then(Value::as_str),
        Some("hello")
    );
    assert_eq!(
        events[4].get("is_error").and_then(Value::as_bool),
        Some(false)
    );
    Ok(())
}

#[test]
fn stream_json_input_reads_prompt_from_stdin() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let mut child = mock_claude()
        .env("HOME", home.path())
        .args([
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--",
            "printf argv-wrong",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let mut stdin = child.stdin.take().ok_or("missing stdin")?;
    stdin.write_all(stream_json_user_frame("printf stdin-ok").as_bytes())?;
    drop(stdin);

    let output = child.wait_with_output()?;
    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let result = events
        .iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("result"))
        .and_then(|event| event.get("result"))
        .and_then(Value::as_str)
        .ok_or("missing result")?;
    assert_eq!(result, "stdin-ok");

    let command = events
        .iter()
        .find(|event| {
            event.get("type").and_then(Value::as_str) == Some("assistant")
                && event
                    .pointer("/message/content/0/type")
                    .and_then(Value::as_str)
                    == Some("tool_use")
        })
        .and_then(|event| event.pointer("/message/content/0/input/command"))
        .and_then(Value::as_str)
        .ok_or("missing command")?;
    assert_eq!(command, "printf stdin-ok");
    Ok(())
}

#[test]
fn one_shot_stream_json_drains_trailing_stdin() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let mut child = mock_claude()
        .env("HOME", home.path())
        .args([
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--",
            "printf argv-wrong",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let mut stdin = child.stdin.take().ok_or("missing stdin")?;
    stdin.write_all(stream_json_user_frame("printf stdin-ok").as_bytes())?;
    stdin.write_all(b"\xff\n")?;
    drop(stdin);

    let output = child.wait_with_output()?;
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("read stream-json stdin"),
        "unexpected stderr: {stderr}"
    );
    assert!(output.stdout.is_empty());
    Ok(())
}

#[test]
fn active_input_stream_reads_followups_after_first_result() -> Result<(), Box<dyn std::error::Error>>
{
    let home = tempfile::tempdir()?;
    let StreamJsonChild {
        child,
        mut stdin,
        rx,
        stdout_thread,
    } = spawn_stream_json_child(home.path(), false)?;

    stdin.write_all(
        stream_json_user_frame_with_uuid("@active-input-smoke:2", "active-initial").as_bytes(),
    )?;
    stdin.flush()?;

    let mut events = recv_until_result(&rx, ACTIVE_INPUT_READY_RESULT)?;
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        ["system/init", "result/success"]
    );

    stdin.write_all(stream_json_user_frame_with_uuid("first", "follow-up-1").as_bytes())?;
    stdin.write_all(stream_json_user_frame_with_uuid("second", "follow-up-2").as_bytes())?;
    stdin.flush()?;

    events.extend(recv_until_result(&rx, "RESULT=first+second")?);
    drop(stdin);

    let (status, stderr) = wait_child(child, stdout_thread)?;
    assert!(status.success(), "expected success, stderr: {stderr}");
    assert!(stderr.is_empty());
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        ["system/init", "result/success", "result/success"]
    );

    let session_id = init_session_id(&events)?;
    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;
    assert_eq!(parse_jsonl(history.as_bytes())?, events);
    Ok(())
}

#[test]
fn active_input_stream_replays_user_messages() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let StreamJsonChild {
        child,
        mut stdin,
        rx,
        stdout_thread,
    } = spawn_stream_json_child(home.path(), true)?;

    stdin.write_all(
        stream_json_user_frame_with_uuid("@active-input-smoke:2", "active-initial").as_bytes(),
    )?;
    stdin.flush()?;

    let mut events = recv_until_result(&rx, ACTIVE_INPUT_READY_RESULT)?;
    stdin.write_all(stream_json_user_frame_with_uuid("first", "follow-up-1").as_bytes())?;
    stdin.write_all(stream_json_user_frame_with_uuid("second", "follow-up-2").as_bytes())?;
    stdin.flush()?;
    events.extend(recv_until_result(&rx, "RESULT=first+second")?);
    drop(stdin);

    let (status, stderr) = wait_child(child, stdout_thread)?;
    assert!(status.success(), "expected success, stderr: {stderr}");
    assert!(stderr.is_empty());

    let session_id = init_session_id(&events)?;
    let replayed_users = events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("user"))
        .map(|event| {
            (
                event.get("uuid").and_then(Value::as_str),
                event.pointer("/message/content").and_then(Value::as_str),
                event.get("session_id").and_then(Value::as_str),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        replayed_users
            .iter()
            .map(|(uuid, content, _)| (*uuid, *content))
            .collect::<Vec<_>>(),
        [
            (Some("active-initial"), Some("@active-input-smoke:2")),
            (Some("follow-up-1"), Some("first")),
            (Some("follow-up-2"), Some("second")),
        ]
    );
    assert!(
        replayed_users
            .iter()
            .all(|(_, _, replayed_session_id)| *replayed_session_id == Some(session_id.as_str()))
    );

    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;
    assert_eq!(parse_jsonl(history.as_bytes())?, events);
    Ok(())
}

#[test]
fn active_input_stream_rejects_early_eof() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let StreamJsonChild {
        child,
        mut stdin,
        rx,
        stdout_thread,
    } = spawn_stream_json_child(home.path(), false)?;

    stdin.write_all(
        stream_json_user_frame_with_uuid("@active-input-smoke:2", "active-initial").as_bytes(),
    )?;
    stdin.flush()?;
    let _ = recv_until_result(&rx, ACTIVE_INPUT_READY_RESULT)?;
    drop(stdin);

    let (status, stderr) = wait_child(child, stdout_thread)?;
    assert!(!status.success());
    assert!(
        stderr.contains("active-input stdin closed after 0 of 2 follow-up user messages"),
        "unexpected stderr: {stderr}"
    );
    Ok(())
}

#[test]
fn concurrent_stream_json_ids_are_unique() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let children = (0..16)
        .map(|_| {
            let mut command = mock_claude();
            command
                .env("HOME", home.path())
                .args(["--output-format", "stream-json", "--", "true"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut session_ids = HashSet::new();

    for child in children {
        let output = child.wait_with_output()?;
        assert!(
            output.status.success(),
            "expected success, stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stderr.is_empty());

        let events = parse_jsonl(&output.stdout)?;
        let session_id = init_session_id(&events)?;
        assert!(
            session_ids.insert(session_id.clone()),
            "duplicate session id: {session_id}"
        );
        assert!(expected_history_path(home.path(), &session_id).exists());
    }

    Ok(())
}

#[test]
fn stream_json_shell_failure_writes_error_history() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let output = mock_claude()
        .env("HOME", home.path())
        .args([
            "--output-format",
            "stream-json",
            "--",
            "printf out; printf err >&2; exit 7",
        ])
        .output()?;

    assert_eq!(output.status.code(), Some(7));
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let session_id = init_session_id(&events)?;
    let stdout = String::from_utf8(output.stdout)?;
    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;

    assert_eq!(history, stdout);
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        [
            "system/init",
            "assistant/text",
            "assistant/tool_use",
            "user/tool_result",
            "result/error",
        ]
    );
    assert_eq!(
        events[3]
            .pointer("/message/content/0/content")
            .and_then(Value::as_str),
        Some("outerr")
    );
    assert_eq!(
        events[3]
            .pointer("/message/content/0/is_error")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        events[4].get("result").and_then(Value::as_str),
        Some("outerr")
    );
    assert_eq!(
        events[4].get("is_error").and_then(Value::as_bool),
        Some(true)
    );
    Ok(())
}

#[test]
fn exit_after_result_writes_init_and_result_history() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let output = mock_claude()
        .env("HOME", home.path())
        .args(["--output-format", "stream-json", "--", "@exit-after-result"])
        .output()?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let session_id = init_session_id(&events)?;
    let stdout = String::from_utf8(output.stdout)?;
    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;

    assert_eq!(history, stdout);
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        ["system/init", "result/success"]
    );
    assert_eq!(
        events[0].get("model").and_then(Value::as_str),
        Some("mock-claude")
    );
    assert_eq!(
        events[0]
            .get("tools")
            .and_then(Value::as_array)
            .and_then(|tools| tools.first())
            .and_then(Value::as_str),
        Some("Bash")
    );
    assert_eq!(
        events[1].get("result").and_then(Value::as_str),
        Some("Done.")
    );
    assert_eq!(
        events[1].get("is_error").and_then(Value::as_bool),
        Some(false)
    );
    Ok(())
}

#[test]
fn echo_jsonl_rejects_path_like_session_id_without_writing_history() -> std::io::Result<()> {
    let home = tempfile::tempdir()?;
    let payload = r#"{"type":"system","subtype":"init","cwd":"/home/user/workspace","session_id":"../escape","tools":["Bash"],"model":"mock-claude"}"#;
    let prompt = format!("@ECHO@\n{payload}\n");

    let output = mock_claude()
        .env("HOME", home.path())
        .args(["--output-format", "stream-json", "--", &prompt])
        .output()?;

    assert!(!output.status.success());
    assert!(
        output.stdout.is_empty(),
        "expected empty stdout, got: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("invalid @ECHO@ session_id"));
    assert!(stderr.contains("../escape"));
    assert!(!expected_history_path(home.path(), "../escape").exists());
    assert!(
        !home
            .path()
            .join(".claude")
            .join("projects")
            .join("escape.jsonl")
            .exists()
    );
    Ok(())
}

#[test]
fn echo_jsonl_rejects_invalid_json_line() -> Result<(), Box<dyn std::error::Error>> {
    let output = mock_claude()
        .args(["--output-format", "stream-json", "--", "@ECHO@\n{\"type\""])
        .output()?;

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("invalid @ECHO@ JSONL line 2"));
    Ok(())
}

#[test]
fn echo_jsonl_rejects_empty_payload() -> Result<(), Box<dyn std::error::Error>> {
    let output = mock_claude()
        .args(["--output-format", "stream-json", "--", "@ECHO@\n\n"])
        .output()?;

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("@ECHO@ payload must contain at least one JSONL event")
    );
    Ok(())
}
