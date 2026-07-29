use super::{
    BinaryLoggingFixture, assert_default_zero_task_attribution,
    assert_single_download_total_success,
};
use crate::support::{manifest_json, write_manifest};

#[test]
fn binary_reads_manifest_from_stdin() {
    let fixture = BinaryLoggingFixture::new("stdin-success").unwrap();
    let json = manifest_json(&[], None).unwrap();

    let output = fixture.run_manifest_stdin(&json).unwrap();

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
    let actions = fixture.action_types().unwrap();
    assert_default_zero_task_attribution(&actions);
    let ops = fixture.ops_entries().unwrap();
    assert_single_download_total_success(&ops, true);
}

#[test]
fn binary_reads_manifest_from_path() {
    let fixture = BinaryLoggingFixture::new("path-success").unwrap();
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
    let actions = fixture.action_types().unwrap();
    assert_default_zero_task_attribution(&actions);
    let ops = fixture.ops_entries().unwrap();
    assert_single_download_total_success(&ops, true);
}

#[test]
fn binary_path_mode_rejects_extra_args_before_telemetry() {
    let fixture = BinaryLoggingFixture::new("path-extra-arg").unwrap();
    let manifest_path = write_manifest(&fixture.dir, &[], None).unwrap();

    let output = fixture
        .command()
        .arg(&manifest_path)
        .arg("--ignored")
        .output()
        .unwrap();

    assert!(!output.status.success());
    let content = fixture.read_system_log().unwrap();
    assert!(
        content.contains("[ERROR] [sandbox:download] Usage: guest-download"),
        "unexpected system log: {content:?}"
    );
    assert!(!fixture.logs.ops_log.exists());
}

#[test]
fn binary_manifest_stdin_rejects_extra_args_before_telemetry() {
    let fixture = BinaryLoggingFixture::new("stdin-extra-arg").unwrap();

    let output = fixture
        .command()
        .arg("--manifest-stdin")
        .arg("--ignored")
        .output()
        .unwrap();

    assert!(!output.status.success());
    let content = fixture.read_system_log().unwrap();
    assert!(
        content.contains("[ERROR] [sandbox:download] Usage: guest-download"),
        "unexpected system log: {content:?}"
    );
    assert!(!fixture.logs.ops_log.exists());
}

#[test]
fn binary_invalid_stdin_manifest_logs_parse_failure_without_body() {
    let fixture = BinaryLoggingFixture::new("stdin-invalid").unwrap();
    let body = b"{{not valid json super-secret-body";

    let output = fixture.run_manifest_stdin(body).unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains("super-secret-body"));
    let content = fixture.read_system_log().unwrap();
    assert!(
        content.contains("[ERROR] [sandbox:download] Failed to parse manifest"),
        "unexpected system log: {content:?}"
    );
    assert!(!content.contains("super-secret-body"));
    let ops = fixture.ops_entries().unwrap();
    assert_single_download_total_success(&ops, false);
}

#[test]
fn binary_writes_system_log_on_manifest_read_failure() {
    let fixture = BinaryLoggingFixture::new("missing-manifest").unwrap();

    let output = fixture
        .run_manifest_path("/tmp/nonexistent-guest-download-manifest.json")
        .unwrap();

    assert!(!output.status.success());

    let content = fixture.read_system_log().unwrap();
    assert!(
        content.contains("[ERROR] [sandbox:download] Failed to read manifest"),
        "unexpected system log: {content:?}"
    );
    assert!(
        content.contains("[ERROR] [sandbox:download] Download failed"),
        "unexpected system log: {content:?}"
    );
    let ops = fixture.ops_entries().unwrap();
    assert_single_download_total_success(&ops, false);
}

#[test]
fn binary_without_manifest_path_logs_usage() {
    let fixture = BinaryLoggingFixture::new("missing-arg").unwrap();

    let output = fixture.command().output().unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("[ERROR] [sandbox:download] Usage: guest-download <manifest_path>"),
        "unexpected stderr: {stderr}"
    );
    let content = fixture.read_system_log().unwrap();
    assert!(
        content.contains("[ERROR] [sandbox:download] Usage: guest-download <manifest_path>"),
        "unexpected system log: {content:?}"
    );
    assert!(
        !fixture.logs.ops_log.exists(),
        "usage failure should not record download_total before a run starts"
    );
}
