//! Disabled Codex app-server execution backend.
//!
//! This module owns only the experimental app-server runtime path. Ordinary
//! Codex execution continues to use `codex exec --json` unless the explicit
//! guest env flag selects this backend.

use std::future::Future;
use std::path::PathBuf;

use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use crate::env;
use crate::error::AgentError;
use crate::events;
use crate::http::HttpClient;
use crate::masker::SecretMasker;
use crate::paths;

use super::codex_app_server::{
    CodexAppServerClient, CodexAppServerConfig, CodexAppServerError, ServerNotification,
};
use super::event_delivery::{AckedEventPrefix, PreparedEvent};
use super::{
    CliEventIngestor, CliExecutionResult, HeartbeatMonitor, HeartbeatStatus, LOG_TAG,
    ParsedEventAction, command, notification_to_codex_event,
};
use guest_common::{log_info, log_warn};

const TURN_NOTIFICATION_LABEL: &str = "turn notification";

struct NotificationIngestResult {
    emitted_thread_started: bool,
    terminal_exit_code: Option<i32>,
}

struct ThreadIdentity {
    wire_id: String,
    canonical_id: String,
}

struct EventIngestSink<'a> {
    ingestor: &'a mut CliEventIngestor,
    log_file: &'a mut tokio::fs::File,
    masker: &'a SecretMasker,
    should_send_events: bool,
    event_tx: &'a tokio::sync::mpsc::UnboundedSender<PreparedEvent>,
}

pub(super) async fn execute_codex_app_server(
    masker: &SecretMasker,
    mut heartbeat_monitor: HeartbeatMonitor,
    http: HttpClient,
) -> Result<CliExecutionResult, AgentError> {
    masker.add_sensitive_value(env::resume_session_id());
    log_info!(LOG_TAG, "Starting codex app-server execution...");

    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<PreparedEvent>();
    let should_send_events = http.has_api();
    let event_http = http.clone();
    let event_sender = tokio::spawn(async move {
        let mut acked_prefix = AckedEventPrefix::default();
        while let Some(event) = event_rx.recv().await {
            match event {
                PreparedEvent::Webhook { sequence, payload } => {
                    match events::post_event(&event_http, &payload).await {
                        Ok(()) => {
                            acked_prefix.record_success(sequence);
                        }
                        Err(e) => {
                            acked_prefix.record_failure(sequence);
                            log_warn!(LOG_TAG, "Event send failed: {e}");
                        }
                    }
                }
            }
        }
        acked_prefix.last_contiguous()
    });

    let run_result = run_codex_app_server(
        masker,
        &mut heartbeat_monitor,
        should_send_events,
        &event_tx,
    )
    .await;

    drop(event_tx);

    match run_result {
        Ok(mut result) => {
            match event_sender.await {
                Ok(sequence) => {
                    result.last_event_sequence = sequence;
                }
                Err(error) => {
                    log_warn!(LOG_TAG, "Event sender task failed: {error}");
                }
            }
            Ok(result)
        }
        Err(error) => {
            event_sender.abort();
            let _ = event_sender.await;
            Err(error)
        }
    }
}

async fn run_codex_app_server(
    masker: &SecretMasker,
    heartbeat_monitor: &mut HeartbeatMonitor,
    should_send_events: bool,
    event_tx: &tokio::sync::mpsc::UnboundedSender<PreparedEvent>,
) -> Result<CliExecutionResult, AgentError> {
    let log_file = guest_contracts::runtime_paths::create_private(paths::agent_log_file())?;
    let mut log_file = tokio::fs::File::from_std(log_file);
    let mut ingestor = CliEventIngestor::new();
    let mut client = CodexAppServerClient::spawn(codex_app_server_config())
        .map_err(|error| app_server_error(masker, error))?;
    let mut heartbeat_done = false;

    let run_result = async {
        race_with_heartbeat(
            client.initialize(),
            heartbeat_monitor,
            &mut heartbeat_done,
            masker,
        )
        .await?;
        let thread_response = race_with_heartbeat(
            start_or_resume_thread(&mut client),
            heartbeat_monitor,
            &mut heartbeat_done,
            masker,
        )
        .await?;
        let thread_identity = thread_identity_from_response(&thread_response)?;
        validate_resumed_thread_id(&thread_identity.canonical_id)?;
        let mut thread_started_emitted = false;

        while let Some(notification) = client.pop_notification() {
            let mut sink = EventIngestSink {
                ingestor: &mut ingestor,
                log_file: &mut log_file,
                masker,
                should_send_events,
                event_tx,
            };
            let ingest_result = ingest_notification(
                notification,
                &mut sink,
                thread_started_emitted,
                &thread_identity.canonical_id,
                "",
            )
            .await?;
            thread_started_emitted = thread_started_emitted || ingest_result.emitted_thread_started;
        }

        if !thread_started_emitted {
            let mut sink = EventIngestSink {
                ingestor: &mut ingestor,
                log_file: &mut log_file,
                masker,
                should_send_events,
                event_tx,
            };
            ingest_event(
                synthesize_thread_started_event(&thread_identity.canonical_id),
                &mut sink,
            )
            .await?;
            thread_started_emitted = true;
        }

        let turn_response = race_with_heartbeat(
            client.request_value("turn/start", turn_start_params(&thread_identity.wire_id)),
            heartbeat_monitor,
            &mut heartbeat_done,
            masker,
        )
        .await?;
        let turn_id = turn_id_from_response(&turn_response)?;

        let exit_code = loop {
            let notification = next_notification_or_heartbeat(
                &mut client,
                heartbeat_monitor,
                &mut heartbeat_done,
                masker,
            )
            .await?;
            let mut sink = EventIngestSink {
                ingestor: &mut ingestor,
                log_file: &mut log_file,
                masker,
                should_send_events,
                event_tx,
            };
            let ingest_result = ingest_notification(
                notification,
                &mut sink,
                thread_started_emitted,
                &thread_identity.canonical_id,
                &turn_id,
            )
            .await?;
            thread_started_emitted = thread_started_emitted || ingest_result.emitted_thread_started;
            if let Some(exit_code) = ingest_result.terminal_exit_code {
                break exit_code;
            }
        };

        Ok::<CliExecutionResult, AgentError>(CliExecutionResult {
            exit_code,
            stderr_lines: Vec::new(),
            last_event_sequence: None,
            claude_result: None,
            post_result_cleanup_result: None,
            failure_diagnostic: ingestor.failure_diagnostic(),
            control_error: None,
            cli_termination: None,
        })
    }
    .await;

    let shutdown_result = if run_result.is_ok() {
        client.shutdown().await
    } else {
        client.terminate().await
    };
    let stderr_lines = masker.mask_diagnostic_lines(client.stderr_tail().to_vec());

    match (run_result, shutdown_result) {
        (Ok(mut result), Ok(())) => {
            result.stderr_lines = stderr_lines;
            Ok(result)
        }
        (Ok(_result), Err(error)) => Err(AgentError::Execution(format!(
            "codex app-server shutdown failed: {}",
            masker.mask_string(&error.to_string())
        ))),
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(shutdown_error)) => {
            let shutdown_error = masker.mask_string(&shutdown_error.to_string());
            log_warn!(
                LOG_TAG,
                "codex app-server shutdown failed after run error: {shutdown_error}"
            );
            Err(error)
        }
    }
}

fn codex_app_server_config() -> CodexAppServerConfig {
    let binary = if env::use_mock_codex() {
        log_info!(LOG_TAG, "Using mock-codex app-server for testing");
        PathBuf::from(env::mock_codex_path())
    } else {
        PathBuf::from("codex")
    };
    let codex_home = PathBuf::from(format!("{}/.codex", env::home_dir()));
    let mut config = CodexAppServerConfig::new(binary, codex_home)
        .with_current_dir(paths::CANONICAL_WORKING_DIR);
    if env::use_mock_codex()
        && let Ok(scenario) = std::env::var("MOCK_CODEX_APP_SERVER_SCENARIO")
    {
        config = config.with_env("MOCK_CODEX_APP_SERVER_SCENARIO", scenario);
    }
    if env::is_codex_oauth_mode() {
        config = config.with_env(
            "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
            crate::codex_auth::REFRESH_TOKEN_NOOP_URL,
        );
    }
    config
}

async fn start_or_resume_thread(
    client: &mut CodexAppServerClient,
) -> Result<Value, CodexAppServerError> {
    let resume_id = env::resume_session_id();
    if resume_id.is_empty() {
        client.request_value("thread/start", thread_params()).await
    } else {
        let mut params = thread_param_fields();
        params.insert("threadId".to_string(), Value::String(resume_id.to_string()));
        client
            .request_value("thread/resume", Value::Object(params))
            .await
    }
}

fn thread_params() -> Value {
    Value::Object(thread_param_fields())
}

fn thread_param_fields() -> Map<String, Value> {
    let mut params = Map::new();
    params.insert(
        "cwd".to_string(),
        Value::String(paths::CANONICAL_WORKING_DIR.to_string()),
    );
    params.insert(
        "approvalPolicy".to_string(),
        Value::String("never".to_string()),
    );
    params.insert(
        "approvalsReviewer".to_string(),
        Value::String("user".to_string()),
    );
    params.insert(
        "sandbox".to_string(),
        Value::String("danger-full-access".to_string()),
    );
    params.insert(
        "config".to_string(),
        json!({
            "features.memories": true,
        }),
    );
    if !env::openai_model().is_empty() {
        params.insert(
            "model".to_string(),
            Value::String(env::openai_model().to_string()),
        );
    }
    if !env::append_system_prompt().is_empty() {
        params.insert(
            "developerInstructions".to_string(),
            Value::String(env::append_system_prompt().to_string()),
        );
    }
    params
}

fn turn_start_params(thread_id: &str) -> Value {
    let mut params = Map::new();
    params.insert("threadId".to_string(), Value::String(thread_id.to_string()));
    params.insert(
        "input".to_string(),
        Value::Array(vec![json!({
            "type": "text",
            "text": env::prompt(),
            "text_elements": [],
        })]),
    );
    params.insert(
        "cwd".to_string(),
        Value::String(paths::CANONICAL_WORKING_DIR.to_string()),
    );
    params.insert(
        "approvalPolicy".to_string(),
        Value::String("never".to_string()),
    );
    params.insert(
        "approvalsReviewer".to_string(),
        Value::String("user".to_string()),
    );
    params.insert(
        "sandboxPolicy".to_string(),
        json!({ "type": "dangerFullAccess" }),
    );
    if !env::openai_model().is_empty() {
        params.insert(
            "model".to_string(),
            Value::String(env::openai_model().to_string()),
        );
    }
    if let Some(effort) = command::default_codex_reasoning_effort_for_model(env::openai_model()) {
        params.insert("effort".to_string(), Value::String(effort.to_string()));
    }
    Value::Object(params)
}

async fn next_notification_or_heartbeat(
    client: &mut CodexAppServerClient,
    heartbeat_monitor: &mut HeartbeatMonitor,
    heartbeat_done: &mut bool,
    masker: &SecretMasker,
) -> Result<ServerNotification, AgentError> {
    race_with_heartbeat(
        client.next_notification(TURN_NOTIFICATION_LABEL),
        heartbeat_monitor,
        heartbeat_done,
        masker,
    )
    .await
}

async fn race_with_heartbeat<T>(
    app_server_wait: impl Future<Output = Result<T, CodexAppServerError>>,
    heartbeat_monitor: &mut HeartbeatMonitor,
    heartbeat_done: &mut bool,
    masker: &SecretMasker,
) -> Result<T, AgentError> {
    // If heartbeat wins, the caller exits the run and shuts the app-server
    // down. We intentionally do not try to reuse a possibly half-read JSON-RPC
    // stream after cancelling `app_server_wait`.
    tokio::select! {
        result = app_server_wait => result.map_err(|error| app_server_error(masker, error)),
        heartbeat_result = wait_for_heartbeat(heartbeat_monitor), if !*heartbeat_done => {
            *heartbeat_done = true;
            Err(heartbeat_error(heartbeat_result))
        }
    }
}

fn app_server_error(masker: &SecretMasker, error: impl std::fmt::Display) -> AgentError {
    AgentError::Execution(masker.mask_string(&error.to_string()))
}

async fn wait_for_heartbeat(
    heartbeat_monitor: &mut HeartbeatMonitor,
) -> Result<HeartbeatStatus, oneshot::error::RecvError> {
    match heartbeat_monitor.as_mut() {
        Some(receiver) => receiver.await,
        None => std::future::pending().await,
    }
}

fn heartbeat_error(result: Result<HeartbeatStatus, oneshot::error::RecvError>) -> AgentError {
    match result {
        Ok(HeartbeatStatus::Failed(error)) => error,
        Ok(HeartbeatStatus::Stopped) => {
            AgentError::Execution("heartbeat stopped before codex app-server completed".to_string())
        }
        Ok(HeartbeatStatus::TaskFailed(message)) => {
            AgentError::Execution(format!("heartbeat task panicked: {message}"))
        }
        Err(error) => AgentError::Execution(format!(
            "heartbeat task stopped before reporting status: {error}"
        )),
    }
}

async fn ingest_notification(
    notification: ServerNotification,
    sink: &mut EventIngestSink<'_>,
    thread_started_emitted: bool,
    expected_thread_id: &str,
    active_turn_id: &str,
) -> Result<NotificationIngestResult, AgentError> {
    let Some(event) = notification_to_codex_event(&notification)
        .map_err(|error| AgentError::Execution(error.to_string()))?
    else {
        return Ok(NotificationIngestResult {
            emitted_thread_started: false,
            terminal_exit_code: None,
        });
    };
    validate_event_scope(&event, expected_thread_id, active_turn_id)?;
    if is_duplicate_thread_started(&event, thread_started_emitted, expected_thread_id) {
        return Ok(NotificationIngestResult {
            emitted_thread_started: false,
            terminal_exit_code: None,
        });
    }
    let emitted_thread_started = is_thread_started_event(&event, expected_thread_id);
    let terminal_exit_code = terminal_exit_code(&event, expected_thread_id, active_turn_id);
    ingest_event(event, sink).await?;
    Ok(NotificationIngestResult {
        emitted_thread_started,
        terminal_exit_code,
    })
}

fn validate_event_scope(
    event: &Value,
    expected_canonical_thread_id: &str,
    active_turn_id: &str,
) -> Result<(), AgentError> {
    if let Some(thread_id) = event_thread_id(event)
        && !thread_id_matches_canonical(thread_id, expected_canonical_thread_id)
    {
        return Err(AgentError::Execution(
            "codex app-server reported unexpected thread id in event".to_string(),
        ));
    }
    if let Some(turn_id) = event_turn_id(event) {
        if active_turn_id.is_empty() {
            return Err(AgentError::Execution(
                "codex app-server reported turn-scoped event before turn/start".to_string(),
            ));
        }
        if turn_id != active_turn_id {
            return Err(AgentError::Execution(
                "codex app-server reported unexpected turn id in event".to_string(),
            ));
        }
    }
    Ok(())
}

fn event_thread_id(event: &Value) -> Option<&str> {
    event.get("thread_id").and_then(Value::as_str)
}

fn event_turn_id(event: &Value) -> Option<&str> {
    event
        .get("turn_id")
        .and_then(Value::as_str)
        .or_else(|| event.pointer("/turn/id").and_then(Value::as_str))
}

async fn ingest_event(event: Value, sink: &mut EventIngestSink<'_>) -> Result<(), AgentError> {
    let raw_line = serde_json::to_vec(&event)?;
    match sink
        .ingestor
        .begin_event(
            sink.log_file,
            raw_line,
            &event,
            sink.masker,
            super::framework::CliFrameworkBehavior::new(env::Framework::Codex),
        )
        .await?
    {
        ParsedEventAction::Forward => {
            sink.ingestor
                .enqueue_event(event, sink.masker, sink.should_send_events, sink.event_tx);
        }
        ParsedEventAction::Skip => {}
    }
    Ok(())
}

fn is_duplicate_thread_started(
    event: &Value,
    thread_started_emitted: bool,
    expected_canonical_thread_id: &str,
) -> bool {
    thread_started_emitted && is_thread_started_event(event, expected_canonical_thread_id)
}

fn is_thread_started_event(event: &Value, expected_canonical_thread_id: &str) -> bool {
    event.get("type").and_then(Value::as_str) == Some("thread.started")
        && event
            .get("thread_id")
            .and_then(Value::as_str)
            .is_some_and(|thread_id| {
                thread_id_matches_canonical(thread_id, expected_canonical_thread_id)
            })
}

fn terminal_exit_code(
    event: &Value,
    expected_canonical_thread_id: &str,
    active_turn_id: &str,
) -> Option<i32> {
    match event.get("type").and_then(Value::as_str)? {
        "turn.completed" => {
            if !event
                .get("thread_id")
                .and_then(Value::as_str)
                .is_some_and(|thread_id| {
                    thread_id_matches_canonical(thread_id, expected_canonical_thread_id)
                })
            {
                return None;
            }
            let turn_id = event.pointer("/turn/id").and_then(Value::as_str)?;
            if turn_id != active_turn_id {
                return None;
            }
            match event.pointer("/turn/status").and_then(Value::as_str) {
                Some("completed") => Some(0),
                Some("failed" | "interrupted") => Some(1),
                _ => None,
            }
        }
        "error" => {
            if event
                .get("thread_id")
                .and_then(Value::as_str)
                .is_some_and(|thread_id| {
                    thread_id_matches_canonical(thread_id, expected_canonical_thread_id)
                })
                && event.get("turn_id").and_then(Value::as_str) == Some(active_turn_id)
                && event.get("will_retry").and_then(Value::as_bool) == Some(false)
            {
                Some(1)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn synthesize_thread_started_event(thread_id: &str) -> Value {
    json!({
        "type": "thread.started",
        "thread_id": thread_id,
    })
}

fn thread_identity_from_response(response: &Value) -> Result<ThreadIdentity, AgentError> {
    let wire_id = non_empty_string_at(response, "/thread/id", "thread response missing thread.id")?;
    let canonical_id = canonical_codex_thread_id(
        &wire_id,
        "thread response returned an invalid Codex thread id",
    )?;
    Ok(ThreadIdentity {
        wire_id,
        canonical_id,
    })
}

fn validate_resumed_thread_id(canonical_thread_id: &str) -> Result<(), AgentError> {
    let resume_id = env::resume_session_id();
    if resume_id.is_empty() {
        return Ok(());
    }
    let canonical_resume_id = canonical_codex_thread_id(
        resume_id,
        "VM0_RESUME_SESSION_ID is not a valid Codex thread id",
    )?;
    if canonical_thread_id != canonical_resume_id {
        return Err(AgentError::Execution(
            "thread/resume returned a different thread id".to_string(),
        ));
    }
    Ok(())
}

fn turn_id_from_response(response: &Value) -> Result<String, AgentError> {
    non_empty_string_at(response, "/turn/id", "turn/start response missing turn.id")
}

fn thread_id_matches_canonical(thread_id: &str, expected_canonical_thread_id: &str) -> bool {
    guest_contracts::codex_thread_id::canonical_codex_thread_id(thread_id).as_deref()
        == Some(expected_canonical_thread_id)
}

fn canonical_codex_thread_id(thread_id: &str, message: &'static str) -> Result<String, AgentError> {
    guest_contracts::codex_thread_id::canonical_codex_thread_id(thread_id)
        .ok_or_else(|| AgentError::Execution(message.to_string()))
}

fn non_empty_string_at(
    value: &Value,
    pointer: &'static str,
    message: &'static str,
) -> Result<String, AgentError> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| AgentError::Execution(message.to_string()))
}
