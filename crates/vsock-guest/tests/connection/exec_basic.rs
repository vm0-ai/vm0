use std::io::Write;

use vsock_proto::{
    self, ExecControlPolicy, ExecLifecyclePolicy, ExecOutputPolicy, ExecTermination,
    ExecTimeoutPolicy, MSG_EXEC_START,
};

use super::support::*;

#[test]
fn exec_operation_capture_only_stdout_stderr_success() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        101,
        "printf stdout; printf stderr >&2",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 101);

    assert!(chunks.is_empty());
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"stdout".to_vec()));
    assert_eq!(result.stderr, Some(b"stderr".to_vec()));
    assert!(!result.stdout_truncated);
    assert!(!result.stderr_truncated);
    assert!(result.diagnostic.is_empty());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_expected_nonzero_exit_still_returns_result() {
    let (handle, mut host_stream) = start_guest_connection();

    let payload = vsock_proto::encode_exec_start_with_expected_exit_codes(
        vsock_proto::ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::OneShot,
            timeout: ExecTimeoutPolicy::Duration { timeout_ms: 5000 },
            command: "exit 66",
            env: &[],
            sudo: false,
            label: "test",
            stdout: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[66],
            control: ExecControlPolicy::Disabled,
            stdin_bytes: None,
        },
    );
    let msg = vsock_proto::encode(MSG_EXEC_START, 102, &payload.unwrap()).unwrap();
    host_stream.write_all(&msg).unwrap();
    let (chunks, result) = read_exec_result(&mut host_stream, 102);

    assert!(chunks.is_empty());
    assert_eq!(
        result.termination,
        ExecTermination::Exited { exit_code: 66 }
    );
    assert_eq!(result.stdout, Some(Vec::new()));
    assert_eq!(result.stderr, Some(Vec::new()));
    assert!(result.diagnostic.is_empty());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_large_env_payload_succeeds() {
    let values = large_env_values();
    let env = large_env_entries(&values);
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start_with_env(
        &mut host_stream,
        124,
        LARGE_ENV_COMMAND,
        5000,
        &env,
        ExecOutputPolicy::Capture { limit_bytes: 128 },
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
    );
    let (_chunks, result) = read_exec_result(&mut host_stream, 124);

    assert_eq!(
        result.termination,
        ExecTermination::Exited { exit_code: 0 },
        "diagnostic: {} stderr: {:?}",
        result.diagnostic,
        result.stderr,
    );
    assert_large_env_stdout(&result.stdout.unwrap_or_default());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_repeated_short_operations_soak() {
    let (handle, mut host_stream) = start_guest_connection();

    for seq in 130..138 {
        let expected = format!("run-{seq}");
        send_exec_start(
            &mut host_stream,
            seq,
            &format!("printf {expected}"),
            5000,
            ExecOutputPolicy::Capture { limit_bytes: 64 },
            ExecOutputPolicy::Capture { limit_bytes: 64 },
        );
        let (chunks, result) = read_exec_result(&mut host_stream, seq);

        assert!(chunks.is_empty());
        assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
        assert_eq!(result.stdout, Some(expected.into_bytes()));
        assert_eq!(result.stderr, Some(Vec::new()));
        assert!(!result.stdout_truncated);
        assert!(!result.stderr_truncated);
    }

    finish_guest_connection(handle, host_stream);
}
