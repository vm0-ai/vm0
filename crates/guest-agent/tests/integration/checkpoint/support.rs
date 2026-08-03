use crate::support::*;
use httpmock::prelude::*;
use serde_json::json;
#[cfg(target_os = "linux")]
use std::{ffi::CString, os::unix::ffi::OsStrExt};
use std::{
    ffi::OsString,
    io::{Seek, SeekFrom, Write},
};

pub(super) const LARGE_SESSION_HISTORY_SIZE_BYTES: usize = 1024 * 1024 + 1;

pub(super) fn runtime_from_process_env() -> Result<guest_agent::run_context::GuestRuntime, String> {
    guest_agent::run_context::GuestRuntime::from_process_env()
}

pub(super) fn set_claude_session_pruning(
    runtime: &mut guest_agent::run_context::GuestRuntime,
    enabled: bool,
) {
    runtime
        .config
        .feature_flags
        .insert("claudeSessionPruning".to_string(), enabled);
}

pub(super) fn session_file_paths() -> (String, String) {
    let paths = shared_guest_paths();
    (
        paths.session_id_file().to_string(),
        paths.session_history_path_file().to_string(),
    )
}

pub(super) struct EnvVarRestore {
    key: &'static str,
    value: Option<OsString>,
}

impl EnvVarRestore {
    pub(super) fn capture(key: &'static str) -> Self {
        Self {
            key,
            value: std::env::var_os(key),
        }
    }
}

impl Drop for EnvVarRestore {
    fn drop(&mut self) {
        unsafe {
            match &self.value {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }
}

pub(super) fn write_derived_claude_history(
    home_dir: &str,
    session_id: &str,
    history: &str,
) -> Result<(), String> {
    let (session_id_file, _) = session_file_paths();
    guest_agent::paths::write_private(&session_id_file, session_id)
        .map_err(|e| format!("write session id: {e}"))?;
    let project_name = guest_agent::paths::CANONICAL_WORKING_DIR
        .strip_prefix('/')
        .unwrap_or(guest_agent::paths::CANONICAL_WORKING_DIR)
        .replace('/', "-");
    let history_path = std::path::Path::new(home_dir)
        .join(".claude")
        .join("projects")
        .join(format!("-{project_name}"))
        .join(format!("{session_id}.jsonl"));
    let parent = history_path
        .parent()
        .ok_or_else(|| format!("history path has no parent: {}", history_path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("create history dir {}: {e}", parent.display()))?;
    std::fs::write(&history_path, history)
        .map_err(|e| format!("write history {}: {e}", history_path.display()))?;
    Ok(())
}

pub(super) fn write_literal_session_history(
    session_id: &str,
    history: &[u8],
) -> Result<tempfile::TempDir, String> {
    let (session_id_file, session_history_path_file) = session_file_paths();
    let dir = tempfile::tempdir().map_err(|e| format!("create temp history dir: {e}"))?;
    let history_path = dir.path().join(format!("{session_id}.jsonl"));
    std::fs::write(&history_path, history)
        .map_err(|e| format!("write history {}: {e}", history_path.display()))?;
    guest_agent::paths::write_private(&session_id_file, session_id)
        .map_err(|e| format!("write session id: {e}"))?;
    guest_agent::paths::write_private(
        &session_history_path_file,
        history_path.to_string_lossy().as_ref(),
    )
    .map_err(|e| format!("write session history marker: {e}"))?;
    Ok(dir)
}

#[cfg(target_os = "linux")]
pub(super) fn create_fifo(path: &std::path::Path) -> std::io::Result<()> {
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    let result = unsafe { libc::mkfifo(path.as_ptr(), 0o600) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

pub(super) fn write_prunable_claude_history(
    session_id: &str,
) -> Result<(tempfile::TempDir, Vec<u8>), String> {
    let boundary_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let summary_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let records = [
        json!({
            "type": "system",
            "subtype": "compact_boundary",
            "sessionId": session_id,
            "uuid": boundary_id,
            "parentUuid": null,
            "logicalParentUuid": "11111111-1111-4111-8111-111111111111",
            "isSidechain": false,
            "version": "2.1.220"
        }),
        json!({
            "type": "user",
            "sessionId": session_id,
            "uuid": summary_id,
            "parentUuid": boundary_id,
            "isCompactSummary": true,
            "message": {"role": "user", "content": "retained summary"}
        }),
    ];
    let mut candidate = Vec::new();
    for record in records {
        let mut line =
            serde_json::to_vec(&record).map_err(|error| format!("encode history: {error}"))?;
        line.push(b'\n');
        candidate.extend_from_slice(&line);
    }

    let history_dir =
        tempfile::tempdir().map_err(|error| format!("create history dir: {error}"))?;
    let history_path = history_dir.path().join(format!("{session_id}.jsonl"));
    let mut history_file =
        std::fs::File::create(&history_path).map_err(|error| format!("create history: {error}"))?;
    history_file
        .set_len(guest_session_prune::CLAUDE_COMPACT_GENERATION_MAX_BYTES + 1)
        .map_err(|error| format!("size history: {error}"))?;
    history_file
        .seek(SeekFrom::End(0))
        .map_err(|error| format!("seek history: {error}"))?;
    history_file
        .write_all(b"\n")
        .and_then(|()| history_file.write_all(&candidate))
        .and_then(|()| history_file.flush())
        .map_err(|error| format!("write history: {error}"))?;

    let (session_id_file, session_history_path_file) = session_file_paths();
    guest_agent::paths::write_private(&session_id_file, session_id)
        .map_err(|error| format!("write session id: {error}"))?;
    guest_agent::paths::write_private(
        &session_history_path_file,
        history_path.to_string_lossy().as_ref(),
    )
    .map_err(|error| format!("write history marker: {error}"))?;
    Ok((history_dir, candidate))
}

pub(super) fn write_prunable_codex_history(
    session_id: &str,
) -> Result<(tempfile::TempDir, std::path::PathBuf, Vec<u8>), String> {
    let history_dir =
        tempfile::tempdir().map_err(|error| format!("create Codex history dir: {error}"))?;
    let day_dir = history_dir
        .path()
        .join(".codex")
        .join("sessions")
        .join("2026")
        .join("07")
        .join("26");
    std::fs::create_dir_all(&day_dir)
        .map_err(|error| format!("create Codex session directory: {error}"))?;
    let history_path = day_dir.join(format!("rollout-{session_id}.jsonl"));

    let line = |record_type: &str, payload: serde_json::Value| -> Result<Vec<u8>, String> {
        let mut bytes = serde_json::to_vec(&json!({
            "timestamp": "2026-07-26T00:00:00Z",
            "type": record_type,
            "payload": payload,
        }))
        .map_err(|error| format!("encode Codex history: {error}"))?;
        bytes.push(b'\n');
        Ok(bytes)
    };
    let canonical = line(
        "session_meta",
        json!({
            "id": session_id,
            "session_id": session_id,
            "timestamp": "2026-07-26T00:00:00Z",
            "cwd": guest_agent::paths::CANONICAL_WORKING_DIR,
            "originator": "codex",
            "cli_version": "0.144.6",
            "source": "cli",
            "history_mode": "legacy",
        }),
    )?;
    let turn_id = "compact-turn";
    let retained_records = [
        line(
            "event_msg",
            json!({
                "type": "task_started",
                "turn_id": turn_id,
                "model_context_window": 258400,
                "collaboration_mode_kind": "default",
            }),
        )?,
        line(
            "event_msg",
            json!({
                "type": "user_message",
                "message": "compact this thread",
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
                "turn_id": turn_id,
                "cwd": guest_agent::paths::CANONICAL_WORKING_DIR,
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
                    "role": "user",
                    "content": [{
                        "type": "input_text",
                        "text": "retained summary",
                    }],
                }],
                "window_number": 1,
                "first_window_id": "019c0000-0000-7000-8000-000000000001",
                "window_id": "019c0000-0000-7000-8000-000000000002",
            }),
        )?,
        line(
            "world_state",
            json!({"full": true, "state": {"working_directory": "/workspace"}}),
        )?,
        line(
            "event_msg",
            json!({
                "type": "task_complete",
                "turn_id": turn_id,
                "last_agent_message": "retained summary",
            }),
        )?,
    ];
    let candidate = std::iter::once(canonical.clone())
        .chain(retained_records.iter().cloned())
        .flatten()
        .collect::<Vec<_>>();

    let mut history_file = std::fs::File::create(&history_path)
        .map_err(|error| format!("create Codex history: {error}"))?;
    history_file
        .write_all(&canonical)
        .map_err(|error| format!("write canonical Codex history: {error}"))?;
    history_file
        .set_len(api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES + 1)
        .map_err(|error| format!("size Codex history: {error}"))?;
    history_file
        .seek(SeekFrom::End(0))
        .and_then(|_| history_file.write_all(b"\n"))
        .and_then(|()| {
            for record in retained_records {
                history_file.write_all(&record)?;
            }
            history_file.flush()
        })
        .map_err(|error| format!("write retained Codex history: {error}"))?;

    let (session_id_file, _) = session_file_paths();
    guest_agent::paths::write_private(&session_id_file, session_id)
        .map_err(|error| format!("write Codex session id: {error}"))?;
    Ok((history_dir, history_path, candidate))
}

pub(super) fn zstd_session_history_for_test(history: &[u8]) -> std::io::Result<Vec<u8>> {
    zstd::stream::encode_all(history, 3)
}

pub(super) fn high_entropy_history(size: usize) -> Vec<u8> {
    let mut state = 0x6a09e667f3bcc909_u64;
    let mut bytes = Vec::with_capacity(size);
    for _ in 0..size {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let value = state.wrapping_mul(0x2545f4914f6cdd1d);
        bytes.push((value >> 56) as u8);
    }
    bytes
}

pub(super) fn upload_zstd_validation_response(
    req: &HttpMockRequest,
    expected_body: &[u8],
) -> HttpMockResponse {
    if request_header_absent(req, "authorization")
        && request_header_absent(req, "x-vercel-protection-bypass")
        && req.body_ref() != expected_body
        && zstd::stream::decode_all(req.body_ref()).is_ok_and(|decoded| decoded == expected_body)
    {
        http_status(200)
    } else {
        http_status(400)
    }
}
