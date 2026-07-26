use std::io::{Seek, SeekFrom, Write};

use guest_session_prune::{
    CODEX_COMPACT_GENERATION_MAX_BYTES, CodexHistoryIneligibleReason, CodexHistorySelection,
    select_codex_compact_generation,
};
use serde_json::{Value, json};

const THREAD_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TURN_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

fn line(record_type: &str, payload: Value) -> serde_json::Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(&json!({
        "timestamp": "2026-01-01T00:00:00.000Z",
        "type": record_type,
        "payload": payload,
    }))?;
    bytes.push(b'\n');
    Ok(bytes)
}

#[test]
fn selects_a_small_generation_from_a_source_above_the_public_guard()
-> Result<(), Box<dyn std::error::Error>> {
    let canonical = line(
        "session_meta",
        json!({
            "session_id": THREAD_ID,
            "id": THREAD_ID,
            "timestamp": "2026-01-01T00:00:00.000Z",
            "cwd": "/workspace",
            "originator": "codex_exec",
            "cli_version": "0.145.0",
            "source": "exec",
            "model_provider": "mock",
            "history_mode": "legacy",
        }),
    )?;
    let retained = [
        line(
            "event_msg",
            json!({
                "type": "task_started",
                "turn_id": TURN_ID,
                "model_context_window": 258400,
                "collaboration_mode_kind": "default",
            }),
        )?,
        line(
            "event_msg",
            json!({
                "type": "user_message",
                "message": "continue",
                "images": [],
                "local_images": [],
                "audio": [],
                "local_audio": [],
                "text_elements": [],
            }),
        )?,
        line(
            "turn_context",
            json!({
                "turn_id": TURN_ID,
                "cwd": "/workspace",
                "approval_policy": {"granular": {"sandbox_approval": true}},
                "sandbox_policy": {"type": "read_only"},
                "model": "gpt-test",
                "summary": "auto",
            }),
        )?,
        line(
            "compacted",
            json!({
                "message": "retained summary",
                "replacement_history": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "output_text",
                        "text": "retained summary",
                    }],
                }],
            }),
        )?,
        line(
            "world_state",
            json!({
                "full": true,
                "state": {"resources": []},
            }),
        )?,
        line(
            "event_msg",
            json!({
                "type": "task_complete",
                "turn_id": TURN_ID,
                "last_agent_message": "retained summary",
            }),
        )?,
    ];

    let mut file = tempfile::NamedTempFile::new()?;
    file.write_all(&canonical)?;
    file.as_file_mut()
        .set_len(CODEX_COMPACT_GENERATION_MAX_BYTES + 1)?;
    file.as_file_mut().seek(SeekFrom::End(0))?;
    file.write_all(b"\n")?;
    for record in &retained {
        file.write_all(record)?;
    }
    file.flush()?;

    let mut source = file.reopen()?;
    let candidate = match select_codex_compact_generation(&mut source, THREAD_ID)? {
        CodexHistorySelection::Candidate(candidate) => candidate,
        CodexHistorySelection::Ineligible(reason) => {
            return Err(format!("expected candidate, got {reason:?}").into());
        }
    };
    let expected = std::iter::once(canonical)
        .chain(retained)
        .flatten()
        .collect::<Vec<_>>();

    assert!(candidate.source_size() > CODEX_COMPACT_GENERATION_MAX_BYTES);
    assert_eq!(candidate.candidate_size(), expected.len() as u64);
    let selected = candidate.into_bytes();
    assert_eq!(selected, expected);

    let mut repeated = tempfile::tempfile()?;
    repeated.write_all(&selected)?;
    repeated.seek(SeekFrom::Start(0))?;
    assert_eq!(
        select_codex_compact_generation(&mut repeated, THREAD_ID)?,
        CodexHistorySelection::Ineligible(CodexHistoryIneligibleReason::SourceWithinGuard)
    );
    Ok(())
}
