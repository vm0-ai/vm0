mod claude;
mod codex;
mod identity;
mod validation;

use sandbox::EXEC_OUTPUT_LIMIT_64_KIB;
use sandbox_mock::MockSandbox;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tracing_subscriber::prelude::*;

use super::super::DEFAULT_EXEC_TIMEOUT;
use super::super::session_restore::MaterializedResumeSession;
use super::support::{CapturedEvent, CapturedEvents, minimal_context};
use crate::types::{
    ExecutionContext, ResumeSession, ResumeSessionHistory, ResumeSessionHistoryRef,
    ResumeSessionHistoryRefKind,
};

static RESTORE_SESSION_LOG_CALLSITE_LOCK: Mutex<()> = Mutex::new(());

const CODEX_SESSION_ID: &str = "019e9154-c304-70f0-adde-36efb1be1701";
const CODEX_SESSION_ID_COMPACT_UPPERCASE: &str = "019E9154C30470F0ADDE36EFB1BE1701";
const CODEX_SESSION_ID_MIXED_CASE: &str = "019e9154C30470f0ADDE36efB1be1701";
const CODEX_SESSION_ID_NO_DASHES: &str = "019e9154c30470f0adde36efb1be1701";
const CODEX_CANONICAL_ROLLOUT_PATH: &str = "/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl";
const CODEX_CANONICAL_ROLLOUT_SUFFIX: &str =
    "/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl";
const CODEX_CANONICAL_ROLLOUT_FILENAME_SUFFIX: &str = "-019e9154-c304-70f0-adde-36efb1be1701.jsonl";

fn materialized_text_session(
    session_id: impl Into<String>,
    history: impl Into<String>,
) -> MaterializedResumeSession<'static> {
    MaterializedResumeSession::new(session_id.into(), history.into().into_bytes())
}

fn materialized_bytes_session(
    session_id: impl Into<String>,
    history: &[u8],
) -> MaterializedResumeSession<'static> {
    MaterializedResumeSession::new(session_id.into(), history.to_vec())
}

fn history_ref(hash: impl Into<String>, raw_size: u64) -> ResumeSessionHistoryRef {
    ResumeSessionHistoryRef {
        kind: ResumeSessionHistoryRefKind::Blob,
        hash: hash.into(),
        url: "https://example.com/history".into(),
        encoding: None,
        raw_size,
        encoded_size: raw_size,
    }
}

fn history_ref_for_bytes(history: &[u8]) -> ResumeSessionHistoryRef {
    history_ref(hex::encode(Sha256::digest(history)), history.len() as u64)
}

fn resume_ref(
    session_id: impl Into<String>,
    history_ref: ResumeSessionHistoryRef,
) -> ResumeSession {
    ResumeSession {
        cli_agent_session_id: session_id.into(),
        history: ResumeSessionHistory::Ref { history_ref },
    }
}

fn resume_ref_for_history(session_id: impl Into<String>, history: &[u8]) -> ResumeSession {
    resume_ref(session_id, history_ref_for_bytes(history))
}

fn claude_context() -> ExecutionContext {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "claude-code".into();
    ctx
}

fn codex_context() -> ExecutionContext {
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "codex".into();
    ctx
}

fn codex_session_meta_history(session_id: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({
            "timestamp": "2026-06-04T07:18:08.001Z",
            "type": "session_meta",
            "payload": {
                "id": session_id,
                "timestamp": "2026-06-04T07:18:08.000Z",
                "cwd": "/workspace",
                "originator": "test",
                "cli_version": "0.137.0",
                "source": "cli",
                "model_provider": "test-provider",
                "base_instructions": null,
            },
        }),
    )
}

fn codex_minimal_session_meta_history(session_id: &str) -> String {
    format!(
        "{}\n",
        serde_json::json!({
            "timestamp": "2026-06-04T07:18:08.001Z",
            "type": "session_meta",
            "payload": {
                "id": session_id,
                "timestamp": "2026-06-04T07:18:08.000Z",
            },
        }),
    )
}

fn assert_codex_cleanup_call(sandbox: &MockSandbox) {
    let exec_calls = sandbox.exec_calls();
    assert_eq!(exec_calls.len(), 1);
    assert_eq!(
        exec_calls[0].env_keys,
        [
            "VM0_CODEX_RESTORE_SESSION_ID".to_string(),
            "VM0_CODEX_RESTORE_SESSION_FILENAME_KEY".to_string(),
            "VM0_CODEX_RESTORE_SESSION_PATH".to_string()
        ]
    );
    assert_eq!(exec_calls[0].timeout, DEFAULT_EXEC_TIMEOUT);
    assert_eq!(exec_calls[0].output_limits, EXEC_OUTPUT_LIMIT_64_KIB);
    assert!(!exec_calls[0].sudo);
    assert!(exec_calls[0].stdin_bytes.is_none());
    assert!(exec_calls[0].cmd.contains("codex_home='/home/user/.codex'"));
    assert!(exec_calls[0].cmd.contains("root=\"$codex_home/sessions\""));
    assert!(exec_calls[0].cmd.contains("check_restore_dir_component"));
    assert!(
        exec_calls[0]
            .cmd
            .contains("check_restore_dir_component \"$codex_home\"")
    );
    assert!(
        exec_calls[0]
            .cmd
            .contains("codex restore directory is a symlink")
    );
    assert!(exec_calls[0].cmd.contains("scan_budget="));
    assert!(
        exec_calls[0]
            .cmd
            .contains("collect_matching_session_entries")
    );
    assert!(
        exec_calls[0]
            .cmd
            .contains("find \"$root\" -mindepth 1 -print0")
    );
    assert!(
        exec_calls[0]
            .cmd
            .contains("delete_matching_session_entries")
    );
    assert!(exec_calls[0].cmd.contains("xargs -0"));
    assert!(exec_calls[0].cmd.contains("\\\\.jsonl\\\\.zst"));
    assert!(exec_calls[0].cmd.contains("\\\\.jsonl\\\\.vm0tmp-"));
    assert!(exec_calls[0].cmd.contains("id_no_dashes"));
    assert!(
        exec_calls[0]
            .cmd
            .contains("VM0_CODEX_RESTORE_SESSION_FILENAME_KEY")
    );
    assert!(!exec_calls[0].cmd.contains("tr -d"));
    assert!(!exec_calls[0].cmd.contains("-delete"));
    assert!(!exec_calls[0].cmd.contains("for path in \"$dir\"/*"));
}

fn capture_restore_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: std::future::Future,
{
    let _capture_guard = RESTORE_SESSION_LOG_CALLSITE_LOCK
        .lock()
        .expect("restore session log callsite lock poisoned");
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let output = block_on_restore_session(future);
    drop(guard);
    (output, captured.entries())
}

fn run_restore_session<F>(future: F) -> F::Output
where
    F: std::future::Future,
{
    let _capture_guard = RESTORE_SESSION_LOG_CALLSITE_LOCK
        .lock()
        .expect("restore session log callsite lock poisoned");
    block_on_restore_session(future)
}

fn block_on_restore_session<F>(future: F) -> F::Output
where
    F: std::future::Future,
{
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build restore session test runtime")
        .block_on(future)
}

fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
    events
        .iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|actual| actual == message)
        })
        .unwrap_or_else(|| panic!("missing event {message:?}; captured={events:#?}"))
}
