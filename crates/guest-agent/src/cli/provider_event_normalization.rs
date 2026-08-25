//! Provider-owned semantic arrays flattened before canonical sequencing.

use serde_json::Value;

use crate::env::Framework;

pub(super) fn normalize_for_sequencing(framework: Framework, event: Value) -> Vec<Value> {
    match framework {
        Framework::ClaudeCode => expand_claude_message_content(event),
        Framework::Codex => expand_codex_file_changes(event),
        Framework::Pi => vec![event],
    }
}

fn expand_claude_message_content(event: Value) -> Vec<Value> {
    let Value::Object(mut outer) = event else {
        return vec![event];
    };
    if !matches!(
        outer.get("type").and_then(Value::as_str),
        Some("assistant" | "user")
    ) {
        return vec![Value::Object(outer)];
    }

    let Some(message) = outer.get_mut("message").and_then(Value::as_object_mut) else {
        return vec![Value::Object(outer)];
    };
    let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) else {
        return vec![Value::Object(outer)];
    };
    if content.len() <= 1 {
        return vec![Value::Object(outer)];
    }

    let blocks = std::mem::take(content);
    let message = message.clone();
    blocks
        .into_iter()
        .map(|block| {
            let mut normalized_outer = outer.clone();
            let mut normalized_message = message.clone();
            normalized_message.insert("content".to_string(), Value::Array(vec![block]));
            normalized_outer.insert("message".to_string(), Value::Object(normalized_message));
            Value::Object(normalized_outer)
        })
        .collect()
}

fn expand_codex_file_changes(event: Value) -> Vec<Value> {
    let Value::Object(mut outer) = event else {
        return vec![event];
    };
    if outer.get("type").and_then(Value::as_str) != Some("item.completed") {
        return vec![Value::Object(outer)];
    }

    let Some(item) = outer.get_mut("item").and_then(Value::as_object_mut) else {
        return vec![Value::Object(outer)];
    };
    if item.get("type").and_then(Value::as_str) != Some("file_change") {
        return vec![Value::Object(outer)];
    }
    let Some(changes) = item.get_mut("changes").and_then(Value::as_array_mut) else {
        return vec![Value::Object(outer)];
    };
    if changes.len() <= 1 {
        return vec![Value::Object(outer)];
    }

    let changes = std::mem::take(changes);
    let item = item.clone();
    changes
        .into_iter()
        .map(|change| {
            let mut normalized_outer = outer.clone();
            let mut normalized_item = item.clone();
            normalized_item.insert("changes".to_string(), Value::Array(vec![change]));
            normalized_outer.insert("item".to_string(), Value::Object(normalized_item));
            Value::Object(normalized_outer)
        })
        .collect()
}
