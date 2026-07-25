use crate::session;
use serde_json::{Value, json};
use std::io::{self, Write};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const LARGE_NOTIFICATION_MESSAGE_BYTES: usize = 17 * 1024 * 1024;

pub(super) fn initialize_response() -> Value {
    json!({
        "userAgent": format!("guest-mock-codex-app-server/{}", env!("CARGO_PKG_VERSION")),
        "codexHome": session::codex_home(),
        "platformFamily": std::env::consts::FAMILY,
        "platformOs": std::env::consts::OS,
    })
}

pub(super) fn thread_response(thread_id: &str, resume: bool) -> Value {
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

pub(super) fn server_notification() -> Value {
    server_notification_with_index(0)
}

pub(super) fn server_notification_with_index(index: usize) -> Value {
    json!({
        "method": "experimental/server-notification",
        "params": {
            "message": "guest-mock-codex notification",
            "index": index
        }
    })
}

pub(super) fn large_server_notification() -> Value {
    json!({
        "method": "experimental/server-notification",
        "params": {
            "message": "x".repeat(LARGE_NOTIFICATION_MESSAGE_BYTES),
        }
    })
}

pub(super) fn thread_started_notification(thread_id: &str) -> Value {
    json!({
        "method": "thread/started",
        "params": {
            "thread": thread(thread_id)
        }
    })
}

pub(super) fn turn_started_notification(thread_id: &str, turn_id: &str) -> Value {
    json!({
        "method": "turn/started",
        "params": {
            "threadId": thread_id,
            "turn": turn(turn_id)
        }
    })
}

pub(super) fn reasoning_item_started_notification(
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
    started_at_ms: u64,
) -> Value {
    json!({
        "method": "item/started",
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
            "startedAtMs": started_at_ms,
            "item": {
                "id": item_id,
                "type": "reasoning",
                "summary": ["mock reasoning content must not enter timing telemetry"],
                "content": []
            }
        }
    })
}

pub(super) fn agent_message_item_started_notification(
    thread_id: &str,
    turn_id: &str,
    item_id: &str,
    started_at_ms: u64,
) -> Value {
    json!({
        "method": "item/started",
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
            "startedAtMs": started_at_ms,
            "item": {
                "id": item_id,
                "type": "agentMessage",
                "text": ""
            }
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

pub(super) fn turn_completed_notification(thread_id: &str, turn_id: &str) -> Value {
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

pub(super) fn warning_notification(thread_id: &str, index: usize) -> Value {
    json!({
        "method": "warning",
        "params": {
            "threadId": thread_id,
            "message": format!("guest-mock-codex warning {index}")
        }
    })
}

pub(super) fn large_warning_notification(
    thread_id: &str,
    index: usize,
    message_bytes: usize,
) -> Value {
    json!({
        "method": "warning",
        "params": {
            "threadId": thread_id,
            "message": format!("{index}:{}", "x".repeat(message_bytes)),
        }
    })
}

pub(super) fn write_turn_notifications<W: Write>(
    output: &mut W,
    thread_id: &str,
    turn_id: &str,
) -> io::Result<()> {
    write_json_line(output, &turn_started_notification(thread_id, turn_id))?;
    let started_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_millis();
    let started_at_ms = u64::try_from(started_at_ms).map_err(io::Error::other)?;
    for (index, offset_ms) in [0_u64, 1].into_iter().enumerate() {
        write_json_line(
            output,
            &reasoning_item_started_notification(
                thread_id,
                turn_id,
                &format!("mock-reasoning-item-{index}"),
                started_at_ms + offset_ms,
            ),
        )?;
    }
    for (index, offset_ms) in [2_u64, 3].into_iter().enumerate() {
        write_json_line(
            output,
            &agent_message_item_started_notification(
                thread_id,
                turn_id,
                &format!("mock-agent-message-item-{index}"),
                started_at_ms + offset_ms,
            ),
        )?;
    }
    write_turn_completion_notifications(output, thread_id, turn_id)
}

pub(super) fn write_turn_completion_notifications<W: Write>(
    output: &mut W,
    thread_id: &str,
    turn_id: &str,
) -> io::Result<()> {
    write_json_line(
        output,
        &assistant_item_completed_notification(thread_id, turn_id),
    )?;
    write_json_line(output, &turn_completed_notification(thread_id, turn_id))
}

pub(super) fn server_request(id: Value) -> Value {
    json!({
        "id": id,
        "method": "experimental/server-request",
        "params": {
            "message": "guest-mock-codex server request"
        }
    })
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

pub(super) fn turn(turn_id: &str) -> Value {
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

pub(super) fn write_success<W: Write>(output: &mut W, id: Value, result: Value) -> io::Result<()> {
    write_json_line(output, &json!({ "id": id, "result": result }))
}

pub(super) fn write_error<W: Write>(
    output: &mut W,
    id: Value,
    code: i64,
    message: &str,
) -> io::Result<()> {
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

pub(super) fn write_json_line<W: Write>(output: &mut W, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, value).map_err(io::Error::other)?;
    writeln!(output)?;
    output.flush()
}

pub(super) fn write_split_json_line_prefix<W: Write>(
    output: &mut W,
    value: &Value,
) -> io::Result<String> {
    const SPLIT_AT: usize = 24;
    let mut line = serde_json::to_string(value).map_err(io::Error::other)?;
    line.push('\n');
    let suffix = line.split_off(SPLIT_AT.min(line.len()));
    write!(output, "{line}")?;
    output.flush()?;
    Ok(suffix)
}
