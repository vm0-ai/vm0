use super::{BinaryLoggingFixture, assert_download_total_success_present};
use crate::support::{
    assert_does_not_contain_any, create_tar_gz, read_http_request_path, write_manifest,
};
use httpmock::prelude::*;
use std::io::{self, Write as _};
use std::net::{TcpListener, TcpStream};
use std::thread;

const EXPECTED_RETRY_ATTEMPTS: usize = 3;
const SERVER_STOP_PATH: &str = "/__stop";

fn validate_attempt_warning(
    log_name: &str,
    log: &str,
    attempt: usize,
    expected_error: &str,
) -> Result<(), String> {
    let prefix = format!("Attempt {attempt}/{EXPECTED_RETRY_ATTEMPTS} failed after ");
    let line = log
        .lines()
        .find(|line| line.contains(&prefix) && line.contains(expected_error))
        .ok_or_else(|| {
            format!("missing {prefix:?} with {expected_error:?} in {log_name}: {log}")
        })?;
    let elapsed = line
        .split_once(&prefix)
        .and_then(|(_, suffix)| suffix.split_once("ms: "))
        .map(|(elapsed, _)| elapsed)
        .ok_or_else(|| format!("malformed attempt warning in {log_name}: {line}"))?;
    if elapsed.is_empty() || !elapsed.chars().all(|character| character.is_ascii_digit()) {
        return Err(format!(
            "invalid elapsed milliseconds in {log_name}: {line}"
        ));
    }
    Ok(())
}

fn validate_attempt_warnings(
    log_name: &str,
    log: &str,
    expected_attempts: usize,
    expected_error: &str,
) -> Result<(), String> {
    let warning_count = log.lines().filter(|line| line.contains("Attempt ")).count();
    if warning_count != expected_attempts {
        return Err(format!(
            "unexpected attempt warning count in {log_name}: {log}"
        ));
    }
    for attempt in 1..=expected_attempts {
        validate_attempt_warning(log_name, log, attempt, expected_error)?;
    }
    Ok(())
}

fn start_connection_drop_server() -> io::Result<(String, thread::JoinHandle<io::Result<usize>>)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let base_url = format!("http://{}", listener.local_addr()?);
    let handle = thread::spawn(move || {
        let mut accepted = 0;
        loop {
            let (mut stream, _) = listener.accept()?;
            if read_http_request_path(&mut stream)? == SERVER_STOP_PATH {
                return Ok(accepted);
            }
            accepted += 1;
        }
    });

    Ok((base_url, handle))
}

fn stop_connection_drop_server(base_url: &str) -> io::Result<()> {
    let address = base_url
        .strip_prefix("http://")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid server URL"))?;
    let mut stream = TcpStream::connect(address)?;
    stream.write_all(
        format!("GET {SERVER_STOP_PATH} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n")
            .as_bytes(),
    )
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
    validate_attempt_warning("stderr", &stderr, 1, "HTTP status 404").unwrap();
    validate_attempt_warning("system log", &system_log_content, 1, "HTTP status 404").unwrap();

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
fn binary_classifies_malformed_http_url_without_logging_it() {
    let fixture = BinaryLoggingFixture::new("malformed-secret-url").unwrap();
    let mount = fixture.dir.path().join("mount");
    let url = "http://invalid host/storage-object/archive.tar.gz?X-Amz-Signature=malformed-secret-token&X-Amz-Credential=malformed-credential";
    let manifest =
        write_manifest(&fixture.dir, &[(mount.to_str().unwrap(), Some(url))], None).unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(!output.status.success());

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log_content = fixture.read_system_log().unwrap();
    let ops_log_content = fixture.read_ops_log().unwrap();
    let forbidden = [
        url,
        "invalid host",
        "X-Amz-Signature",
        "malformed-secret-token",
        "X-Amz-Credential",
        "malformed-credential",
    ];
    assert_does_not_contain_any("stderr", &stderr, &forbidden);
    assert_does_not_contain_any("system log", &system_log_content, &forbidden);
    assert_does_not_contain_any("sandbox ops log", &ops_log_content, &forbidden);

    let expected_error = "HTTP request error (kind=invalid_request)";
    validate_attempt_warnings("stderr", &stderr, 1, expected_error).unwrap();
    validate_attempt_warnings("system log", &system_log_content, 1, expected_error).unwrap();

    let ops = fixture.ops_entries().unwrap();
    assert!(
        ops.iter()
            .any(|entry| entry["action_type"] == "storage_download"
                && entry["success"] == false
                && entry["error"]
                    .as_str()
                    .is_some_and(|error| error.contains(expected_error))),
        "missing classified storage_download entry: {ops_log_content}"
    );
    assert_download_total_success_present(&ops, false);
}

#[test]
fn binary_classifies_connection_drop_without_logging_url() {
    let (base_url, server_handle) = start_connection_drop_server().unwrap();
    let fixture = BinaryLoggingFixture::new("connection-drop-secret-url").unwrap();
    let mount = fixture.dir.path().join("mount");
    let url = format!(
        "{base_url}/storage-object/archive.tar.gz?X-Amz-Signature=connection-secret-token&X-Amz-Credential=connection-credential"
    );
    let manifest =
        write_manifest(&fixture.dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();
    stop_connection_drop_server(&base_url).unwrap();
    let accepted = server_handle.join().unwrap().unwrap();

    assert!(!output.status.success());
    assert_eq!(accepted, EXPECTED_RETRY_ATTEMPTS);

    let stderr = String::from_utf8_lossy(&output.stderr);
    let system_log_content = fixture.read_system_log().unwrap();
    let ops_log_content = fixture.read_ops_log().unwrap();
    let forbidden = [
        url.as_str(),
        "storage-object",
        "X-Amz-Signature",
        "connection-secret-token",
        "X-Amz-Credential",
        "connection-credential",
    ];
    assert_does_not_contain_any("stderr", &stderr, &forbidden);
    assert_does_not_contain_any("system log", &system_log_content, &forbidden);
    assert_does_not_contain_any("sandbox ops log", &ops_log_content, &forbidden);

    let expected_error = "HTTP request error (kind=io io_kind=UnexpectedEof)";
    validate_attempt_warnings("stderr", &stderr, EXPECTED_RETRY_ATTEMPTS, expected_error).unwrap();
    validate_attempt_warnings(
        "system log",
        &system_log_content,
        EXPECTED_RETRY_ATTEMPTS,
        expected_error,
    )
    .unwrap();

    let ops = fixture.ops_entries().unwrap();
    assert!(
        ops.iter()
            .any(|entry| entry["action_type"] == "storage_download"
                && entry["success"] == false
                && entry["error"]
                    .as_str()
                    .is_some_and(|error| error.contains(expected_error))),
        "missing classified storage_download entry: {ops_log_content}"
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
