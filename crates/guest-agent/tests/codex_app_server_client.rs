use std::future::Future;
use std::ops::{Deref, DerefMut};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use guest_agent::cli::codex_app_server::{
    CodexAppServerClient, CodexAppServerConfig, CodexAppServerError, InitializeResponse,
};
use serde_json::{Value, json};
use tempfile::TempDir;

const CLIENT_TIMEOUT: Duration = Duration::from_secs(5);

static MOCK_CODEX_BUILD: OnceLock<Result<PathBuf, String>> = OnceLock::new();

struct ClientFixture {
    client: CodexAppServerClient,
    _codex_home: TempDir,
}

impl Deref for ClientFixture {
    type Target = CodexAppServerClient;

    fn deref(&self) -> &Self::Target {
        &self.client
    }
}

impl DerefMut for ClientFixture {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.client
    }
}

#[tokio::test]
async fn codex_app_server_initializes_and_sends_initialized_notification() -> Result<(), String> {
    let mut client = spawn_client(None)?;

    let initialized = wait_result(client.initialize(), "initialize").await?;
    assert!(
        initialized
            .user_agent
            .starts_with("guest-mock-codex-app-server/")
    );
    assert!(!initialized.codex_home.is_empty());

    let state = wait_result(client.request_value("mock/state", json!({})), "mock/state").await?;
    assert_eq!(state["initializedNotificationReceived"], true);
    assert_eq!(state["hasPendingResponse"], false);

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_correlates_request_response_by_id() -> Result<(), String> {
    let mut client = spawn_client(None)?;
    wait_result(client.initialize(), "initialize").await?;

    let started = wait_result(
        client.request_value("thread/start", json!({ "cwd": "/tmp" })),
        "thread/start",
    )
    .await?;

    assert!(started["thread"]["id"].as_str().is_some());
    assert_eq!(started["thread"]["source"], "appServer");

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_returns_structured_rpc_errors() -> Result<(), String> {
    let mut client = spawn_client(None)?;
    wait_result(client.initialize(), "initialize").await?;

    let result = wait_result_allow_error(
        client.request_value("unknown/method", json!({})),
        "unknown/method",
    )
    .await;

    match result {
        Err(CodexAppServerError::Rpc { method, error, .. }) => {
            assert_eq!(method, "unknown/method");
            assert_eq!(error.code, -32601);
            assert_eq!(error.message, "unsupported method");
        }
        other => return Err(format!("expected RPC error, got {other:?}")),
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_buffers_interleaved_notifications() -> Result<(), String> {
    let mut client = spawn_client(Some("interleaved-notification"))?;
    wait_result(client.initialize(), "initialize").await?;

    let started = wait_result(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await?;
    assert!(started["thread"]["id"].as_str().is_some());

    let notification = client
        .pop_notification()
        .ok_or_else(|| "expected buffered notification".to_string())?;
    assert_eq!(notification.method, "experimental/server-notification");
    assert_eq!(
        notification
            .params
            .as_ref()
            .and_then(|value| value.get("message")),
        Some(&json!("guest-mock-codex notification"))
    );
    assert!(client.pop_notification().is_none());

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_rejects_notification_queue_overflow() -> Result<(), String> {
    let mut client = spawn_client(Some("notification-overflow"))?;
    wait_result(client.initialize(), "initialize").await?;

    let result = wait_result_allow_error(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await;

    match result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("server notification queue exceeded"));
        }
        other => {
            return Err(format!(
                "expected notification overflow error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_rejects_large_buffered_notifications() -> Result<(), String> {
    let mut client = spawn_client(Some("large-notification-before-response"))?;
    wait_result(client.initialize(), "initialize").await?;

    let result = wait_result_allow_error(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await;

    match result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("server notification queue exceeded"));
            assert!(!message.contains("xxx"));
        }
        other => {
            return Err(format!(
                "expected large notification queue error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_rejects_server_requests_and_continues() -> Result<(), String> {
    let mut client = spawn_client(Some("server-request-before-response"))?;
    wait_result(client.initialize(), "initialize").await?;

    let started = wait_result(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await?;
    assert!(started["thread"]["id"].as_str().is_some());

    let state = wait_result(client.request_value("mock/state", json!({})), "mock/state").await?;
    assert_eq!(state["hasPendingResponse"], false);
    assert_eq!(
        state["serverRequestResponses"][0]["id"],
        "guest-mock-codex-server-request-1"
    );
    assert_eq!(state["serverRequestResponses"][0]["error"]["code"], -32601);
    assert!(
        state["serverRequestResponses"][0]["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("unsupported server request method"))
    );

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_rejects_null_id_server_requests_and_continues() -> Result<(), String> {
    let mut client = spawn_client(Some("null-id-server-request-before-response"))?;
    wait_result(client.initialize(), "initialize").await?;

    let started = wait_result(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await?;
    assert!(started["thread"]["id"].as_str().is_some());

    let state = wait_result(client.request_value("mock/state", json!({})), "mock/state").await?;
    assert_eq!(state["hasPendingResponse"], false);
    assert!(state["serverRequestResponses"][0]["id"].is_null());
    assert_eq!(state["serverRequestResponses"][0]["error"]["code"], -32601);

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_malformed_stdout_fails_without_hanging() -> Result<(), String> {
    let mut client = spawn_client(Some("malformed-stdout"))?;

    let result = wait_result_allow_error(client.initialize(), "initialize").await;
    match result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("malformed app-server stdout JSON"));
            assert!(!message.contains("not-valid-json"));
        }
        other => {
            return Err(format!(
                "expected malformed stdout protocol error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_oversized_stdout_line_is_rejected() -> Result<(), String> {
    let mut client = spawn_client(Some("oversized-stdout"))?;

    let result = wait_result_allow_error(client.initialize(), "initialize").await;
    match result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("app-server stdout line exceeded"));
            assert!(!message.contains("xxx"));
        }
        other => {
            return Err(format!(
                "expected oversized stdout protocol error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_malformed_rpc_error_fails_without_raw_payload() -> Result<(), String> {
    let mut client = spawn_client(Some("malformed-error-response"))?;
    wait_result(client.initialize(), "initialize").await?;

    let result = wait_result_allow_error(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await;
    match result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("error response must be an object"));
            assert!(!message.contains("do-not-log-malformed-error-payload"));
        }
        other => {
            return Err(format!(
                "expected malformed error response protocol error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_unexpected_typed_response_fails_without_raw_payload() -> Result<(), String>
{
    let mut client = spawn_client(Some("malformed-initialize-result"))?;

    let result: Result<InitializeResponse, CodexAppServerError> = wait_result_allow_error(
        client.request("initialize", initialize_params()),
        "initialize",
    )
    .await;
    match result {
        Err(CodexAppServerError::Protocol(message)) => {
            assert!(message.contains("unexpected shape"));
            assert!(!message.contains("do-not-log-malformed-initialize-result"));
        }
        other => {
            return Err(format!(
                "expected unexpected typed response protocol error, got {other:?}"
            ));
        }
    }

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_disconnect_after_initialize_fails_next_request() -> Result<(), String> {
    let mut client = spawn_client(Some("disconnect-after-initialize"))?;

    let initialized: InitializeResponse = wait_result(
        client.request("initialize", initialize_params()),
        "manual initialize",
    )
    .await?;
    assert_eq!(initialized.platform_family, std::env::consts::FAMILY);

    let result =
        wait_result_allow_error(client.request_value("mock/state", json!({})), "mock/state").await;
    assert_disconnect_like(result)?;

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_child_exit_before_response_fails_pending_request() -> Result<(), String> {
    let mut client = spawn_client(Some("exit-on-turn-start"))?;
    wait_result(client.initialize(), "initialize").await?;

    let started = wait_result(
        client.request_value("thread/start", json!({})),
        "thread/start",
    )
    .await?;
    let thread_id = started["thread"]["id"]
        .as_str()
        .ok_or_else(|| "missing thread id".to_string())?;

    let result = wait_result_allow_error(
        client.request_value(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [text_input("initial prompt")]
            }),
        ),
        "turn/start",
    )
    .await;
    assert_disconnect_like(result)?;

    wait_result(client.shutdown(), "shutdown").await
}

#[tokio::test]
async fn codex_app_server_shutdown_reaps_child() -> Result<(), String> {
    let mut client = spawn_client(None)?;
    let pid = client
        .process_id()
        .ok_or_else(|| "app-server child missing pid".to_string())?;
    wait_result(client.initialize(), "initialize").await?;

    wait_result(client.shutdown(), "shutdown").await?;
    assert_process_exited(pid)?;
    wait_result(client.shutdown(), "second shutdown").await
}

#[tokio::test]
async fn codex_app_server_drop_kills_open_child() -> Result<(), String> {
    let client = spawn_client(None)?;
    let pid = client
        .process_id()
        .ok_or_else(|| "app-server child missing pid".to_string())?;

    drop(client);
    wait_for_process_exit(pid).await
}

fn spawn_client(scenario: Option<&str>) -> Result<ClientFixture, String> {
    let codex_home = TempDir::new().map_err(|error| format!("create codex home: {error}"))?;
    let mut config = CodexAppServerConfig::new(mock_codex_path()?, codex_home.path());
    if let Some(scenario) = scenario {
        config = config.with_env("MOCK_CODEX_APP_SERVER_SCENARIO", scenario);
    }
    let client = CodexAppServerClient::spawn(config).map_err(|error| format!("{error:?}"))?;
    Ok(ClientFixture {
        client,
        _codex_home: codex_home,
    })
}

fn mock_codex_path() -> Result<PathBuf, String> {
    MOCK_CODEX_BUILD
        .get_or_init(build_and_locate_mock_codex)
        .clone()
}

fn build_and_locate_mock_codex() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let target_profile_dir = exe
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| "target/<profile> dir".to_string())?;
    let target_dir = target_profile_dir
        .parent()
        .ok_or_else(|| "target dir".to_string())?;
    let profile_dir_name = target_profile_dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "profile dir name".to_string())?;

    let mut cmd = std::process::Command::new("cargo");
    cmd.args(["build", "-p", "guest-mock-codex", "--quiet"])
        .arg("--target-dir")
        .arg(target_dir);
    match profile_dir_name {
        "debug" => {}
        "release" => {
            cmd.arg("--release");
        }
        other => {
            cmd.args(["--profile", other]);
        }
    }

    let status = cmd
        .status()
        .map_err(|e| format!("invoke cargo build: {e}"))?;
    if !status.success() {
        return Err("cargo build -p guest-mock-codex failed".into());
    }

    let mock = target_profile_dir.join("guest-mock-codex");
    if !mock.exists() {
        return Err(format!("mock binary not found at {}", mock.display()));
    }
    Ok(mock)
}

async fn wait_result<T>(
    future: impl Future<Output = Result<T, CodexAppServerError>>,
    label: &str,
) -> Result<T, String> {
    match tokio::time::timeout(CLIENT_TIMEOUT, future).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(format!("{label} failed: {error:?}")),
        Err(_) => Err(format!("{label} timed out")),
    }
}

async fn wait_result_allow_error<T>(
    future: impl Future<Output = Result<T, CodexAppServerError>>,
    label: &str,
) -> Result<T, CodexAppServerError> {
    tokio::time::timeout(CLIENT_TIMEOUT, future)
        .await
        .unwrap_or_else(|_| Err(CodexAppServerError::Protocol(format!("{label} timed out"))))
}

fn initialize_params() -> Value {
    json!({
        "clientInfo": {
            "name": "vm0-guest-agent-tests",
            "title": null,
            "version": env!("CARGO_PKG_VERSION")
        },
        "capabilities": {
            "experimentalApi": true,
            "requestAttestation": false
        }
    })
}

fn text_input(text: &str) -> Value {
    json!({
        "type": "text",
        "text": text,
        "text_elements": []
    })
}

fn assert_disconnect_like<T: std::fmt::Debug>(
    result: Result<T, CodexAppServerError>,
) -> Result<(), String> {
    match result {
        Err(CodexAppServerError::Disconnected { .. })
        | Err(CodexAppServerError::ChildExited { .. })
        | Err(CodexAppServerError::Io(_)) => Ok(()),
        other => Err(format!("expected disconnect-like failure, got {other:?}")),
    }
}

async fn wait_for_process_exit(pid: u32) -> Result<(), String> {
    let wait_task = tokio::task::spawn_blocking(move || wait_for_process_exit_blocking(pid));
    match tokio::time::timeout(CLIENT_TIMEOUT, wait_task).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(format!("waitpid task failed: {error}")),
        Err(_) => {
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
            Err(format!("process {pid} did not exit"))
        }
    }
}

fn wait_for_process_exit_blocking(pid: u32) -> Result<(), String> {
    let mut status = 0;
    let wait_result = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, 0) };
    if wait_result == pid as libc::pid_t {
        return Ok(());
    }

    let wait_error = std::io::Error::last_os_error();
    if wait_error.raw_os_error() == Some(libc::ECHILD) && process_exited(pid)? {
        return Ok(());
    }

    Err(format!("waitpid({pid}) failed: {wait_error}"))
}

fn assert_process_exited(pid: u32) -> Result<(), String> {
    if process_exited(pid)? {
        Ok(())
    } else {
        Err(format!("process {pid} is still running"))
    }
}

fn process_exited(pid: u32) -> Result<bool, String> {
    let mut status = 0;
    let wait_result = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG) };
    if wait_result == pid as libc::pid_t {
        return Ok(true);
    }
    if wait_result == 0 {
        return Ok(false);
    }

    let wait_error = std::io::Error::last_os_error();
    if wait_error.raw_os_error() != Some(libc::ECHILD) {
        return Err(format!("waitpid({pid}) failed: {wait_error}"));
    }

    let kill_result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if kill_result == 0 {
        return Ok(false);
    }
    let kill_error = std::io::Error::last_os_error();
    if kill_error.raw_os_error() == Some(libc::ESRCH) {
        Ok(true)
    } else {
        Err(format!("kill -0 {pid} failed: {kill_error}"))
    }
}
