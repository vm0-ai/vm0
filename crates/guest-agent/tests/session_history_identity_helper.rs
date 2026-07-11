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
    SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS,
};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

type TestResult = Result<(), Box<dyn std::error::Error>>;

struct VerifyCase {
    name: &'static str,
    metadata_path: PathBuf,
    expectation_args: Vec<OsString>,
    expected_exit_code: i32,
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
