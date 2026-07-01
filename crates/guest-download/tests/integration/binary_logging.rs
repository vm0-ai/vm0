use crate::support::{
    assert_does_not_contain_any, create_tar_gz, manifest_json, unique_run_id, write_manifest,
};
use httpmock::prelude::*;
use std::io::{self, Write as _};
use std::path::PathBuf;
use std::process::{Output, Stdio};
use tempfile::TempDir;

struct RuntimeLogPaths {
    runtime_dir: PathBuf,
    system_log: PathBuf,
    ops_log: PathBuf,
}

impl RuntimeLogPaths {
    fn new(dir: &TempDir) -> Self {
        let runtime_dir = dir.path().join("guest-runtime");
        Self {
            system_log: guest_contracts::runtime_paths::system_log_file(&runtime_dir),
            ops_log: guest_contracts::runtime_paths::sandbox_ops_log_file(&runtime_dir),
            runtime_dir,
        }
    }
}

fn run_binary_with_manifest_stdin(
    manifest_json: &[u8],
    run_id: &str,
    logs: &RuntimeLogPaths,
) -> io::Result<Output> {
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg("--manifest-stdin")
        .env("VM0_RUN_ID", run_id)
        .env(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            &logs.runtime_dir,
        )
        .stdin(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| io::Error::other("guest-download stdin unavailable"))?
        .write_all(manifest_json)?;
    child.wait_with_output()
}

#[test]
fn binary_writes_system_log_to_explicit_runtime_path() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();
    let run_id = unique_run_id("success");
    let logs = RuntimeLogPaths::new(&dir);

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg(&manifest_path)
        .env("VM0_RUN_ID", &run_id)
        .env(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            &logs.runtime_dir,
        )
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let content = std::fs::read_to_string(&logs.system_log).unwrap();
    assert!(
        content.contains("[INFO] [sandbox:download] Download completed"),
        "unexpected system log: {content:?}"
    );
    assert_eq!(content.matches("Download completed").count(), 1);

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("[INFO] [sandbox:download] Download completed"));
    let ops_content = std::fs::read_to_string(&logs.ops_log).unwrap();
    let totals: Vec<serde_json::Value> = ops_content
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|entry: &serde_json::Value| entry["action_type"] == "download_total")
        .collect();
    assert_eq!(totals.len(), 1, "unexpected ops log: {ops_content}");
    assert_eq!(totals[0]["success"], true);
}

#[test]
fn binary_reads_manifest_from_stdin() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = unique_run_id("stdin-success");
    let logs = RuntimeLogPaths::new(&dir);
    let json = manifest_json(&[], None).unwrap();

    let output = run_binary_with_manifest_stdin(&json, &run_id, &logs).unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let content = std::fs::read_to_string(&logs.system_log).unwrap();
    assert!(
        content.contains("[INFO] [sandbox:download] Download completed"),
        "unexpected system log: {content:?}"
    );
    let ops_content = std::fs::read_to_string(&logs.ops_log).unwrap();
    let totals: Vec<serde_json::Value> = ops_content
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|entry: &serde_json::Value| entry["action_type"] == "download_total")
        .collect();
    assert_eq!(totals.len(), 1, "unexpected ops log: {ops_content}");
    assert_eq!(totals[0]["success"], true);
}

#[test]
fn binary_path_mode_ignores_extra_args_for_compatibility() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();
    let run_id = unique_run_id("path-extra-arg");
    let logs = RuntimeLogPaths::new(&dir);

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg(&manifest_path)
        .arg("--ignored")
        .env("VM0_RUN_ID", &run_id)
        .env(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            &logs.runtime_dir,
        )
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let content = std::fs::read_to_string(&logs.system_log).unwrap();
    assert!(
        content.contains("[INFO] [sandbox:download] Download completed"),
        "unexpected system log: {content:?}"
    );
}

#[test]
fn binary_manifest_stdin_rejects_extra_args_before_telemetry() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = unique_run_id("stdin-extra-arg");
    let logs = RuntimeLogPaths::new(&dir);

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg("--manifest-stdin")
        .arg("--ignored")
        .env("VM0_RUN_ID", &run_id)
        .env(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            &logs.runtime_dir,
        )
        .output()
        .unwrap();

    assert!(!output.status.success());
    let content = std::fs::read_to_string(&logs.system_log).unwrap();
    assert!(
        content.contains("[ERROR] [sandbox:download] Usage: guest-download"),
        "unexpected system log: {content:?}"
    );
    assert!(!logs.ops_log.exists());
}

#[test]
fn binary_invalid_stdin_manifest_logs_parse_failure_without_body() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = unique_run_id("stdin-invalid");
    let logs = RuntimeLogPaths::new(&dir);
    let body = b"{{not valid json super-secret-body";

    let output = run_binary_with_manifest_stdin(body, &run_id, &logs).unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains("super-secret-body"));
    let content = std::fs::read_to_string(&logs.system_log).unwrap();
    assert!(
        content.contains("[ERROR] [sandbox:download] Failed to parse manifest"),
        "unexpected system log: {content:?}"
    );
    assert!(!content.contains("super-secret-body"));
    let ops_content = std::fs::read_to_string(&logs.ops_log).unwrap();
    let totals: Vec<serde_json::Value> = ops_content
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|entry: &serde_json::Value| entry["action_type"] == "download_total")
        .collect();
    assert_eq!(totals.len(), 1, "unexpected ops log: {ops_content}");
    assert_eq!(totals[0]["success"], false);
}

#[test]
fn binary_writes_system_log_on_manifest_read_failure() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = unique_run_id("missing-manifest");
    let logs = RuntimeLogPaths::new(&dir);

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg("/tmp/nonexistent-guest-download-manifest.json")
        .env("VM0_RUN_ID", &run_id)
        .env(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            &logs.runtime_dir,
        )
        .output()
        .unwrap();

    assert!(!output.status.success());

    let content = std::fs::read_to_string(&logs.system_log).unwrap();
    assert!(
        content.contains("[ERROR] [sandbox:download] Failed to read manifest"),
        "unexpected system log: {content:?}"
    );
    assert!(
        content.contains("[ERROR] [sandbox:download] Download failed"),
        "unexpected system log: {content:?}"
    );
    let ops_content = std::fs::read_to_string(&logs.ops_log).unwrap();
    let totals: Vec<serde_json::Value> = ops_content
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|entry: &serde_json::Value| entry["action_type"] == "download_total")
        .collect();
    assert_eq!(totals.len(), 1, "unexpected ops log: {ops_content}");
    assert_eq!(totals[0]["success"], false);
}

#[test]
fn binary_without_manifest_path_logs_usage() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = unique_run_id("missing-arg");
    let logs = RuntimeLogPaths::new(&dir);

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .env("VM0_RUN_ID", &run_id)
        .env(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            &logs.runtime_dir,
        )
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("[ERROR] [sandbox:download] Usage: guest-download <manifest_path>"),
        "unexpected stderr: {stderr}"
    );
    let content = std::fs::read_to_string(&logs.system_log).unwrap();
    assert!(
        content.contains("[ERROR] [sandbox:download] Usage: guest-download <manifest_path>"),
        "unexpected system log: {content:?}"
    );
    assert!(
        !logs.ops_log.exists(),
        "usage failure should not record download_total before a run starts"
    );
}

#[test]
fn binary_fails_without_run_id_for_runtime_log_setup() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg(&manifest_path)
        .env_remove("VM0_RUN_ID")
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("VM0_RUN_ID is required for guest-download runtime paths"),
        "unexpected stderr: {stderr}"
    );
}

#[test]
fn binary_fails_with_empty_run_id_for_runtime_log_setup() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg(&manifest_path)
        .env("VM0_RUN_ID", "")
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("VM0_RUN_ID is required for guest-download runtime paths"),
        "unexpected stderr: {stderr}"
    );
}

#[test]
fn binary_fails_with_relative_runtime_dir_for_runtime_log_setup() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();
    let run_id = unique_run_id("relative-runtime-dir");

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg(&manifest_path)
        .env("VM0_RUN_ID", run_id)
        .env(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            "relative-runtime-dir",
        )
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(
            "failed to resolve guest-download runtime paths: VM0_GUEST_RUNTIME_DIR must be an absolute path"
        ),
        "unexpected stderr: {stderr}"
    );
}

#[test]
fn binary_fails_with_invalid_run_id_for_runtime_log_setup() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg(&manifest_path)
        .env("VM0_RUN_ID", "invalid/run/id")
        .env_remove(guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV)
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(
            "failed to resolve guest-download runtime paths: VM0_RUN_ID must be a single safe path segment"
        ),
        "unexpected stderr: {stderr}"
    );
}

#[test]
fn binary_fails_without_home_or_runtime_dir_for_runtime_log_setup() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();
    let run_id = unique_run_id("missing-home");

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg(&manifest_path)
        .env("VM0_RUN_ID", run_id)
        .env_remove(guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV)
        .env_remove("HOME")
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("failed to resolve guest-download runtime paths: HOME is required for guest runtime paths"),
        "unexpected stderr: {stderr}"
    );
}

#[test]
fn binary_does_not_log_http_archive_url_on_success() {
    let server = MockServer::start();
    let tar_gz = create_tar_gz(&[("secret.txt", b"downloaded")]).unwrap();

    let mock = server.mock(|when, then| {
        when.method(GET).path("/storage-object-key/archive.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url(
        "/storage-object-key/archive.tar.gz?X-Amz-Signature=super-secret-token&X-Amz-Credential=credential-secret",
    );
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();
    let run_id = unique_run_id("secret-url-success");
    let logs = RuntimeLogPaths::new(&dir);

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg(&manifest)
        .env("VM0_RUN_ID", &run_id)
        .env(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            &logs.runtime_dir,
        )
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(mount.join("secret.txt")).unwrap(),
        "downloaded"
    );
    mock.assert_calls(1);

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log_content = std::fs::read_to_string(&logs.system_log).unwrap();
    let ops_log_content = std::fs::read_to_string(&logs.ops_log).unwrap();
    let forbidden = [
        url.as_str(),
        "storage-object-key",
        "X-Amz-Signature",
        "super-secret-token",
        "X-Amz-Credential",
        "credential-secret",
    ];
    assert_does_not_contain_any("stderr", &stderr, &forbidden);
    assert_does_not_contain_any("system log", &system_log_content, &forbidden);
    assert_does_not_contain_any("sandbox ops log", &ops_log_content, &forbidden);
}

#[test]
fn binary_does_not_log_http_archive_url_on_fatal_status() {
    let server = MockServer::start();

    let mock = server.mock(|when, then| {
        when.method(GET)
            .path("/failing-storage-object/archive.tar.gz");
        then.status(404);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url(
        "/failing-storage-object/archive.tar.gz?X-Amz-Signature=fatal-secret-token&X-Amz-Credential=fatal-credential",
    );
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();
    let run_id = unique_run_id("secret-url-fatal");
    let logs = RuntimeLogPaths::new(&dir);

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg(&manifest)
        .env("VM0_RUN_ID", &run_id)
        .env(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            &logs.runtime_dir,
        )
        .output()
        .unwrap();

    assert!(!output.status.success());
    mock.assert_calls(1);

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log_content = std::fs::read_to_string(&logs.system_log).unwrap();
    let ops_log_content = std::fs::read_to_string(&logs.ops_log).unwrap();
    let forbidden = [
        url.as_str(),
        "failing-storage-object",
        "X-Amz-Signature",
        "fatal-secret-token",
        "X-Amz-Credential",
        "fatal-credential",
    ];
    assert_does_not_contain_any("stderr", &stderr, &forbidden);
    assert_does_not_contain_any("system log", &system_log_content, &forbidden);
    assert_does_not_contain_any("sandbox ops log", &ops_log_content, &forbidden);
    assert!(
        stderr.contains("HTTP status 404"),
        "unexpected stderr: {stderr}"
    );

    let ops: Vec<serde_json::Value> = ops_log_content
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(
        ops.iter()
            .any(|entry| entry["action_type"] == "storage_download"
                && entry["success"] == false
                && entry["error"]
                    .as_str()
                    .is_some_and(|error| error.contains("HTTP status 404")
                        && error.contains("mountPath=")
                        && error.contains("urlScheme=http"))),
        "missing failed storage_download entry: {ops_log_content}"
    );
    assert!(
        ops.iter()
            .any(|entry| entry["action_type"] == "download_total" && entry["success"] == false),
        "missing failed download_total entry: {ops_log_content}"
    );
}

#[test]
fn binary_does_not_log_file_archive_path_on_missing_local_file() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("secret-staged-archive.tar.gz");
    assert!(!missing.exists());

    let mount = dir.path().join("mount");
    let url = format!("file://{}", missing.display());
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();
    let run_id = unique_run_id("secret-file-path");
    let logs = RuntimeLogPaths::new(&dir);

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg(&manifest)
        .env("VM0_RUN_ID", &run_id)
        .env(
            guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
            &logs.runtime_dir,
        )
        .output()
        .unwrap();

    assert!(!output.status.success());

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log_content = std::fs::read_to_string(&logs.system_log).unwrap();
    let ops_log_content = std::fs::read_to_string(&logs.ops_log).unwrap();
    let missing_path = missing.to_string_lossy();
    let forbidden = [url.as_str(), missing_path.as_ref(), "secret-staged-archive"];
    assert_does_not_contain_any("stderr", &stderr, &forbidden);
    assert_does_not_contain_any("system log", &system_log_content, &forbidden);
    assert_does_not_contain_any("sandbox ops log", &ops_log_content, &forbidden);
}
