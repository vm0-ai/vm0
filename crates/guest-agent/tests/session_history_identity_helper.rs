use api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES;
use guest_contracts::session_history_identity::{
    FinalSessionHistoryFramework, FinalSessionHistoryIdentity, FinalSessionHistoryRefKind,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ,
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS, SessionHistorySidecarExportMetadata,
    SessionHistorySidecarRepresentation,
};
#[cfg(target_os = "linux")]
use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

struct VerifyCase {
    name: &'static str,
    metadata_path: PathBuf,
    expectation_args: Vec<OsString>,
    expected_exit_code: i32,
}

struct SourceOpenWatch {
    #[cfg(target_os = "linux")]
    inotify: Inotify,
}

impl SourceOpenWatch {
    fn new(path: &Path) -> TestResult<Self> {
        #[cfg(target_os = "linux")]
        {
            let inotify = Inotify::init(InitFlags::IN_CLOEXEC | InitFlags::IN_NONBLOCK)?;
            let _watch = inotify.add_watch(
                path,
                AddWatchFlags::IN_OPEN | AddWatchFlags::IN_CLOSE_NOWRITE,
            )?;
            Ok(Self { inotify })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = path;
            Ok(Self {})
        }
    }

    fn assert_opened_once(self) -> TestResult {
        #[cfg(target_os = "linux")]
        {
            let events = self.inotify.read_events()?;
            let open_count = events
                .iter()
                .filter(|event| event.mask.contains(AddWatchFlags::IN_OPEN))
                .count();
            assert_eq!(open_count, 1, "source events: {events:?}");
        }
        Ok(())
    }
}

#[test]
fn verify_session_history_identity_returns_stable_exit_codes() -> TestResult {
    let dir = tempfile::tempdir()?;

    let matching_history = br#"{"type":"system"}"#;
    let matching_history_path = dir.path().join("matching-history.jsonl");
    std::fs::write(&matching_history_path, matching_history)?;
    let matching_history_hash = sha256_hex(matching_history);
    let matching_identity = FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::ClaudeCode,
        "a".repeat(64),
        FinalSessionHistoryRefKind::Blob,
        matching_history_hash.clone(),
        matching_history.len() as u64,
        matching_history_path.to_string_lossy(),
    )?;
    let matching_metadata_path =
        write_metadata(dir.path(), "matching-identity.json", &matching_identity)?;

    let invalid_metadata_path = dir.path().join("invalid-identity.json");
    std::fs::write(&invalid_metadata_path, b"not-json")?;

    let framework_mismatch_identity = FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::Codex,
        "a".repeat(64),
        FinalSessionHistoryRefKind::Blob,
        matching_history_hash,
        matching_history.len() as u64,
        matching_history_path.to_string_lossy(),
    )?;
    let framework_mismatch_metadata_path = write_metadata(
        dir.path(),
        "framework-mismatch-identity.json",
        &framework_mismatch_identity,
    )?;

    let missing_history_path = dir.path().join("missing-history.jsonl");
    let history_read_identity = FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::ClaudeCode,
        "a".repeat(64),
        FinalSessionHistoryRefKind::Blob,
        "b".repeat(64),
        1,
        missing_history_path.to_string_lossy(),
    )?;
    let history_read_metadata_path = write_metadata(
        dir.path(),
        "history-read-identity.json",
        &history_read_identity,
    )?;

    let mismatched_history_path = dir.path().join("mismatched-history.jsonl");
    std::fs::write(&mismatched_history_path, b"actual!")?;
    let history_mismatch_identity = FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::ClaudeCode,
        "a".repeat(64),
        FinalSessionHistoryRefKind::Blob,
        sha256_hex(b"expect!"),
        7,
        mismatched_history_path.to_string_lossy(),
    )?;
    let history_mismatch_metadata_path = write_metadata(
        dir.path(),
        "history-mismatch-identity.json",
        &history_mismatch_identity,
    )?;

    let history_too_large_identity = FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::ClaudeCode,
        "a".repeat(64),
        FinalSessionHistoryRefKind::Blob,
        "b".repeat(64),
        RESUME_SESSION_HISTORY_MAX_BYTES + 1,
        matching_history_path.to_string_lossy(),
    )?;
    let history_too_large_metadata_path = write_metadata(
        dir.path(),
        "history-too-large-identity.json",
        &history_too_large_identity,
    )?;

    let cases = [
        VerifyCase {
            name: "success",
            metadata_path: matching_metadata_path.clone(),
            expectation_args: Vec::new(),
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS,
        },
        VerifyCase {
            name: "invalid arguments",
            metadata_path: matching_metadata_path.clone(),
            expectation_args: vec![OsString::from("claude-code")],
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS,
        },
        VerifyCase {
            name: "metadata read",
            metadata_path: dir.path().join("missing-identity.json"),
            expectation_args: Vec::new(),
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ,
        },
        VerifyCase {
            name: "invalid metadata",
            metadata_path: invalid_metadata_path,
            expectation_args: Vec::new(),
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA,
        },
        VerifyCase {
            name: "framework mismatch",
            metadata_path: framework_mismatch_metadata_path,
            expectation_args: Vec::new(),
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH,
        },
        VerifyCase {
            name: "expected identity mismatch",
            metadata_path: matching_metadata_path,
            expectation_args: expectation_args(&matching_identity, "b".repeat(64)),
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH,
        },
        VerifyCase {
            name: "history read",
            metadata_path: history_read_metadata_path,
            expectation_args: Vec::new(),
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
        },
        VerifyCase {
            name: "history mismatch",
            metadata_path: history_mismatch_metadata_path,
            expectation_args: Vec::new(),
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
        },
        VerifyCase {
            name: "history too large",
            metadata_path: history_too_large_metadata_path,
            expectation_args: Vec::new(),
            expected_exit_code: SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
        },
    ];

    for case in cases {
        let output = run_helper(&case)?;
        assert_eq!(
            output.status.code(),
            Some(case.expected_exit_code),
            "{}: stdout={}, stderr={}",
            case.name,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    Ok(())
}

#[test]
fn export_session_history_sidecar_reads_raw_source_once() -> TestResult {
    let dir = tempfile::tempdir()?;
    let history = br#"{"type":"system"}"#;
    let history_path = dir.path().join("history.jsonl");
    std::fs::write(&history_path, history)?;
    let identity = FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::ClaudeCode,
        "a".repeat(64),
        FinalSessionHistoryRefKind::Blob,
        sha256_hex(history),
        history.len() as u64,
        history_path.to_string_lossy(),
    )?;
    let metadata_path = write_metadata(dir.path(), "raw-identity.json", &identity)?;
    let export_path = dir.path().join("raw-sidecar");
    let source_watch = SourceOpenWatch::new(&history_path)?;

    let output = run_export_helper(&metadata_path, &export_path)?;

    assert!(
        output.status.success(),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    source_watch.assert_opened_once()?;
    let export_metadata =
        serde_json::from_slice::<SessionHistorySidecarExportMetadata>(&output.stdout)?;
    assert_eq!(
        export_metadata.representation,
        SessionHistorySidecarRepresentation::Raw
    );
    assert_eq!(export_metadata.encoded_size, history.len() as u64);
    assert_eq!(std::fs::read(export_path)?, history);
    Ok(())
}

#[test]
fn export_session_history_sidecar_reads_native_codex_zstd_once() -> TestResult {
    let dir = tempfile::tempdir()?;
    let sessions_dir = dir.path().join("sessions");
    let day_dir = sessions_dir.join("2026").join("07").join("13");
    std::fs::create_dir_all(&day_dir)?;
    let thread_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let history = br#"{"type":"session_meta","timestamp":"2026-07-13T10:00:00Z"}"#;
    let encoded = zstd::encode_all(history.as_slice(), 0)?;
    let history_path = day_dir.join("rollout-019e9154c30470f0adde36efb1be1701.jsonl.zst");
    std::fs::write(&history_path, &encoded)?;
    let sessions_dir = sessions_dir.to_string_lossy();
    let marker = format!(
        "CODEX_SEARCH:{}:{sessions_dir}:{thread_id}",
        sessions_dir.len()
    );
    let identity = FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::Codex,
        "a".repeat(64),
        FinalSessionHistoryRefKind::Blob,
        sha256_hex(history),
        history.len() as u64,
        marker,
    )?;
    let metadata_path = write_metadata(dir.path(), "codex-identity.json", &identity)?;
    let export_path = dir.path().join("codex-sidecar");
    let source_watch = SourceOpenWatch::new(&history_path)?;

    let output = run_export_helper(&metadata_path, &export_path)?;

    assert!(
        output.status.success(),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    source_watch.assert_opened_once()?;
    let export_metadata =
        serde_json::from_slice::<SessionHistorySidecarExportMetadata>(&output.stdout)?;
    assert_eq!(
        export_metadata.representation,
        SessionHistorySidecarRepresentation::CodexZstd
    );
    assert_eq!(export_metadata.encoded_size, encoded.len() as u64);
    assert_eq!(std::fs::read(export_path)?, encoded);
    Ok(())
}

#[test]
fn export_session_history_sidecar_rejects_metadata_above_resume_limit_before_reading() -> TestResult
{
    let dir = tempfile::tempdir()?;
    let history_path = dir.path().join("missing-oversized-history.jsonl");
    let identity = FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::ClaudeCode,
        "a".repeat(64),
        FinalSessionHistoryRefKind::Blob,
        "b".repeat(64),
        RESUME_SESSION_HISTORY_MAX_BYTES + 1,
        history_path.to_string_lossy(),
    )?;
    let metadata_path = write_metadata(dir.path(), "oversized-identity.json", &identity)?;
    let export_path = dir.path().join("oversized-sidecar");

    let output = run_export_helper(&metadata_path, &export_path)?;

    assert_eq!(
        output.status.code(),
        Some(SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    assert!(!export_path.exists());
    Ok(())
}

#[test]
fn export_session_history_sidecar_keeps_source_read_failures() -> TestResult {
    let dir = tempfile::tempdir()?;
    let history_path = dir.path().join("missing-history.jsonl");
    let identity = FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::ClaudeCode,
        "a".repeat(64),
        FinalSessionHistoryRefKind::Blob,
        "b".repeat(64),
        1,
        history_path.to_string_lossy(),
    )?;
    let metadata_path = write_metadata(dir.path(), "missing-source-identity.json", &identity)?;
    let export_path = dir.path().join("missing-source-sidecar");

    let output = run_export_helper(&metadata_path, &export_path)?;

    assert_eq!(
        output.status.code(),
        Some(SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!export_path.exists());
    Ok(())
}

#[test]
fn export_session_history_sidecar_rejects_history_mismatch() -> TestResult {
    let dir = tempfile::tempdir()?;
    let history = b"actual";
    let history_path = dir.path().join("mismatched-history.jsonl");
    std::fs::write(&history_path, history)?;
    let identity = FinalSessionHistoryIdentity::new(
        FinalSessionHistoryFramework::ClaudeCode,
        "a".repeat(64),
        FinalSessionHistoryRefKind::Blob,
        sha256_hex(b"expect"),
        history.len() as u64,
        history_path.to_string_lossy(),
    )?;
    let metadata_path = write_metadata(dir.path(), "mismatched-identity.json", &identity)?;
    let export_path = dir.path().join("mismatched-sidecar");

    let output = run_export_helper(&metadata_path, &export_path)?;

    assert_eq!(
        output.status.code(),
        Some(SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!export_path.exists());
    Ok(())
}

fn write_metadata(
    dir: &Path,
    name: &str,
    identity: &FinalSessionHistoryIdentity,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let path = dir.join(name);
    std::fs::write(&path, identity.to_json_vec()?)?;
    Ok(path)
}

fn expectation_args(
    identity: &FinalSessionHistoryIdentity,
    session_id_hash: String,
) -> Vec<OsString> {
    vec![
        OsString::from(identity.framework.as_str()),
        OsString::from(session_id_hash),
        OsString::from(identity.history_ref_kind.as_str()),
        OsString::from(&identity.history_hash),
        OsString::from(identity.history_size_bytes.to_string()),
    ]
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn run_helper(case: &VerifyCase) -> Result<Output, std::io::Error> {
    Command::new(env!("CARGO_BIN_EXE_guest-agent"))
        .env_clear()
        .arg("verify-session-history-identity")
        .arg(&case.metadata_path)
        .args(&case.expectation_args)
        .output()
}

fn run_export_helper(metadata_path: &Path, export_path: &Path) -> Result<Output, std::io::Error> {
    Command::new(env!("CARGO_BIN_EXE_guest-agent"))
        .env_clear()
        .arg("export-session-history-sidecar")
        .arg(metadata_path)
        .arg(export_path)
        .output()
}
