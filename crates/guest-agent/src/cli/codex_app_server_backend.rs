//! Experimental Codex app-server execution backend.
//!
//! This module owns only the experimental app-server runtime path. Ordinary
//! Codex execution continues to use `codex exec --json` unless the explicit
//! guest env flag selects this backend.

use std::future::Future;
use std::path::PathBuf;

use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use crate::env::Framework;
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
    CliEventIngestor, CliExecutionResult, CliRuntimeConfig, HeartbeatMonitor, HeartbeatStatus,
    LOG_TAG, ParsedEventAction, codex_app_server_events::IGNORED_NOTIFICATION_METHODS, command,
    notification_to_codex_event,
};
use crate::active_input::{ActiveInputFrame, ActiveInputWriter};
use guest_common::{log_info, log_warn};

const TURN_NOTIFICATION_LABEL: &str = "turn notification";

struct NotificationIngestResult {
    emitted_thread_started: bool,
}

struct PreparedNotificationIngest {
    event: Option<Value>,
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

struct CodexTurnScope<'a> {
    thread_id: &'a str,
    turn_id: &'a str,
}

enum CodexRunEvent {
    Notification(ServerNotification),
    ActiveInput(Option<ActiveInputFrame>),
}

pub(super) async fn execute_codex_app_server_for_runtime(
    masker: &SecretMasker,
    mut heartbeat_monitor: HeartbeatMonitor,
    http: HttpClient,
    active_input: ActiveInputWriter,
    runtime: &CliRuntimeConfig<'_>,
) -> Result<CliExecutionResult, AgentError> {
    masker.add_sensitive_value(runtime.resume_session_id.as_ref());
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
        active_input,
        runtime,
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
    mut active_input: ActiveInputWriter,
    runtime: &CliRuntimeConfig<'_>,
) -> Result<CliExecutionResult, AgentError> {
    let log_file = guest_contracts::runtime_paths::create_private(runtime.agent_log_file.as_ref())?;
    let mut log_file = tokio::fs::File::from_std(log_file);
    let mut ingestor = CliEventIngestor::new();
    let resume_thread_id = resume_thread_id_from_runtime(runtime)?;
    if let Some(resume_thread_id) = &resume_thread_id {
        masker.add_sensitive_value(resume_thread_id);
    }
    let mut client = CodexAppServerClient::spawn(codex_app_server_config(runtime))
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
            start_or_resume_thread(&mut client, resume_thread_id.as_deref(), runtime),
            heartbeat_monitor,
            &mut heartbeat_done,
            masker,
        )
        .await?;
        let thread_identity = thread_identity_from_response(&thread_response)?;
        validate_resumed_thread_id(&thread_identity.canonical_id, resume_thread_id.as_deref())?;
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
                None,
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
            client.request_value(
                "turn/start",
                turn_start_params(&thread_identity.wire_id, runtime),
            ),
            heartbeat_monitor,
            &mut heartbeat_done,
            masker,
        )
        .await?;
        let turn_id = turn_id_from_response(&turn_response)?;
        let mut active_input_open = active_input.is_enabled();
        let mut turn_started_observed = false;

        let exit_code = loop {
            let event = next_codex_run_event(
                &mut client,
                &mut active_input,
                active_input_open,
                turn_started_observed,
                heartbeat_monitor,
                &mut heartbeat_done,
                masker,
            )
            .await?;
            match event {
                CodexRunEvent::Notification(notification) => {
                    let mut sink = EventIngestSink {
                        ingestor: &mut ingestor,
                        log_file: &mut log_file,
                        masker,
                        should_send_events,
                        event_tx,
                    };
                    let notification_scope = CodexTurnScope {
                        thread_id: &thread_identity.canonical_id,
                        turn_id: &turn_id,
                    };
                    let notification_ready_for_active_input =
                        is_active_input_ready_notification(&notification, &turn_id);
                    let terminal_exit_code = ingest_run_notification(
                        notification,
                        &mut sink,
                        &active_input,
                        &mut thread_started_emitted,
                        &notification_scope,
                    )
                    .await?;
                    turn_started_observed =
                        turn_started_observed || notification_ready_for_active_input;
                    if let Some(exit_code) = terminal_exit_code {
                        active_input.close_terminal();
                        break exit_code;
                    }
                }
                CodexRunEvent::ActiveInput(Some(frame)) => {
                    let steer_scope = CodexTurnScope {
                        thread_id: &thread_identity.wire_id,
                        turn_id: &turn_id,
                    };
                    steer_active_input(
                        &mut client,
                        &active_input,
                        frame,
                        &steer_scope,
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
                    let notification_scope = CodexTurnScope {
                        thread_id: &thread_identity.canonical_id,
                        turn_id: &turn_id,
                    };
                    if let Some(exit_code) = drain_queued_notifications(
                        &mut client,
                        &mut sink,
                        &active_input,
                        &mut thread_started_emitted,
                        &notification_scope,
                    )
                    .await?
                    {
                        active_input.close_terminal();
                        break exit_code;
                    }
                }
                CodexRunEvent::ActiveInput(None) => {
                    active_input_open = false;
                }
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
    active_input.close_terminal();

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

fn codex_app_server_config(runtime: &CliRuntimeConfig<'_>) -> CodexAppServerConfig {
    let binary = if runtime.use_mock_codex {
        log_info!(LOG_TAG, "Using mock-codex app-server for testing");
        PathBuf::from(runtime.mock_codex_path.as_ref())
    } else {
        PathBuf::from("codex")
    };
    let codex_home = PathBuf::from(runtime.codex_home());
    let mut config = CodexAppServerConfig::new(binary, codex_home)
        .with_child_env(
            runtime.home_dir.as_ref(),
            runtime.user_env,
            runtime.api_url.as_ref(),
        )
        .with_current_dir(paths::CANONICAL_WORKING_DIR)
        .with_opt_out_notification_methods(IGNORED_NOTIFICATION_METHODS.iter().copied());
    if runtime.use_mock_codex
        && let Ok(scenario) = std::env::var("MOCK_CODEX_APP_SERVER_SCENARIO")
    {
        config = config.with_env("MOCK_CODEX_APP_SERVER_SCENARIO", scenario);
    }
    if runtime.codex_oauth_mode {
        config = config.with_env(
            "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
            crate::codex_auth::REFRESH_TOKEN_NOOP_URL,
        );
    }
    config
}

async fn start_or_resume_thread(
    client: &mut CodexAppServerClient,
    resume_thread_id: Option<&str>,
    runtime: &CliRuntimeConfig<'_>,
) -> Result<Value, CodexAppServerError> {
    match resume_thread_id {
        Some(resume_thread_id) => {
            let mut params = thread_param_fields(runtime);
            params.insert(
                "threadId".to_string(),
                Value::String(resume_thread_id.to_string()),
            );
            client
                .request_value("thread/resume", Value::Object(params))
                .await
        }
        None => {
            client
                .request_value("thread/start", thread_params(runtime))
                .await
        }
    }
}

fn thread_params(runtime: &CliRuntimeConfig<'_>) -> Value {
    Value::Object(thread_param_fields(runtime))
}

fn thread_param_fields(runtime: &CliRuntimeConfig<'_>) -> Map<String, Value> {
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
    if !runtime.openai_model.is_empty() {
        params.insert(
            "model".to_string(),
            Value::String(runtime.openai_model.to_string()),
        );
    }
    if !runtime.append_system_prompt.is_empty() {
        params.insert(
            "developerInstructions".to_string(),
            Value::String(runtime.append_system_prompt.to_string()),
        );
    }
    params
}

fn turn_start_params(thread_id: &str, runtime: &CliRuntimeConfig<'_>) -> Value {
    let mut params = Map::new();
    params.insert("threadId".to_string(), Value::String(thread_id.to_string()));
    params.insert(
        "input".to_string(),
        Value::Array(vec![json!({
            "type": "text",
            "text": runtime.prompt.as_ref(),
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
    if !runtime.openai_model.is_empty() {
        params.insert(
            "model".to_string(),
            Value::String(runtime.openai_model.to_string()),
        );
    }
    if let Some(effort) =
        command::default_codex_reasoning_effort_for_model(runtime.openai_model.as_ref())
    {
        params.insert("effort".to_string(), Value::String(effort.to_string()));
    }
    Value::Object(params)
}

async fn next_codex_run_event(
    client: &mut CodexAppServerClient,
    active_input: &mut ActiveInputWriter,
    active_input_open: bool,
    active_input_ready: bool,
    heartbeat_monitor: &mut HeartbeatMonitor,
    heartbeat_done: &mut bool,
    masker: &SecretMasker,
) -> Result<CodexRunEvent, AgentError> {
    let active_input_can_be_read = can_read_active_input(active_input_open, active_input_ready);
    // Do not let buffered terminal notifications overtake input the control
    // path already accepted.
    if active_input_can_be_read && let Some(frame) = active_input.try_next_frame() {
        return Ok(CodexRunEvent::ActiveInput(Some(frame)));
    }
    if let Some(notification) = client.pop_notification() {
        return Ok(CodexRunEvent::Notification(notification));
    }

    tokio::select! {
        biased;
        frame = active_input.next_frame(), if active_input_can_be_read => {
            Ok(CodexRunEvent::ActiveInput(frame))
        }
        notification = client.next_notification(TURN_NOTIFICATION_LABEL) => {
            notification
                .map(CodexRunEvent::Notification)
                .map_err(|error| app_server_error(masker, error))
        }
        heartbeat_result = wait_for_heartbeat(heartbeat_monitor), if !*heartbeat_done => {
            *heartbeat_done = true;
            Err(heartbeat_error(heartbeat_result))
        }
    }
}

fn can_read_active_input(active_input_open: bool, active_input_ready: bool) -> bool {
    active_input_open && active_input_ready
}

fn is_active_input_ready_notification(notification: &ServerNotification, turn_id: &str) -> bool {
    notification.method == "turn/started"
        && notification
            .params
            .as_ref()
            .and_then(|params| params.pointer("/turn/id"))
            .and_then(Value::as_str)
            == Some(turn_id)
}

async fn steer_active_input(
    client: &mut CodexAppServerClient,
    active_input: &ActiveInputWriter,
    frame: ActiveInputFrame,
    target: &CodexTurnScope<'_>,
    heartbeat_monitor: &mut HeartbeatMonitor,
    heartbeat_done: &mut bool,
    masker: &SecretMasker,
) -> Result<(), AgentError> {
    let thread_id = target.thread_id;
    let turn_id = target.turn_id;
    let params = turn_steer_params(thread_id, turn_id, &frame);
    log_info!(
        LOG_TAG,
        "Codex active input steer: target_thread_id={thread_id} captured_active_turn_id={turn_id} expected_turn_id={turn_id} message_id={} outcome=attempt",
        frame.message_id
    );
    active_input.mark_writing(&frame.uuid);
    let result = race_with_heartbeat(
        client.request_value("turn/steer", params),
        heartbeat_monitor,
        heartbeat_done,
        masker,
    )
    .await;
    match result {
        Ok(_) => {
            active_input.mark_written_without_replay(&frame.uuid);
            log_info!(
                LOG_TAG,
                "Codex active input steer: target_thread_id={thread_id} captured_active_turn_id={turn_id} expected_turn_id={turn_id} message_id={} outcome=active_turn_advanced",
                frame.message_id
            );
            Ok(())
        }
        Err(error) => {
            active_input.close_terminal();
            log_warn!(
                LOG_TAG,
                "Codex active input steer: target_thread_id={thread_id} captured_active_turn_id={turn_id} expected_turn_id={turn_id} message_id={} outcome=failed error={error}",
                frame.message_id
            );
            Err(AgentError::Execution(format!(
                "codex app-server active input steer failed for message {}: {error}",
                frame.message_id
            )))
        }
    }
}

fn turn_steer_params(thread_id: &str, turn_id: &str, frame: &ActiveInputFrame) -> Value {
    json!({
        "threadId": thread_id,
        "expectedTurnId": turn_id,
        "clientUserMessageId": frame.message_id.as_str(),
        "input": [{
            "type": "text",
            "text": frame.text.as_str(),
            "text_elements": [],
        }],
    })
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

async fn drain_queued_notifications(
    client: &mut CodexAppServerClient,
    sink: &mut EventIngestSink<'_>,
    active_input: &ActiveInputWriter,
    thread_started_emitted: &mut bool,
    scope: &CodexTurnScope<'_>,
) -> Result<Option<i32>, AgentError> {
    let mut prepared_notifications = Vec::new();
    let mut prepared_thread_started_emitted = *thread_started_emitted;
    while let Some(notification) = client.pop_notification() {
        let prepared = prepare_notification_ingest(
            notification,
            prepared_thread_started_emitted,
            scope.thread_id,
            scope.turn_id,
        )?;
        prepared_thread_started_emitted =
            prepared_thread_started_emitted || prepared.emitted_thread_started;
        let is_terminal = prepared.terminal_exit_code.is_some();
        prepared_notifications.push(prepared);
        if is_terminal {
            active_input.close_terminal();
            break;
        }
    }
    for prepared in prepared_notifications {
        if let Some(event) = prepared.event {
            ingest_event(event, sink).await?;
        }
        *thread_started_emitted = *thread_started_emitted || prepared.emitted_thread_started;
        if let Some(exit_code) = prepared.terminal_exit_code {
            return Ok(Some(exit_code));
        }
    }
    Ok(None)
}

async fn ingest_run_notification(
    notification: ServerNotification,
    sink: &mut EventIngestSink<'_>,
    active_input: &ActiveInputWriter,
    thread_started_emitted: &mut bool,
    scope: &CodexTurnScope<'_>,
) -> Result<Option<i32>, AgentError> {
    let prepared = prepare_notification_ingest(
        notification,
        *thread_started_emitted,
        scope.thread_id,
        scope.turn_id,
    )?;
    // Close before any ingest await so the control path cannot accept input
    // after this run has already observed a terminal turn event.
    if prepared.terminal_exit_code.is_some() {
        active_input.close_terminal();
    }
    let terminal_exit_code = prepared.terminal_exit_code;
    if let Some(event) = prepared.event {
        ingest_event(event, sink).await?;
    }
    *thread_started_emitted = *thread_started_emitted || prepared.emitted_thread_started;
    Ok(terminal_exit_code)
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
    terminal_active_input: Option<&ActiveInputWriter>,
) -> Result<NotificationIngestResult, AgentError> {
    let prepared = prepare_notification_ingest(
        notification,
        thread_started_emitted,
        expected_thread_id,
        active_turn_id,
    )?;
    if prepared.terminal_exit_code.is_some()
        && let Some(active_input) = terminal_active_input
    {
        active_input.close_terminal();
    }
    if let Some(event) = prepared.event {
        ingest_event(event, sink).await?;
    }
    Ok(NotificationIngestResult {
        emitted_thread_started: prepared.emitted_thread_started,
    })
}

fn prepare_notification_ingest(
    notification: ServerNotification,
    thread_started_emitted: bool,
    expected_thread_id: &str,
    active_turn_id: &str,
) -> Result<PreparedNotificationIngest, AgentError> {
    let Some(event) = notification_to_codex_event(&notification)
        .map_err(|error| AgentError::Execution(error.to_string()))?
    else {
        return Ok(PreparedNotificationIngest {
            event: None,
            emitted_thread_started: false,
            terminal_exit_code: None,
        });
    };
    validate_event_scope(&event, expected_thread_id, active_turn_id)?;
    if is_duplicate_thread_started(&event, thread_started_emitted, expected_thread_id) {
        return Ok(PreparedNotificationIngest {
            event: None,
            emitted_thread_started: false,
            terminal_exit_code: None,
        });
    }
    let emitted_thread_started = is_thread_started_event(&event, expected_thread_id);
    let terminal_exit_code = terminal_exit_code(&event, expected_thread_id, active_turn_id);
    Ok(PreparedNotificationIngest {
        event: Some(event),
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
            super::framework::CliFrameworkBehavior::new(Framework::Codex),
        )
        .await?
    {
        ParsedEventAction::Forward => {
            if let Some(text) = codex_agent_message_text(&event) {
                println!("{}", sink.masker.mask_string(text));
            }
            sink.ingestor
                .enqueue_event(event, sink.masker, sink.should_send_events, sink.event_tx);
        }
        ParsedEventAction::Skip => {}
    }
    Ok(())
}

fn codex_agent_message_text(event: &Value) -> Option<&str> {
    if event.get("type").and_then(Value::as_str) != Some("item.completed") {
        return None;
    }
    let item = event.get("item")?;
    if item.get("type").and_then(Value::as_str) != Some("agent_message") {
        return None;
    }
    item.get("text").and_then(Value::as_str)
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

fn resume_thread_id_from_runtime(
    runtime: &CliRuntimeConfig<'_>,
) -> Result<Option<String>, AgentError> {
    let resume_id = runtime.resume_session_id.as_ref();
    if resume_id.is_empty() {
        return Ok(None);
    }
    canonical_codex_thread_id(
        resume_id,
        "VM0_RESUME_SESSION_ID is not a valid Codex thread id",
    )
    .map(Some)
}

fn validate_resumed_thread_id(
    canonical_thread_id: &str,
    resume_thread_id: Option<&str>,
) -> Result<(), AgentError> {
    if let Some(resume_thread_id) = resume_thread_id
        && canonical_thread_id != resume_thread_id
    {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_input_is_read_only_after_source_and_turn_are_ready() {
        assert!(!can_read_active_input(false, false));
        assert!(!can_read_active_input(false, true));
        assert!(!can_read_active_input(true, false));
        assert!(can_read_active_input(true, true));
    }

    #[test]
    fn turn_started_notification_enables_active_input_for_matching_turn() {
        let matching_notification = ServerNotification {
            method: "turn/started".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "inProgress"
                }
            })),
        };
        let wrong_turn_notification = ServerNotification {
            method: "turn/started".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-2",
                    "status": "inProgress"
                }
            })),
        };
        let thread_started_notification = ServerNotification {
            method: "thread/started".to_string(),
            params: Some(json!({
                "thread": {
                    "id": "thread-1"
                }
            })),
        };

        assert!(is_active_input_ready_notification(
            &matching_notification,
            "turn-1"
        ));
        assert!(!is_active_input_ready_notification(
            &wrong_turn_notification,
            "turn-1"
        ));
        assert!(!is_active_input_ready_notification(
            &thread_started_notification,
            "turn-1"
        ));
    }

    #[test]
    fn codex_agent_message_text_reads_completed_agent_message_only() {
        let agent_message = json!({
            "type": "item.completed",
            "item": {
                "type": "agent_message",
                "text": "RESULT=ok"
            }
        });
        let plan_message = json!({
            "type": "item.completed",
            "item": {
                "type": "plan",
                "text": "not final output"
            }
        });
        let started_agent_message = json!({
            "type": "item.started",
            "item": {
                "type": "agent_message",
                "text": "not completed"
            }
        });

        assert_eq!(codex_agent_message_text(&agent_message), Some("RESULT=ok"));
        assert_eq!(codex_agent_message_text(&plan_message), None);
        assert_eq!(codex_agent_message_text(&started_agent_message), None);
    }
}
