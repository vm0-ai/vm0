//! Codex app-server stdio JSON-RPC client.
//!
//! This module owns the protocol and process boundary for
//! `codex app-server --listen stdio://`. It intentionally does not interpret
//! thread or turn semantics; later runtime code can build those policies on
//! top of this generic request/notification layer.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::runtime::Handle;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::error::AgentError;

use super::{child_env, diagnostics};

const METHOD_NOT_FOUND: i64 = -32601;
const NOTIFICATION_QUEUE_CAPACITY: usize = 128;
const NOTIFICATION_QUEUE_MAX_BYTES: usize = 16 * 1024 * 1024;
const STDOUT_MAX_LINE_BYTES: usize = 64 * 1024 * 1024;
const SHUTDOWN_SIGTERM_GRACE: Duration = Duration::from_secs(2);
const SHUTDOWN_SIGKILL_GRACE: Duration = Duration::from_secs(2);
const STDERR_DRAIN_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub struct CodexAppServerConfig {
    binary: PathBuf,
    codex_home: PathBuf,
    extra_env: Vec<(String, String)>,
}

impl CodexAppServerConfig {
    pub fn new(binary: impl Into<PathBuf>, codex_home: impl Into<PathBuf>) -> Self {
        Self {
            binary: binary.into(),
            codex_home: codex_home.into(),
            extra_env: Vec::new(),
        }
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.extra_env.push((key.into(), value.into()));
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcId {
    Number(i64),
    String(String),
    Null,
}

#[derive(Debug, Clone, PartialEq)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ServerNotification {
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ServerRequest {
    pub id: JsonRpcId,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResponse {
    pub user_agent: String,
    pub codex_home: String,
    pub platform_family: String,
    pub platform_os: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CodexAppServerError {
    #[error("failed to spawn codex app-server: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("codex app-server io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("codex app-server JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("codex app-server RPC error for {method}: {error}")]
    Rpc {
        method: String,
        id: JsonRpcId,
        error: Box<JsonRpcError>,
    },
    #[error("codex app-server protocol error: {0}")]
    Protocol(String),
    #[error("codex app-server disconnected while waiting for {method}")]
    Disconnected { method: String },
    #[error("codex app-server child exited while waiting for {method}: {status}")]
    ChildExited { method: String, status: String },
    #[error("codex app-server did not exit after shutdown")]
    ShutdownTimeout,
}

impl std::fmt::Display for JsonRpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "code={} message={}",
            self.code,
            bounded_error_message(&self.message)
        )
    }
}

impl From<CodexAppServerError> for AgentError {
    fn from(value: CodexAppServerError) -> Self {
        AgentError::Execution(value.to_string())
    }
}

pub struct CodexAppServerClient {
    stdin: Option<ChildStdin>,
    stdout_reader: BufReader<ChildStdout>,
    process_id: Option<u32>,
    process_group_id: Option<i32>,
    wait_rx: Option<oneshot::Receiver<std::io::Result<ExitStatus>>>,
    stderr_handle: Option<JoinHandle<Vec<String>>>,
    stderr_tail: Vec<String>,
    next_request_id: i64,
    in_flight_request_id: Option<JsonRpcId>,
    outbound_write_in_progress: bool,
    stream_unusable_reason: Option<String>,
    notifications: VecDeque<QueuedNotification>,
    notification_queue_bytes: usize,
    closed: bool,
}

impl CodexAppServerClient {
    pub fn spawn(config: CodexAppServerConfig) -> Result<Self, CodexAppServerError> {
        let runtime = Handle::try_current().map_err(|_error| {
            CodexAppServerError::Protocol(
                "codex app-server client requires a Tokio runtime".to_string(),
            )
        })?;
        std::fs::create_dir_all(&config.codex_home)?;

        let mut cmd = tokio::process::Command::new(&config.binary);
        child_env::apply_to_tokio_command(&mut cmd);
        cmd.args(["app-server", "--listen", "stdio://"])
            .env("CODEX_HOME", &config.codex_home)
            .env_remove("MOCK_CODEX_FIXTURE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true);
        for (key, value) in config.extra_env {
            cmd.env(key, value);
        }

        let mut child = cmd.spawn().map_err(CodexAppServerError::Spawn)?;
        let process_id = child.id();
        let process_group_id = process_id.map(|pid| pid as i32);
        let stdin = child.stdin.take().ok_or_else(|| {
            CodexAppServerError::Protocol("app-server stdin was not piped".to_string())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            CodexAppServerError::Protocol("app-server stdout was not piped".to_string())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            CodexAppServerError::Protocol("app-server stderr was not piped".to_string())
        })?;
        let stderr_handle =
            runtime.spawn(async move { diagnostics::collect_stderr_result_tail(stderr).await });
        let (wait_tx, wait_rx) = oneshot::channel();
        runtime.spawn(async move {
            let _ = wait_tx.send(child.wait().await);
        });

        Ok(Self {
            stdin: Some(stdin),
            stdout_reader: BufReader::new(stdout),
            process_id,
            process_group_id,
            wait_rx: Some(wait_rx),
            stderr_handle: Some(stderr_handle),
            stderr_tail: Vec::new(),
            next_request_id: 1,
            in_flight_request_id: None,
            outbound_write_in_progress: false,
            stream_unusable_reason: None,
            notifications: VecDeque::with_capacity(NOTIFICATION_QUEUE_CAPACITY),
            notification_queue_bytes: 0,
            closed: false,
        })
    }

    pub fn process_id(&self) -> Option<u32> {
        self.process_id
    }

    pub fn pop_notification(&mut self) -> Option<ServerNotification> {
        let queued = self.notifications.pop_front()?;
        self.notification_queue_bytes = self.notification_queue_bytes.saturating_sub(queued.bytes);
        Some(queued.notification)
    }

    pub fn stderr_tail(&self) -> &[String] {
        &self.stderr_tail
    }

    pub async fn initialize(&mut self) -> Result<InitializeResponse, CodexAppServerError> {
        let response = self
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "vm0-guest-agent",
                        "title": null,
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {
                        "experimentalApi": true,
                        "requestAttestation": false
                    }
                }),
            )
            .await?;
        self.notify("initialized", Value::Null).await?;
        Ok(response)
    }

    pub async fn request<T>(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<T, CodexAppServerError>
    where
        T: DeserializeOwned,
    {
        let value = self.request_value(method, params).await?;
        serde_json::from_value(value).map_err(|_error| {
            self.poison_stream(format!(
                "app-server response for {method} had an unexpected shape"
            ))
        })
    }

    pub async fn request_value(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Value, CodexAppServerError> {
        self.ensure_stream_usable()?;
        let id = JsonRpcId::Number(self.next_request_id);
        self.next_request_id = self.next_request_id.checked_add(1).ok_or_else(|| {
            CodexAppServerError::Protocol("app-server request id counter overflow".to_string())
        })?;
        self.in_flight_request_id = Some(id.clone());
        if let Err(error) = self
            .write_message(&outgoing_request(&id, method, params))
            .await
        {
            self.in_flight_request_id = None;
            return Err(error);
        }

        loop {
            let message = match self.read_next_message(method).await {
                Ok(message) => message,
                Err(error) => {
                    self.in_flight_request_id = None;
                    return Err(error);
                }
            };
            match message {
                IncomingMessage::Success {
                    id: response_id,
                    result,
                } if response_id == id => {
                    self.in_flight_request_id = None;
                    return Ok(result);
                }
                IncomingMessage::Error {
                    id: response_id,
                    error,
                } if response_id == id => {
                    self.in_flight_request_id = None;
                    return Err(CodexAppServerError::Rpc {
                        method: method.to_string(),
                        id: response_id,
                        error: Box::new(error),
                    });
                }
                IncomingMessage::Success { .. } | IncomingMessage::Error { .. } => {
                    self.in_flight_request_id = None;
                    return Err(self.poison_stream(format!(
                        "received response for unknown id while waiting for {method}"
                    )));
                }
                IncomingMessage::Notification {
                    notification,
                    line_bytes,
                } => {
                    if let Err(error) = self.push_notification(notification, line_bytes) {
                        self.in_flight_request_id = None;
                        return Err(self.poison_error(error));
                    }
                }
                IncomingMessage::Request(request) => {
                    if let Err(error) = self.reject_server_request(&request).await {
                        self.in_flight_request_id = None;
                        return Err(error);
                    }
                }
            }
        }
    }

    pub async fn notify(&mut self, method: &str, params: Value) -> Result<(), CodexAppServerError> {
        self.ensure_stream_usable()?;
        self.write_message(&outgoing_notification(method, params))
            .await
    }

    pub async fn shutdown(&mut self) -> Result<(), CodexAppServerError> {
        if self.closed {
            return Ok(());
        }

        self.stdin.take();
        if self.wait_rx.is_some() && !self.wait_for_child(SHUTDOWN_SIGTERM_GRACE).await? {
            self.signal_process_group(libc::SIGTERM);
            if !self.wait_for_child(SHUTDOWN_SIGKILL_GRACE).await? {
                self.signal_process_group(libc::SIGKILL);
                if !self.wait_for_child(SHUTDOWN_SIGKILL_GRACE).await? {
                    return Err(CodexAppServerError::ShutdownTimeout);
                }
            }
        }

        self.closed = true;
        self.drain_stderr().await;
        Ok(())
    }

    async fn wait_for_child(&mut self, timeout: Duration) -> Result<bool, CodexAppServerError> {
        let Some(wait_rx) = self.wait_rx.as_mut() else {
            return Ok(true);
        };

        match tokio::time::timeout(timeout, wait_rx).await {
            Ok(result) => {
                self.finish_child_wait(result)?;
                Ok(true)
            }
            Err(_) => Ok(false),
        }
    }

    fn finish_child_wait(
        &mut self,
        result: Result<std::io::Result<ExitStatus>, oneshot::error::RecvError>,
    ) -> Result<ExitStatus, CodexAppServerError> {
        self.wait_rx = None;
        match result {
            Ok(Ok(status)) => {
                self.clear_child_process_handles();
                Ok(status)
            }
            Ok(Err(error)) => {
                self.kill_and_clear_child_process_handles();
                Err(CodexAppServerError::Io(error))
            }
            Err(_) => {
                self.kill_and_clear_child_process_handles();
                Err(CodexAppServerError::Protocol(
                    "app-server wait task ended without status".to_string(),
                ))
            }
        }
    }

    fn try_finish_child_wait(&mut self) -> Result<Option<ExitStatus>, CodexAppServerError> {
        let Some(wait_rx) = self.wait_rx.as_mut() else {
            return Ok(None);
        };

        match wait_rx.try_recv() {
            Ok(Ok(status)) => {
                self.wait_rx = None;
                self.clear_child_process_handles();
                Ok(Some(status))
            }
            Ok(Err(error)) => {
                self.wait_rx = None;
                self.kill_and_clear_child_process_handles();
                Err(CodexAppServerError::Io(error))
            }
            Err(oneshot::error::TryRecvError::Empty) => Ok(None),
            Err(oneshot::error::TryRecvError::Closed) => {
                self.wait_rx = None;
                self.kill_and_clear_child_process_handles();
                Err(CodexAppServerError::Protocol(
                    "app-server wait task ended without status".to_string(),
                ))
            }
        }
    }

    async fn read_next_message(
        &mut self,
        pending_method: &str,
    ) -> Result<IncomingMessage, CodexAppServerError> {
        loop {
            tokio::select! {
                biased;
                line = read_stdout_line(&mut self.stdout_reader) => {
                    let line = match line {
                        Ok(Some(line)) => line,
                        Ok(None) => {
                            match self.try_finish_child_wait() {
                                Ok(Some(status)) => {
                                    let error = CodexAppServerError::ChildExited {
                                        method: pending_method.to_string(),
                                        status: status.to_string(),
                                    };
                                    return Err(self.poison_error(error));
                                }
                                Ok(None) => {
                                    return Err(self.poison_error(CodexAppServerError::Disconnected {
                                        method: pending_method.to_string(),
                                    }));
                                }
                                Err(error) => {
                                    return Err(self.poison_error(error));
                                }
                            }
                        }
                        Err(error) => {
                            return Err(self.poison_error(error));
                        }
                    };
                    if line.trim().is_empty() {
                        continue;
                    }
                    return parse_incoming_message(&line).map_err(|error| self.poison_error(error));
                }
                result = async {
                    match self.wait_rx.as_mut() {
                        Some(wait_rx) => Some(wait_rx.await),
                        None => None,
                    }
                }, if self.wait_rx.is_some() => {
                    let Some(result) = result else {
                        return Err(self.poison_stream("app-server wait receiver disappeared"));
                    };
                    let status = match self.finish_child_wait(result) {
                        Ok(status) => status,
                        Err(error) => return Err(self.poison_error(error)),
                    };
                    let error = CodexAppServerError::ChildExited {
                        method: pending_method.to_string(),
                        status: status.to_string(),
                    };
                    return Err(self.poison_error(error));
                }
            }
        }
    }

    async fn reject_server_request(
        &mut self,
        request: &ServerRequest,
    ) -> Result<(), CodexAppServerError> {
        let method = bounded_method_name(&request.method);
        self.write_message(&json!({
            "id": request.id.clone(),
            "error": {
                "code": METHOD_NOT_FOUND,
                "message": format!("unsupported server request method {method}")
            }
        }))
        .await
    }

    fn push_notification(
        &mut self,
        notification: ServerNotification,
        line_bytes: usize,
    ) -> Result<(), CodexAppServerError> {
        if self.notifications.len() == NOTIFICATION_QUEUE_CAPACITY {
            return Err(CodexAppServerError::Protocol(format!(
                "server notification queue exceeded {NOTIFICATION_QUEUE_CAPACITY} entries"
            )));
        }
        let next_bytes = self
            .notification_queue_bytes
            .checked_add(line_bytes)
            .ok_or_else(|| {
                CodexAppServerError::Protocol(
                    "server notification queue byte count overflowed".to_string(),
                )
            })?;
        if next_bytes > NOTIFICATION_QUEUE_MAX_BYTES {
            return Err(CodexAppServerError::Protocol(format!(
                "server notification queue exceeded {NOTIFICATION_QUEUE_MAX_BYTES} bytes"
            )));
        }
        self.notification_queue_bytes = next_bytes;
        self.notifications.push_back(QueuedNotification {
            notification,
            bytes: line_bytes,
        });
        Ok(())
    }

    async fn write_message(&mut self, message: &Value) -> Result<(), CodexAppServerError> {
        if let Some(message) = self.stream_unusable_reason.clone() {
            self.signal_process_group(libc::SIGKILL);
            return Err(CodexAppServerError::Protocol(message));
        }
        if self.outbound_write_in_progress {
            return Err(self.poison_stream("previous app-server write did not complete"));
        }
        if self.stdin.is_none() {
            return Err(CodexAppServerError::Protocol(
                "app-server stdin is closed".to_string(),
            ));
        }
        let mut bytes = serde_json::to_vec(message)?;
        bytes.push(b'\n');
        self.outbound_write_in_progress = true;
        let result = async {
            let stdin = self.stdin.as_mut().ok_or_else(|| {
                CodexAppServerError::Protocol("app-server stdin is closed".to_string())
            })?;
            stdin.write_all(&bytes).await?;
            stdin.flush().await?;
            Ok(())
        }
        .await;
        self.outbound_write_in_progress = false;
        result.map_err(|error| self.poison_error(error))
    }

    fn ensure_stream_usable(&mut self) -> Result<(), CodexAppServerError> {
        if let Some(message) = self.stream_unusable_reason.clone() {
            self.signal_process_group(libc::SIGKILL);
            return Err(CodexAppServerError::Protocol(message));
        }
        if self.outbound_write_in_progress {
            return Err(self.poison_stream("previous app-server write did not complete"));
        }
        if self.in_flight_request_id.is_some() {
            return Err(self.poison_stream("previous app-server request did not complete"));
        }
        Ok(())
    }

    fn poison_error(&mut self, error: CodexAppServerError) -> CodexAppServerError {
        let message = match &error {
            CodexAppServerError::Protocol(message) => message.clone(),
            _ => error.to_string(),
        };
        self.mark_stream_unusable(message);
        self.signal_process_group(libc::SIGKILL);
        error
    }

    fn poison_stream(&mut self, message: impl Into<String>) -> CodexAppServerError {
        let message = message.into();
        self.mark_stream_unusable(message.clone());
        self.signal_process_group(libc::SIGKILL);
        CodexAppServerError::Protocol(message)
    }

    fn mark_stream_unusable(&mut self, message: String) {
        if self.stream_unusable_reason.is_none() {
            self.stream_unusable_reason = Some(message);
        }
    }

    async fn drain_stderr(&mut self) {
        let Some(stderr_handle) = self.stderr_handle.take() else {
            return;
        };
        let mut stderr_handle = stderr_handle;

        match tokio::time::timeout(STDERR_DRAIN_GRACE, &mut stderr_handle).await {
            Ok(Ok(lines)) => {
                self.stderr_tail = lines;
            }
            Ok(Err(_join_error)) => {}
            Err(_elapsed) => {
                stderr_handle.abort();
            }
        }
    }

    fn signal_process_group(&mut self, signal: libc::c_int) {
        if let Some(pgid) = self.process_group_id {
            unsafe {
                libc::kill(-pgid, signal);
            }
        } else if let Some(pid) = self.process_id {
            unsafe {
                libc::kill(pid as libc::pid_t, signal);
            }
        }
    }

    fn clear_child_process_handles(&mut self) {
        self.process_id = None;
        self.process_group_id = None;
    }

    fn kill_and_clear_child_process_handles(&mut self) {
        self.signal_process_group(libc::SIGKILL);
        self.clear_child_process_handles();
    }
}

impl Drop for CodexAppServerClient {
    fn drop(&mut self) {
        if !self.closed {
            self.stdin.take();
            let _ = self.try_finish_child_wait();
            self.signal_process_group(libc::SIGKILL);
        }
        if let Some(stderr_handle) = self.stderr_handle.take() {
            stderr_handle.abort();
        }
    }
}

struct QueuedNotification {
    notification: ServerNotification,
    bytes: usize,
}

enum IncomingMessage {
    Success {
        id: JsonRpcId,
        result: Value,
    },
    Error {
        id: JsonRpcId,
        error: JsonRpcError,
    },
    Notification {
        notification: ServerNotification,
        line_bytes: usize,
    },
    Request(ServerRequest),
}

fn outgoing_request(id: &JsonRpcId, method: &str, params: Value) -> Value {
    json!({
        "id": id,
        "method": method,
        "params": params,
    })
}

fn outgoing_notification(method: &str, params: Value) -> Value {
    if params.is_null() {
        json!({ "method": method })
    } else {
        json!({
            "method": method,
            "params": params,
        })
    }
}

async fn read_stdout_line(
    stdout_reader: &mut BufReader<ChildStdout>,
) -> Result<Option<String>, CodexAppServerError> {
    let mut line = Vec::new();

    loop {
        let (consumed, reached_line_end) = {
            let available = stdout_reader.fill_buf().await?;
            if available.is_empty() {
                if line.is_empty() {
                    return Ok(None);
                }
                break;
            }

            if let Some(newline_index) = available.iter().position(|byte| *byte == b'\n') {
                if line.len() + newline_index > STDOUT_MAX_LINE_BYTES {
                    return Err(stdout_line_too_large_error());
                }
                let line_chunk = available.get(..newline_index).ok_or_else(|| {
                    CodexAppServerError::Protocol(
                        "app-server stdout reader returned an invalid newline offset".to_string(),
                    )
                })?;
                line.extend_from_slice(line_chunk);
                (newline_index + 1, true)
            } else {
                if line.len() + available.len() > STDOUT_MAX_LINE_BYTES {
                    return Err(stdout_line_too_large_error());
                }
                line.extend_from_slice(available);
                (available.len(), false)
            }
        };

        stdout_reader.consume(consumed);
        if reached_line_end {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            break;
        }
    }

    String::from_utf8(line).map(Some).map_err(|error| {
        CodexAppServerError::Protocol(format!(
            "app-server stdout line is not UTF-8: {}; line_bytes={}",
            error.utf8_error(),
            error.as_bytes().len()
        ))
    })
}

fn stdout_line_too_large_error() -> CodexAppServerError {
    CodexAppServerError::Protocol(format!(
        "app-server stdout line exceeded {STDOUT_MAX_LINE_BYTES} bytes"
    ))
}

fn parse_incoming_message(line: &str) -> Result<IncomingMessage, CodexAppServerError> {
    let value: Value = serde_json::from_str(line).map_err(|error| {
        CodexAppServerError::Protocol(format!(
            "malformed app-server stdout JSON: {error}; line_bytes={}",
            line.len()
        ))
    })?;

    if let Some(method_value) = value.get("method") {
        if value.get("result").is_some() || value.get("error").is_some() {
            return Err(CodexAppServerError::Protocol(
                "request or notification contains response fields".to_string(),
            ));
        }
        let method = method_value
            .as_str()
            .ok_or_else(|| CodexAppServerError::Protocol("method must be a string".to_string()))?
            .to_string();
        let params = value.get("params").cloned();
        if let Some(id_value) = value.get("id") {
            return Ok(IncomingMessage::Request(ServerRequest {
                id: parse_id(id_value)?,
                method,
                params,
            }));
        }
        return Ok(IncomingMessage::Notification {
            notification: ServerNotification { method, params },
            line_bytes: line.len(),
        });
    }

    let Some(id_value) = value.get("id") else {
        return Err(CodexAppServerError::Protocol(
            "message has neither id nor method".to_string(),
        ));
    };
    let id = parse_id(id_value)?;

    match (value.get("result"), value.get("error")) {
        (Some(result), None) => Ok(IncomingMessage::Success {
            id,
            result: result.clone(),
        }),
        (None, Some(error)) => Ok(IncomingMessage::Error {
            id,
            error: parse_error_object(error)?,
        }),
        (Some(_), Some(_)) => Err(CodexAppServerError::Protocol(
            "response contains both result and error".to_string(),
        )),
        (None, None) => Err(CodexAppServerError::Protocol(
            "response contains neither result nor error".to_string(),
        )),
    }
}

fn parse_id(value: &Value) -> Result<JsonRpcId, CodexAppServerError> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .map(JsonRpcId::Number)
            .ok_or_else(invalid_id_error),
        Value::String(value) => Ok(JsonRpcId::String(value.clone())),
        Value::Null => Ok(JsonRpcId::Null),
        _ => Err(invalid_id_error()),
    }
}

fn invalid_id_error() -> CodexAppServerError {
    CodexAppServerError::Protocol(
        "app-server message id must be an integer, string, or null".to_string(),
    )
}

fn parse_error_object(value: &Value) -> Result<JsonRpcError, CodexAppServerError> {
    let Value::Object(fields) = value else {
        return Err(CodexAppServerError::Protocol(
            "error response must be an object".to_string(),
        ));
    };
    let code = fields.get("code").and_then(Value::as_i64).ok_or_else(|| {
        CodexAppServerError::Protocol("error response must contain an integer code".to_string())
    })?;
    let message = fields
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CodexAppServerError::Protocol(
                "error response must contain a string message".to_string(),
            )
        })?
        .to_string();
    Ok(JsonRpcError {
        code,
        message,
        data: fields.get("data").cloned(),
    })
}

fn bounded_method_name(method: &str) -> String {
    const MAX_CHARS: usize = 120;
    let mut chars = method.chars();
    let bounded = chars.by_ref().take(MAX_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{bounded}...")
    } else {
        bounded
    }
}

fn bounded_error_message(message: &str) -> String {
    const MAX_CHARS: usize = 240;
    let mut chars = message.chars();
    let bounded = chars.by_ref().take(MAX_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{bounded}...")
    } else {
        bounded
    }
}
