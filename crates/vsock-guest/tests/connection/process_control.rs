use std::thread;
use std::time::Duration;

use vsock_guest::handle_connection;
use vsock_proto::{
    self, MSG_ERROR, MSG_OPERATIONS_QUIESCED, MSG_SPAWN_PROCESS_RESULT, ProcessControlStatus,
};

use super::support::*;

#[test]
fn process_messages_seq_zero_return_error() {
    const NONCE: vsock_proto::ProcessControlNonce = *b"0123456789abcdef";

    let (handle, mut host_stream) = start_guest_connection();

    send_spawn_process_with_control_nonce(&mut host_stream, 0, "printf should-not-run", NONCE);
    let spawn_error = read_message(&mut host_stream);
    assert_eq!(spawn_error.msg_type, MSG_ERROR);
    assert_eq!(spawn_error.seq, 0);
    assert!(
        vsock_proto::decode_error(&spawn_error.payload)
            .unwrap()
            .contains("non-zero sequence")
    );

    send_process_control(&mut host_stream, 0, 1, NONCE, "message-zero");
    let control_error = read_message(&mut host_stream);
    assert_eq!(control_error.msg_type, MSG_ERROR);
    assert_eq!(control_error.seq, 0);
    assert!(
        vsock_proto::decode_error(&control_error.payload)
            .unwrap()
            .contains("non-zero sequence")
    );

    finish_guest_connection(handle, host_stream);
}

#[test]
fn process_control_validates_nonce_before_sink_dispatch() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    const NONCE: vsock_proto::ProcessControlNonce = *b"0123456789abcdef";

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    read_and_discard_message(&mut host_stream);
    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    send_spawn_process_with_control_nonce(&mut host_stream, 31, "sleep 60", NONCE);
    let result = read_message(&mut host_stream);
    assert_eq!(result.msg_type, MSG_SPAWN_PROCESS_RESULT);
    assert_eq!(result.seq, 31);

    send_process_control(&mut host_stream, 32, 31, NONCE, "message-1");
    assert_process_control_result(
        &mut host_stream,
        32,
        31,
        NONCE,
        "message-1",
        ProcessControlStatus::Unsupported,
        "process control sink is not configured",
    );

    drop(host_stream);
    let _ = handle.join();
}

#[test]
fn process_control_rejects_nonce_mismatch() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    const NONCE: vsock_proto::ProcessControlNonce = *b"0123456789abcdef";
    const WRONG_NONCE: vsock_proto::ProcessControlNonce = *b"fedcba9876543210";

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    read_and_discard_message(&mut host_stream);
    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    send_spawn_process_with_control_nonce(&mut host_stream, 33, "sleep 60", NONCE);
    let result = read_message(&mut host_stream);
    assert_eq!(result.msg_type, MSG_SPAWN_PROCESS_RESULT);
    assert_eq!(result.seq, 33);

    send_process_control(&mut host_stream, 34, 33, WRONG_NONCE, "message-2");
    assert_process_control_result(
        &mut host_stream,
        34,
        33,
        WRONG_NONCE,
        "message-2",
        ProcessControlStatus::NonceMismatch,
        "process operation nonce mismatch",
    );

    drop(host_stream);
    let _ = handle.join();
}

#[test]
fn process_control_duplicate_spawn_seq_returns_error_without_replacing_active_nonce() {
    const NONCE: vsock_proto::ProcessControlNonce = *b"0123456789abcdef";
    const DUPLICATE_NONCE: vsock_proto::ProcessControlNonce = *b"fedcba9876543210";

    let (handle, mut host_stream) = start_guest_connection();

    send_spawn_process_with_control_nonce(&mut host_stream, 39, "sleep 60", NONCE);
    let result = read_message(&mut host_stream);
    assert_eq!(result.msg_type, MSG_SPAWN_PROCESS_RESULT);
    assert_eq!(result.seq, 39);

    send_spawn_process_with_control_nonce(
        &mut host_stream,
        39,
        "printf duplicate",
        DUPLICATE_NONCE,
    );
    let duplicate = read_message(&mut host_stream);
    assert_eq!(duplicate.msg_type, MSG_ERROR);
    assert_eq!(duplicate.seq, 39);
    let error = vsock_proto::decode_error(&duplicate.payload).unwrap();
    assert!(error.contains("already active"));

    send_process_control(&mut host_stream, 40, 39, NONCE, "message-duplicate");
    assert_process_control_result(
        &mut host_stream,
        40,
        39,
        NONCE,
        "message-duplicate",
        ProcessControlStatus::Unsupported,
        "process control sink is not configured",
    );

    finish_guest_connection(handle, host_stream);
}

#[test]
fn duplicate_spawn_seq_without_control_nonce_returns_error() {
    let (handle, mut host_stream) = start_guest_connection();

    send_spawn_process(&mut host_stream, 41, "sleep 60", None, 5000);
    let result = read_message(&mut host_stream);
    assert_eq!(result.msg_type, MSG_SPAWN_PROCESS_RESULT);
    assert_eq!(result.seq, 41);

    send_spawn_process(&mut host_stream, 41, "printf duplicate", None, 5000);
    let duplicate = read_message(&mut host_stream);
    assert_eq!(duplicate.msg_type, MSG_ERROR);
    assert_eq!(duplicate.seq, 41);
    let error = vsock_proto::decode_error(&duplicate.payload).unwrap();
    assert!(error.contains("already active"));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn duplicate_spawn_seq_releases_rejected_operation_guard() {
    let fifo_path = unique_tmp_path("duplicate-spawn-release", ".fifo");
    let fifo_cstr = std::ffi::CString::new(fifo_path.as_str()).unwrap();
    // SAFETY: fifo_cstr is a valid NUL-terminated path and mode is a normal
    // POSIX permission mask for a test-only FIFO.
    let mkfifo_result = unsafe { libc::mkfifo(fifo_cstr.as_ptr(), 0o600) };
    assert_eq!(
        mkfifo_result,
        0,
        "mkfifo failed: {:?}",
        std::io::Error::last_os_error()
    );

    let (handle, mut host_stream) = start_guest_connection();
    let command = format!("cat < {} >/dev/null; printf released", fifo_path.as_str());

    send_spawn_process(&mut host_stream, 42, &command, None, 5000);
    let result = read_message(&mut host_stream);
    assert_eq!(result.msg_type, MSG_SPAWN_PROCESS_RESULT);
    assert_eq!(result.seq, 42);
    let pid = vsock_proto::decode_spawn_process_result(&result.payload).unwrap();

    send_spawn_process(&mut host_stream, 42, "printf duplicate", None, 5000);
    let duplicate = read_message(&mut host_stream);
    assert_eq!(duplicate.msg_type, MSG_ERROR);
    assert_eq!(duplicate.seq, 42);
    let error = vsock_proto::decode_error(&duplicate.payload).unwrap();
    assert!(error.contains("already active"));

    let writer_path = fifo_path.as_str().to_owned();
    let writer = thread::spawn(move || {
        std::fs::write(writer_path, b"release").unwrap();
    });
    let (stdout_data, exit_code, stderr) =
        read_streaming_exit_after_result(&mut host_stream, 42, pid);
    writer.join().unwrap();
    assert_eq!(exit_code, 0);
    assert_eq!(stdout_data, b"released");
    assert!(
        stderr.is_empty(),
        "unexpected stderr from controlled process: {:?}",
        String::from_utf8_lossy(&stderr),
    );

    send_quiesce_operations(&mut host_stream, 43);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    assert_eq!(quiesced.seq, 43);
    assert!(quiesced.payload.is_empty());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn process_control_without_registered_nonce_returns_inactive() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    const NONCE: vsock_proto::ProcessControlNonce = *b"0123456789abcdef";

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    read_and_discard_message(&mut host_stream);
    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    send_spawn_process(&mut host_stream, 37, "sleep 60", None, 5000);
    let result = read_message(&mut host_stream);
    assert_eq!(result.msg_type, MSG_SPAWN_PROCESS_RESULT);
    assert_eq!(result.seq, 37);

    send_process_control(&mut host_stream, 38, 37, NONCE, "message-4");
    assert_process_control_result(
        &mut host_stream,
        38,
        37,
        NONCE,
        "message-4",
        ProcessControlStatus::Inactive,
        "process operation is not active",
    );

    drop(host_stream);
    let _ = handle.join();
}

#[test]
fn process_control_after_exit_returns_inactive() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    const NONCE: vsock_proto::ProcessControlNonce = *b"0123456789abcdef";

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    read_and_discard_message(&mut host_stream);
    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    send_spawn_process_with_control_nonce(&mut host_stream, 35, "printf done", NONCE);
    let (_pid, stdout_data, exit_code, stderr) = read_streaming_result(&mut host_stream, 35);
    assert_eq!(stdout_data, b"done");
    assert_eq!(exit_code, 0, "stderr: {}", String::from_utf8_lossy(&stderr));

    send_process_control(&mut host_stream, 36, 35, NONCE, "message-3");
    assert_process_control_result(
        &mut host_stream,
        36,
        35,
        NONCE,
        "message-3",
        ProcessControlStatus::Inactive,
        "process operation is not active",
    );

    drop(host_stream);
    let _ = handle.join();
}
