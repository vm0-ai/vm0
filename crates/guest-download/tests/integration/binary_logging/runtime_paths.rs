use super::{
    BinaryLoggingFixture, RuntimeLogPaths, assert_default_zero_task_attribution,
    assert_single_download_total_success, guest_download_command, process,
};
use crate::support::{unique_run_id, write_manifest};

#[test]
fn binary_writes_system_log_to_explicit_runtime_path() {
    let fixture = BinaryLoggingFixture::new("success").unwrap();
    let manifest_path = write_manifest(&fixture.dir, &[], None).unwrap();

    let output = fixture.run_manifest_path(&manifest_path).unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let content = fixture.read_system_log().unwrap();
    assert!(
        content.contains("[INFO] [sandbox:download] Download completed"),
        "unexpected system log: {content:?}"
    );
    assert_eq!(content.matches("Download completed").count(), 1);

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("[INFO] [sandbox:download] Download completed"));
    let actions = fixture.action_types().unwrap();
    assert_default_zero_task_attribution(&actions);
    let ops = fixture.ops_entries().unwrap();
    assert_single_download_total_success(&ops, true);
}

#[test]
fn binary_fails_without_run_id_for_runtime_log_setup() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();

    let output = process::run(
        guest_download_command()
            .arg(&manifest_path)
            .env_remove("VM0_RUN_ID"),
    )
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

    let output = process::run(
        guest_download_command()
            .arg(&manifest_path)
            .env("VM0_RUN_ID", ""),
    )
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

    let output = process::run(
        guest_download_command()
            .arg(&manifest_path)
            .env("VM0_RUN_ID", run_id)
            .env(
                guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
                "relative-runtime-dir",
            ),
    )
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

    let output = process::run(
        guest_download_command()
            .arg(&manifest_path)
            .env("VM0_RUN_ID", "invalid/run/id")
            .env_remove(guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV),
    )
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
fn binary_uses_absolute_runtime_dir_without_validating_run_id_as_path_segment() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();
    let logs = RuntimeLogPaths::new(&dir);

    let output = process::run(
        guest_download_command()
            .arg(&manifest_path)
            .env("VM0_RUN_ID", "ignored/when/runtime-dir/is-set")
            .env(
                guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
                &logs.runtime_dir,
            ),
    )
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
fn binary_fails_without_home_or_runtime_dir_for_runtime_log_setup() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();
    let run_id = unique_run_id("missing-home");

    let output = process::run(
        guest_download_command()
            .arg(&manifest_path)
            .env("VM0_RUN_ID", run_id)
            .env_remove(guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV)
            .env_remove("HOME"),
    )
    .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("failed to resolve guest-download runtime paths: HOME is required for guest runtime paths"),
        "unexpected stderr: {stderr}"
    );
}
