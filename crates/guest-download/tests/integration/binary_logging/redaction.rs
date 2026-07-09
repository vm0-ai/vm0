use super::{BinaryLoggingFixture, assert_download_total_success_present};
use crate::support::{assert_does_not_contain_any, create_tar_gz, write_manifest};
use httpmock::prelude::*;

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

    let fixture = BinaryLoggingFixture::new("secret-url-success").unwrap();
    let mount = fixture.dir.path().join("mount");
    let url = server.url(
        "/storage-object-key/archive.tar.gz?X-Amz-Signature=super-secret-token&X-Amz-Credential=credential-secret",
    );
    let manifest =
        write_manifest(&fixture.dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

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
    let system_log_content = fixture.read_system_log().unwrap();
    let ops_log_content = fixture.read_ops_log().unwrap();
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

    let fixture = BinaryLoggingFixture::new("secret-url-fatal").unwrap();
    let mount = fixture.dir.path().join("mount");
    let url = server.url(
        "/failing-storage-object/archive.tar.gz?X-Amz-Signature=fatal-secret-token&X-Amz-Credential=fatal-credential",
    );
    let manifest =
        write_manifest(&fixture.dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(!output.status.success());
    mock.assert_calls(1);

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log_content = fixture.read_system_log().unwrap();
    let ops_log_content = fixture.read_ops_log().unwrap();
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

    let ops = fixture.ops_entries().unwrap();
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
    assert_download_total_success_present(&ops, false);
}

#[test]
fn binary_records_artifact_404_as_fatal_status() {
    let server = MockServer::start();

    let mock = server.mock(|when, then| {
        when.method(GET)
            .path("/failing-artifact-object/archive.tar.gz");
        then.status(404);
    });

    let fixture = BinaryLoggingFixture::new("artifact-secret-url-fatal").unwrap();
    let mount = fixture.dir.path().join("artifact-mount");
    let url = server.url(
        "/failing-artifact-object/archive.tar.gz?X-Amz-Signature=artifact-secret-token&X-Amz-Credential=artifact-credential",
    );
    let manifest = write_manifest(
        &fixture.dir,
        &[],
        Some((mount.to_str().unwrap(), Some(&url))),
    )
    .unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(!output.status.success());
    mock.assert_calls(1);

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log_content = fixture.read_system_log().unwrap();
    let ops_log_content = fixture.read_ops_log().unwrap();
    let forbidden = [
        url.as_str(),
        "failing-artifact-object",
        "X-Amz-Signature",
        "artifact-secret-token",
        "X-Amz-Credential",
        "artifact-credential",
    ];
    assert_does_not_contain_any("stderr", &stderr, &forbidden);
    assert_does_not_contain_any("system log", &system_log_content, &forbidden);
    assert_does_not_contain_any("sandbox ops log", &ops_log_content, &forbidden);
    assert!(
        stderr.contains("HTTP status 404"),
        "unexpected stderr: {stderr}"
    );

    let ops = fixture.ops_entries().unwrap();
    assert!(
        ops.iter()
            .any(|entry| entry["action_type"] == "artifact_download"
                && entry["success"] == false
                && entry["error"]
                    .as_str()
                    .is_some_and(|error| error.contains("HTTP status 404")
                        && error.contains("mountPath=")
                        && error.contains("urlScheme=http"))),
        "missing failed artifact_download entry: {ops_log_content}"
    );
    assert_download_total_success_present(&ops, false);
}

#[test]
fn binary_does_not_log_file_archive_path_on_missing_local_file() {
    let fixture = BinaryLoggingFixture::new("secret-file-path").unwrap();
    let missing = fixture.dir.path().join("secret-staged-archive.tar.gz");
    assert!(!missing.exists());

    let mount = fixture.dir.path().join("mount");
    let url = format!("file://{}", missing.display());
    let manifest =
        write_manifest(&fixture.dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(!output.status.success());

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log_content = fixture.read_system_log().unwrap();
    let ops_log_content = fixture.read_ops_log().unwrap();
    let missing_path = missing.to_string_lossy();
    let forbidden = [url.as_str(), missing_path.as_ref(), "secret-staged-archive"];
    assert_does_not_contain_any("stderr", &stderr, &forbidden);
    assert_does_not_contain_any("system log", &system_log_content, &forbidden);
    assert_does_not_contain_any("sandbox ops log", &ops_log_content, &forbidden);
}
