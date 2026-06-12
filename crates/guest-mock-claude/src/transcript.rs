use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

/// Generate a mock session ID: `mock-{uuid-v7}`.
pub(crate) fn generate_session_id() -> String {
    format!("mock-{}", Uuid::now_v7())
}

pub(crate) fn is_valid_session_history_id(session_id: &str) -> bool {
    if session_id.is_empty()
        || session_id == "."
        || session_id == ".."
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.chars().any(char::is_control)
    {
        return false;
    }

    let mut components = Path::new(session_id).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

/// Build the session history file path and create the directory.
///
/// Claude Code stores session history at: `{home}/.claude/projects/-{path}/{session_id}.jsonl`
fn build_session_history_path(session_id: &str, home: &str) -> Option<String> {
    if !is_valid_session_history_id(session_id) {
        return None;
    }

    let project_name = CANONICAL_WORKING_DIR
        .trim_start_matches('/')
        .replace('/', "-");
    let session_dir = PathBuf::from(home)
        .join(".claude")
        .join("projects")
        .join(format!("-{project_name}"));

    if std::fs::create_dir_all(&session_dir).is_err() {
        return None;
    }

    Some(
        session_dir
            .join(format!("{session_id}.jsonl"))
            .to_string_lossy()
            .into_owned(),
    )
}

/// Create session history using `$HOME` from the environment.
pub(crate) fn create_session_history(session_id: &str) -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());
    build_session_history_path(session_id, &home)
}

#[derive(Default)]
pub(crate) struct JsonlTranscript {
    lines: Vec<String>,
}

impl JsonlTranscript {
    pub(crate) fn emit_value(&mut self, event: Value) {
        self.emit_raw_line(event.to_string());
    }

    pub(crate) fn emit_raw_line(&mut self, line: String) {
        println!("{line}");
        self.lines.push(line);
    }

    pub(crate) fn write_session_history(&self, session_id: &str) {
        if let Some(path) = create_session_history(session_id) {
            self.write_session_history_file(&path);
        }
    }

    pub(crate) fn write_session_history_file(&self, path: &str) {
        if let Ok(mut file) = std::fs::File::create(path) {
            for line in &self.lines {
                let _ = writeln!(file, "{line}");
            }
        }
    }
}

pub(crate) fn init_event(session_id: &str, tools: &[&str]) -> Value {
    json!({
        "type": "system",
        "subtype": "init",
        "cwd": CANONICAL_WORKING_DIR,
        "session_id": session_id,
        "tools": tools,
        "model": "mock-claude"
    })
}

pub(crate) fn result_event(session_id: &str, is_error: bool, result: &str) -> Value {
    json!({
        "type": "result",
        "subtype": if is_error { "error" } else { "success" },
        "session_id": session_id,
        "is_error": is_error,
        "duration_ms": 100,
        "num_turns": 1,
        "result": result,
        "total_cost_usd": 0,
        "usage": {"input_tokens": 0, "output_tokens": 0}
    })
}

pub(crate) fn assistant_text_event(session_id: &str, text: &str) -> Value {
    json!({
        "type": "assistant",
        "session_id": session_id,
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": text}]
        }
    })
}

pub(crate) fn tool_use_event(session_id: &str, id: &str, name: &str, input: Value) -> Value {
    json!({
        "type": "assistant",
        "session_id": session_id,
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input
            }]
        }
    })
}

pub(crate) fn tool_result_event(
    session_id: &str,
    tool_use_id: &str,
    content: &str,
    is_error: bool,
) -> Value {
    json!({
        "type": "user",
        "session_id": session_id,
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content,
                "is_error": is_error
            }]
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn session_history_path_structure() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_str().unwrap();

        let result = build_session_history_path("test-session-123", home);

        let expected =
            format!("{home}/.claude/projects/-home-user-workspace/test-session-123.jsonl");
        assert_eq!(result, Some(expected));
    }

    #[test]
    fn session_history_creates_directory() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_str().unwrap();

        let _ = build_session_history_path("test-session", home);

        let expected_dir = dir.path().join(".claude/projects/-home-user-workspace");
        assert!(expected_dir.exists());
    }

    #[test]
    fn session_history_id_accepts_safe_file_components() {
        for session_id in [
            "mock-123",
            "preview-1",
            "550e8400-e29b-41d4-a716-446655440000",
            "session.with.dot",
        ] {
            assert!(
                is_valid_session_history_id(session_id),
                "expected {session_id} to be accepted"
            );
        }
    }

    #[test]
    fn session_history_path_rejects_unsafe_session_ids() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_str().unwrap();

        for session_id in [
            "",
            ".",
            "..",
            "../escape",
            "..\\escape",
            "/absolute",
            "nested/path",
            "nested\\path",
            "line\nbreak",
        ] {
            assert!(
                !is_valid_session_history_id(session_id),
                "expected {session_id:?} to be rejected"
            );
            assert_eq!(build_session_history_path(session_id, home), None);
        }
        assert!(!dir.path().join(".claude").exists());
    }

    #[test]
    fn session_id_has_mock_prefix() {
        let id = generate_session_id();
        assert!(id.starts_with("mock-"));
    }

    #[test]
    fn session_id_has_canonical_uuid_suffix() {
        let id = generate_session_id();
        let suffix = id.strip_prefix("mock-").expect("mock prefix");
        let parsed = Uuid::parse_str(suffix).expect("uuid suffix");

        assert_eq!(parsed.to_string(), suffix);
    }

    #[test]
    fn session_id_unique_without_sleep() {
        let mut ids = HashSet::new();

        for _ in 0..1024 {
            let id = generate_session_id();
            assert!(ids.insert(id), "generated duplicate session id");
        }
    }

    #[test]
    fn session_id_unique_across_threads() {
        let handles = (0..16)
            .map(|_| {
                std::thread::spawn(|| (0..64).map(|_| generate_session_id()).collect::<Vec<_>>())
            })
            .collect::<Vec<_>>();
        let mut ids = HashSet::new();

        for handle in handles {
            for id in handle.join().expect("session id worker should not panic") {
                assert!(ids.insert(id), "generated duplicate session id");
            }
        }
    }
}
