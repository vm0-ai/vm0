//! Integration tests that spawn the real binary via Cargo's
//! `CARGO_BIN_EXE_guest-mock-codex` env var.
//!
//! Cover the contract guest-agent will rely on: stdout JSONL shape, the
//! on-disk session file path / format, and resume semantics.

use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use chrono::{Datelike, Utc};
use guest_mock_codex::{
    build_events, build_session_path, find_session_file, read_session_file, session_artifacts,
    session_files, write_session_file,
};
use serde_json::{Value, json};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_guest-mock-codex");

#[derive(Debug)]
struct RunOutput {
    events: Vec<Value>,
    status: i32,
    stderr: String,
}

fn run(codex_home: &Path, args: &[&str]) -> std::io::Result<RunOutput> {
    run_with_env(codex_home, args, &[])
}

fn run_with_env(
    codex_home: &Path,
    args: &[&str],
    env: &[(&str, &str)],
) -> std::io::Result<RunOutput> {
    let mut cmd = Command::new(BIN);
    cmd.env("CODEX_HOME", codex_home).args(args);
    cmd.env_remove("MOCK_CODEX_FIXTURE");
    for (k, v) in env {
        cmd.env(k, v);
    }
    let output = cmd.output()?;

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

fn spawn(codex_home: &Path, args: &[&str]) -> std::io::Result<Child> {
    let mut cmd = Command::new(BIN);
    cmd.env("CODEX_HOME", codex_home).args(args);
    cmd.env_remove("MOCK_CODEX_FIXTURE");
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    cmd.spawn()
}

struct AppServerProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl AppServerProcess {
    fn request(&mut self, id: i64, method: &str, params: Value) -> std::io::Result<Value> {
        self.send(&json!({
            "id": id,
            "method": method,
            "params": params,
        }))?;
        self.read_required()
    }

    fn notify(&mut self, method: &str, params: Value) -> std::io::Result<()> {
        self.send(&json!({
            "method": method,
            "params": params,
        }))
    }

    fn send(&mut self, message: &Value) -> std::io::Result<()> {
        let stdin = self.stdin.as_mut().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "app-server stdin is closed")
        })?;
        serde_json::to_writer(&mut *stdin, message).map_err(std::io::Error::other)?;
        writeln!(stdin)?;
        stdin.flush()
    }

    fn read_required(&mut self) -> std::io::Result<Value> {
        self.read_message()?.ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "app-server closed stdout before responding",
            )
        })
    }

    fn read_message(&mut self) -> std::io::Result<Option<Value>> {
        let mut line = String::new();
        if self.stdout.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let value = serde_json::from_str(&line)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
        Ok(Some(value))
    }

    fn close_and_wait(&mut self) -> std::io::Result<i32> {
        self.stdin.take();
        let status = self.child.wait()?;
        Ok(status.code().unwrap_or(-1))
    }
}

impl Drop for AppServerProcess {
    fn drop(&mut self) {
        self.stdin.take();
        match self.child.try_wait() {
            Ok(Some(_)) => {
                let _ = self.child.wait();
            }
            Ok(None) => {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
            Err(_) => {}
        }
    }
}

fn spawn_app_server(
    codex_home: &Path,
    args: &[&str],
    scenario: Option<&str>,
) -> std::io::Result<AppServerProcess> {
    let mut cmd = Command::new(BIN);
    cmd.env("CODEX_HOME", codex_home).args(args);
    cmd.env_remove("MOCK_CODEX_FIXTURE");
    cmd.env_remove("MOCK_CODEX_APP_SERVER_SCENARIO");
    if let Some(value) = scenario {
        cmd.env("MOCK_CODEX_APP_SERVER_SCENARIO", value);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    let stdin = child.stdin.take().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "failed to open app-server stdin",
        )
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "failed to open app-server stdout",
        )
    })?;
    Ok(AppServerProcess {
        child,
        stdin: Some(stdin),
        stdout: BufReader::new(stdout),
    })
}

fn text_input(text: &str) -> Value {
    json!({
        "type": "text",
        "text": text,
        "textElements": []
    })
}

fn initialize_params() -> Value {
    json!({
        "clientInfo": {
            "name": "guest-mock-codex-tests",
            "title": null,
            "version": "0.1.0"
        },
        "capabilities": {
            "experimentalApi": true
        }
    })
}

fn assert_invalid_resume_rejected(codex_home: &Path, out: &RunOutput) -> std::io::Result<()> {
    assert_ne!(out.status, 0, "invalid resume id should fail");
    assert!(
        out.events.is_empty(),
        "invalid resume id should not emit JSONL events: {:?}",
        out.events
    );
    assert!(
        !out.stderr.is_empty(),
        "invalid resume id should report an error on stderr"
    );
    assert!(
        out.stderr.contains("invalid thread id"),
        "invalid resume id should report the validation failure: {:?}",
        out.stderr
    );
    assert!(
        out.stderr.contains("expected canonical UUID"),
        "invalid resume id should describe the expected format: {:?}",
        out.stderr
    );
    assert!(
        session_artifacts(codex_home)?.is_empty(),
        "invalid resume id should not write session artifacts"
    );
    Ok(())
}

fn require_session_file(codex_home: &Path) -> std::io::Result<PathBuf> {
    find_session_file(codex_home)?.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("session file not found under {codex_home:?}"),
        )
    })
}

fn session_year_candidates() -> [String; 2] {
    let year = Utc::now().date_naive().year();
    [format!("{year:04}"), format!("{:04}", year + 1)]
}

#[test]
fn app_server_turn_steer_returns_active_turn_and_records_inputs() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(dir.path(), &["app-server", "--listen", "stdio://"], None)?;

    let initialized = server.request(1, "initialize", initialize_params())?;
    assert_eq!(initialized["id"], 1);
    assert!(initialized.get("jsonrpc").is_none());
    assert!(initialized.get("type").is_none());
    assert!(initialized["result"]["codexHome"].as_str().is_some());
    server.notify("initialized", json!({}))?;

    let started = server.request(2, "thread/start", json!({ "cwd": "/tmp" }))?;
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(started["result"]["thread"]["source"], "appServer");
    assert_eq!(started["result"]["thread"]["status"]["type"], "idle");
    assert_eq!(started["result"]["sandbox"]["type"], "dangerFullAccess");

    let turn_started = server.request(
        3,
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [text_input("initial prompt")]
        }),
    )?;
    let turn_id = turn_started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(turn_started["result"]["turn"]["status"], "inProgress");

    let steered = server.request(
        4,
        "turn/steer",
        json!({
            "threadId": thread_id,
            "expectedTurnId": turn_id,
            "input": [text_input("follow-up prompt")]
        }),
    )?;
    assert_eq!(steered["result"]["turnId"], turn_id);

    let recorded = server.request(5, "mock/inputs", json!({}))?;
    assert_eq!(recorded["result"]["initial"], json!(["initial prompt"]));
    assert_eq!(recorded["result"]["steered"], json!(["follow-up prompt"]));

    let session_path = require_session_file(dir.path())?;
    let events = read_session_file(&session_path)?;
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["type"], "mock.app_server.input");
    assert_eq!(events[0]["kind"], "initial");
    assert_eq!(events[0]["text"], "initial prompt");
    assert_eq!(events[1]["kind"], "steered");
    assert_eq!(events[1]["text"], "follow-up prompt");
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_rejects_invalid_or_duplicate_initialize() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(dir.path(), &["app-server", "--listen", "stdio://"], None)?;

    let invalid = server.request(1, "initialize", json!({}))?;
    assert_eq!(invalid["id"], 1);
    assert_eq!(invalid["error"]["code"], -32600);
    assert!(
        invalid["error"]["message"]
            .as_str()
            .unwrap()
            .contains("clientInfo")
    );

    let initialized = server.request(2, "initialize", initialize_params())?;
    assert_eq!(
        initialized["result"]["platformFamily"],
        std::env::consts::FAMILY
    );

    let duplicate = server.request(3, "initialize", initialize_params())?;
    assert_eq!(duplicate["error"]["code"], -32600);
    assert_eq!(duplicate["error"]["message"], "Already initialized");

    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_accepts_stdio_and_resumes_supplied_thread() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let supplied_thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let mut server = spawn_app_server(
        dir.path(),
        &[
            "app-server",
            "--stdio",
            "-c",
            "model=gpt-5",
            "--config",
            "sandbox=danger-full-access",
        ],
        None,
    )?;

    server.request(1, "initialize", initialize_params())?;
    server.notify("initialized", json!({}))?;
    let resumed = server.request(
        2,
        "thread/resume",
        json!({
            "threadId": supplied_thread_id
        }),
    )?;

    assert_eq!(resumed["result"]["thread"]["id"], supplied_thread_id);
    assert_eq!(resumed["result"]["thread"]["sessionId"], supplied_thread_id);
    assert!(resumed["result"]["initialTurnsPage"].is_null());
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_rejects_non_stdio_listen_url() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let out = run(
        dir.path(),
        &["app-server", "--stdio", "--listen", "tcp://127.0.0.1:0"],
    )?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "unsupported app-server listen URL should not emit stdout JSON: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("only supports stdio transport"),
        "unsupported app-server listen URL should fail clearly: {:?}",
        out.stderr
    );
    Ok(())
}

#[test]
fn app_server_resumed_non_uuid_thread_records_inputs() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let supplied_thread_id = "thread-1";
    let mut server = spawn_app_server(dir.path(), &["app-server", "--stdio"], None)?;

    server.request(1, "initialize", initialize_params())?;
    let resumed = server.request(
        2,
        "thread/resume",
        json!({
            "threadId": supplied_thread_id
        }),
    )?;
    assert_eq!(resumed["result"]["thread"]["id"], supplied_thread_id);

    let turn_started = server.request(
        3,
        "turn/start",
        json!({
            "threadId": supplied_thread_id,
            "input": [text_input("initial prompt")]
        }),
    )?;
    let turn_id = turn_started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let steered = server.request(
        4,
        "turn/steer",
        json!({
            "threadId": supplied_thread_id,
            "expectedTurnId": turn_id,
            "input": [text_input("follow-up prompt")]
        }),
    )?;
    assert_eq!(steered["result"]["turnId"], turn_id);

    let session_path = require_session_file(dir.path())?;
    let file_name = session_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    assert!(
        !file_name.starts_with(supplied_thread_id),
        "non-UUID app-server thread ids should not be used directly as session filenames: {file_name}"
    );
    let events = read_session_file(&session_path)?;
    assert_eq!(events[0]["thread_id"], supplied_thread_id);
    assert_eq!(events[0]["text"], "initial prompt");
    assert_eq!(events[1]["thread_id"], supplied_thread_id);
    assert_eq!(events[1]["text"], "follow-up prompt");
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_reuses_artifact_for_repeated_non_uuid_resume() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let supplied_thread_id = "thread-1";
    let mut server = spawn_app_server(dir.path(), &["app-server", "--stdio"], None)?;

    server.request(1, "initialize", initialize_params())?;
    server.request(
        2,
        "thread/resume",
        json!({
            "threadId": supplied_thread_id
        }),
    )?;
    server.request(
        3,
        "turn/start",
        json!({
            "threadId": supplied_thread_id,
            "input": [text_input("first prompt")]
        }),
    )?;

    server.request(
        4,
        "thread/resume",
        json!({
            "threadId": supplied_thread_id
        }),
    )?;
    server.request(
        5,
        "turn/start",
        json!({
            "threadId": supplied_thread_id,
            "input": [text_input("second prompt")]
        }),
    )?;

    let artifacts = session_artifacts(dir.path())?
        .into_iter()
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("jsonl"))
        .collect::<Vec<_>>();
    assert_eq!(
        artifacts.len(),
        1,
        "repeated resume for the same non-UUID app-server thread should append to one artifact: {artifacts:?}"
    );
    let session_path = artifacts.into_iter().next().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "app-server session artifact not found",
        )
    })?;
    let events = read_session_file(&session_path)?;
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["thread_id"], supplied_thread_id);
    assert_eq!(events[0]["text"], "first prompt");
    assert_eq!(events[1]["thread_id"], supplied_thread_id);
    assert_eq!(events[1]["text"], "second prompt");
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_rejects_empty_resume_thread_id() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(dir.path(), &["app-server", "--stdio"], None)?;

    server.request(1, "initialize", initialize_params())?;
    let error = server.request(
        2,
        "thread/resume",
        json!({
            "threadId": ""
        }),
    )?;

    assert_eq!(error["error"]["code"], -32600);
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("threadId")
    );
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_initialized_notification_does_not_replace_initialize_request() -> std::io::Result<()>
{
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(dir.path(), &["app-server", "--stdio"], None)?;

    server.notify("initialized", json!({}))?;
    let error = server.request(1, "thread/start", json!({}))?;

    assert_eq!(error["error"]["code"], -32600);
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not initialized")
    );
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_new_thread_clears_previous_active_turn() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(dir.path(), &["app-server", "--stdio"], None)?;

    server.request(1, "initialize", initialize_params())?;
    let first_thread = server.request(2, "thread/start", json!({}))?;
    let first_thread_id = first_thread["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let first_turn = server.request(
        3,
        "turn/start",
        json!({
            "threadId": first_thread_id,
            "input": [text_input("initial prompt")]
        }),
    )?;
    let first_turn_id = first_turn["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let second_thread = server.request(4, "thread/start", json!({}))?;
    let second_thread_id = second_thread["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let error = server.request(
        5,
        "turn/steer",
        json!({
            "threadId": second_thread_id,
            "expectedTurnId": first_turn_id,
            "input": [text_input("follow-up prompt")]
        }),
    )?;

    assert_eq!(error["error"]["code"], -32600);
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no active turn")
    );
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_stale_turn_scenario_returns_protocol_error() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(
        dir.path(),
        &["app-server", "--listen", "stdio://"],
        Some("stale-turn"),
    )?;

    server.request(1, "initialize", initialize_params())?;
    let started = server.request(2, "thread/start", json!({}))?;
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let turn_started = server.request(
        3,
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [text_input("initial prompt")]
        }),
    )?;
    let turn_id = turn_started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let error = server.request(
        4,
        "turn/steer",
        json!({
            "threadId": thread_id,
            "expectedTurnId": turn_id,
            "input": [text_input("follow-up prompt")]
        }),
    )?;
    assert_eq!(error["id"], 4);
    assert!(error.get("jsonrpc").is_none());
    assert_eq!(error["error"]["code"], -32600);
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("stale")
    );
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_no_active_turn_scenario_returns_protocol_error() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(
        dir.path(),
        &["app-server", "--listen", "stdio://"],
        Some("no-active-turn"),
    )?;

    server.request(1, "initialize", initialize_params())?;
    let started = server.request(2, "thread/start", json!({}))?;
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let turn_started = server.request(
        3,
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [text_input("initial prompt")]
        }),
    )?;
    let turn_id = turn_started["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let error = server.request(
        4,
        "turn/steer",
        json!({
            "threadId": thread_id,
            "expectedTurnId": turn_id,
            "input": [text_input("follow-up prompt")]
        }),
    )?;
    assert_eq!(error["error"]["code"], -32600);
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no active turn")
    );
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_disconnect_after_initialize_closes_stdout() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(
        dir.path(),
        &["app-server", "--listen", "stdio://"],
        Some("disconnect-after-initialize"),
    )?;

    let initialized = server.request(1, "initialize", initialize_params())?;
    assert_eq!(
        initialized["result"]["platformFamily"],
        std::env::consts::FAMILY
    );
    assert!(server.read_message()?.is_none());
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_exit_on_turn_start_closes_stdout_without_response() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(
        dir.path(),
        &["app-server", "--listen", "stdio://"],
        Some("exit-on-turn-start"),
    )?;

    server.request(1, "initialize", initialize_params())?;
    let started = server.request(2, "thread/start", json!({}))?;
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.send(&json!({
        "id": 3,
        "method": "turn/start",
        "params": {
            "threadId": thread_id,
            "input": [text_input("initial prompt")]
        }
    }))?;

    assert!(server.read_message()?.is_none());
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_returns_errors_for_unsupported_method_and_input() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(dir.path(), &["app-server", "--listen", "stdio://"], None)?;

    server.request(1, "initialize", initialize_params())?;
    let unsupported = server.request(2, "unknown/method", json!({}))?;
    assert_eq!(unsupported["error"]["code"], -32601);

    let started = server.request(3, "thread/start", json!({}))?;
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let invalid_input = server.request(
        4,
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": []
        }),
    )?;
    assert_eq!(invalid_input["error"]["code"], -32600);
    assert!(
        invalid_input["error"]["message"]
            .as_str()
            .unwrap()
            .contains("input")
    );
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn happy_path_emits_three_events_and_persists_jsonl() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let out = run(dir.path(), &["exec", "--json", "--", "hello"])?;

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 3);
    assert_eq!(out.events[0]["type"], "thread.started");
    assert_eq!(out.events[1]["type"], "item.completed");
    assert_eq!(out.events[1]["item"]["type"], "agent_message");
    assert_eq!(out.events[1]["item"]["text"], "hello");
    assert_eq!(out.events[2]["type"], "turn.completed");
    assert_eq!(out.events[2]["usage"]["input_tokens"], 10);
    assert_eq!(out.events[2]["usage"]["output_tokens"], 20);

    let thread_id = out.events[0]["thread_id"].as_str().unwrap();
    let session_path = require_session_file(dir.path())?;
    assert!(
        session_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .starts_with(thread_id),
        "session filename should start with thread_id: {session_path:?}"
    );

    let events = read_session_file(&session_path)?;
    assert_eq!(events, out.events);
    Ok(())
}

#[test]
fn new_rejects_sessions_file_root_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("sessions"), b"not a directory")?;

    let out = run(dir.path(), &["exec", "--json", "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "unusable sessions root should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("sessions path is not a real directory"),
        "new run should report the unusable sessions root: {:?}",
        out.stderr
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn new_rejects_symlinked_session_parent_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    let outside_year = dir.path().join("outside-year");
    std::fs::create_dir_all(&sessions)?;
    std::fs::create_dir_all(&outside_year)?;
    for year in session_year_candidates() {
        std::os::unix::fs::symlink(&outside_year, sessions.join(year))?;
    }

    let out = run(dir.path(), &["exec", "--json", "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "symlinked session parent should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("sessions path is not a real directory"),
        "new run should report the symlinked session parent: {:?}",
        out.stderr
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn new_rejects_symlinked_codex_home_without_lock_artifacts() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let outside_home = dir.path().join("outside-home");
    let codex_home = dir.path().join("codex-home");
    std::fs::create_dir_all(&outside_home)?;
    std::os::unix::fs::symlink(&outside_home, &codex_home)?;

    let out = run(&codex_home, &["exec", "--json", "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "symlinked codex home should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        codex_home.symlink_metadata()?.file_type().is_symlink(),
        "mock should leave the CODEX_HOME symlink in place"
    );
    assert!(
        !outside_home.join(".session-locks").exists(),
        "mock should not create lock files through a symlinked CODEX_HOME"
    );
    assert!(
        !outside_home.join("sessions").exists(),
        "mock should not create session files through a symlinked CODEX_HOME"
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_rejects_special_lock_file_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let lock_dir = dir.path().join(".session-locks");
    std::fs::create_dir_all(&lock_dir)?;
    mkfifo(&lock_dir.join(format!("{thread_id}.lock")))?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "special lock file should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        session_artifacts(dir.path())?.is_empty(),
        "special lock file should prevent session writes"
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_rejects_special_session_file_without_hanging() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let session_path = build_session_path(dir.path(), Utc::now().date_naive(), thread_id)?;
    if let Some(parent) = session_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    mkfifo(&session_path)?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "special session file should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("session path is not a regular file"),
        "special session file should be reported: {:?}",
        out.stderr
    );
    Ok(())
}

#[test]
fn fixture_rejects_sessions_file_root_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("sessions"), b"not a directory")?;

    let out = run_with_env(
        dir.path(),
        &["exec", "--json", "--", "ignored"],
        &[("MOCK_CODEX_FIXTURE", "event-mapping-rich")],
    )?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "fixture mode should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("sessions path is not a real directory"),
        "fixture mode should report the unusable sessions root: {:?}",
        out.stderr
    );
    Ok(())
}

#[test]
fn resume_echoes_thread_id_and_appends_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let first = run(dir.path(), &["exec", "--json", "--", "turn-1"])?;
    let thread_id = first.events[0]["thread_id"].as_str().unwrap().to_string();

    let second = run(dir.path(), &["exec", "resume", &thread_id, "--", "turn-2"])?;
    assert_eq!(second.status, 0);
    assert_eq!(second.events[0]["thread_id"], thread_id);
    assert_eq!(second.events[1]["item"]["text"], "turn-2");

    let session_path = require_session_file(dir.path())?;
    let events = read_session_file(&session_path)?;
    assert_eq!(events.len(), 6);
    assert_eq!(events[1]["item"]["text"], "turn-1");
    assert_eq!(events[4]["item"]["text"], "turn-2");
    Ok(())
}

#[test]
fn resume_with_unknown_id_starts_fresh_with_supplied_id() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let supplied = "0199a213-81c0-7800-8aa1-bbab2a035a53";

    let out = run(dir.path(), &["exec", "resume", supplied, "--", "hi"])?;
    assert_eq!(out.status, 0);
    assert_eq!(out.events[0]["thread_id"], supplied);

    let session_path = require_session_file(dir.path())?;
    assert!(
        session_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .starts_with(supplied)
    );
    Ok(())
}

#[test]
fn resume_appends_existing_session_from_previous_date() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let existing_path = dir
        .path()
        .join(format!("sessions/2001/01/01/{thread_id}.jsonl"));
    write_session_file(&existing_path, &build_events(thread_id, "turn-1"))?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-2"])?;
    assert_eq!(out.status, 0);
    assert_eq!(out.events[0]["thread_id"], thread_id);

    let events = read_session_file(&existing_path)?;
    assert_eq!(events.len(), 6);
    assert_eq!(events[1]["item"]["text"], "turn-1");
    assert_eq!(events[4]["item"]["text"], "turn-2");
    assert_eq!(session_files(dir.path())?, vec![existing_path]);
    Ok(())
}

#[test]
fn resume_appends_restored_rollout_session() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let restored_path = dir.path().join(format!(
        "sessions/2001/01/01/rollout-2001-01-01T00-00-00-{thread_id}.jsonl"
    ));
    write_session_file(&restored_path, &build_events(thread_id, "turn-1"))?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-2"])?;
    assert_eq!(out.status, 0);
    assert_eq!(out.events[0]["thread_id"], thread_id);

    let events = read_session_file(&restored_path)?;
    assert_eq!(events.len(), 6);
    assert_eq!(events[1]["item"]["text"], "turn-1");
    assert_eq!(events[4]["item"]["text"], "turn-2");
    assert_eq!(session_files(dir.path())?, vec![restored_path]);
    Ok(())
}

#[test]
fn resume_appends_restored_rollout_session_without_parsing_history() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let restored_path = dir.path().join(format!(
        "sessions/2001/01/01/rollout-2001-01-01T00-00-00-{thread_id}.jsonl"
    ));
    if let Some(parent) = restored_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&restored_path, "{not-json}")?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-2"])?;
    assert_eq!(out.status, 0);
    assert_eq!(out.events[0]["thread_id"], thread_id);

    let raw = std::fs::read_to_string(&restored_path)?;
    assert!(
        raw.starts_with("{not-json}\n"),
        "resume should preserve existing raw history and add a line break: {raw:?}"
    );
    assert!(
        raw.contains("\"text\":\"turn-2\""),
        "resume should append the new turn events: {raw:?}"
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_rejects_today_symlinked_fallback_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let outside_path = dir.path().join("outside.jsonl");
    write_session_file(&outside_path, &build_events(thread_id, "outside-turn"))?;
    let session_path = build_session_path(dir.path(), Utc::now().date_naive(), thread_id)?;
    if let Some(parent) = session_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::os::unix::fs::symlink(&outside_path, &session_path)?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-2"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "symlinked fallback should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("session path is not a regular file"),
        "resume should report the symlinked session path: {:?}",
        out.stderr
    );

    let outside_events = read_session_file(&outside_path)?;
    assert_eq!(outside_events.len(), 3);
    assert_eq!(outside_events[1]["item"]["text"], "outside-turn");
    assert!(
        session_path.symlink_metadata()?.file_type().is_symlink(),
        "resume should leave the symlink in place"
    );
    Ok(())
}

#[test]
fn resume_rejects_duplicate_matching_sessions_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let first_path = dir
        .path()
        .join(format!("sessions/2001/01/01/{thread_id}.jsonl"));
    let second_path = dir.path().join(format!(
        "sessions/2001/01/02/rollout-restored-{thread_id}.jsonl"
    ));
    write_session_file(&first_path, &build_events(thread_id, "first"))?;
    write_session_file(&second_path, &build_events(thread_id, "second"))?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-3"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "duplicate sessions should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("multiple session files found"),
        "resume should report duplicate session files: {:?}",
        out.stderr
    );
    assert_eq!(read_session_file(&first_path)?.len(), 3);
    assert_eq!(read_session_file(&second_path)?.len(), 3);
    Ok(())
}

#[test]
fn resume_preserves_stale_fixed_temp_file() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let session_path = build_session_path(dir.path(), Utc::now().date_naive(), thread_id)?;
    if let Some(parent) = session_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let stale_temp_path = session_path.with_extension("jsonl.tmp");
    std::fs::write(&stale_temp_path, "stale temp must survive")?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-1"])?;

    assert_eq!(out.status, 0);
    assert_eq!(
        std::fs::read_to_string(&stale_temp_path)?,
        "stale temp must survive"
    );
    let events = read_session_file(&session_path)?;
    assert_eq!(events.len(), 3);
    assert_eq!(events[1]["item"]["text"], "turn-1");
    Ok(())
}

#[test]
fn concurrent_resume_writes_preserve_all_turns() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let first = run(dir.path(), &["exec", "--json", "--", "turn-0"])?;
    assert_eq!(first.status, 0);
    let thread_id = first.events[0]["thread_id"].as_str().unwrap();

    let mut children = Vec::new();
    for prompt in ["turn-1", "turn-2", "turn-3", "turn-4", "turn-5"] {
        children.push(spawn(
            dir.path(),
            &["exec", "resume", thread_id, "--", prompt],
        )?);
    }

    for mut child in children {
        let status = child.wait()?;
        assert!(status.success(), "resume child failed with {status}");
    }

    let session_path = require_session_file(dir.path())?;
    let events = read_session_file(&session_path)?;
    let prompts: BTreeSet<&str> = events
        .iter()
        .filter_map(|event| event.pointer("/item/text").and_then(Value::as_str))
        .collect();
    assert_eq!(
        prompts,
        BTreeSet::from(["turn-0", "turn-1", "turn-2", "turn-3", "turn-4", "turn-5"])
    );
    assert_eq!(events.len(), 18);
    Ok(())
}

#[test]
fn resume_rejects_final_session_directory_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let session_path = build_session_path(dir.path(), Utc::now().date_naive(), thread_id)?;
    std::fs::create_dir_all(&session_path)?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "unusable final session path should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("session path is not a regular file"),
        "resume should report the unusable final session path: {:?}",
        out.stderr
    );
    Ok(())
}

#[test]
fn resume_ignores_stale_fixed_temp_directory() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let session_path = build_session_path(dir.path(), Utc::now().date_naive(), thread_id)?;
    let stale_temp_path = session_path.with_extension("jsonl.tmp");
    std::fs::create_dir_all(&stale_temp_path)?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_eq!(out.status, 0);
    assert!(stale_temp_path.is_dir());
    let resume_events = read_session_file(&session_path)?;
    assert_eq!(resume_events.len(), 3);
    assert_eq!(resume_events[1]["item"]["text"], "hi");
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_ignores_stale_fixed_temp_symlink() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let session_path = build_session_path(dir.path(), Utc::now().date_naive(), thread_id)?;
    let temp_path = session_path.with_extension("jsonl.tmp");
    if let Some(parent) = temp_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let outside_path = dir.path().join("outside.tmp");
    std::fs::write(&outside_path, "outside")?;
    std::os::unix::fs::symlink(&outside_path, &temp_path)?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_eq!(out.status, 0);
    assert_eq!(std::fs::read_to_string(&outside_path)?, "outside");
    assert!(temp_path.symlink_metadata()?.file_type().is_symlink());
    let resume_events = read_session_file(&session_path)?;
    assert_eq!(resume_events.len(), 3);
    assert_eq!(resume_events[1]["item"]["text"], "hi");
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_ignores_stale_fixed_temp_hardlink() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let session_path = build_session_path(dir.path(), Utc::now().date_naive(), thread_id)?;
    let temp_path = session_path.with_extension("jsonl.tmp");
    if let Some(parent) = temp_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let outside_path = dir.path().join("outside.tmp");
    std::fs::write(&outside_path, "outside")?;
    std::fs::hard_link(&outside_path, &temp_path)?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-2"])?;
    assert_eq!(out.status, 0);
    assert_eq!(out.events[0]["thread_id"], thread_id);

    assert_eq!(std::fs::read_to_string(&outside_path)?, "outside");
    assert!(
        temp_path.exists(),
        "stale fixed temp path should not be renamed away"
    );
    let resume_events = read_session_file(&session_path)?;
    assert_eq!(resume_events.len(), 3);
    assert_eq!(resume_events[1]["item"]["text"], "turn-2");
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_ignores_symlinked_existing_session() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let outside_path = dir.path().join("outside.jsonl");
    write_session_file(&outside_path, &build_events(thread_id, "outside-turn"))?;

    let linked_path = dir
        .path()
        .join(format!("sessions/2001/01/01/{thread_id}.jsonl"));
    if let Some(parent) = linked_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::os::unix::fs::symlink(&outside_path, &linked_path)?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-2"])?;
    assert_eq!(out.status, 0);
    assert_eq!(out.events[0]["thread_id"], thread_id);

    let outside_events = read_session_file(&outside_path)?;
    assert_eq!(outside_events.len(), 3);
    assert_eq!(outside_events[1]["item"]["text"], "outside-turn");
    assert!(
        linked_path.symlink_metadata()?.file_type().is_symlink(),
        "resume should not replace the existing symlink"
    );

    let session_files = session_files(dir.path())?;
    let real_resume_path = session_files
        .into_iter()
        .find(|path| {
            path != &linked_path
                && path.file_stem().and_then(|value| value.to_str()) == Some(thread_id)
        })
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "real resume session file not found",
            )
        })?;
    let resume_events = read_session_file(&real_resume_path)?;
    assert_eq!(resume_events.len(), 3);
    assert_eq!(resume_events[1]["item"]["text"], "turn-2");
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_rejects_symlinked_session_parent_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    let outside_year = dir.path().join("outside-year");
    std::fs::create_dir_all(&sessions)?;
    std::fs::create_dir_all(&outside_year)?;
    for year in session_year_candidates() {
        std::os::unix::fs::symlink(&outside_year, sessions.join(year))?;
    }
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "symlinked session parent should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("sessions path is not a real directory"),
        "resume should report the symlinked session parent: {:?}",
        out.stderr
    );
    Ok(())
}

#[test]
fn resume_rejects_sessions_file_root_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("sessions"), b"not a directory")?;
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "unusable sessions root should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("sessions path is not a real directory"),
        "resume should report the unusable sessions root: {:?}",
        out.stderr
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_rejects_sessions_symlink_loop_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    std::os::unix::fs::symlink(&sessions, &sessions)?;
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "unusable sessions root should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        !out.stderr.is_empty(),
        "resume should report the filesystem error"
    );
    Ok(())
}

#[test]
fn resume_rejects_absolute_thread_id_without_events_or_artifacts() -> std::io::Result<()> {
    let codex_dir = TempDir::new().unwrap();
    let outside_dir = TempDir::new().unwrap();
    let outside_target = outside_dir.path().join("escape");
    let supplied = outside_target.to_str().unwrap();

    let out = run(codex_dir.path(), &["exec", "resume", supplied, "--", "hi"])?;
    assert_invalid_resume_rejected(codex_dir.path(), &out)?;

    assert!(
        !outside_target.with_extension("jsonl").exists(),
        "invalid absolute id should not create an outside session file"
    );
    assert!(
        !outside_target.with_extension("jsonl.tmp").exists(),
        "invalid absolute id should not leave an outside temp file"
    );
    Ok(())
}

#[test]
fn resume_rejects_traversal_thread_id_without_events_or_artifacts() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();

    let out = run(dir.path(), &["exec", "resume", "../escape", "--", "hi"])?;
    assert_invalid_resume_rejected(dir.path(), &out)
}

#[test]
fn resume_rejects_nested_thread_id_without_events_or_artifacts() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();

    let out = run(dir.path(), &["exec", "resume", "nested/id", "--", "hi"])?;
    assert_invalid_resume_rejected(dir.path(), &out)
}

#[test]
fn resume_rejects_non_uuid_thread_id_without_events_or_artifacts() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();

    let out = run(dir.path(), &["exec", "resume", "xyz-uuid", "--", "hi"])?;
    assert_invalid_resume_rejected(dir.path(), &out)
}

#[test]
fn resume_rejects_uppercase_uuid_thread_id_without_events_or_artifacts() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();

    let out = run(
        dir.path(),
        &[
            "exec",
            "resume",
            "0199A213-81C0-7800-8AA1-BBAB2A035A53",
            "--",
            "hi",
        ],
    )?;
    assert_invalid_resume_rejected(dir.path(), &out)
}

#[test]
fn resume_rejects_simple_uuid_thread_id_without_events_or_artifacts() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();

    let out = run(
        dir.path(),
        &[
            "exec",
            "resume",
            "0199a21381c078008aa1bbab2a035a53",
            "--",
            "hi",
        ],
    )?;
    assert_invalid_resume_rejected(dir.path(), &out)
}

#[test]
fn accepts_all_no_op_flags_without_failing() {
    let dir = TempDir::new().unwrap();
    let out = run(
        dir.path(),
        &[
            "exec",
            "--json",
            "--sandbox",
            "danger-full-access",
            "--skip-git-repo-check",
            "-C",
            "/tmp",
            "-m",
            "gpt-5",
            "-c",
            "features.memories=true",
            "--config",
            "developer_instructions=\"your name is Aria\"",
            "--append-system-prompt",
            "your name is Aria",
            "--",
            "hello",
        ],
    )
    .unwrap();

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 3);
    assert_eq!(out.events[1]["item"]["text"], "hello");
}

#[test]
fn prompt_without_double_dash_separator_works() {
    let dir = TempDir::new().unwrap();
    let out = run(dir.path(), &["exec", "--json", "hello world"]).unwrap();

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 3);
    assert_eq!(out.events[1]["item"]["text"], "hello world");
}

#[test]
fn config_flags_before_prompt_are_not_echoed() {
    let dir = TempDir::new().unwrap();
    let out = run(
        dir.path(),
        &[
            "exec",
            "--json",
            "-c",
            "features.memories=true",
            "hello from codex",
        ],
    )
    .unwrap();

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 3);
    assert_eq!(out.events[1]["item"]["text"], "hello from codex");
}

#[test]
fn config_flags_before_resume_are_not_echoed() {
    let dir = TempDir::new().unwrap();
    let first = run(dir.path(), &["exec", "--json", "--", "turn-1"]).unwrap();
    let thread_id = first.events[0]["thread_id"].as_str().unwrap().to_string();

    let second = run(
        dir.path(),
        &[
            "exec",
            "--json",
            "-c",
            "features.memories=true",
            "resume",
            &thread_id,
            "turn-2",
        ],
    )
    .unwrap();

    assert_eq!(second.status, 0);
    assert_eq!(second.events[0]["thread_id"], thread_id);
    assert_eq!(second.events[1]["item"]["text"], "turn-2");
}

#[test]
fn fixture_event_mapping_rich_emits_full_event_set() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let out = run_with_env(
        dir.path(),
        &["exec", "--json", "--", "ignored"],
        &[("MOCK_CODEX_FIXTURE", "event-mapping-rich")],
    )?;

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 11);
    assert_eq!(
        out.events[0]["thread_id"],
        "00000000-0000-0000-0000-000000000001"
    );

    let item_types: Vec<&str> = out
        .events
        .iter()
        .filter_map(|e| e["item"]["type"].as_str())
        .collect();
    for expected in [
        "command_execution",
        "file_edit",
        "file_read",
        "file_change",
        "reasoning",
        "agent_message",
    ] {
        assert!(
            item_types.contains(&expected),
            "fixture missing item type {expected}: got {item_types:?}"
        );
    }
    assert_eq!(out.events.last().unwrap()["type"], "turn.completed");

    let session_path = require_session_file(dir.path())?;
    let persisted = read_session_file(&session_path)?;
    assert_eq!(persisted, out.events);
    Ok(())
}

#[test]
fn fixture_turn_failed_ends_with_turn_failed() {
    let dir = TempDir::new().unwrap();
    let out = run_with_env(
        dir.path(),
        &["exec", "--json", "--", "ignored"],
        &[("MOCK_CODEX_FIXTURE", "turn-failed")],
    )
    .unwrap();

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 3);
    assert_eq!(
        out.events[0]["thread_id"],
        "00000000-0000-0000-0000-000000000002"
    );
    assert_eq!(out.events.last().unwrap()["type"], "turn.failed");
}

#[test]
fn fixture_error_event_emits_error_type() {
    let dir = TempDir::new().unwrap();
    let out = run_with_env(
        dir.path(),
        &["exec", "--json", "--", "ignored"],
        &[("MOCK_CODEX_FIXTURE", "error-event")],
    )
    .unwrap();

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 2);
    assert_eq!(
        out.events[0]["thread_id"],
        "00000000-0000-0000-0000-000000000003"
    );
    assert_eq!(out.events[1]["type"], "error");
}

#[test]
fn fixture_invalid_api_key_emits_error_code() {
    let dir = TempDir::new().unwrap();
    let out = run_with_env(
        dir.path(),
        &["exec", "--json", "--", "ignored"],
        &[("MOCK_CODEX_FIXTURE", "invalid-api-key")],
    )
    .unwrap();

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 2);
    assert_eq!(
        out.events[0]["thread_id"],
        "00000000-0000-0000-0000-000000000004"
    );
    assert_eq!(out.events[1]["type"], "error");
    assert_eq!(out.events[1]["code"], "invalid_api_key");
}

#[test]
fn fixture_unknown_name_falls_through_to_synthetic() {
    let dir = TempDir::new().unwrap();
    let out = run_with_env(
        dir.path(),
        &["exec", "--json", "--", "hello"],
        &[("MOCK_CODEX_FIXTURE", "no-such-fixture")],
    )
    .unwrap();

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 3);
    assert_eq!(out.events[0]["type"], "thread.started");
    assert_eq!(out.events[1]["item"]["text"], "hello");
    assert_eq!(out.events[2]["type"], "turn.completed");
}

#[test]
fn fixture_empty_env_var_uses_synthetic() {
    let dir = TempDir::new().unwrap();
    let out = run_with_env(
        dir.path(),
        &["exec", "--json", "--", "hello"],
        &[("MOCK_CODEX_FIXTURE", "")],
    )
    .unwrap();

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 3);
    assert_eq!(out.events[1]["item"]["text"], "hello");
}

#[test]
fn thread_id_is_uuid_v7_shape() {
    let dir = TempDir::new().unwrap();
    let out = run(dir.path(), &["exec", "--json", "--", "x"]).unwrap();
    let id = out.events[0]["thread_id"].as_str().unwrap();
    let parts: Vec<&str> = id.split('-').collect();
    assert_eq!(parts.len(), 5);
    assert_eq!(parts[0].len(), 8);
    assert_eq!(parts[1].len(), 4);
    assert_eq!(parts[2].len(), 4);
    assert_eq!(parts[3].len(), 4);
    assert_eq!(parts[4].len(), 12);
    assert!(
        parts[2].starts_with('7'),
        "expected uuid v7 (third group starts with '7'): {id}"
    );
}

#[cfg(unix)]
#[test]
fn session_files_skip_symlinked_files_and_dirs() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    let day_dir = sessions.join("2026/06/09");
    std::fs::create_dir_all(&day_dir)?;
    let real_file = day_dir.join("00000000-0000-0000-0000-000000000001.jsonl");
    std::fs::write(&real_file, "{}\n")?;
    let linked_file = day_dir.join("00000000-0000-0000-0000-000000000002.jsonl");
    std::os::unix::fs::symlink(&real_file, &linked_file)?;
    std::os::unix::fs::symlink(&sessions, sessions.join("loop"))?;

    let files = session_files(dir.path())?;
    assert_eq!(files, vec![real_file]);
    assert!(linked_file.symlink_metadata()?.file_type().is_symlink());
    Ok(())
}

#[cfg(unix)]
#[test]
fn session_files_skip_dangling_jsonl_symlinks() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    let day_dir = sessions.join("2026/06/09");
    std::fs::create_dir_all(&day_dir)?;
    let real_file = day_dir.join("00000000-0000-0000-0000-000000000001.jsonl");
    std::fs::write(&real_file, "{}\n")?;
    let missing_target = dir.path().join("missing/codex-session.jsonl");
    std::os::unix::fs::symlink(
        missing_target,
        day_dir.join("00000000-0000-0000-0000-000000000002.jsonl"),
    )?;

    let files = session_files(dir.path())?;
    assert_eq!(files, vec![real_file]);
    Ok(())
}

#[cfg(unix)]
#[test]
fn session_files_skip_jsonl_symlink_loops() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    let day_dir = sessions.join("2026/06/09");
    std::fs::create_dir_all(&day_dir)?;
    let real_file = day_dir.join("00000000-0000-0000-0000-000000000001.jsonl");
    std::fs::write(&real_file, "{}\n")?;
    let looped_file = day_dir.join("00000000-0000-0000-0000-000000000002.jsonl");
    std::os::unix::fs::symlink(&looped_file, &looped_file)?;

    let files = session_files(dir.path())?;
    assert_eq!(files, vec![real_file]);
    Ok(())
}

#[cfg(unix)]
#[test]
fn session_artifacts_skip_root_symlink_loop() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    std::os::unix::fs::symlink(&sessions, &sessions)?;

    assert!(session_artifacts(dir.path())?.is_empty());
    assert!(session_files(dir.path())?.is_empty());
    Ok(())
}

#[cfg(unix)]
#[test]
fn session_artifacts_skip_symlinked_root_dir() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let real_sessions = dir.path().join("real-sessions");
    let real_day_dir = real_sessions.join("2026/06/09");
    std::fs::create_dir_all(&real_day_dir)?;
    std::fs::write(
        real_day_dir.join("00000000-0000-0000-0000-000000000001.jsonl"),
        "{}\n",
    )?;
    std::os::unix::fs::symlink(&real_sessions, dir.path().join("sessions"))?;

    assert!(session_artifacts(dir.path())?.is_empty());
    assert!(session_files(dir.path())?.is_empty());
    Ok(())
}

#[cfg(unix)]
fn mkfifo(path: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes())
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidInput, err))?;
    // SAFETY: `c_path` is a valid NUL-terminated path and `mkfifo` does not
    // retain the pointer after returning.
    let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    if result < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
