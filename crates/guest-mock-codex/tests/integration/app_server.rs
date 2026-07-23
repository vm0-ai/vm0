use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use guest_mock_codex::{read_session_file, session_artifacts};
use serde_json::{Value, json};
use tempfile::TempDir;

use crate::support::{BIN, ChildWaitOutcome, require_session_file, run, wait_child_with_timeout};

const APP_SERVER_READ_TIMEOUT: Duration = Duration::from_secs(5);
const APP_SERVER_EXIT_TIMEOUT: Duration = Duration::from_secs(5);

struct AppServerProcess {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    stdout_rx: Receiver<Result<Option<Value>, String>>,
    stdout_done_rx: Option<Receiver<()>>,
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

    fn send_raw_line(&mut self, line: &str) -> std::io::Result<()> {
        let stdin = self.stdin.as_mut().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "app-server stdin is closed")
        })?;
        writeln!(stdin, "{line}")?;
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
        match self.stdout_rx.recv_timeout(APP_SERVER_READ_TIMEOUT) {
            Ok(result) => result
                .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidData, message)),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "timed out waiting for app-server stdout message",
            )),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "app-server stdout reader exited without EOF",
            )),
        }
    }

    fn close_and_wait(&mut self) -> std::io::Result<i32> {
        self.stdin.take();
        let child = self
            .child
            .take()
            .ok_or_else(|| std::io::Error::other("app-server child already waited"))?;
        let stdout_deadline = Instant::now() + APP_SERVER_EXIT_TIMEOUT + APP_SERVER_EXIT_TIMEOUT;
        let status = match wait_child_with_timeout(
            child,
            APP_SERVER_EXIT_TIMEOUT,
            APP_SERVER_EXIT_TIMEOUT,
        ) {
            ChildWaitOutcome::Exited(status) | ChildWaitOutcome::TimedOut(status) => status,
            ChildWaitOutcome::ReapTimedOut => {
                self.detach_stdout_reader();
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "app-server child did not exit after SIGKILL",
                ));
            }
            ChildWaitOutcome::KillFailed(error) => {
                self.detach_stdout_reader();
                return Err(std::io::Error::new(
                    error.kind(),
                    format!("failed to kill app-server child after timeout: {error}"),
                ));
            }
            ChildWaitOutcome::ReapFailed(error) | ChildWaitOutcome::WaitFailed(error) => {
                self.detach_stdout_reader();
                return Err(std::io::Error::new(
                    error.kind(),
                    format!("wait for app-server child: {error}"),
                ));
            }
        };
        self.wait_for_stdout_reader_until(stdout_deadline)?;
        Ok(status.code().unwrap_or(-1))
    }

    fn wait_for_stdout_reader_until(&mut self, deadline: Instant) -> std::io::Result<()> {
        if let Some(stdout_done_rx) = self.stdout_done_rx.take() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match stdout_done_rx.recv_timeout(remaining) {
                Ok(()) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "app-server stdout reader did not finish before the output deadline",
                    ));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(std::io::Error::other(
                        "app-server stdout reader exited without completion",
                    ));
                }
            }
        }
        Ok(())
    }

    fn detach_stdout_reader(&mut self) {
        self.stdout_done_rx.take();
    }
}

impl Drop for AppServerProcess {
    fn drop(&mut self) {
        self.stdin.take();
        if let Some(mut child) = self.child.take() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    let _ = child.wait();
                }
                Ok(None) | Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        let _ = self.wait_for_stdout_reader_until(Instant::now() + APP_SERVER_EXIT_TIMEOUT);
    }
}

fn spawn_app_server(
    codex_home: &Path,
    args: &[&str],
    scenario: Option<&str>,
) -> std::io::Result<AppServerProcess> {
    spawn_app_server_with_env(codex_home, args, scenario, &[])
}

fn spawn_app_server_with_env(
    codex_home: &Path,
    args: &[&str],
    scenario: Option<&str>,
    env: &[(&str, &str)],
) -> std::io::Result<AppServerProcess> {
    let mut cmd = Command::new(BIN);
    cmd.env("CODEX_HOME", codex_home).args(args);
    cmd.env_remove("MOCK_CODEX_FIXTURE");
    cmd.env_remove("MOCK_CODEX_APP_SERVER_SCENARIO");
    if let Some(value) = scenario {
        cmd.env("MOCK_CODEX_APP_SERVER_SCENARIO", value);
    }
    for (key, value) in env {
        cmd.env(key, value);
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
    let (stdout_tx, stdout_rx) = mpsc::channel();
    let (stdout_done_tx, stdout_done_rx) = mpsc::channel();
    let _ = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut reached_eof = true;
        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    let _ = stdout_tx.send(Err(format!("read app-server stdout line: {error}")));
                    reached_eof = false;
                    break;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            let value = serde_json::from_str::<Value>(&line)
                .map(Some)
                .map_err(|error| format!("parse app-server stdout JSON: {error}; line={line:?}"));
            if stdout_tx.send(value).is_err() {
                reached_eof = false;
                break;
            }
        }
        if reached_eof {
            let _ = stdout_tx.send(Ok(None));
        }
        let _ = stdout_done_tx.send(());
    });
    Ok(AppServerProcess {
        child: Some(child),
        stdin: Some(stdin),
        stdout_rx,
        stdout_done_rx: Some(stdout_done_rx),
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
            "experimentalApi": true,
            "requestAttestation": false
        }
    })
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
    assert_eq!(turn_started["result"]["turn"]["itemsView"], "notLoaded");
    assert!(turn_started["result"]["turn"]["startedAt"].is_null());

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
fn app_server_turn_steer_can_complete_runtime_turn_after_success() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(
        dir.path(),
        &["app-server", "--listen", "stdio://"],
        Some("runtime-turn-complete-after-steer"),
    )?;

    server.request(1, "initialize", initialize_params())?;
    let started = server.request(2, "thread/start", json!({ "cwd": "/tmp" }))?;
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

    let steered = server.request(
        4,
        "turn/steer",
        json!({
            "threadId": thread_id,
            "expectedTurnId": turn_id,
            "clientUserMessageId": "active-msg-1",
            "input": [text_input("follow-up prompt")]
        }),
    )?;
    assert_eq!(steered["result"]["turnId"], turn_id);

    let turn_started_notification = server.read_required()?;
    let item_completed_notification = server.read_required()?;
    let turn_completed_notification = server.read_required()?;
    assert_eq!(turn_started_notification["method"], "turn/started");
    assert_eq!(item_completed_notification["method"], "item/completed");
    assert_eq!(turn_completed_notification["method"], "turn/completed");

    let session_path = require_session_file(dir.path())?;
    let events = read_session_file(&session_path)?;
    assert_eq!(events[1]["kind"], "steered");
    assert_eq!(
        events[1]["turn_request_client_user_message_id"],
        "active-msg-1"
    );
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_can_start_runtime_turn_before_steer_completion() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(
        dir.path(),
        &["app-server", "--listen", "stdio://"],
        Some("runtime-turn-started-before-steer"),
    )?;

    server.request(1, "initialize", initialize_params())?;
    let started = server.request(2, "thread/start", json!({ "cwd": "/tmp" }))?;
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
    let turn_started_notification = server.read_required()?;
    assert_eq!(turn_started_notification["method"], "turn/started");
    assert_eq!(
        turn_started_notification["params"]["turn"]["id"]
            .as_str()
            .unwrap(),
        turn_id
    );

    let steered = server.request(
        4,
        "turn/steer",
        json!({
            "threadId": thread_id,
            "expectedTurnId": turn_id,
            "clientUserMessageId": "active-msg-1",
            "input": [text_input("follow-up prompt")]
        }),
    )?;
    assert_eq!(steered["result"]["turnId"], turn_id);

    let item_completed_notification = server.read_required()?;
    let turn_completed_notification = server.read_required()?;
    assert_eq!(item_completed_notification["method"], "item/completed");
    assert_eq!(turn_completed_notification["method"], "turn/completed");
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_exit_on_turn_steer_closes_without_response() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(
        dir.path(),
        &["app-server", "--listen", "stdio://"],
        Some("exit-on-turn-steer"),
    )?;

    server.request(1, "initialize", initialize_params())?;
    let started = server.request(2, "thread/start", json!({ "cwd": "/tmp" }))?;
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
    let turn_started_notification = server.read_required()?;
    assert_eq!(turn_started_notification["method"], "turn/started");

    let error = server
        .request(
            4,
            "turn/steer",
            json!({
                "threadId": thread_id,
                "expectedTurnId": turn_id,
                "input": [text_input("follow-up prompt")]
            }),
        )
        .expect_err("exit-on-turn-steer should close before responding");
    assert_eq!(error.kind(), std::io::ErrorKind::UnexpectedEof);
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
fn app_server_ignores_exec_fixture_mode() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server_with_env(
        dir.path(),
        &["app-server", "--stdio"],
        None,
        &[("MOCK_CODEX_FIXTURE", "event-mapping-rich")],
    )?;

    let initialized = server.request(1, "initialize", initialize_params())?;

    assert_eq!(initialized["id"], 1);
    assert!(initialized.get("type").is_none());
    assert!(
        initialized["result"]["userAgent"]
            .as_str()
            .is_some_and(|user_agent| user_agent.starts_with("guest-mock-codex-app-server/"))
    );
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_invalid_json_exits_without_hanging() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(dir.path(), &["app-server", "--stdio"], None)?;

    server.send_raw_line("{not-json")?;

    assert!(server.read_message()?.is_none());
    assert_ne!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_records_initialized_notification() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(dir.path(), &["app-server", "--stdio"], None)?;

    server.request(1, "initialize", initialize_params())?;
    server.notify("initialized", json!({}))?;

    let state = server.request(2, "mock/state", json!({}))?;
    assert_eq!(state["result"]["initializedNotificationReceived"], true);
    assert_eq!(state["result"]["hasPendingResponse"], false);
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_interleaved_notification_scenario_emits_before_response() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(
        dir.path(),
        &["app-server", "--stdio"],
        Some("interleaved-notification"),
    )?;

    server.request(1, "initialize", initialize_params())?;
    server.send(&json!({
        "id": 2,
        "method": "thread/start",
        "params": {}
    }))?;

    let notification = server.read_required()?;
    assert_eq!(notification["method"], "experimental/server-notification");
    assert_eq!(
        notification["params"]["message"],
        "guest-mock-codex notification"
    );

    let response = server.read_required()?;
    assert_eq!(response["id"], 2);
    assert!(response["result"]["thread"]["id"].as_str().is_some());
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_notification_overflow_scenario_emits_many_notifications() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(
        dir.path(),
        &["app-server", "--stdio"],
        Some("notification-overflow"),
    )?;

    server.request(1, "initialize", initialize_params())?;
    server.send(&json!({
        "id": 2,
        "method": "thread/start",
        "params": {}
    }))?;

    for index in 0..129 {
        let notification = server.read_required()?;
        assert_eq!(notification["method"], "experimental/server-notification");
        assert_eq!(notification["params"]["index"], index);
    }

    let response = server.read_required()?;
    assert_eq!(response["id"], 2);
    assert!(response["result"]["thread"]["id"].as_str().is_some());
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_server_request_scenario_waits_for_client_response() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(
        dir.path(),
        &["app-server", "--stdio"],
        Some("server-request-before-response"),
    )?;

    server.request(1, "initialize", initialize_params())?;
    server.send(&json!({
        "id": 2,
        "method": "thread/start",
        "params": {}
    }))?;

    let server_request = server.read_required()?;
    assert_eq!(server_request["id"], "guest-mock-codex-server-request-1");
    assert_eq!(server_request["method"], "experimental/server-request");

    server.send(&json!({
        "id": "guest-mock-codex-server-request-1",
        "error": {
            "code": -32601,
            "message": "unsupported server request"
        }
    }))?;

    let response = server.read_required()?;
    assert_eq!(response["id"], 2);
    assert!(response["result"]["thread"]["id"].as_str().is_some());

    let state = server.request(3, "mock/state", json!({}))?;
    assert_eq!(state["result"]["hasPendingResponse"], false);
    assert_eq!(
        state["result"]["serverRequestResponses"][0]["error"]["code"],
        -32601
    );
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_malformed_stdout_scenario_exits_after_invalid_line() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(
        dir.path(),
        &["app-server", "--stdio"],
        Some("malformed-stdout"),
    )?;

    server.send(&json!({
        "id": 1,
        "method": "initialize",
        "params": initialize_params()
    }))?;

    let error = server.read_required().unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert_eq!(server.close_and_wait()?, 0);
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
fn app_server_rejects_missing_or_empty_turn_thread_id() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(dir.path(), &["app-server", "--stdio"], None)?;

    server.request(1, "initialize", initialize_params())?;
    let started = server.request(2, "thread/start", json!({}))?;
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let missing_start = server.request(
        3,
        "turn/start",
        json!({
            "input": [text_input("initial prompt")]
        }),
    )?;
    let empty_start = server.request(
        4,
        "turn/start",
        json!({
            "threadId": "",
            "input": [text_input("initial prompt")]
        }),
    )?;

    let turn_started = server.request(
        5,
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
    let missing_steer = server.request(
        6,
        "turn/steer",
        json!({
            "expectedTurnId": turn_id,
            "input": [text_input("follow-up prompt")]
        }),
    )?;
    let empty_steer = server.request(
        7,
        "turn/steer",
        json!({
            "threadId": "",
            "expectedTurnId": turn_id,
            "input": [text_input("follow-up prompt")]
        }),
    )?;

    for error in [missing_start, empty_start, missing_steer, empty_steer] {
        assert_eq!(error["error"]["code"], -32600);
        assert!(
            error["error"]["message"]
                .as_str()
                .unwrap()
                .contains("threadId")
        );
    }
    assert_eq!(server.close_and_wait()?, 0);
    Ok(())
}

#[test]
fn app_server_rejects_missing_or_empty_expected_turn_id() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let mut server = spawn_app_server(dir.path(), &["app-server", "--stdio"], None)?;

    server.request(1, "initialize", initialize_params())?;
    let started = server.request(2, "thread/start", json!({}))?;
    let thread_id = started["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.request(
        3,
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [text_input("initial prompt")]
        }),
    )?;

    let missing_expected_turn = server.request(
        4,
        "turn/steer",
        json!({
            "threadId": thread_id,
            "input": [text_input("follow-up prompt")]
        }),
    )?;
    let empty_expected_turn = server.request(
        5,
        "turn/steer",
        json!({
            "threadId": thread_id,
            "expectedTurnId": "",
            "input": [text_input("follow-up prompt")]
        }),
    )?;

    assert_eq!(missing_expected_turn["error"]["code"], -32600);
    assert_eq!(
        missing_expected_turn["error"]["message"],
        "missing expectedTurnId"
    );
    assert_eq!(empty_expected_turn["error"]["code"], -32600);
    assert_eq!(
        empty_expected_turn["error"]["message"],
        "expectedTurnId must not be empty"
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
    let thread_start_error = server.request(1, "thread/start", json!({}))?;
    let turn_start_error = server.request(
        2,
        "turn/start",
        json!({
            "threadId": "thread-1",
            "input": [text_input("initial prompt")]
        }),
    )?;
    let turn_steer_error = server.request(
        3,
        "turn/steer",
        json!({
            "threadId": "thread-1",
            "expectedTurnId": "turn-1",
            "input": [text_input("follow-up prompt")]
        }),
    )?;

    assert_eq!(thread_start_error["error"]["code"], -32600);
    assert!(
        thread_start_error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not initialized")
    );
    assert_eq!(turn_start_error["error"]["code"], -32600);
    assert_eq!(
        turn_start_error["error"]["message"],
        "app server is not initialized"
    );
    assert_eq!(turn_steer_error["error"]["code"], -32600);
    assert_eq!(
        turn_steer_error["error"]["message"],
        "app server is not initialized"
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
    let turn_started_notification = server.read_required()?;
    assert_eq!(turn_started_notification["method"], "turn/started");

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
    let turn_started_notification = server.read_required()?;
    assert_eq!(turn_started_notification["method"], "turn/started");

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
