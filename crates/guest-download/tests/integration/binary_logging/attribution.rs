use super::{BinaryLoggingFixture, assert_action_types_present};
use crate::support::{create_tar_gz, read_http_request_path, write_manifest};
use httpmock::prelude::*;
use httpmock::{HttpMockRequest, HttpMockResponse};
use serde_json::Value;
use std::io::Write as _;
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::Duration;

const STORAGE_REMOTE_PREFIX: &str = "storage_download_remote_";
const ARTIFACT_REMOTE_PREFIX: &str = "artifact_download_remote_";

fn operation<'a>(ops: &'a [Value], action: &str) -> Option<&'a Value> {
    ops.iter().find(|entry| entry["action_type"] == action)
}

fn action_precedes(actions: &[String], earlier: &str, later: &str) -> bool {
    let earlier_index = actions.iter().position(|action| action == earlier);
    let later_index = actions.iter().position(|action| action == later);
    earlier_index
        .zip(later_index)
        .is_some_and(|(earlier_index, later_index)| earlier_index < later_index)
}

fn deterministic_bytes(len: usize) -> Vec<u8> {
    let mut state = 0x1234_5678_u32;
    (0..len)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            state.to_be_bytes().into_iter().next().unwrap_or_default()
        })
        .collect()
}

fn start_delayed_archive_server(
    archive: Vec<u8>,
    header_delay: Duration,
    body_delay: Duration,
) -> std::io::Result<(String, thread::JoinHandle<std::io::Result<()>>)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let url = format!("http://{}/archive.tar.gz", listener.local_addr()?);
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept()?;
        assert_eq!(read_http_request_path(&mut stream)?, "/archive.tar.gz");
        thread::sleep(header_delay);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\ncontent-type: application/gzip\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            archive.len()
        )?;
        stream.flush()?;
        thread::sleep(body_delay);
        stream.write_all(&archive)?;
        stream.flush()
    });
    Ok((url, handle))
}

#[test]
fn binary_records_download_scheduler_attribution() {
    let server = MockServer::start();
    let remote_tar = create_tar_gz(&[("remote.txt", b"remote")]).unwrap();
    let remote_mock = server.mock(|when, then| {
        when.method(GET).path("/remote.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&remote_tar);
    });

    let fixture = BinaryLoggingFixture::new("scheduler-attribution").unwrap();
    let local_tar = create_tar_gz(&[("local.txt", b"local")]).unwrap();
    let local_archive = fixture.dir.path().join("local.tar.gz");
    std::fs::write(&local_archive, local_tar).unwrap();
    let parent_mount = fixture.dir.path().join("mount");
    let child_mount = parent_mount.join("child");
    let remote_url = server.url("/remote.tar.gz");
    let local_url = format!("file://{}", local_archive.display());
    let manifest = write_manifest(
        &fixture.dir,
        &[(parent_mount.to_str().unwrap(), Some(&remote_url))],
        Some((child_mount.to_str().unwrap(), Some(&local_url))),
    )
    .unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    remote_mock.assert_calls(1);
    assert_eq!(
        std::fs::read_to_string(parent_mount.join("remote.txt")).unwrap(),
        "remote"
    );
    assert_eq!(
        std::fs::read_to_string(child_mount.join("local.txt")).unwrap(),
        "local"
    );

    let actions = fixture.action_types().unwrap();
    assert_action_types_present(
        &actions,
        &[
            "guest_download_task_count_2",
            "guest_download_remote_url_count_1",
            "guest_download_file_url_count_1",
            "guest_download_skill_child_task_count_0",
            "guest_download_framework_home_instructions_task_absent",
            "guest_download_potential_parent_child_overlap_count_1",
            "guest_download_mount_conflict_deferral_count_1",
            "guest_download_instructions_skill_conflict_deferral_count_0",
            "guest_download_exact_path_conflict_deferral_count_0",
            "guest_download_other_parent_child_conflict_deferral_count_1",
            "storage_download",
            "storage_download_remote_request_to_response_headers",
            "storage_download_remote_body_read",
            "storage_download_remote_extract_outside_body_read",
            "storage_download_remote_compressed_bytes_consumed_lt_64_kib",
            "storage_download_remote_attempt_count_1",
            "artifact_download",
            "download_total",
        ],
    );
    assert!(
        action_precedes(&actions, "guest_download_task_count_2", "storage_download"),
        "expected batch attribution before task attribution in {actions:?}"
    );
    assert!(
        action_precedes(
            &actions,
            "storage_download",
            "storage_download_remote_request_to_response_headers"
        ),
        "expected task total before remote attribution in {actions:?}"
    );
    assert!(
        action_precedes(
            &actions,
            "storage_download_remote_attempt_count_1",
            "guest_download_mount_conflict_deferral_count_1"
        ),
        "expected remote attribution before conflict totals in {actions:?}"
    );
    assert!(
        action_precedes(
            &actions,
            "artifact_download",
            "guest_download_mount_conflict_deferral_count_1"
        ),
        "expected task attribution before conflict totals in {actions:?}"
    );
    assert!(
        action_precedes(
            &actions,
            "guest_download_mount_conflict_deferral_count_1",
            "download_total"
        ),
        "expected conflict totals before run total in {actions:?}"
    );
    assert!(
        !actions
            .iter()
            .any(|action| action.starts_with(ARTIFACT_REMOTE_PREFIX)),
        "local artifact emitted remote attribution: {actions:?}"
    );
}

#[test]
fn binary_records_scheduler_attribution_for_failed_download() {
    let server = MockServer::start();
    let remote_mock = server.mock(|when, then| {
        when.method(GET).path("/missing.tar.gz");
        then.status(404);
    });

    let fixture = BinaryLoggingFixture::new("scheduler-attribution-failure").unwrap();
    let local_tar = create_tar_gz(&[("local.txt", b"local")]).unwrap();
    let local_archive = fixture.dir.path().join("local.tar.gz");
    std::fs::write(&local_archive, local_tar).unwrap();
    let parent_mount = fixture.dir.path().join("mount");
    let child_mount = parent_mount.join("child");
    let remote_url = server.url("/missing.tar.gz");
    let local_url = format!("file://{}", local_archive.display());
    let manifest = write_manifest(
        &fixture.dir,
        &[(parent_mount.to_str().unwrap(), Some(&remote_url))],
        Some((child_mount.to_str().unwrap(), Some(&local_url))),
    )
    .unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(
        !output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    remote_mock.assert_calls(1);
    assert_eq!(
        std::fs::read_to_string(child_mount.join("local.txt")).unwrap(),
        "local"
    );

    let ops = fixture.ops_entries().unwrap();
    let conflict = ops
        .iter()
        .find(|entry| entry["action_type"] == "guest_download_mount_conflict_deferral_count_1")
        .unwrap_or_else(|| panic!("missing mount conflict count in {ops:?}"));
    assert_eq!(conflict["success"], true);
    let other_parent_child_conflict = ops
        .iter()
        .find(|entry| {
            entry["action_type"] == "guest_download_other_parent_child_conflict_deferral_count_1"
        })
        .unwrap_or_else(|| panic!("missing other parent/child conflict count in {ops:?}"));
    assert_eq!(other_parent_child_conflict["success"], true);
    let total = ops
        .iter()
        .find(|entry| entry["action_type"] == "download_total")
        .unwrap_or_else(|| panic!("missing download_total in {ops:?}"));
    assert_eq!(total["success"], false);

    let remote_ops: Vec<&Value> = ops
        .iter()
        .filter(|entry| {
            entry["action_type"]
                .as_str()
                .is_some_and(|action| action.starts_with(STORAGE_REMOTE_PREFIX))
        })
        .collect();
    assert_eq!(remote_ops.len(), 5, "unexpected remote operations: {ops:?}");
    assert!(remote_ops.iter().all(|entry| entry["success"] == false));
    assert!(remote_ops.iter().all(|entry| entry.get("error").is_none()));
    assert_eq!(
        operation(&ops, "storage_download_remote_attempt_count_1").unwrap()["duration_ms"],
        0
    );
    assert_eq!(
        operation(
            &ops,
            "storage_download_remote_compressed_bytes_consumed_zero"
        )
        .unwrap()["duration_ms"],
        0
    );
}

#[test]
fn binary_records_remote_artifact_attribution_and_compressed_byte_bucket() {
    let server = MockServer::start();
    let content = deterministic_bytes(100_000);
    let archive = create_tar_gz(&[("artifact.bin", &content)]).unwrap();
    assert!(archive.len() >= 65_536, "archive compressed too small");
    assert!(archive.len() < 262_144, "archive compressed too large");
    let archive_mock = server.mock(|when, then| {
        when.method(GET).path("/artifact.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&archive);
    });

    let fixture = BinaryLoggingFixture::new("artifact-remote-attribution").unwrap();
    let mount = fixture.dir.path().join("artifact");
    let url = server.url("/artifact.tar.gz");
    let manifest = write_manifest(
        &fixture.dir,
        &[],
        Some((mount.to_str().unwrap(), Some(&url))),
    )
    .unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    archive_mock.assert_calls(1);
    assert_eq!(std::fs::read(mount.join("artifact.bin")).unwrap(), content);

    let actions = fixture.action_types().unwrap();
    assert_action_types_present(
        &actions,
        &[
            "artifact_download",
            "artifact_download_remote_request_to_response_headers",
            "artifact_download_remote_body_read",
            "artifact_download_remote_extract_outside_body_read",
            "artifact_download_remote_compressed_bytes_consumed_64_kib_to_256_kib",
            "artifact_download_remote_attempt_count_1",
        ],
    );
    for remote_action in actions
        .iter()
        .filter(|action| action.starts_with(ARTIFACT_REMOTE_PREFIX))
    {
        assert!(
            action_precedes(&actions, "artifact_download", remote_action),
            "expected artifact total before {remote_action} in {actions:?}"
        );
    }
    assert!(
        !actions
            .iter()
            .any(|action| action.starts_with(STORAGE_REMOTE_PREFIX)),
        "artifact emitted storage attribution: {actions:?}"
    );
}

#[test]
fn binary_aggregates_remote_attribution_across_retries() {
    let server = MockServer::start();
    let archive = create_tar_gz(&[("recovered.txt", b"recovered")]).unwrap();
    let calls = AtomicUsize::new(0);
    let archive_mock = server.mock(move |when, then| {
        when.method(GET).path("/retry.tar.gz");
        then.delay(Duration::from_millis(60))
            .respond_with(move |_request: &HttpMockRequest| {
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    HttpMockResponse::builder().status(500).build()
                } else {
                    HttpMockResponse::builder()
                        .status(200)
                        .header("content-type", "application/gzip")
                        .body(archive.clone())
                        .build()
                }
            });
    });

    let fixture = BinaryLoggingFixture::new("remote-attribution-retry").unwrap();
    let mount = fixture.dir.path().join("storage");
    let url = server.url("/retry.tar.gz");
    let manifest =
        write_manifest(&fixture.dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    archive_mock.assert_calls(2);
    let ops = fixture.ops_entries().unwrap();
    let attempt = operation(&ops, "storage_download_remote_attempt_count_2").unwrap();
    assert_eq!(attempt["success"], true);
    assert!(attempt.get("error").is_none());
    assert_eq!(
        operation(&ops, "storage_download_remote_request_to_response_headers").unwrap()["success"],
        true
    );
    let request_wait = operation(&ops, "storage_download_remote_request_to_response_headers")
        .unwrap()["duration_ms"]
        .as_u64()
        .unwrap();
    assert!(
        request_wait >= 100,
        "request wait did not include both attempts: {ops:?}"
    );
}

#[test]
fn binary_separates_response_header_and_body_read_wait() {
    let archive = create_tar_gz(&[("delayed.txt", b"delayed")]).unwrap();
    let delay = Duration::from_millis(80);
    let (url, server) = start_delayed_archive_server(archive, delay, delay).unwrap();
    let fixture = BinaryLoggingFixture::new("remote-attribution-delays").unwrap();
    let mount = fixture.dir.path().join("storage");
    let manifest =
        write_manifest(&fixture.dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();
    server.join().unwrap().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let ops = fixture.ops_entries().unwrap();
    let header_wait = operation(&ops, "storage_download_remote_request_to_response_headers")
        .unwrap()["duration_ms"]
        .as_u64()
        .unwrap();
    let body_wait = operation(&ops, "storage_download_remote_body_read").unwrap()["duration_ms"]
        .as_u64()
        .unwrap();
    assert!(
        header_wait >= 50,
        "header wait was {header_wait}ms: {ops:?}"
    );
    assert!(body_wait >= 50, "body wait was {body_wait}ms: {ops:?}");
}
