use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use vsock_proto::{
    ExecCapturedOutput, ExecTermination, GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES,
    MSG_GUEST_STORAGE_MANIFEST, MSG_GUEST_STORAGE_MANIFEST_RESULT, MSG_OPERATIONS_QUIESCED,
};

use super::support::*;

fn create_program(body: &str) -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("guest-download-test");
    std::fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    (directory, path)
}

fn send_request(
    stream: &mut impl Write,
    seq: u32,
    timeout_ms: u32,
    run_id: &str,
    runtime_dir: &str,
    manifest_json: &[u8],
) {
    let payload = vsock_proto::encode_guest_storage_manifest_request(
        timeout_ms,
        run_id,
        runtime_dir,
        manifest_json,
    )
    .unwrap();
    let frame = vsock_proto::encode(MSG_GUEST_STORAGE_MANIFEST, seq, &payload).unwrap();
    stream.write_all(&frame).unwrap();
}

struct TestResult {
    termination: ExecTermination,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
    diagnostic: String,
}

fn read_result(stream: &mut impl std::io::Read, seq: u32) -> TestResult {
    let message = read_message(stream);
    assert_eq!(message.msg_type, MSG_GUEST_STORAGE_MANIFEST_RESULT);
    assert_eq!(message.seq, seq);
    let decoded = vsock_proto::decode_guest_storage_manifest_result(&message.payload).unwrap();
    let (stdout, stdout_truncated) = captured(decoded.stdout);
    let (stderr, stderr_truncated) = captured(decoded.stderr);
    TestResult {
        termination: decoded.termination,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        diagnostic: decoded.diagnostic.to_owned(),
    }
}

fn captured(output: ExecCapturedOutput<'_>) -> (Vec<u8>, bool) {
    match output {
        ExecCapturedOutput::Captured { bytes, truncated } => (bytes.to_vec(), truncated),
        ExecCapturedOutput::Discarded => panic!("storage helper output must be captured"),
    }
}

fn slow_program(pid_path: &Path) -> String {
    format!(
        "printf '%s' \"$$\" > '{}'; cat >/dev/null; sleep 60",
        pid_path.display()
    )
}

#[test]
fn guest_storage_manifest_runs_fixed_argv_env_and_stdin() {
    let (_directory, program) = create_program(
        r#"
[ "$1" = "--manifest-stdin" ]
[ "$OKOU_RUN_ID" = "run-1" ]
[ "$OKOU_GUEST_RUNTIME_DIR" = "/run/vm0/runs/run-1" ]
[ "${VM0_GUEST_RUNTIME_DIR+x}" != x ]
[ "$(cat)" = '{"storages":[]}' ]
printf 'applied\n'
printf 'helper stderr\n' >&2
"#,
    );
    let (handle, mut host_stream) = start_guest_connection_with_storage_manifest_program(program);

    send_request(
        &mut host_stream,
        401,
        1_000,
        "run-1",
        "/run/vm0/runs/run-1",
        br#"{"storages":[]}"#,
    );
    let result = read_result(&mut host_stream, 401);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, b"applied\n");
    assert_eq!(result.stderr, b"helper stderr\n");
    assert!(!result.stdout_truncated);
    assert!(!result.stderr_truncated);
    assert!(result.diagnostic.is_empty());
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_storage_manifest_returns_nonzero_exit_and_captured_diagnostic_output() {
    let (_directory, program) = create_program(
        r#"
cat >/dev/null
printf 'manifest failed\n' >&2
exit 7
"#,
    );
    let (handle, mut host_stream) = start_guest_connection_with_storage_manifest_program(program);

    send_request(&mut host_stream, 411, 1_000, "run", "/run", b"{}");
    let result = read_result(&mut host_stream, 411);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 7 });
    assert!(result.stdout.is_empty());
    assert_eq!(result.stderr, b"manifest failed\n");
    assert!(!result.stdout_truncated);
    assert!(!result.stderr_truncated);
    assert!(result.diagnostic.is_empty());
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_storage_manifest_bounds_both_output_streams() {
    let output_bytes = GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES + 1_024;
    let (_directory, program) = create_program(&format!(
        "cat >/dev/null; head -c {output_bytes} /dev/zero | tr '\\000' x; head -c {output_bytes} /dev/zero | tr '\\000' y >&2"
    ));
    let (handle, mut host_stream) = start_guest_connection_with_storage_manifest_program(program);

    send_request(&mut host_stream, 402, 5_000, "run", "/run", b"{}");
    let result = read_result(&mut host_stream, 402);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(
        result.stdout.len(),
        GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES
    );
    assert_eq!(
        result.stderr.len(),
        GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES
    );
    assert!(result.stdout_truncated);
    assert!(result.stderr_truncated);
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_storage_manifest_timeout_kills_and_reaps_process_group() {
    let pid_path = unique_pid_path("storage-manifest-timeout");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&slow_program(Path::new(pid_path.as_str())));
    let (handle, mut host_stream) = start_guest_connection_with_storage_manifest_program(program);

    send_request(&mut host_stream, 403, 20, "run", "/run", b"{}");
    let pid = process_guard.read_pid();
    let result = read_result(&mut host_stream, 403);

    assert_eq!(result.termination, ExecTermination::TimedOut);
    wait_for_pid_exit(pid, "guest storage manifest timeout");
    process_guard.disarm();
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_storage_manifest_natural_exit_cleans_remaining_process_group() {
    let pid_path = unique_pid_path("storage-manifest-natural-exit");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&format!(
        "cat >/dev/null; sleep 60 & printf '%s' \"$!\" > '{}'; printf 'applied\\n'",
        pid_path.as_str()
    ));
    let (handle, mut host_stream) = start_guest_connection_with_storage_manifest_program(program);

    send_request(&mut host_stream, 408, 1_000, "run", "/run", b"{}");
    let pid = process_guard.read_pid();
    let result = read_result(&mut host_stream, 408);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, b"applied\n");
    wait_for_pid_exit(pid, "guest storage manifest natural exit");
    process_guard.disarm();
    finish_guest_connection(handle, host_stream);
}

#[test]
fn guest_storage_manifest_connection_close_kills_and_reaps_process_group() {
    let pid_path = unique_pid_path("storage-manifest-disconnect");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&slow_program(Path::new(pid_path.as_str())));
    let (handle, mut host_stream) = start_guest_connection_with_storage_manifest_program(program);

    send_request(&mut host_stream, 404, 60_000, "run", "/run", b"{}");
    let pid = process_guard.read_pid();
    drop(host_stream);
    join_guest_connection(handle);

    wait_for_pid_exit(pid, "guest storage manifest connection close");
    process_guard.disarm();
}

#[test]
fn guest_storage_manifest_rejects_concurrent_request_and_cleans_active_process() {
    let pid_path = unique_pid_path("storage-manifest-busy");
    let mut process_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (_directory, program) = create_program(&slow_program(Path::new(pid_path.as_str())));
    let (handle, mut host_stream) = start_guest_connection_with_storage_manifest_program(program);

    send_request(&mut host_stream, 409, 60_000, "run", "/run", b"{}");
    let pid = process_guard.read_pid();
    send_request(&mut host_stream, 410, 1_000, "run", "/run", b"{}");
    let error = read_error_response(&mut host_stream, 410);
    assert!(error.contains("already active"));

    drop(host_stream);
    join_guest_connection(handle);
    wait_for_pid_exit(pid, "guest storage manifest busy connection close");
    process_guard.disarm();
}

#[test]
fn guest_storage_manifest_validates_request_and_obeys_quiesce_gate() {
    let marker = unique_tmp_path("storage-manifest-quiesce", ".marker");
    let (_directory, program) = create_program(&format!("touch '{}'; exit 0", marker.as_str()));
    let (handle, mut host_stream) = start_guest_connection_with_storage_manifest_program(program);

    let malformed = vsock_proto::encode(MSG_GUEST_STORAGE_MANIFEST, 405, b"bad").unwrap();
    host_stream.write_all(&malformed).unwrap();
    let malformed_error = read_error_response(&mut host_stream, 405);
    assert!(malformed_error.contains("timeout_ms truncated"));

    send_quiesce_operations(&mut host_stream, 406);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    send_request(&mut host_stream, 407, 1_000, "run", "/run", b"{}");
    let quiesce_error = read_error_response(&mut host_stream, 407);
    assert!(quiesce_error.contains("operations are quiescing"));
    assert!(!Path::new(marker.as_str()).exists());

    finish_guest_connection(handle, host_stream);
}
