use super::messages::{
    agent_message_item_started_notification, assistant_item_completed_notification,
    initialize_response, large_server_notification, large_warning_notification,
    reasoning_item_started_notification, server_notification, server_notification_with_index,
    server_request, thread_response, thread_started_notification, turn,
    turn_completed_notification, turn_started_notification, warning_notification, write_error,
    write_json_line, write_split_json_line_prefix, write_success,
    write_turn_completion_notifications, write_turn_notifications,
};
use super::persistence::{InputEventContext, persist_input_events};
use super::scenario::Scenario;
use super::{AppServerState, INVALID_REQUEST, PendingResponse, ServerAction, spawn_stderr_holder};
use serde_json::{Value, json};
use std::io::{self, Write};
use std::thread;
use uuid::Uuid;

const NOTIFICATION_OVERFLOW_COUNT: usize = 129;
const OVERSIZED_STDOUT_BYTES: usize = 65 * 1024 * 1024;
const EVENT_DELIVERY_FLOOD_COUNT: usize = 640;
const EVENT_DELIVERY_LARGE_EVENT_COUNT: usize = 10;
const EVENT_DELIVERY_LARGE_EVENT_BYTES: usize = 2 * 1024 * 1024;
const SECONDARY_THREAD_ID: &str = "00000000-0000-4000-8000-000000000def";
const SECONDARY_ITEM_STARTED_AT_MS: u64 = 1_700_000_000_000;

impl AppServerState {
    pub(super) fn handle_initialize<W: Write>(
        &mut self,
        id: Value,
        params: &Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
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

    pub(super) fn handle_thread_start<W: Write>(
        &mut self,
        id: Value,
        params: &Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
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
            string_param(params, "model").map(str::to_string),
            string_param(params, "modelProvider").map(str::to_string),
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
            Scenario::ServerRequestBeforeResponse | Scenario::NullIdServerRequestBeforeResponse => {
                let request_id = if self.scenario == Scenario::NullIdServerRequestBeforeResponse {
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
            Scenario::RuntimeTurnComplete | Scenario::SecondaryThreadNotifications => {
                write_json_line(output, &thread_started_notification(&thread_id))?;
                write_success(output, id, result)?;
            }
            Scenario::SplitNotificationAfterThreadStart => {
                write_success(output, id, result)?;
                self.pending_split_stdout_suffix = Some(write_split_json_line_prefix(
                    output,
                    &server_notification(),
                )?);
            }
            _ => {
                write_success(output, id, result)?;
            }
        }
        Ok(ServerAction::Continue)
    }

    pub(super) fn handle_thread_resume<W: Write>(
        &mut self,
        id: Value,
        params: &Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
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
            string_param(params, "model").map(str::to_string),
            string_param(params, "modelProvider").map(str::to_string),
        );
        let response_thread_id = if self.scenario == Scenario::ResumeDifferentThreadId {
            "0193abcd-ef01-7234-89ab-cdef01234568"
        } else {
            thread_id
        };
        write_success(output, id, thread_response(response_thread_id, true))?;
        Ok(ServerAction::Continue)
    }

    pub(super) fn handle_turn_start<W: Write>(
        &mut self,
        id: Value,
        params: &Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        if !self.initialized {
            write_error(output, id, INVALID_REQUEST, "app server is not initialized")?;
            return Ok(ServerAction::Continue);
        }
        if self.scenario == Scenario::ExitOnTurnStart {
            return Ok(ServerAction::Stop);
        }
        if self.scenario == Scenario::ExitOnTurnStartWithStderrHolder {
            spawn_stderr_holder()?;
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
        let thread_request_model = current_thread.thread_request_model.clone();
        let thread_request_model_provider = current_thread.thread_request_model_provider.clone();
        let inputs = match text_inputs(params) {
            Ok(inputs) => inputs,
            Err(message) => {
                write_error(output, id, INVALID_REQUEST, &message)?;
                return Ok(ServerAction::Continue);
            }
        };

        let turn_id = Uuid::now_v7().to_string();
        if !matches!(
            self.scenario,
            Scenario::NoActiveTurn | Scenario::RuntimeTurnStartedBeforeSteer
        ) && let Some(current_thread) = &mut self.current_thread
        {
            current_thread.active_turn_id = Some(turn_id.clone());
        }
        self.initial_inputs.extend(inputs.iter().cloned());
        persist_input_events(
            &InputEventContext {
                artifact_thread_id: &artifact_thread_id,
                thread_id: &thread_id,
                turn_id: &turn_id,
                kind: "initial",
                thread_request_has_runtime_workspace_roots,
                thread_request_model: thread_request_model.as_deref(),
                thread_request_model_provider: thread_request_model_provider.as_deref(),
                turn_params: params,
            },
            &inputs,
        )?;
        write_success(output, id, json!({ "turn": turn(&turn_id) }))?;
        if self.scenario == Scenario::UnexpectedThreadOutputItemStarted {
            write_json_line(
                output,
                &reasoning_item_started_notification(
                    "unexpected-thread-id",
                    &turn_id,
                    "unexpected-thread-reasoning-item",
                    1_700_000_000_000,
                ),
            )?;
            return Ok(ServerAction::Stop);
        }
        if self.scenario == Scenario::UnexpectedTurnOutputItemStarted {
            write_json_line(
                output,
                &reasoning_item_started_notification(
                    &thread_id,
                    "unexpected-turn-id",
                    "unexpected-turn-reasoning-item",
                    1_700_000_000_000,
                ),
            )?;
            return Ok(ServerAction::Stop);
        }
        if self.scenario == Scenario::UnexpectedThreadTurnCompleted {
            write_json_line(
                output,
                &turn_completed_notification("unexpected-thread-id", &turn_id),
            )?;
            return Ok(ServerAction::Stop);
        }
        if self.scenario == Scenario::SecondaryThreadNotifications {
            write_secondary_thread_notifications(output, &thread_id, &turn_id)?;
            return Ok(ServerAction::Continue);
        }
        if self.scenario.writes_turn_started_before_steer() {
            if let Some(current_thread) = &mut self.current_thread
                && self.scenario == Scenario::RuntimeTurnStartedBeforeSteer
            {
                current_thread.active_turn_id = Some(turn_id.clone());
            }
            write_json_line(output, &turn_started_notification(&thread_id, &turn_id))?;
        }
        if matches!(
            self.scenario,
            Scenario::RuntimeTurnComplete | Scenario::RuntimeTurnCompleteWithoutThreadStarted
        ) {
            write_turn_notifications(output, &thread_id, &turn_id)?;
        }
        if self.scenario == Scenario::RuntimeEventFlood {
            write_json_line(output, &turn_started_notification(&thread_id, &turn_id))?;
            for index in 0..EVENT_DELIVERY_FLOOD_COUNT {
                write_json_line(output, &warning_notification(&thread_id, index))?;
                thread::sleep(std::time::Duration::from_millis(1));
            }
            write_json_line(output, &turn_completed_notification(&thread_id, &turn_id))?;
        }
        if self.scenario == Scenario::RuntimeLargeEventFlood {
            write_json_line(output, &turn_started_notification(&thread_id, &turn_id))?;
            for index in 0..EVENT_DELIVERY_LARGE_EVENT_COUNT {
                write_json_line(
                    output,
                    &large_warning_notification(
                        &thread_id,
                        index,
                        EVENT_DELIVERY_LARGE_EVENT_BYTES,
                    ),
                )?;
                thread::sleep(std::time::Duration::from_millis(50));
            }
            write_json_line(output, &turn_completed_notification(&thread_id, &turn_id))?;
        }
        Ok(ServerAction::Continue)
    }

    pub(super) fn handle_turn_steer<W: Write>(
        &mut self,
        id: Value,
        params: &Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        if !self.initialized {
            write_error(output, id, INVALID_REQUEST, "app server is not initialized")?;
            return Ok(ServerAction::Continue);
        }
        if self.scenario == Scenario::ExitOnTurnSteer {
            return Ok(ServerAction::Stop);
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
        let thread_request_model = current_thread.thread_request_model.clone();
        let thread_request_model_provider = current_thread.thread_request_model_provider.clone();
        let inputs = match text_inputs(params) {
            Ok(inputs) => inputs,
            Err(message) => {
                write_error(output, id, INVALID_REQUEST, &message)?;
                return Ok(ServerAction::Continue);
            }
        };
        self.steered_inputs.extend(inputs.iter().cloned());
        persist_input_events(
            &InputEventContext {
                artifact_thread_id: &artifact_thread_id,
                thread_id: &thread_id,
                turn_id: &active_turn_id,
                kind: "steered",
                thread_request_has_runtime_workspace_roots,
                thread_request_model: thread_request_model.as_deref(),
                thread_request_model_provider: thread_request_model_provider.as_deref(),
                turn_params: params,
            },
            &inputs,
        )?;
        if self.scenario == Scenario::RuntimeTurnCompleteBeforeSteerResponse {
            write_turn_completion_notifications(output, &thread_id, &active_turn_id)?;
        }
        write_success(output, id, json!({ "turnId": active_turn_id }))?;
        if self.scenario == Scenario::RuntimeTurnCompleteAfterSteer {
            write_turn_notifications(output, &thread_id, &active_turn_id)?;
        }
        if self.scenario == Scenario::RuntimeTurnStartedBeforeSteer {
            write_turn_completion_notifications(output, &thread_id, &active_turn_id)?;
        }
        Ok(ServerAction::Continue)
    }

    pub(super) fn handle_mock_inputs<W: Write>(
        &mut self,
        id: Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
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

    pub(super) fn handle_mock_state<W: Write>(
        &mut self,
        id: Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
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

    pub(super) fn handle_mock_complete_split_notification<W: Write>(
        &mut self,
        id: Value,
        output: &mut W,
    ) -> io::Result<ServerAction> {
        let Some(suffix) = self.pending_split_stdout_suffix.take() else {
            write_error(output, id, INVALID_REQUEST, "missing split notification")?;
            return Ok(ServerAction::Continue);
        };
        write!(output, "{suffix}")?;
        output.flush()?;
        write_success(output, id, json!({ "completed": true }))?;
        Ok(ServerAction::Continue)
    }
}

fn write_secondary_thread_notifications<W: Write>(
    output: &mut W,
    thread_id: &str,
    turn_id: &str,
) -> io::Result<()> {
    write_json_line(output, &thread_started_notification(SECONDARY_THREAD_ID))?;
    write_json_line(output, &warning_notification(thread_id, 0))?;
    write_json_line(
        output,
        &turn_started_notification(SECONDARY_THREAD_ID, turn_id),
    )?;
    write_json_line(
        output,
        &agent_message_item_started_notification(
            SECONDARY_THREAD_ID,
            turn_id,
            "secondary-agent-message-item",
            SECONDARY_ITEM_STARTED_AT_MS,
        ),
    )?;
    write_json_line(
        output,
        &assistant_item_completed_notification(thread_id, turn_id),
    )?;
    write_json_line(output, &warning_notification(SECONDARY_THREAD_ID, 1))?;
    write_json_line(
        output,
        &assistant_item_completed_notification(SECONDARY_THREAD_ID, turn_id),
    )?;
    write_json_line(
        output,
        &turn_completed_notification(SECONDARY_THREAD_ID, turn_id),
    )?;
    write_json_line(output, &turn_completed_notification(thread_id, turn_id))
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
