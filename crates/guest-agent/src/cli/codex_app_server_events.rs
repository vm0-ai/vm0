//! Compatibility mapping from Codex app-server notifications to Codex JSONL events.

use serde_json::{Map, Value, json};

use super::codex_app_server::ServerNotification;

const DELTA_NOTIFICATION_METHODS: &[&str] = &[
    "command/exec/outputDelta",
    "process/outputDelta",
    "item/agentMessage/delta",
    "item/plan/delta",
    "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
    "item/fileChange/patchUpdated",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta",
    "thread/realtime/transcript/delta",
    "thread/realtime/outputAudio/delta",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum TurnStatus {
    Completed,
    Interrupted,
    Failed,
    InProgress,
}

impl TurnStatus {
    fn normalized(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Interrupted => "interrupted",
            Self::Failed => "failed",
            Self::InProgress => "in_progress",
        }
    }

    fn is_failure(self) -> bool {
        matches!(self, Self::Failed | Self::Interrupted)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ItemStatus {
    InProgress,
    Completed,
    Failed,
    Declined,
}

impl ItemStatus {
    fn normalized(self) -> &'static str {
        match self {
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Declined => "declined",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PlanStepStatus {
    Pending,
    InProgress,
    Completed,
}

impl PlanStepStatus {
    fn normalized(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
        }
    }
}

/// Error returned when a supported Codex app-server notification is malformed.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CodexAppServerEventError {
    #[error("codex app-server notification {method} missing params")]
    MissingParams { method: String },
    #[error("codex app-server notification {method} missing field {field}")]
    MissingField { method: String, field: &'static str },
    #[error("codex app-server notification {method} has invalid field {field}")]
    InvalidField { method: String, field: &'static str },
}

/// Convert a Codex app-server notification into the existing Codex JSONL event shape.
///
/// Unsupported notifications and app-server delta notifications return `Ok(None)`.
/// Supported notifications with malformed required fields return an error.
pub fn notification_to_codex_event(
    notification: &ServerNotification,
) -> Result<Option<Value>, CodexAppServerEventError> {
    match notification.method.as_str() {
        "thread/started" => map_thread_started(notification).map(Some),
        "turn/started" => map_turn(notification, "turn.started").map(Some),
        "turn/completed" => map_turn_completed(notification).map(Some),
        "turn/plan/updated" => map_turn_plan_updated(notification).map(Some),
        "item/started" => map_item(notification, "item.started", "started_at_ms", "startedAtMs"),
        "item/completed" => map_item(
            notification,
            "item.completed",
            "completed_at_ms",
            "completedAtMs",
        ),
        "error" => map_error(notification).map(Some),
        "warning" => map_warning(notification).map(Some),
        method if DELTA_NOTIFICATION_METHODS.contains(&method) => Ok(None),
        _ => Ok(None),
    }
}

fn map_thread_started(
    notification: &ServerNotification,
) -> Result<Value, CodexAppServerEventError> {
    let params = required_params(notification)?;
    let thread = required_object_field(params, &notification.method, "thread")?;
    let thread_id = required_string_field(thread, &notification.method, "thread.id")?;

    Ok(json!({
        "type": "thread.started",
        "thread_id": thread_id,
    }))
}

fn map_turn(
    notification: &ServerNotification,
    event_type: &'static str,
) -> Result<Value, CodexAppServerEventError> {
    let params = required_params(notification)?;
    let params_object = params
        .as_object()
        .ok_or_else(|| invalid_field(notification, "params"))?;
    let thread_id = required_string_field(params_object, &notification.method, "threadId")?;
    let turn = required_object_field(params, &notification.method, "turn")?;
    let status = required_turn_status_field(turn, &notification.method, "turn.status")?;
    if event_type == "turn.started" && status != TurnStatus::InProgress {
        return Err(invalid_field_for_method(
            &notification.method,
            "turn.status",
        ));
    }
    if status == TurnStatus::InProgress && non_null_field(turn, "error") {
        return Err(invalid_field_for_method(&notification.method, "turn.error"));
    }

    Ok(json!({
        "type": event_type,
        "thread_id": thread_id,
        "turn": normalize_turn_with_status(turn, &notification.method, status)?,
    }))
}

fn map_turn_completed(
    notification: &ServerNotification,
) -> Result<Value, CodexAppServerEventError> {
    let params = required_params(notification)?;
    let params_object = params
        .as_object()
        .ok_or_else(|| invalid_field(notification, "params"))?;
    let thread_id = required_string_field(params_object, &notification.method, "threadId")?;
    let turn = required_object_field(params, &notification.method, "turn")?;
    let status = required_turn_status_field(turn, &notification.method, "turn.status")?;
    if status == TurnStatus::InProgress {
        return Err(invalid_field_for_method(
            &notification.method,
            "turn.status",
        ));
    }
    if status == TurnStatus::Completed && non_null_field(turn, "error") {
        return Err(invalid_field_for_method(&notification.method, "turn.error"));
    }
    let normalized_turn = normalize_turn_with_status(turn, &notification.method, status)?;

    if status.is_failure() {
        return Ok(json!({
            "type": "turn.failed",
            "thread_id": thread_id,
            "turn": normalized_turn,
            "error": turn_failure_message(turn, status.normalized()),
        }));
    }

    Ok(json!({
        "type": "turn.completed",
        "thread_id": thread_id,
        "turn": normalized_turn,
    }))
}

fn map_turn_plan_updated(
    notification: &ServerNotification,
) -> Result<Value, CodexAppServerEventError> {
    let params = required_params(notification)?;
    let params_object = params
        .as_object()
        .ok_or_else(|| invalid_field(notification, "params"))?;
    let thread_id = required_string_field(params_object, &notification.method, "threadId")?;
    let turn_id = required_string_field(params_object, &notification.method, "turnId")?;
    let explanation =
        optional_nullable_string_field(params_object, &notification.method, "explanation")?;
    let plan = params_object
        .get("plan")
        .ok_or_else(|| missing_field(&notification.method, "plan"))?
        .as_array()
        .ok_or_else(|| invalid_field_for_method(&notification.method, "plan"))?;
    let plan = plan
        .iter()
        .map(|step| normalize_turn_plan_step(step, &notification.method))
        .collect::<Result<Vec<_>, _>>()?;

    let mut event = Map::new();
    event.insert(
        "type".to_string(),
        Value::String("turn.plan.updated".to_string()),
    );
    event.insert(
        "thread_id".to_string(),
        Value::String(thread_id.to_string()),
    );
    event.insert("turn_id".to_string(), Value::String(turn_id.to_string()));
    event.insert("plan".to_string(), Value::Array(plan));
    if let Some(explanation) = explanation {
        event.insert(
            "explanation".to_string(),
            Value::String(explanation.to_string()),
        );
    }

    Ok(Value::Object(event))
}

fn map_item(
    notification: &ServerNotification,
    event_type: &'static str,
    output_timestamp_field: &'static str,
    input_timestamp_field: &'static str,
) -> Result<Option<Value>, CodexAppServerEventError> {
    let params = required_params(notification)?;
    let params_object = params
        .as_object()
        .ok_or_else(|| invalid_field(notification, "params"))?;
    let thread_id = required_string_field(params_object, &notification.method, "threadId")?;
    let turn_id = required_string_field(params_object, &notification.method, "turnId")?;
    let item = required_object_field(params, &notification.method, "item")?;
    let timestamp =
        required_number_field(params_object, &notification.method, input_timestamp_field)?;
    let Some(normalized_item) = normalize_item(item, &notification.method)? else {
        return Ok(None);
    };

    let mut event = Map::new();
    event.insert("type".to_string(), Value::String(event_type.to_string()));
    event.insert(
        "thread_id".to_string(),
        Value::String(thread_id.to_string()),
    );
    event.insert("turn_id".to_string(), Value::String(turn_id.to_string()));
    event.insert("item".to_string(), normalized_item);
    event.insert(output_timestamp_field.to_string(), timestamp);

    Ok(Some(Value::Object(event)))
}

fn map_error(notification: &ServerNotification) -> Result<Value, CodexAppServerEventError> {
    let params = required_params(notification)?;
    let params_object = params
        .as_object()
        .ok_or_else(|| invalid_field(notification, "params"))?;
    let thread_id = required_string_field(params_object, &notification.method, "threadId")?;
    let turn_id = required_string_field(params_object, &notification.method, "turnId")?;
    let will_retry = required_bool_field(params_object, &notification.method, "willRetry")?;
    let error = required_object_field(params, &notification.method, "error")?;
    let message = required_string_field(error, &notification.method, "error.message")?;
    let normalized_error = normalize_error(error);
    let event_type = if will_retry { "warning" } else { "error" };

    Ok(json!({
        "type": event_type,
        "thread_id": thread_id,
        "turn_id": turn_id,
        "will_retry": will_retry,
        "message": message,
        "error": normalized_error,
    }))
}

fn map_warning(notification: &ServerNotification) -> Result<Value, CodexAppServerEventError> {
    let params = required_params(notification)?;
    let params_object = params
        .as_object()
        .ok_or_else(|| invalid_field(notification, "params"))?;
    let message = required_string_field(params_object, &notification.method, "message")?;
    let thread_id =
        optional_nullable_string_field(params_object, &notification.method, "threadId")?;

    let mut event = Map::new();
    event.insert("type".to_string(), Value::String("warning".to_string()));
    event.insert("message".to_string(), Value::String(message.to_string()));
    if let Some(thread_id) = thread_id {
        event.insert(
            "thread_id".to_string(),
            Value::String(thread_id.to_string()),
        );
    }

    Ok(Value::Object(event))
}

fn normalize_turn_with_status(
    turn: &Map<String, Value>,
    method: &str,
    status: TurnStatus,
) -> Result<Value, CodexAppServerEventError> {
    let mut normalized = Map::new();
    let id = required_string_field(turn, method, "turn.id")?;
    normalized.insert("id".to_string(), Value::String(id.to_string()));

    normalized.insert(
        "status".to_string(),
        Value::String(status.normalized().to_string()),
    );
    if let Some(error) = turn.get("error") {
        normalized.insert("error".to_string(), normalize_optional_error(error));
    }
    copy_optional_field(&mut normalized, "started_at", turn, "startedAt");
    copy_optional_field(&mut normalized, "completed_at", turn, "completedAt");
    copy_optional_field(&mut normalized, "duration_ms", turn, "durationMs");

    Ok(Value::Object(normalized))
}

fn normalize_item(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Option<Value>, CodexAppServerEventError> {
    let item_type = required_string_field(item, method, "item.type")?;
    match item_type {
        "agentMessage" => normalize_agent_message(item, method).map(Some),
        "plan" => normalize_plan(item, method).map(Some),
        "reasoning" => normalize_reasoning(item, method).map(Some),
        "commandExecution" => normalize_command_execution(item, method).map(Some),
        "fileChange" => normalize_file_change_item(item, method).map(Some),
        _ => Ok(None),
    }
}

fn normalize_turn_plan_step(step: &Value, method: &str) -> Result<Value, CodexAppServerEventError> {
    let step = step
        .as_object()
        .ok_or_else(|| invalid_field_for_method(method, "plan[]"))?;
    let text = required_string_field(step, method, "plan[].step")?;
    let status = required_plan_step_status_field(step, method, "plan[].status")?;

    Ok(json!({
        "step": text,
        "status": status.normalized(),
    }))
}

fn normalize_agent_message(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let mut normalized = base_item(item, method, "agent_message")?;
    let text = required_string_field(item, method, "item.text")?;
    normalized.insert("text".to_string(), Value::String(text.to_string()));
    Ok(Value::Object(normalized))
}

fn normalize_plan(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let mut normalized = base_item(item, method, "plan")?;
    let text = required_string_field(item, method, "item.text")?;
    normalized.insert("text".to_string(), Value::String(text.to_string()));
    Ok(Value::Object(normalized))
}

fn normalize_reasoning(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let mut normalized = base_item(item, method, "reasoning")?;
    let mut text_parts = optional_string_array_field(item, method, "summary", "item.summary")?;
    text_parts.extend(optional_string_array_field(
        item,
        method,
        "content",
        "item.content",
    )?);
    if !text_parts.is_empty() {
        normalized.insert("text".to_string(), Value::String(text_parts.join("\n")));
    }
    Ok(Value::Object(normalized))
}

fn normalize_command_execution(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let mut normalized = base_item(item, method, "command_execution")?;
    let command = required_string_field(item, method, "item.command")?;
    normalized.insert("command".to_string(), Value::String(command.to_string()));
    let status = required_lifecycle_item_status_field(item, method, "item.status")?;
    normalized.insert(
        "status".to_string(),
        Value::String(status.normalized().to_string()),
    );
    copy_optional_field(&mut normalized, "cwd", item, "cwd");
    copy_optional_field(
        &mut normalized,
        "aggregated_output",
        item,
        "aggregatedOutput",
    );
    copy_optional_field(&mut normalized, "exit_code", item, "exitCode");
    copy_optional_field(&mut normalized, "duration_ms", item, "durationMs");
    Ok(Value::Object(normalized))
}

fn normalize_file_change_item(
    item: &Map<String, Value>,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let mut normalized = base_item(item, method, "file_change")?;
    let status = required_lifecycle_item_status_field(item, method, "item.status")?;
    normalized.insert(
        "status".to_string(),
        Value::String(status.normalized().to_string()),
    );

    let changes = item
        .get("changes")
        .ok_or_else(|| missing_field(method, "item.changes"))?
        .as_array()
        .ok_or_else(|| invalid_field_for_method(method, "item.changes"))?;
    let normalized_changes = changes
        .iter()
        .map(|change| normalize_file_update_change(change, method))
        .collect::<Result<Vec<_>, _>>()?;
    normalized.insert("changes".to_string(), Value::Array(normalized_changes));

    Ok(Value::Object(normalized))
}

fn normalize_file_update_change(
    change: &Value,
    method: &str,
) -> Result<Value, CodexAppServerEventError> {
    let change = change
        .as_object()
        .ok_or_else(|| invalid_field_for_method(method, "item.changes[]"))?;
    let path = required_string_field(change, method, "item.changes[].path")?;
    let kind = change
        .get("kind")
        .ok_or_else(|| missing_field(method, "item.changes[].kind"))?;

    let mut normalized = Map::new();
    normalized.insert("path".to_string(), Value::String(path.to_string()));
    let normalized_kind = normalize_patch_kind(kind, method)?;
    normalized.insert(
        "kind".to_string(),
        Value::String(normalized_kind.to_string()),
    );
    if let Some(diff) = change.get("diff").and_then(Value::as_str) {
        normalized.insert("diff".to_string(), Value::String(diff.to_string()));
    }
    if normalized_kind == "modify"
        && let Some(move_path) = optional_patch_move_path(kind, method)?
    {
        normalized.insert(
            "move_path".to_string(),
            Value::String(move_path.to_string()),
        );
    }

    Ok(Value::Object(normalized))
}

fn normalize_patch_kind(
    kind: &Value,
    method: &str,
) -> Result<&'static str, CodexAppServerEventError> {
    let (kind, field) = match kind {
        Value::String(kind) => (kind.as_str(), "item.changes[].kind"),
        Value::Object(kind) => (
            required_string_field(kind, method, "item.changes[].kind.type")?,
            "item.changes[].kind.type",
        ),
        _ => {
            return Err(invalid_field_for_method(method, "item.changes[].kind"));
        }
    };

    match kind {
        "add" => Ok("add"),
        "delete" => Ok("delete"),
        "modify" => Ok("modify"),
        "update" => Ok("modify"),
        _ => Err(invalid_field_for_method(method, field)),
    }
}

fn optional_patch_move_path<'a>(
    kind: &'a Value,
    method: &str,
) -> Result<Option<&'a str>, CodexAppServerEventError> {
    let Some(kind) = kind.as_object() else {
        return Ok(None);
    };
    let Some(move_path) = kind.get("move_path") else {
        return Ok(None);
    };
    if move_path.is_null() {
        return Ok(None);
    }
    move_path
        .as_str()
        .map(Some)
        .ok_or_else(|| invalid_field_for_method(method, "item.changes[].kind.move_path"))
}

fn base_item(
    item: &Map<String, Value>,
    method: &str,
    item_type: &'static str,
) -> Result<Map<String, Value>, CodexAppServerEventError> {
    let mut normalized = Map::new();
    let id = required_string_field(item, method, "item.id")?;
    normalized.insert("id".to_string(), Value::String(id.to_string()));
    normalized.insert("type".to_string(), Value::String(item_type.to_string()));
    Ok(normalized)
}

fn normalize_optional_error(error: &Value) -> Value {
    match error {
        Value::Object(error) => normalize_error(error),
        Value::Null => Value::Null,
        value => value.clone(),
    }
}

fn normalize_error(error: &Map<String, Value>) -> Value {
    let mut normalized = Map::new();
    copy_optional_field(&mut normalized, "code", error, "code");
    copy_optional_field(&mut normalized, "error", error, "error");
    copy_optional_field(&mut normalized, "message", error, "message");
    copy_optional_field(
        &mut normalized,
        "additional_details",
        error,
        "additionalDetails",
    );
    copy_optional_field(&mut normalized, "codex_error_info", error, "codexErrorInfo");
    copy_optional_field(&mut normalized, "connectors", error, "connectors");
    copy_optional_field(&mut normalized, "failureReason", error, "failureReason");
    Value::Object(normalized)
}

fn turn_failure_message(turn: &Map<String, Value>, status: &str) -> String {
    turn.get("error")
        .and_then(error_message)
        .unwrap_or_else(|| format!("turn {}", camel_to_snake(status).replace('_', " ")))
}

fn error_message(error: &Value) -> Option<String> {
    match error {
        Value::String(message) => trimmed_message(message),
        Value::Object(error) => combined_message_and_details(
            error.get("message").and_then(Value::as_str),
            error.get("additionalDetails").and_then(Value::as_str),
        ),
        _ => None,
    }
}

fn combined_message_and_details(message: Option<&str>, details: Option<&str>) -> Option<String> {
    match (
        message.and_then(trimmed_message),
        details.and_then(trimmed_message),
    ) {
        (Some(message), Some(details)) => Some(format!("{message} ({details})")),
        (Some(message), None) => Some(message),
        (None, Some(details)) => Some(details),
        (None, None) => None,
    }
}

fn trimmed_message(message: &str) -> Option<String> {
    let message = message.trim();
    if message.is_empty() {
        return None;
    }
    Some(message.to_string())
}

fn required_params(notification: &ServerNotification) -> Result<&Value, CodexAppServerEventError> {
    notification
        .params
        .as_ref()
        .ok_or_else(|| CodexAppServerEventError::MissingParams {
            method: notification.method.clone(),
        })
}

fn required_object_field<'a>(
    value: &'a Value,
    method: &str,
    field: &'static str,
) -> Result<&'a Map<String, Value>, CodexAppServerEventError> {
    value
        .pointer(&format!("/{}", field.replace('.', "/")))
        .ok_or_else(|| missing_field(method, field))?
        .as_object()
        .ok_or_else(|| invalid_field_for_method(method, field))
}

fn required_string_field<'a>(
    object: &'a Map<String, Value>,
    method: &str,
    field: &'static str,
) -> Result<&'a str, CodexAppServerEventError> {
    let key = field.rsplit('.').next().unwrap_or(field);
    object
        .get(key)
        .ok_or_else(|| missing_field(method, field))?
        .as_str()
        .ok_or_else(|| invalid_field_for_method(method, field))
}

fn optional_nullable_string_field<'a>(
    object: &'a Map<String, Value>,
    method: &str,
    field: &'static str,
) -> Result<Option<&'a str>, CodexAppServerEventError> {
    let key = field.rsplit('.').next().unwrap_or(field);
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .map(Some)
        .ok_or_else(|| invalid_field_for_method(method, field))
}

fn required_bool_field(
    object: &Map<String, Value>,
    method: &str,
    field: &'static str,
) -> Result<bool, CodexAppServerEventError> {
    let key = field.rsplit('.').next().unwrap_or(field);
    object
        .get(key)
        .ok_or_else(|| missing_field(method, field))?
        .as_bool()
        .ok_or_else(|| invalid_field_for_method(method, field))
}

fn required_number_field(
    object: &Map<String, Value>,
    method: &str,
    field: &'static str,
) -> Result<Value, CodexAppServerEventError> {
    let key = field.rsplit('.').next().unwrap_or(field);
    let value = object
        .get(key)
        .ok_or_else(|| missing_field(method, field))?;
    if value.is_number() {
        return Ok(value.clone());
    }
    Err(invalid_field_for_method(method, field))
}

fn required_turn_status_field(
    object: &Map<String, Value>,
    method: &str,
    field: &'static str,
) -> Result<TurnStatus, CodexAppServerEventError> {
    let status = required_string_field(object, method, field)?;
    match status {
        "completed" => Ok(TurnStatus::Completed),
        "interrupted" => Ok(TurnStatus::Interrupted),
        "failed" => Ok(TurnStatus::Failed),
        "inProgress" => Ok(TurnStatus::InProgress),
        _ => Err(invalid_field_for_method(method, field)),
    }
}

fn required_plan_step_status_field(
    object: &Map<String, Value>,
    method: &str,
    field: &'static str,
) -> Result<PlanStepStatus, CodexAppServerEventError> {
    let status = required_string_field(object, method, field)?;
    match status {
        "pending" => Ok(PlanStepStatus::Pending),
        "inProgress" => Ok(PlanStepStatus::InProgress),
        "completed" => Ok(PlanStepStatus::Completed),
        _ => Err(invalid_field_for_method(method, field)),
    }
}

fn required_lifecycle_item_status_field(
    object: &Map<String, Value>,
    method: &str,
    field: &'static str,
) -> Result<ItemStatus, CodexAppServerEventError> {
    let status = required_string_field(object, method, field)?;
    let status = match status {
        "inProgress" => ItemStatus::InProgress,
        "completed" => ItemStatus::Completed,
        "failed" => ItemStatus::Failed,
        "declined" => ItemStatus::Declined,
        _ => return Err(invalid_field_for_method(method, field)),
    };
    match (method, status) {
        ("item/started", ItemStatus::InProgress) => Ok(status),
        ("item/completed", ItemStatus::Completed | ItemStatus::Failed | ItemStatus::Declined) => {
            Ok(status)
        }
        ("item/started" | "item/completed", _) => Err(invalid_field_for_method(method, field)),
        _ => Ok(status),
    }
}

fn optional_string_array_field(
    object: &Map<String, Value>,
    method: &str,
    key: &'static str,
    field: &'static str,
) -> Result<Vec<String>, CodexAppServerEventError> {
    let Some(values) = object.get(key) else {
        return Ok(Vec::new());
    };
    if values.is_null() {
        return Ok(Vec::new());
    }
    let values = values
        .as_array()
        .ok_or_else(|| invalid_field_for_method(method, field))?;

    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| invalid_field_for_method(method, field))
        })
        .collect()
}

fn copy_optional_field(
    output: &mut Map<String, Value>,
    output_key: &'static str,
    input: &Map<String, Value>,
    input_key: &'static str,
) {
    if let Some(value) = input.get(input_key) {
        output.insert(output_key.to_string(), value.clone());
    }
}

fn non_null_field(object: &Map<String, Value>, key: &'static str) -> bool {
    object.get(key).is_some_and(|value| !value.is_null())
}

fn camel_to_snake(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for (index, character) in value.chars().enumerate() {
        if character.is_ascii_uppercase() {
            if index > 0 {
                output.push('_');
            }
            output.push(character.to_ascii_lowercase());
        } else {
            output.push(character);
        }
    }
    output
}

fn missing_field(method: &str, field: &'static str) -> CodexAppServerEventError {
    CodexAppServerEventError::MissingField {
        method: method.to_string(),
        field,
    }
}

fn invalid_field(
    notification: &ServerNotification,
    field: &'static str,
) -> CodexAppServerEventError {
    invalid_field_for_method(&notification.method, field)
}

fn invalid_field_for_method(method: &str, field: &'static str) -> CodexAppServerEventError {
    CodexAppServerEventError::InvalidField {
        method: method.to_string(),
        field,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use agent_diagnostics::FailureReason;

    use crate::events;
    use crate::masker::SecretMasker;

    use super::*;

    fn notification(method: &str, params: Value) -> ServerNotification {
        ServerNotification {
            method: method.to_string(),
            params: Some(params),
        }
    }

    fn mapped_event(method: &str, params: Value) -> Value {
        notification_to_codex_event(&notification(method, params))
            .expect("notification should map")
            .expect("notification should produce an event")
    }

    #[test]
    fn thread_started_maps_to_top_level_thread_id() {
        let event = mapped_event(
            "thread/started",
            json!({
                "thread": {
                    "id": "thread-1",
                    "name": "demo"
                }
            }),
        );

        assert_eq!(
            event,
            json!({
                "type": "thread.started",
                "thread_id": "thread-1"
            })
        );
    }

    #[test]
    fn item_completed_agent_message_maps_to_existing_output_shape() {
        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "agentMessage",
                    "id": "item-1",
                    "text": "hello",
                    "phase": null,
                    "memoryCitation": null
                }
            }),
        );

        assert_eq!(
            event,
            json!({
                "type": "item.completed",
                "thread_id": "thread-1",
                "turn_id": "turn-1",
                "completed_at_ms": 42,
                "item": {
                    "id": "item-1",
                    "type": "agent_message",
                    "text": "hello"
                }
            })
        );
    }

    #[test]
    fn blank_agent_message_text_preserves_agent_message_shape() {
        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "agentMessage",
                    "id": "item-1",
                    "text": "",
                    "phase": null,
                    "memoryCitation": null
                }
            }),
        );

        assert_eq!(
            event.pointer("/item/type").and_then(Value::as_str),
            Some("agent_message")
        );
        assert_eq!(
            event.pointer("/item/text").and_then(Value::as_str),
            Some("")
        );
    }

    #[test]
    fn plan_completed_maps_to_visible_plan_item() {
        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "plan",
                    "id": "plan-1",
                    "text": "1. Inspect logs\n2. Patch retry"
                }
            }),
        );

        assert_eq!(
            event,
            json!({
                "type": "item.completed",
                "thread_id": "thread-1",
                "turn_id": "turn-1",
                "completed_at_ms": 42,
                "item": {
                    "id": "plan-1",
                    "type": "plan",
                    "text": "1. Inspect logs\n2. Patch retry"
                }
            })
        );
    }

    #[test]
    fn turn_plan_updated_maps_to_visible_plan_event() {
        let event = mapped_event(
            "turn/plan/updated",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "explanation": "Current plan",
                "plan": [
                    {"step": "Inspect logs", "status": "completed"},
                    {"step": "Patch retry", "status": "inProgress"},
                    {"step": "Run tests", "status": "pending"}
                ]
            }),
        );

        assert_eq!(
            event,
            json!({
                "type": "turn.plan.updated",
                "thread_id": "thread-1",
                "turn_id": "turn-1",
                "explanation": "Current plan",
                "plan": [
                    {"step": "Inspect logs", "status": "completed"},
                    {"step": "Patch retry", "status": "in_progress"},
                    {"step": "Run tests", "status": "pending"}
                ]
            })
        );
        assert_eq!(
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            None
        );
    }

    #[test]
    fn turn_plan_updated_unknown_step_status_returns_error() {
        let error = notification_to_codex_event(&notification(
            "turn/plan/updated",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "plan": [
                    {"step": "Inspect logs", "status": "cancelled"}
                ]
            }),
        ))
        .expect_err("unknown plan step status should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "turn/plan/updated".to_string(),
                field: "plan[].status"
            }
        );
    }

    #[test]
    fn command_execution_started_and_completed_are_normalized() {
        let started = mapped_event(
            "item/started",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "startedAtMs": 12,
                "item": {
                    "type": "commandExecution",
                    "id": "cmd-1",
                    "command": "echo hi",
                    "cwd": "/workspaces/vm0",
                    "processId": null,
                    "source": "exec",
                    "status": "inProgress",
                    "commandActions": [],
                    "aggregatedOutput": null,
                    "exitCode": null,
                    "durationMs": null
                }
            }),
        );
        let completed = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 34,
                "item": {
                    "type": "commandExecution",
                    "id": "cmd-1",
                    "command": "echo hi",
                    "cwd": "/workspaces/vm0",
                    "processId": null,
                    "source": "exec",
                    "status": "completed",
                    "commandActions": [],
                    "aggregatedOutput": "hi\n",
                    "exitCode": 0,
                    "durationMs": 5
                }
            }),
        );

        assert_eq!(
            started,
            json!({
                "type": "item.started",
                "thread_id": "thread-1",
                "turn_id": "turn-1",
                "started_at_ms": 12,
                "item": {
                    "id": "cmd-1",
                    "type": "command_execution",
                    "command": "echo hi",
                    "status": "in_progress",
                    "cwd": "/workspaces/vm0",
                    "aggregated_output": null,
                    "exit_code": null,
                    "duration_ms": null
                }
            })
        );
        assert_eq!(
            completed,
            json!({
                "type": "item.completed",
                "thread_id": "thread-1",
                "turn_id": "turn-1",
                "completed_at_ms": 34,
                "item": {
                    "id": "cmd-1",
                    "type": "command_execution",
                    "command": "echo hi",
                    "status": "completed",
                    "cwd": "/workspaces/vm0",
                    "aggregated_output": "hi\n",
                    "exit_code": 0,
                    "duration_ms": 5
                }
            })
        );
    }

    #[test]
    fn file_change_maps_changes_to_existing_shape() {
        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "fileChange",
                    "id": "file-1",
                    "status": "completed",
                    "changes": [
                        {
                            "path": "src/lib.rs",
                            "kind": {"type": "update", "move_path": "src/renamed.rs"},
                            "diff": "@@"
                        },
                        {
                            "path": "src/new.rs",
                            "kind": {"type": "add"},
                            "diff": "+++"
                        }
                    ]
                }
            }),
        );

        assert_eq!(
            event.pointer("/item/changes"),
            Some(&json!([
                {
                    "path": "src/lib.rs",
                    "kind": "modify",
                    "move_path": "src/renamed.rs",
                    "diff": "@@"
                },
                {
                    "path": "src/new.rs",
                    "kind": "add",
                    "diff": "+++"
                }
            ]))
        );
    }

    #[test]
    fn file_change_ignores_missing_and_malformed_optional_diff() {
        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "fileChange",
                    "id": "file-1",
                    "status": "completed",
                    "changes": [
                        {
                            "path": "src/lib.rs",
                            "kind": "modify"
                        },
                        {
                            "path": "src/new.rs",
                            "kind": {"type": "add"},
                            "diff": null
                        },
                        {
                            "path": "src/generated.rs",
                            "kind": {"type": "add"},
                            "diff": {"unexpected": true}
                        }
                    ]
                }
            }),
        );

        assert_eq!(
            event.pointer("/item/changes"),
            Some(&json!([
                {
                    "path": "src/lib.rs",
                    "kind": "modify"
                },
                {
                    "path": "src/new.rs",
                    "kind": "add"
                },
                {
                    "path": "src/generated.rs",
                    "kind": "add"
                }
            ]))
        );
    }

    #[test]
    fn reasoning_joins_summary_and_content() {
        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "reasoning",
                    "id": "reason-1",
                    "summary": ["checked schema"],
                    "content": ["mapped final item"]
                }
            }),
        );

        assert_eq!(
            event.pointer("/item/type").and_then(Value::as_str),
            Some("reasoning")
        );
        assert_eq!(
            event.pointer("/item/text").and_then(Value::as_str),
            Some("checked schema\nmapped final item")
        );
    }

    #[test]
    fn reasoning_omits_text_when_summary_and_content_default_empty() {
        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "reasoning",
                    "id": "reason-1"
                }
            }),
        );

        assert_eq!(
            event.pointer("/item/type").and_then(Value::as_str),
            Some("reasoning")
        );
        assert_eq!(event.pointer("/item/text"), None);
    }

    #[test]
    fn reasoning_omits_text_when_summary_and_content_are_null() {
        let event = mapped_event(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "reasoning",
                    "id": "reason-1",
                    "summary": null,
                    "content": null
                }
            }),
        );

        assert_eq!(
            event.pointer("/item/type").and_then(Value::as_str),
            Some("reasoning")
        );
        assert_eq!(event.pointer("/item/text"), None);
    }

    #[test]
    fn completed_turn_preserves_completed_event_shape() {
        let event = mapped_event(
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "items": [],
                    "itemsView": {"type": "complete"},
                    "status": "completed",
                    "error": null,
                    "startedAt": 1,
                    "completedAt": 2,
                    "durationMs": 1000
                }
            }),
        );

        assert_eq!(
            event,
            json!({
                "type": "turn.completed",
                "thread_id": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "completed",
                    "error": null,
                    "started_at": 1,
                    "completed_at": 2,
                    "duration_ms": 1000
                }
            })
        );
    }

    #[test]
    fn turn_started_completed_status_returns_error() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "turn/started".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "items": [],
                    "itemsView": {"type": "complete"},
                    "status": "completed",
                    "error": null,
                    "startedAt": 1,
                    "completedAt": 2,
                    "durationMs": 1000
                }
            })),
        })
        .expect_err("started turn must be in progress");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "turn/started".to_string(),
                field: "turn.status"
            }
        );
    }

    #[test]
    fn turn_started_with_error_returns_error() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "turn/started".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "items": [],
                    "itemsView": {"type": "complete"},
                    "status": "inProgress",
                    "error": {
                        "message": "should not be present",
                        "codexErrorInfo": "badRequest",
                        "additionalDetails": null
                    },
                    "startedAt": 1,
                    "completedAt": null,
                    "durationMs": null
                }
            })),
        })
        .expect_err("in-progress turn cannot carry a failure error");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "turn/started".to_string(),
                field: "turn.error"
            }
        );
    }

    #[test]
    fn completed_turn_with_error_returns_error() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "turn/completed".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "items": [],
                    "itemsView": {"type": "complete"},
                    "status": "completed",
                    "error": {
                        "message": "should not be present",
                        "codexErrorInfo": "badRequest",
                        "additionalDetails": null
                    },
                    "startedAt": 1,
                    "completedAt": 2,
                    "durationMs": 1000
                }
            })),
        })
        .expect_err("completed turn cannot carry a failure error");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "turn/completed".to_string(),
                field: "turn.error"
            }
        );
    }

    #[test]
    fn failed_turn_completed_maps_to_existing_failure_shape() {
        let event = mapped_event(
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "items": [],
                    "itemsView": {"type": "complete"},
                    "status": "failed",
                    "error": {
                        "message": "turn failed",
                        "codexErrorInfo": "serverOverloaded",
                        "additionalDetails": "capacity"
                    },
                    "startedAt": 1,
                    "completedAt": 2,
                    "durationMs": 1000
                }
            }),
        );
        let diagnostic =
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
                .expect("failed turn should produce a diagnostic");

        assert_eq!(
            event.pointer("/type").and_then(Value::as_str),
            Some("turn.failed")
        );
        assert_eq!(
            event.pointer("/error").and_then(Value::as_str),
            Some("turn failed (capacity)")
        );
        assert_eq!(
            event.pointer("/turn/error/codex_error_info"),
            Some(&json!("serverOverloaded"))
        );
        assert_eq!(diagnostic.event_type, "turn.failed");
        assert_eq!(diagnostic.message, "turn failed (capacity)");
        assert_eq!(
            diagnostic.failure_reason,
            Some(FailureReason::ProviderOverloaded)
        );
    }

    #[test]
    fn interrupted_turn_completed_maps_to_failure_shape() {
        let event = mapped_event(
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "items": [],
                    "itemsView": {"type": "complete"},
                    "status": "interrupted",
                    "error": null,
                    "startedAt": 1,
                    "completedAt": 2,
                    "durationMs": 1000
                }
            }),
        );

        assert_eq!(
            event.pointer("/type").and_then(Value::as_str),
            Some("turn.failed")
        );
        assert_eq!(
            event.pointer("/error").and_then(Value::as_str),
            Some("turn interrupted")
        );
    }

    #[test]
    fn error_maps_to_existing_error_diagnostic_shape() {
        let event = mapped_event(
            "error",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "willRetry": false,
                "error": {
                    "message": "server rejected request",
                    "codexErrorInfo": "badRequest",
                    "additionalDetails": "policy denied"
                }
            }),
        );
        let diagnostic =
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
                .expect("error event should produce a diagnostic");

        assert_eq!(
            event,
            json!({
                "type": "error",
                "thread_id": "thread-1",
                "turn_id": "turn-1",
                "will_retry": false,
                "message": "server rejected request",
                "error": {
                    "message": "server rejected request",
                    "codex_error_info": "badRequest",
                    "additional_details": "policy denied"
                }
            })
        );
        assert_eq!(diagnostic.event_type, "error");
        assert_eq!(diagnostic.message, "server rejected request");
    }

    #[test]
    fn retryable_error_maps_to_non_failure_warning() {
        let event = mapped_event(
            "error",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "willRetry": true,
                "error": {
                    "message": "temporary stream disconnect",
                    "codexErrorInfo": "serverOverloaded",
                    "additionalDetails": "retrying"
                }
            }),
        );

        assert_eq!(
            event,
            json!({
                "type": "warning",
                "thread_id": "thread-1",
                "turn_id": "turn-1",
                "will_retry": true,
                "message": "temporary stream disconnect",
                "error": {
                    "message": "temporary stream disconnect",
                    "codex_error_info": "serverOverloaded",
                    "additional_details": "retrying"
                }
            })
        );
        assert_eq!(
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            None
        );
    }

    #[test]
    fn error_preserves_code_for_failure_reason_classification() {
        let event = mapped_event(
            "error",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "willRetry": false,
                "error": {
                    "code": "invalid_api_key",
                    "message": "Incorrect API key provided"
                }
            }),
        );
        let diagnostic =
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
                .expect("error event should produce a diagnostic");

        assert_eq!(
            event.pointer("/error/code"),
            Some(&json!("invalid_api_key"))
        );
        assert_eq!(
            diagnostic.failure_reason,
            Some(FailureReason::InvalidApiKey)
        );
    }

    #[test]
    fn failed_turn_preserves_refresh_failure_fields_for_classification() {
        let event = mapped_event(
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "failed",
                    "error": {
                        "code": "TOKEN_REFRESH_FAILED",
                        "message": "Access token expired and refresh failed for: codex-oauth-token.",
                        "connectors": ["codex-oauth-token"],
                        "failureReason": "reconnect_required"
                    }
                }
            }),
        );
        let diagnostic =
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
                .expect("failed turn should produce a diagnostic");

        assert_eq!(
            event.pointer("/turn/error/code"),
            Some(&json!("TOKEN_REFRESH_FAILED"))
        );
        assert_eq!(
            event.pointer("/turn/error/connectors"),
            Some(&json!(["codex-oauth-token"]))
        );
        assert_eq!(
            event.pointer("/turn/error/failureReason"),
            Some(&json!("reconnect_required"))
        );
        assert_eq!(
            diagnostic.failure_reason,
            Some(FailureReason::ReconnectRequired)
        );
    }

    #[test]
    fn warning_maps_to_non_failure_event() {
        let event = mapped_event(
            "warning",
            json!({
                "threadId": "thread-1",
                "message": "configuration warning"
            }),
        );

        assert_eq!(
            event,
            json!({
                "type": "warning",
                "thread_id": "thread-1",
                "message": "configuration warning"
            })
        );
        assert_eq!(
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            None
        );
    }

    #[test]
    fn warning_with_null_thread_id_omits_thread_id() {
        let event = mapped_event(
            "warning",
            json!({
                "threadId": null,
                "message": "global warning"
            }),
        );

        assert_eq!(
            event,
            json!({
                "type": "warning",
                "message": "global warning"
            })
        );
    }

    #[test]
    fn warning_without_thread_id_omits_thread_id() {
        let event = mapped_event(
            "warning",
            json!({
                "message": "global warning"
            }),
        );

        assert_eq!(
            event,
            json!({
                "type": "warning",
                "message": "global warning"
            })
        );
    }

    #[test]
    fn delta_notifications_do_not_produce_visible_events() {
        for method in DELTA_NOTIFICATION_METHODS {
            let result = notification_to_codex_event(&notification(
                method,
                json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-1",
                    "delta": "partial"
                }),
            ))
            .expect("delta notification should be ignored without error");

            assert_eq!(result, None, "method should not emit an event: {method}");
        }
    }

    #[test]
    fn unknown_notification_method_is_ignored() {
        let result = notification_to_codex_event(&notification(
            "thread/status/changed",
            json!({"threadId": "thread-1"}),
        ))
        .expect("unknown notification should not fail");

        assert_eq!(result, None);
    }

    #[test]
    fn unsupported_item_variant_is_ignored_after_payload_validation() {
        let result = notification_to_codex_event(&notification(
            "item/completed",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "webSearch",
                    "id": "search-1",
                    "query": "codex app-server",
                    "action": null
                }
            }),
        ))
        .expect("unsupported item variant should not fail");

        assert_eq!(result, None);
    }

    #[test]
    fn malformed_supported_notification_returns_error() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "thread/started".to_string(),
            params: Some(json!({"thread": {}})),
        })
        .expect_err("missing thread id should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::MissingField {
                method: "thread/started".to_string(),
                field: "thread.id"
            }
        );
    }

    #[test]
    fn item_notification_missing_required_timestamp_returns_error() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "item/completed".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "type": "agentMessage",
                    "id": "item-1",
                    "text": "hello",
                    "phase": null,
                    "memoryCitation": null
                }
            })),
        })
        .expect_err("missing completedAtMs should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::MissingField {
                method: "item/completed".to_string(),
                field: "completedAtMs"
            }
        );
    }

    #[test]
    fn turn_notification_missing_required_status_returns_error() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "turn/completed".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "items": [],
                    "itemsView": {"type": "complete"},
                    "error": null,
                    "startedAt": 1,
                    "completedAt": 2,
                    "durationMs": 1000
                }
            })),
        })
        .expect_err("missing turn status should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::MissingField {
                method: "turn/completed".to_string(),
                field: "turn.status"
            }
        );
    }

    #[test]
    fn turn_notification_unknown_status_returns_error() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "turn/completed".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "items": [],
                    "itemsView": {"type": "complete"},
                    "status": "cancelled",
                    "error": null,
                    "startedAt": 1,
                    "completedAt": 2,
                    "durationMs": 1000
                }
            })),
        })
        .expect_err("unknown turn status should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "turn/completed".to_string(),
                field: "turn.status"
            }
        );
    }

    #[test]
    fn turn_completed_in_progress_status_returns_error() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "turn/completed".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "items": [],
                    "itemsView": {"type": "complete"},
                    "status": "inProgress",
                    "error": null,
                    "startedAt": 1,
                    "completedAt": null,
                    "durationMs": null
                }
            })),
        })
        .expect_err("completed notification cannot carry an in-progress turn");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "turn/completed".to_string(),
                field: "turn.status"
            }
        );
    }

    #[test]
    fn command_execution_unknown_status_returns_error() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "item/completed".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "commandExecution",
                    "id": "cmd-1",
                    "command": "echo hi",
                    "cwd": "/workspaces/vm0",
                    "processId": null,
                    "source": "exec",
                    "status": "queued",
                    "commandActions": [],
                    "aggregatedOutput": null,
                    "exitCode": null,
                    "durationMs": null
                }
            })),
        })
        .expect_err("unknown command status should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "item/completed".to_string(),
                field: "item.status"
            }
        );
    }

    #[test]
    fn item_completed_in_progress_status_returns_error() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "item/completed".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "commandExecution",
                    "id": "cmd-1",
                    "command": "echo hi",
                    "cwd": "/workspaces/vm0",
                    "processId": null,
                    "source": "exec",
                    "status": "inProgress",
                    "commandActions": [],
                    "aggregatedOutput": null,
                    "exitCode": null,
                    "durationMs": null
                }
            })),
        })
        .expect_err("completed item cannot remain in progress");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "item/completed".to_string(),
                field: "item.status"
            }
        );
    }

    #[test]
    fn item_started_completed_status_returns_error() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "item/started".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "startedAtMs": 42,
                "item": {
                    "type": "fileChange",
                    "id": "file-1",
                    "status": "completed",
                    "changes": [
                        {
                            "path": "src/lib.rs",
                            "kind": {"type": "update", "move_path": null},
                            "diff": "@@"
                        }
                    ]
                }
            })),
        })
        .expect_err("started item must be in progress");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "item/started".to_string(),
                field: "item.status"
            }
        );
    }

    #[test]
    fn file_change_unknown_status_returns_error() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "item/completed".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "fileChange",
                    "id": "file-1",
                    "status": "queued",
                    "changes": [
                        {
                            "path": "src/lib.rs",
                            "kind": {"type": "update", "move_path": null},
                            "diff": "@@"
                        }
                    ]
                }
            })),
        })
        .expect_err("unknown file change status should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "item/completed".to_string(),
                field: "item.status"
            }
        );
    }

    #[test]
    fn file_change_unknown_kind_returns_error() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "item/completed".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "fileChange",
                    "id": "file-1",
                    "status": "completed",
                    "changes": [
                        {
                            "path": "src/lib.rs",
                            "kind": {"type": "rename"},
                            "diff": "@@"
                        }
                    ]
                }
            })),
        })
        .expect_err("unknown file change kind should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "item/completed".to_string(),
                field: "item.changes[].kind.type"
            }
        );
    }

    #[test]
    fn file_change_non_string_move_path_returns_error() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "item/completed".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "completedAtMs": 42,
                "item": {
                    "type": "fileChange",
                    "id": "file-1",
                    "status": "completed",
                    "changes": [
                        {
                            "path": "src/lib.rs",
                            "kind": {"type": "update", "move_path": 7},
                            "diff": "@@"
                        }
                    ]
                }
            })),
        })
        .expect_err("non-string move path should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "item/completed".to_string(),
                field: "item.changes[].kind.move_path"
            }
        );
    }

    #[test]
    fn error_notification_missing_required_will_retry_returns_error() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "error".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "error": {
                    "message": "server rejected request",
                    "codexErrorInfo": "badRequest",
                    "additionalDetails": "policy denied"
                }
            })),
        })
        .expect_err("missing willRetry should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::MissingField {
                method: "error".to_string(),
                field: "willRetry"
            }
        );
    }

    #[test]
    fn supported_notification_missing_params_returns_error() {
        let error = notification_to_codex_event(&ServerNotification {
            method: "warning".to_string(),
            params: None,
        })
        .expect_err("missing params should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::MissingParams {
                method: "warning".to_string()
            }
        );
    }
}
