use crate::session;
use chrono::Utc;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};
use std::process::Command;
use std::thread;
use uuid::Uuid;

const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const LARGE_NOTIFICATION_MESSAGE_BYTES: usize = 17 * 1024 * 1024;
const NOTIFICATION_OVERFLOW_COUNT: usize = 129;
const OVERSIZED_STDOUT_BYTES: usize = 65 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scenario {
    Success,
    DisconnectAfterInitialize,
    ExitOnTurnStart,
    HangOnTurnStart,
    InterleavedNotification,
    InvalidResponseId,
    MalformedErrorResponse,
    MalformedInitializeResult,
    LargeNotificationBeforeResponse,
    HangAfterInitializeResponse,
    HangOnThreadStart,
    MalformedStdout,
    HangOnStdinEof,
    SigtermDeafOnStdinEof,
    NullIdServerRequestBeforeResponse,
    NotificationOverflow,
    OversizedStdout,
    ServerRequestBeforeResponse,
    StderrHolderOnStdinEof,
    UnknownResponseBeforeResponse,
    StaleTurn,
    NoActiveTurn,
    RuntimeTurnComplete,
    RuntimeTurnCompleteWithoutThreadStarted,
    ResumeDifferentThreadId,
    ResumeRpcErrorWithThreadId,
    ThreadStartInvalidThreadId,
    UnexpectedThreadTurnCompleted,
}

impl Scenario {
    fn from_env() -> io::Result<Self> {
        match std::env::var("MOCK_CODEX_APP_SERVER_SCENARIO") {
            Ok(value) if value.is_empty() => Ok(Self::Success),
            Ok(value) => match value.as_str() {
                "disconnect-after-initialize" => Ok(Self::DisconnectAfterInitialize),
                "exit-on-turn-start" => Ok(Self::ExitOnTurnStart),
                "hang-on-turn-start" => Ok(Self::HangOnTurnStart),
                "interleaved-notification" => Ok(Self::InterleavedNotification),
                "invalid-response-id" => Ok(Self::InvalidResponseId),
                "malformed-error-response" => Ok(Self::MalformedErrorResponse),
                "malformed-initialize-result" => Ok(Self::MalformedInitializeResult),
                "large-notification-before-response" => Ok(Self::LargeNotificationBeforeResponse),
                "hang-after-initialize-response" => Ok(Self::HangAfterInitializeResponse),
                "hang-on-thread-start" => Ok(Self::HangOnThreadStart),
                "malformed-stdout" => Ok(Self::MalformedStdout),
                "hang-on-stdin-eof" => Ok(Self::HangOnStdinEof),
                "sigterm-deaf-on-stdin-eof" => Ok(Self::SigtermDeafOnStdinEof),
                "null-id-server-request-before-response" => {
                    Ok(Self::NullIdServerRequestBeforeResponse)
                }
                "notification-overflow" => Ok(Self::NotificationOverflow),
                "oversized-stdout" => Ok(Self::OversizedStdout),
                "server-request-before-response" => Ok(Self::ServerRequestBeforeResponse),
                "stderr-holder-on-stdin-eof" => Ok(Self::StderrHolderOnStdinEof),
                "unknown-response-before-response" => Ok(Self::UnknownResponseBeforeResponse),
                "stale-turn" => Ok(Self::StaleTurn),
                "no-active-turn" => Ok(Self::NoActiveTurn),
                "runtime-turn-complete" => Ok(Self::RuntimeTurnComplete),
                "runtime-turn-complete-without-thread-started" => {
                    Ok(Self::RuntimeTurnCompleteWithoutThreadStarted)
                }
                "resume-different-thread-id" => Ok(Self::ResumeDifferentThreadId),
                "resume-rpc-error-with-thread-id" => Ok(Self::ResumeRpcErrorWithThreadId),
                "thread-start-invalid-thread-id" => Ok(Self::ThreadStartInvalidThreadId),
                "unexpected-thread-turn-completed" => Ok(Self::UnexpectedThreadTurnCompleted),
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("unsupported MOCK_CODEX_APP_SERVER_SCENARIO={value:?}"),
                )),
            },
            Err(_) => Ok(Self::Success),
        }
    }
}

pub fn run_app_server(listen: &str) -> io::Result<()> {
    if listen != "stdio://" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "guest-mock-codex app-server only supports stdio transport, got {:?}",
                listen
            ),
        ));
    }

    let scenario = Scenario::from_env()?;
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut state = AppServerState::new(scenario);
    state.run(stdin.lock(), stdout.lock())
}

#[derive(Debug)]
struct AppServerState {
    initialized: bool,
    current_thread: Option<AppServerThread>,
    session_artifact_thread_ids: BTreeMap<String, String>,
    initial_inputs: Vec<String>,
    steered_inputs: Vec<String>,
    initialized_notification_received: bool,
    opt_out_notification_methods: Vec<String>,
    pending_response: Option<PendingResponse>,
    server_request_responses: Vec<Value>,
    scenario: Scenario,
}

#[derive(Debug)]
struct PendingResponse {
    id: Value,
    result: Value,
}

#[derive(Debug)]
struct AppServerThread {
    protocol_thread_id: String,
    artifact_thread_id: String,
    active_turn_id: Option<String>,
    thread_request_has_runtime_workspace_roots: bool,
}

impl AppServerState {
    fn new(scenario: Scenario) -> Self {
        Self {
            initialized: false,
            current_thread: None,
            session_artifact_thread_ids: BTreeMap::new(),
            initial_inputs: Vec::new(),
            steered_inputs: Vec::new(),
            initialized_notification_received: false,
            opt_out_notification_methods: Vec::new(),
            pending_response: None,
            server_request_responses: Vec::new(),
            scenario,
        }
    }

    fn run<R: BufRead, W: Write>(&mut self, input: R, mut output: W) -> io::Result<()> {
        for line_result in input.lines() {
            let line = line_result?;
            if line.trim().is_empty() {
                continue;
            }

            let message: Value = serde_json::from_str(&line)
                .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
            if self.handle_message(message, &mut output)? == ServerAction::Stop {
                return Ok(());
            }
        }
        match self.scenario {
            Scenario::HangOnStdinEof => loop {
                thread::park();
            },
            Scenario::SigtermDeafOnStdinEof => {
                ignore_sigterm();
                loop {
                    thread::park();
                }
            }
            Scenario::StderrHolderOnStdinEof => {
                spawn_stderr_holder()?;
            }
            _ => {}
        }
        Ok(())
    }

    fn handle_message<W: Write>(
        &mut self,
        message: Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            let params = message.get("params").unwrap_or(&Value::Null);
            if let Some(id) = message.get("id").cloned() {
                self.handle_request(id, method, params, output)
            } else {
                self.handle_notification(method);
                Ok(ServerAction::Continue)
            }
        } else {
            self.handle_client_response(message, output)
        }
    }

    fn handle_request<W: Write>(
        &mut self,
        id: Value,
        method: &str,
        params: &Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        match method {
            "initialize" => {
                if self.initialized {
                    write_error(output, id, INVALID_REQUEST, "Already initialized")?;
                    return Ok(ServerAction::Continue);
                }
                if let Err(message) = validate_initialize_params(params) {
                    write_error(output, id, INVALID_REQUEST, message)?;
                    return Ok(ServerAction::Continue);
                }
                self.opt_out_notification_methods = initialize_opt_out_notification_methods(params);
                if self.scenario == Scenario::MalformedStdout {
                    writeln!(output, "{{not-valid-json")?;
                    output.flush()?;
                    return Ok(ServerAction::Stop);
                }
                if self.scenario == Scenario::OversizedStdout {
                    writeln!(output, "{}", "x".repeat(OVERSIZED_STDOUT_BYTES))?;
                    output.flush()?;
                    return Ok(ServerAction::Stop);
                }
                if self.scenario == Scenario::MalformedInitializeResult {
                    write_json_line(
                        output,
                        &json!({
                            "id": id,
                            "result": "do-not-log-malformed-initialize-result"
                        }),
                    )?;
                    return Ok(ServerAction::Continue);
                }
                self.initialized = true;
                write_success(output, id, initialize_response())?;
                if self.scenario == Scenario::HangAfterInitializeResponse {
                    loop {
                        thread::park();
                    }
                }
                if self.scenario == Scenario::DisconnectAfterInitialize {
                    return Ok(ServerAction::Stop);
                }
                Ok(ServerAction::Continue)
            }
            "thread/start" => {
                if !self.initialized {
                    write_error(output, id, INVALID_REQUEST, "app server is not initialized")?;
                    return Ok(ServerAction::Continue);
                }
                if self.scenario == Scenario::HangOnThreadStart {
                    loop {
                        thread::park();
                    }
                }
                let thread_id = Uuid::now_v7().to_string();
                self.set_current_thread(
                    thread_id.clone(),
                    params.get("runtimeWorkspaceRoots").is_some(),
                );
                let response_thread_id = if self.scenario == Scenario::ThreadStartInvalidThreadId {
                    "not-a-valid-codex-thread-id"
                } else {
                    &thread_id
                };
                let result = thread_response(response_thread_id, false);
                match self.scenario {
                    Scenario::InvalidResponseId => {
                        write_success(
                            output,
                            json!({ "secret": "do-not-log-invalid-response-id" }),
                            result,
                        )?;
                    }
                    Scenario::MalformedErrorResponse => {
                        write_json_line(
                            output,
                            &json!({
                                "id": id,
                                "error": "do-not-log-malformed-error-payload"
                            }),
                        )?;
                    }
                    Scenario::InterleavedNotification => {
                        write_json_line(output, &server_notification())?;
                        write_success(output, id, result)?;
                    }
                    Scenario::LargeNotificationBeforeResponse => {
                        write_json_line(output, &large_server_notification())?;
                        write_success(output, id, result)?;
                    }
                    Scenario::ServerRequestBeforeResponse
                    | Scenario::NullIdServerRequestBeforeResponse => {
                        let request_id =
                            if self.scenario == Scenario::NullIdServerRequestBeforeResponse {
                                Value::Null
                            } else {
                                json!("guest-mock-codex-server-request-1")
                            };
                        write_json_line(output, &server_request(request_id))?;
                        self.pending_response = Some(PendingResponse { id, result });
                    }
                    Scenario::NotificationOverflow => {
                        for index in 0..NOTIFICATION_OVERFLOW_COUNT {
                            write_json_line(output, &server_notification_with_index(index))?;
                        }
                        write_success(output, id, result)?;
                    }
                    Scenario::UnknownResponseBeforeResponse => {
                        write_success(
                            output,
                            json!("do-not-log-unknown-response-id"),
                            json!({ "ignored": true }),
                        )?;
                        write_success(output, id, result)?;
                    }
                    Scenario::RuntimeTurnComplete => {
                        write_json_line(output, &thread_started_notification(&thread_id))?;
                        write_success(output, id, result)?;
                    }
                    _ => {
                        write_success(output, id, result)?;
                    }
                }
                Ok(ServerAction::Continue)
            }
            "thread/resume" => {
                if !self.initialized {
                    write_error(output, id, INVALID_REQUEST, "app server is not initialized")?;
                    return Ok(ServerAction::Continue);
                }
                let Some(thread_id) = non_empty_string_param(params, "threadId") else {
                    write_error(output, id, INVALID_REQUEST, "missing threadId")?;
                    return Ok(ServerAction::Continue);
                };
                if self.scenario == Scenario::ResumeRpcErrorWithThreadId {
                    write_error(
                        output,
                        id,
                        INVALID_REQUEST,
                        &format!("resume failed for {thread_id}"),
                    )?;
                    return Ok(ServerAction::Continue);
                }
                self.set_current_thread(
                    thread_id.to_string(),
                    params.get("runtimeWorkspaceRoots").is_some(),
                );
                let response_thread_id = if self.scenario == Scenario::ResumeDifferentThreadId {
                    "0193abcd-ef01-7234-89ab-cdef01234568"
                } else {
                    thread_id
                };
                write_success(output, id, thread_response(response_thread_id, true))?;
                Ok(ServerAction::Continue)
            }
            "turn/start" => {
                if !self.initialized {
                    write_error(output, id, INVALID_REQUEST, "app server is not initialized")?;
                    return Ok(ServerAction::Continue);
                }
                if self.scenario == Scenario::ExitOnTurnStart {
                    return Ok(ServerAction::Stop);
                }
                if self.scenario == Scenario::HangOnTurnStart {
                    loop {
                        thread::park();
                    }
                }

                let Some(thread_id) = non_empty_string_param(params, "threadId") else {
                    write_error(output, id, INVALID_REQUEST, "missing threadId")?;
                    return Ok(ServerAction::Continue);
                };
                let current_thread = match self.current_thread(thread_id) {
                    Ok(current_thread) => current_thread,
                    Err(message) => {
                        write_error(output, id, INVALID_REQUEST, message)?;
                        return Ok(ServerAction::Continue);
                    }
                };
                let thread_id = current_thread.protocol_thread_id.clone();
                let artifact_thread_id = current_thread.artifact_thread_id.clone();
                let thread_request_has_runtime_workspace_roots =
                    current_thread.thread_request_has_runtime_workspace_roots;
                let inputs = match text_inputs(params) {
                    Ok(inputs) => inputs,
                    Err(message) => {
                        write_error(output, id, INVALID_REQUEST, &message)?;
                        return Ok(ServerAction::Continue);
                    }
                };

                let turn_id = Uuid::now_v7().to_string();
                if self.scenario != Scenario::NoActiveTurn
                    && let Some(current_thread) = &mut self.current_thread
                {
                    current_thread.active_turn_id = Some(turn_id.clone());
                }
                self.initial_inputs.extend(inputs.iter().cloned());
                persist_input_events(
                    &artifact_thread_id,
                    &thread_id,
                    &turn_id,
                    "initial",
                    &inputs,
                    thread_request_has_runtime_workspace_roots,
                    params,
                )?;
                write_success(output, id, json!({ "turn": turn(&turn_id) }))?;
                if self.scenario == Scenario::UnexpectedThreadTurnCompleted {
                    write_json_line(
                        output,
                        &turn_completed_notification("unexpected-thread-id", &turn_id),
                    )?;
                    return Ok(ServerAction::Stop);
                }
                if matches!(
                    self.scenario,
                    Scenario::RuntimeTurnComplete
                        | Scenario::RuntimeTurnCompleteWithoutThreadStarted
                ) {
                    write_turn_notifications(output, &thread_id, &turn_id)?;
                }
                Ok(ServerAction::Continue)
            }
            "turn/steer" => {
                if !self.initialized {
                    write_error(output, id, INVALID_REQUEST, "app server is not initialized")?;
                    return Ok(ServerAction::Continue);
                }
                let Some(expected_turn_id) = string_param(params, "expectedTurnId") else {
                    write_error(output, id, INVALID_REQUEST, "missing expectedTurnId")?;
                    return Ok(ServerAction::Continue);
                };
                if expected_turn_id.is_empty() {
                    write_error(
                        output,
                        id,
                        INVALID_REQUEST,
                        "expectedTurnId must not be empty",
                    )?;
                    return Ok(ServerAction::Continue);
                }
                let Some(thread_id) = non_empty_string_param(params, "threadId") else {
                    write_error(output, id, INVALID_REQUEST, "missing threadId")?;
                    return Ok(ServerAction::Continue);
                };
                let current_thread = match self.current_thread(thread_id) {
                    Ok(current_thread) => current_thread,
                    Err(message) => {
                        write_error(output, id, INVALID_REQUEST, message)?;
                        return Ok(ServerAction::Continue);
                    }
                };
                let Some(active_turn_id) = current_thread.active_turn_id.clone() else {
                    write_error(output, id, INVALID_REQUEST, "no active turn")?;
                    return Ok(ServerAction::Continue);
                };
                if self.scenario == Scenario::StaleTurn || expected_turn_id != active_turn_id {
                    write_error(output, id, INVALID_REQUEST, "stale expectedTurnId")?;
                    return Ok(ServerAction::Continue);
                }

                let thread_id = current_thread.protocol_thread_id.clone();
                let artifact_thread_id = current_thread.artifact_thread_id.clone();
                let thread_request_has_runtime_workspace_roots =
                    current_thread.thread_request_has_runtime_workspace_roots;
                let inputs = match text_inputs(params) {
                    Ok(inputs) => inputs,
                    Err(message) => {
                        write_error(output, id, INVALID_REQUEST, &message)?;
                        return Ok(ServerAction::Continue);
                    }
                };
                self.steered_inputs.extend(inputs.iter().cloned());
                persist_input_events(
                    &artifact_thread_id,
                    &thread_id,
                    &active_turn_id,
                    "steered",
                    &inputs,
                    thread_request_has_runtime_workspace_roots,
                    params,
                )?;
                write_success(output, id, json!({ "turnId": active_turn_id }))?;
                Ok(ServerAction::Continue)
            }
            "mock/inputs" => {
                write_success(
                    output,
                    id,
                    json!({
                        "initial": &self.initial_inputs,
                        "steered": &self.steered_inputs,
                    }),
                )?;
                Ok(ServerAction::Continue)
            }
            "mock/state" => {
                write_success(
                    output,
                    id,
                    json!({
                        "initializedNotificationReceived": self.initialized_notification_received,
                        "optOutNotificationMethods": &self.opt_out_notification_methods,
                        "serverRequestResponses": &self.server_request_responses,
                        "hasPendingResponse": self.pending_response.is_some(),
                    }),
                )?;
                Ok(ServerAction::Continue)
            }
            _ => {
                write_error(output, id, METHOD_NOT_FOUND, "unsupported method")?;
                Ok(ServerAction::Continue)
            }
        }
    }

    fn handle_client_response<W: Write>(
        &mut self,
        message: Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        if message.get("id").is_none()
            || (message.get("result").is_none() && message.get("error").is_none())
        {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "missing method"));
        }

        if !matches!(
            self.scenario,
            Scenario::ServerRequestBeforeResponse | Scenario::NullIdServerRequestBeforeResponse
        ) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unexpected client response",
            ));
        }

        let Some(pending) = self.pending_response.take() else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unexpected client response",
            ));
        };
        self.server_request_responses.push(message);
        write_success(output, pending.id, pending.result)?;

        Ok(ServerAction::Continue)
    }

    fn handle_notification(&mut self, method: &str) {
        // The client sends `initialized` after the `initialize` request. It
        // must not substitute for the request itself because later requests
        // need initialize response state to exist.
        if method == "initialized" {
            self.initialized_notification_received = true;
        }
    }

    fn set_current_thread(
        &mut self,
        thread_id: String,
        thread_request_has_runtime_workspace_roots: bool,
    ) {
        let artifact_thread_id = self
            .session_artifact_thread_ids
            .entry(thread_id.clone())
            .or_insert_with(|| session_artifact_thread_id(&thread_id))
            .clone();
        self.current_thread = Some(AppServerThread {
            protocol_thread_id: thread_id,
            artifact_thread_id,
            active_turn_id: None,
            thread_request_has_runtime_workspace_roots,
        });
    }

    fn current_thread(&self, requested_thread_id: &str) -> Result<&AppServerThread, &str> {
        let Some(current_thread) = &self.current_thread else {
            return Err("no active thread");
        };
        if requested_thread_id != current_thread.protocol_thread_id {
            return Err("unknown threadId");
        }
        Ok(current_thread)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ServerAction {
    Continue,
    Stop,
}

fn initialize_response() -> Value {
    json!({
        "userAgent": format!("guest-mock-codex-app-server/{}", env!("CARGO_PKG_VERSION")),
        "codexHome": session::codex_home(),
        "platformFamily": std::env::consts::FAMILY,
        "platformOs": std::env::consts::OS,
    })
}

fn validate_initialize_params(params: &Value) -> Result<(), &'static str> {
    let Some(client_info) = params.get("clientInfo") else {
        return Err("missing clientInfo");
    };
    let Some(name) = client_info.get("name").and_then(Value::as_str) else {
        return Err("missing clientInfo.name");
    };
    if name.contains(['\r', '\n']) {
        return Err("invalid clientInfo.name");
    }
    if client_info.get("version").and_then(Value::as_str).is_none() {
        return Err("missing clientInfo.version");
    }
    let Some(capabilities) = params.get("capabilities") else {
        return Err("missing capabilities");
    };
    if capabilities.get("experimentalApi").and_then(Value::as_bool) != Some(true) {
        return Err("missing capabilities.experimentalApi");
    }
    Ok(())
}

fn initialize_opt_out_notification_methods(params: &Value) -> Vec<String> {
    params
        .get("capabilities")
        .and_then(|capabilities| capabilities.get("optOutNotificationMethods"))
        .and_then(Value::as_array)
        .map(|methods| {
            methods
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn thread_response(thread_id: &str, resume: bool) -> Value {
    let mut response = json!({
        "thread": thread(thread_id),
        "model": "gpt-5",
        "modelProvider": "openai",
        "serviceTier": null,
        "cwd": "/tmp",
        "runtimeWorkspaceRoots": [],
        "instructionSources": [],
        "approvalPolicy": "on-failure",
        "approvalsReviewer": "user",
        "sandbox": {
            "type": "dangerFullAccess"
        },
        "activePermissionProfile": null,
        "reasoningEffort": null,
        "multiAgentMode": null
    });
    if resume && let Value::Object(fields) = &mut response {
        fields.insert("initialTurnsPage".to_string(), Value::Null);
    }
    response
}

fn server_notification() -> Value {
    server_notification_with_index(0)
}

fn server_notification_with_index(index: usize) -> Value {
    json!({
        "method": "experimental/server-notification",
        "params": {
            "message": "guest-mock-codex notification",
            "index": index
        }
    })
}

fn large_server_notification() -> Value {
    json!({
        "method": "experimental/server-notification",
        "params": {
            "message": "x".repeat(LARGE_NOTIFICATION_MESSAGE_BYTES),
        }
    })
}

fn thread_started_notification(thread_id: &str) -> Value {
    json!({
        "method": "thread/started",
        "params": {
            "thread": thread(thread_id)
        }
    })
}

fn turn_started_notification(thread_id: &str, turn_id: &str) -> Value {
    json!({
        "method": "turn/started",
        "params": {
            "threadId": thread_id,
            "turn": turn(turn_id)
        }
    })
}

fn assistant_item_completed_notification(thread_id: &str, turn_id: &str) -> Value {
    json!({
        "method": "item/completed",
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
            "completedAtMs": 2,
            "item": {
                "id": Uuid::now_v7().to_string(),
                "type": "agentMessage",
                "text": "guest-mock-codex app-server response"
            }
        }
    })
}

fn turn_completed_notification(thread_id: &str, turn_id: &str) -> Value {
    json!({
        "method": "turn/completed",
        "params": {
            "threadId": thread_id,
            "turn": completed_turn(turn_id),
            "usage": {
                "inputTokens": 7,
                "outputTokens": 11,
                "totalTokens": 18
            }
        }
    })
}

fn write_turn_notifications<W: Write>(
    output: &mut W,
    thread_id: &str,
    turn_id: &str,
) -> io::Result<()> {
    write_json_line(output, &turn_started_notification(thread_id, turn_id))?;
    write_json_line(
        output,
        &assistant_item_completed_notification(thread_id, turn_id),
    )?;
    write_json_line(output, &turn_completed_notification(thread_id, turn_id))
}

fn server_request(id: Value) -> Value {
    json!({
        "id": id,
        "method": "experimental/server-request",
        "params": {
            "message": "guest-mock-codex server request"
        }
    })
}

fn spawn_stderr_holder() -> io::Result<()> {
    let _child = Command::new("tail").args(["-f", "/dev/null"]).spawn()?;
    Ok(())
}

fn thread(thread_id: &str) -> Value {
    json!({
        "id": thread_id,
        "sessionId": thread_id,
        "forkedFromId": null,
        "parentThreadId": null,
        "preview": "guest-mock-codex app-server thread",
        "ephemeral": false,
        "modelProvider": "openai",
        "createdAt": 1,
        "updatedAt": 1,
        "recencyAt": 1,
        "status": {
            "type": "idle"
        },
        "path": null,
        "cwd": "/tmp",
        "cliVersion": "guest-mock-codex",
        "source": "appServer",
        "threadSource": null,
        "agentNickname": null,
        "agentRole": null,
        "gitInfo": null,
        "name": null,
        "turns": []
    })
}

fn turn(turn_id: &str) -> Value {
    json!({
        "id": turn_id,
        "items": [],
        "itemsView": "notLoaded",
        "status": "inProgress",
        "error": null,
        "startedAt": null,
        "completedAt": null,
        "durationMs": null
    })
}

fn completed_turn(turn_id: &str) -> Value {
    json!({
        "id": turn_id,
        "items": [],
        "itemsView": "notLoaded",
        "status": "completed",
        "error": null,
        "startedAt": 1,
        "completedAt": 3,
        "durationMs": 2
    })
}

fn string_param<'a>(params: &'a Value, name: &str) -> Option<&'a str> {
    params.get(name).and_then(Value::as_str)
}

fn non_empty_string_param<'a>(params: &'a Value, name: &str) -> Option<&'a str> {
    string_param(params, name).filter(|value| !value.is_empty())
}

fn text_inputs(params: &Value) -> Result<Vec<String>, String> {
    let Some(values) = params.get("input").and_then(Value::as_array) else {
        return Err("missing input".to_string());
    };
    if values.is_empty() {
        return Err("input must not be empty".to_string());
    }

    let mut inputs = Vec::with_capacity(values.len());
    for value in values {
        let input_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if input_type != "text" {
            return Err(format!("unsupported input type {input_type:?}"));
        }
        let Some(text) = value.get("text").and_then(Value::as_str) else {
            return Err("text input is missing text".to_string());
        };
        if text.is_empty() {
            return Err("text input must not be empty".to_string());
        }
        inputs.push(text.to_string());
    }
    Ok(inputs)
}

fn persist_input_events(
    artifact_thread_id: &str,
    thread_id: &str,
    turn_id: &str,
    kind: &str,
    inputs: &[String],
    thread_request_has_runtime_workspace_roots: bool,
    turn_params: &Value,
) -> io::Result<()> {
    let events = inputs
        .iter()
        .map(|text| {
            json!({
                "type": "mock.app_server.input",
                "kind": kind,
                "thread_id": thread_id,
                "turn_id": turn_id,
                "text": text,
                "thread_request_has_runtime_workspace_roots": thread_request_has_runtime_workspace_roots,
                "turn_request_has_runtime_workspace_roots": turn_params.get("runtimeWorkspaceRoots").is_some(),
                "turn_request_cwd": turn_params.get("cwd"),
                "turn_request_approval_policy": turn_params.get("approvalPolicy"),
                "turn_request_approvals_reviewer": turn_params.get("approvalsReviewer"),
                "turn_request_sandbox_policy": turn_params.get("sandboxPolicy"),
            })
        })
        .collect::<Vec<_>>();
    let home = session::codex_home();
    session::persist_resume_session(&home, Utc::now().date_naive(), artifact_thread_id, &events)
}

fn session_artifact_thread_id(thread_id: &str) -> String {
    match Uuid::parse_str(thread_id) {
        Ok(uuid) if uuid.to_string() == thread_id => thread_id.to_string(),
        _ => Uuid::now_v7().to_string(),
    }
}

fn write_success<W: Write>(output: &mut W, id: Value, result: Value) -> io::Result<()> {
    write_json_line(output, &json!({ "id": id, "result": result }))
}

fn write_error<W: Write>(output: &mut W, id: Value, code: i64, message: &str) -> io::Result<()> {
    write_json_line(
        output,
        &json!({
            "id": id,
            "error": {
                "code": code,
                "message": message
            }
        }),
    )
}

fn write_json_line<W: Write>(output: &mut W, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, value).map_err(io::Error::other)?;
    writeln!(output)?;
    output.flush()
}

#[cfg(unix)]
fn ignore_sigterm() {
    unsafe {
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
    }
}

#[cfg(not(unix))]
fn ignore_sigterm() {}
