//! Bounded webhook representation for normalized Codex events.
//!
//! The app-server backend writes the complete normalized event to the local
//! agent log before this module sees the webhook copy. Normal events retain
//! their existing serialization. Only events that cannot fit in one delivery
//! request receive visibly marked content reduction.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

use crate::error::AgentError;

const DELIVERY_NOTICE: &str = "[event content truncated for delivery]";
const MAX_REDUCTION_CANDIDATES: usize = 256;
const MAX_REDUCED_FIELDS: usize = 16;
const RETAINED_CONTENT_ADJUSTMENT_ATTEMPTS: usize = 4;

pub(super) struct PreparedCodexEvent {
    pub(super) serialized: Vec<u8>,
    pub(super) reduction: Option<CodexEventReduction>,
}

pub(super) struct CodexEventReduction {
    pub(super) event_type: &'static str,
    pub(super) item_type: &'static str,
    pub(super) original_bytes: usize,
    pub(super) delivered_bytes: usize,
    pub(super) fields: Vec<&'static str>,
    pub(super) fallback: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PathSegment {
    Key(String),
    Index(usize),
}

#[derive(Clone, Debug)]
struct ContentCandidate {
    path: Vec<PathSegment>,
    path_key: String,
    category: &'static str,
    reducible_bytes: usize,
}

struct SelectedContent {
    path: Vec<PathSegment>,
    original: String,
}

pub(super) fn prepare_for_delivery(
    mut event: Value,
    max_serialized_event_bytes: usize,
) -> Result<PreparedCodexEvent, AgentError> {
    let serialized = serde_json::to_vec(&event)?;
    if serialized.len() <= max_serialized_event_bytes {
        return Ok(PreparedCodexEvent {
            serialized,
            reduction: None,
        });
    }

    let original_bytes = serialized.len();
    drop(serialized);
    let event_type = event_type_label(&event);
    let item_type = item_type_label(&event);
    let mut candidates = collect_content_candidates(&event);
    candidates.sort_by(|left, right| {
        right
            .reducible_bytes
            .cmp(&left.reducible_bytes)
            .then_with(|| left.path_key.cmp(&right.path_key))
    });

    let mut reduced_categories = BTreeSet::new();
    let mut selected = Vec::new();
    let mut reducible_bytes = 0usize;
    for candidate in candidates.iter().take(MAX_REDUCED_FIELDS) {
        let Some(original) = string_at_path(&event, &candidate.path).map(str::to_owned) else {
            continue;
        };
        reduced_categories.insert(candidate.category);
        reducible_bytes = reducible_bytes.saturating_add(candidate.reducible_bytes);
        selected.push(SelectedContent {
            path: candidate.path.clone(),
            original,
        });

        let minimum_bytes = original_bytes.saturating_sub(reducible_bytes);
        if minimum_bytes > max_serialized_event_bytes {
            continue;
        }

        apply_retained_budget(&mut event, &selected, 0, 1)?;
        let minimum = serde_json::to_vec(&event)?;
        if minimum.len() > max_serialized_event_bytes {
            continue;
        }
        let total_original_bytes = selected
            .iter()
            .map(|content| content.original.len())
            .sum::<usize>();
        let available_bytes = max_serialized_event_bytes - minimum.len();
        let mut retained_bytes = available_bytes.min(total_original_bytes);

        for _ in 0..RETAINED_CONTENT_ADJUSTMENT_ATTEMPTS {
            apply_retained_budget(&mut event, &selected, retained_bytes, total_original_bytes)?;
            let serialized = serde_json::to_vec(&event)?;
            if serialized.len() <= max_serialized_event_bytes {
                return Ok(reduced_event(
                    serialized,
                    event_type,
                    item_type,
                    original_bytes,
                    reduced_categories,
                    false,
                ));
            }

            let added_bytes = serialized.len().saturating_sub(minimum.len()).max(1);
            retained_bytes = retained_bytes.saturating_mul(available_bytes) / added_bytes;
        }

        return Ok(reduced_event(
            minimum,
            event_type,
            item_type,
            original_bytes,
            reduced_categories,
            false,
        ));
    }

    let mut fallback_categories = candidates
        .iter()
        .map(|candidate| candidate.category)
        .collect::<BTreeSet<_>>();
    fallback_categories.insert("event_structure");
    let fallback = fallback_event(&event)?;
    let serialized = serde_json::to_vec(&fallback)?;
    if serialized.len() > max_serialized_event_bytes {
        return Err(AgentError::Execution(format!(
            "Codex event delivery fallback is {} bytes, exceeding the {max_serialized_event_bytes}-byte serialized event budget",
            serialized.len()
        )));
    }

    Ok(reduced_event(
        serialized,
        event_type,
        item_type,
        original_bytes,
        fallback_categories,
        true,
    ))
}

fn reduced_event(
    serialized: Vec<u8>,
    event_type: &'static str,
    item_type: &'static str,
    original_bytes: usize,
    fields: BTreeSet<&'static str>,
    fallback: bool,
) -> PreparedCodexEvent {
    let delivered_bytes = serialized.len();
    PreparedCodexEvent {
        serialized,
        reduction: Some(CodexEventReduction {
            event_type,
            item_type,
            original_bytes,
            delivered_bytes,
            fields: fields.into_iter().collect(),
            fallback,
        }),
    }
}

fn collect_content_candidates(event: &Value) -> Vec<ContentCandidate> {
    let item_type = event.pointer("/item/type").and_then(Value::as_str);
    let mut candidates = Vec::new();
    collect_value(event, item_type, &mut Vec::new(), &mut candidates);
    candidates
}

fn collect_value(
    value: &Value,
    item_type: Option<&str>,
    path: &mut Vec<PathSegment>,
    candidates: &mut Vec<ContentCandidate>,
) {
    if candidates.len() >= MAX_REDUCTION_CANDIDATES {
        return;
    }

    match value {
        Value::String(text) if !protected_string(path) => {
            candidates.push(ContentCandidate {
                path: path.clone(),
                path_key: path_key(path),
                category: field_category(path, item_type),
                reducible_bytes: json_string_bytes(text)
                    .saturating_sub(json_string_bytes(&truncated_text(text, 0))),
            });
        }
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                path.push(PathSegment::Index(index));
                collect_value(value, item_type, path, candidates);
                path.pop();
                if candidates.len() >= MAX_REDUCTION_CANDIDATES {
                    break;
                }
            }
        }
        Value::Object(fields) => {
            for (key, value) in fields {
                path.push(PathSegment::Key(key.clone()));
                collect_value(value, item_type, path, candidates);
                path.pop();
                if candidates.len() >= MAX_REDUCTION_CANDIDATES {
                    break;
                }
            }
        }
        _ => {}
    }
}

fn json_string_bytes(value: &str) -> usize {
    value.chars().fold(2usize, |bytes, character| {
        bytes
            + match character {
                '"' | '\\' | '\u{0008}' | '\t' | '\n' | '\u{000c}' | '\r' => 2,
                '\u{0000}'..='\u{001f}' => 6,
                _ => character.len_utf8(),
            }
    })
}

fn apply_retained_budget(
    event: &mut Value,
    selected: &[SelectedContent],
    retained_bytes: usize,
    total_original_bytes: usize,
) -> Result<(), AgentError> {
    let retained_bytes = retained_bytes.min(total_original_bytes);
    let mut allocations = selected
        .iter()
        .map(|content| {
            ((retained_bytes as u128 * content.original.len() as u128)
                / total_original_bytes as u128) as usize
        })
        .collect::<Vec<_>>();
    let allocated = allocations.iter().sum::<usize>();
    let mut remainder = retained_bytes.saturating_sub(allocated);
    while remainder > 0 {
        for (allocation, content) in allocations.iter_mut().zip(selected) {
            if *allocation < content.original.len() {
                *allocation += 1;
                remainder -= 1;
                if remainder == 0 {
                    break;
                }
            }
        }
    }

    for (content, allocation) in selected.iter().zip(allocations) {
        set_string_at_path(
            event,
            &content.path,
            truncated_text(&content.original, allocation),
        )?;
    }
    Ok(())
}

fn protected_string(path: &[PathSegment]) -> bool {
    let Some(PathSegment::Key(key)) = path.last() else {
        return false;
    };
    matches!(
        key.as_str(),
        "id" | "type" | "status" | "kind" | "thread_id" | "turn_id"
    )
}

fn field_category(path: &[PathSegment], item_type: Option<&str>) -> &'static str {
    let keys = path
        .iter()
        .filter_map(|segment| match segment {
            PathSegment::Key(key) => Some(key.as_str()),
            PathSegment::Index(_) => None,
        })
        .collect::<Vec<_>>();

    match keys.as_slice() {
        ["item", "text"] => match item_type {
            Some("agent_message") => "agent_message_text",
            Some("reasoning") => "reasoning_text",
            Some("plan") => "plan_text",
            _ => "item_text",
        },
        ["item", "aggregated_output"] | ["item", "output"] => "command_output",
        ["item", "command"] => "command",
        ["item", "changes", "diff"] => "file_diff",
        ["item", "changes", "path"] => "file_path",
        ["plan", "step"] => "plan_step",
        ["explanation"] => "plan_explanation",
        ["message"] | ["error", "message"] | ["turn", "error", "message"] => "message",
        _ => "other_content",
    }
}

fn path_key(path: &[PathSegment]) -> String {
    let mut output = String::new();
    for segment in path {
        match segment {
            PathSegment::Key(key) => {
                output.push('/');
                output.push_str(key);
            }
            PathSegment::Index(index) => {
                output.push('/');
                output.push_str(&index.to_string());
            }
        }
    }
    output
}

fn string_at_path<'a>(value: &'a Value, path: &[PathSegment]) -> Option<&'a str> {
    let mut current = value;
    for segment in path {
        current = match segment {
            PathSegment::Key(key) => current.get(key)?,
            PathSegment::Index(index) => current.get(*index)?,
        };
    }
    current.as_str()
}

fn set_string_at_path(
    value: &mut Value,
    path: &[PathSegment],
    replacement: String,
) -> Result<(), AgentError> {
    let mut current = value;
    for segment in path {
        current = match segment {
            PathSegment::Key(key) => current.get_mut(key),
            PathSegment::Index(index) => current.get_mut(*index),
        }
        .ok_or_else(|| {
            AgentError::Execution("Codex event reduction path disappeared".to_string())
        })?;
    }
    *current = Value::String(replacement);
    Ok(())
}

fn truncated_text(original: &str, retained_bytes: usize) -> String {
    if retained_bytes >= original.len() {
        return original.to_string();
    }

    let head_target = retained_bytes.div_ceil(2);
    let tail_target = retained_bytes / 2;
    let head_end = floor_char_boundary(original, head_target);
    let tail_start = ceil_char_boundary(original, original.len().saturating_sub(tail_target));
    let preserved = head_end + original.len().saturating_sub(tail_start);
    let omitted = original.len().saturating_sub(preserved);
    format!(
        "{}\n[{omitted} bytes truncated for delivery]\n{}",
        &original[..head_end],
        &original[tail_start..]
    )
}

fn floor_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while !value.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn fallback_event(source: &Value) -> Result<Value, AgentError> {
    let source = source.as_object().ok_or_else(|| {
        AgentError::Execution("normalized Codex event is not an object".to_string())
    })?;
    let mut output = Map::new();
    copy_fields(
        source,
        &mut output,
        &[
            "type",
            "thread_id",
            "turn_id",
            "sequenceNumber",
            "started_at_ms",
            "completed_at_ms",
            "will_retry",
        ],
    );

    if let Some(turn) = source.get("turn").and_then(Value::as_object) {
        let mut retained_turn = Map::new();
        copy_fields(
            turn,
            &mut retained_turn,
            &[
                "id",
                "type",
                "status",
                "started_at",
                "completed_at",
                "duration_ms",
            ],
        );
        if turn.get("error").is_some_and(|error| !error.is_null()) {
            retained_turn.insert("error".to_string(), fallback_error());
        }
        output.insert("turn".to_string(), Value::Object(retained_turn));
    }

    if let Some(item) = source.get("item").and_then(Value::as_object) {
        output.insert("item".to_string(), fallback_item(item));
    }

    match source.get("type").and_then(Value::as_str) {
        Some("turn.plan.updated") => {
            output.insert(
                "plan".to_string(),
                json!([{ "step": DELIVERY_NOTICE, "status": "pending" }]),
            );
            output.insert(
                "explanation".to_string(),
                Value::String(DELIVERY_NOTICE.to_string()),
            );
        }
        Some("warning" | "error") => {
            output.insert(
                "message".to_string(),
                Value::String(DELIVERY_NOTICE.to_string()),
            );
            if source.contains_key("error") {
                output.insert("error".to_string(), fallback_error());
            }
        }
        _ => {}
    }

    Ok(Value::Object(output))
}

fn fallback_item(item: &Map<String, Value>) -> Value {
    let mut output = Map::new();
    copy_fields(
        item,
        &mut output,
        &["id", "type", "status", "exit_code", "duration_ms"],
    );
    if item.get("error").is_some_and(|error| !error.is_null()) {
        output.insert("error".to_string(), fallback_error());
    }
    match item.get("type").and_then(Value::as_str) {
        Some("agent_message" | "reasoning" | "plan") => {
            output.insert(
                "text".to_string(),
                Value::String(DELIVERY_NOTICE.to_string()),
            );
        }
        Some("command_execution") => {
            output.insert(
                "command".to_string(),
                Value::String(DELIVERY_NOTICE.to_string()),
            );
            output.insert(
                "aggregated_output".to_string(),
                Value::String(DELIVERY_NOTICE.to_string()),
            );
        }
        Some("file_change") => {
            output.insert(
                "changes".to_string(),
                json!([{
                    "path": DELIVERY_NOTICE,
                    "diff": DELIVERY_NOTICE,
                }]),
            );
        }
        _ => {}
    }
    Value::Object(output)
}

fn fallback_error() -> Value {
    json!({ "message": DELIVERY_NOTICE })
}

fn copy_fields(source: &Map<String, Value>, output: &mut Map<String, Value>, fields: &[&str]) {
    for field in fields {
        if let Some(value) = source.get(*field) {
            output.insert((*field).to_string(), value.clone());
        }
    }
}

fn event_type_label(event: &Value) -> &'static str {
    match event.get("type").and_then(Value::as_str) {
        Some("thread.started") => "thread.started",
        Some("turn.started") => "turn.started",
        Some("turn.completed") => "turn.completed",
        Some("turn.plan.updated") => "turn.plan.updated",
        Some("item.started") => "item.started",
        Some("item.completed") => "item.completed",
        Some("warning") => "warning",
        Some("error") => "error",
        _ => "other",
    }
}

fn item_type_label(event: &Value) -> &'static str {
    match event.pointer("/item/type").and_then(Value::as_str) {
        Some("agent_message") => "agent_message",
        Some("plan") => "plan",
        Some("reasoning") => "reasoning",
        Some("command_execution") => "command_execution",
        Some("file_change") => "file_change",
        Some(_) => "other",
        None => "none",
    }
}
