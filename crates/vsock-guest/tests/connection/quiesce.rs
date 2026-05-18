use std::io::Write;

use vsock_proto::{
    self, ExecOutputPolicy, ExecTermination, MSG_ERROR, MSG_EXEC_START, MSG_OPERATIONS_QUIESCED,
    MSG_OPERATIONS_RESUMED, MSG_QUIESCE_OPERATIONS, MSG_RESUME_OPERATIONS, MSG_WRITE_FILE,
};

use super::support::*;

#[test]
fn quiesce_busy_fences_new_exec_operations_until_pending_exec_finishes() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        201,
        "sleep 60",
        0,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );

    send_quiesce_operations(&mut host_stream, 202);
    let busy = read_message(&mut host_stream);
    assert_eq!(busy.msg_type, MSG_ERROR);
    assert_eq!(busy.seq, 202);
    assert!(
        vsock_proto::decode_error(&busy.payload)
            .unwrap()
            .contains("guest operations still pending: 1")
    );

    send_exec_start(
        &mut host_stream,
        203,
        "printf should-not-run",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    let fenced = read_message(&mut host_stream);
    assert_eq!(fenced.msg_type, MSG_ERROR);
    assert_eq!(fenced.seq, 203);
    assert!(
        vsock_proto::decode_error(&fenced.payload)
            .unwrap()
            .contains("guest operations are quiescing")
    );

    send_exec_cancel(&mut host_stream, 201);
    let (_chunks, cancelled) = read_exec_result(&mut host_stream, 201);
    assert_eq!(cancelled.termination, ExecTermination::Cancelled);

    send_quiesce_operations(&mut host_stream, 204);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    assert_eq!(quiesced.seq, 204);
    assert!(quiesced.payload.is_empty());

    send_resume_operations(&mut host_stream, 205);
    let resumed = read_message(&mut host_stream);
    assert_eq!(resumed.msg_type, MSG_OPERATIONS_RESUMED);
    assert_eq!(resumed.seq, 205);
    assert!(resumed.payload.is_empty());

    send_exec_start(
        &mut host_stream,
        206,
        "printf ok",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    let (_chunks, result) = read_exec_result(&mut host_stream, 206);
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"ok".to_vec()));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn quiesced_connection_rejects_write_file_without_creating_file() {
    let (handle, mut host_stream) = start_guest_connection();
    let path = unique_tmp_path("quiesce-write-file", ".txt");

    send_quiesce_operations(&mut host_stream, 211);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);

    let payload = vsock_proto::encode_write_file(path.as_str(), b"blocked", false, false).unwrap();
    let msg = vsock_proto::encode(MSG_WRITE_FILE, 212, &payload).unwrap();
    host_stream.write_all(&msg).unwrap();

    let fenced = read_message(&mut host_stream);
    assert_eq!(fenced.msg_type, MSG_ERROR);
    assert_eq!(fenced.seq, 212);
    assert!(
        vsock_proto::decode_error(&fenced.payload)
            .unwrap()
            .contains("guest operations are quiescing")
    );
    assert!(!std::path::Path::new(path.as_str()).exists());

    send_resume_operations(&mut host_stream, 213);
    let resumed = read_message(&mut host_stream);
    assert_eq!(resumed.msg_type, MSG_OPERATIONS_RESUMED);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn quiesced_connection_rejects_new_operation_without_decoding_payload() {
    let (handle, mut host_stream) = start_guest_connection();

    send_quiesce_operations(&mut host_stream, 216);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);

    let malformed_start = vsock_proto::encode(MSG_EXEC_START, 217, b"malformed").unwrap();
    host_stream.write_all(&malformed_start).unwrap();
    let fenced = read_message(&mut host_stream);
    assert_eq!(fenced.msg_type, MSG_ERROR);
    assert_eq!(fenced.seq, 217);
    assert!(
        vsock_proto::decode_error(&fenced.payload)
            .unwrap()
            .contains("guest operations are quiescing")
    );

    send_resume_operations(&mut host_stream, 218);
    let resumed = read_message(&mut host_stream);
    assert_eq!(resumed.msg_type, MSG_OPERATIONS_RESUMED);

    send_exec_start(
        &mut host_stream,
        219,
        "printf ok",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    let (_chunks, result) = read_exec_result(&mut host_stream, 219);
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"ok".to_vec()));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn resume_operations_is_idempotent() {
    let (handle, mut host_stream) = start_guest_connection();

    send_resume_operations(&mut host_stream, 221);
    let resumed = read_message(&mut host_stream);
    assert_eq!(resumed.msg_type, MSG_OPERATIONS_RESUMED);
    assert_eq!(resumed.seq, 221);

    send_exec_start(
        &mut host_stream,
        222,
        "printf open",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    let (_chunks, result) = read_exec_result(&mut host_stream, 222);
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"open".to_vec()));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn quiesce_operations_is_idempotent_while_quiesced() {
    let (handle, mut host_stream) = start_guest_connection();

    send_quiesce_operations(&mut host_stream, 223);
    let first = read_message(&mut host_stream);
    assert_eq!(first.msg_type, MSG_OPERATIONS_QUIESCED);
    assert_eq!(first.seq, 223);

    send_quiesce_operations(&mut host_stream, 224);
    let second = read_message(&mut host_stream);
    assert_eq!(second.msg_type, MSG_OPERATIONS_QUIESCED);
    assert_eq!(second.seq, 224);

    send_exec_start(
        &mut host_stream,
        225,
        "printf should-not-run",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    let fenced = read_message(&mut host_stream);
    assert_eq!(fenced.msg_type, MSG_ERROR);
    assert_eq!(fenced.seq, 225);
    assert!(
        vsock_proto::decode_error(&fenced.payload)
            .unwrap()
            .contains("guest operations are quiescing")
    );

    send_resume_operations(&mut host_stream, 226);
    let resumed = read_message(&mut host_stream);
    assert_eq!(resumed.msg_type, MSG_OPERATIONS_RESUMED);
    assert_eq!(resumed.seq, 226);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn malformed_quiesce_resume_payloads_do_not_change_state() {
    let (handle, mut host_stream) = start_guest_connection();

    send_control_payload(&mut host_stream, MSG_QUIESCE_OPERATIONS, 227, b"unexpected");
    let quiesce_error = read_message(&mut host_stream);
    assert_eq!(quiesce_error.msg_type, MSG_ERROR);
    assert_eq!(quiesce_error.seq, 227);
    assert!(
        vsock_proto::decode_error(&quiesce_error.payload)
            .unwrap()
            .contains("quiesce_operations payload must be empty")
    );

    send_exec_start(
        &mut host_stream,
        228,
        "printf open",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    let (_chunks, open_result) = read_exec_result(&mut host_stream, 228);
    assert_eq!(
        open_result.termination,
        ExecTermination::Exited { exit_code: 0 }
    );
    assert_eq!(open_result.stdout, Some(b"open".to_vec()));

    send_quiesce_operations(&mut host_stream, 229);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    assert_eq!(quiesced.seq, 229);

    send_control_payload(&mut host_stream, MSG_RESUME_OPERATIONS, 230, b"unexpected");
    let resume_error = read_message(&mut host_stream);
    assert_eq!(resume_error.msg_type, MSG_ERROR);
    assert_eq!(resume_error.seq, 230);
    assert!(
        vsock_proto::decode_error(&resume_error.payload)
            .unwrap()
            .contains("resume_operations payload must be empty")
    );

    send_exec_start(
        &mut host_stream,
        231,
        "printf should-not-run",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    let fenced = read_message(&mut host_stream);
    assert_eq!(fenced.msg_type, MSG_ERROR);
    assert_eq!(fenced.seq, 231);
    assert!(
        vsock_proto::decode_error(&fenced.payload)
            .unwrap()
            .contains("guest operations are quiescing")
    );

    send_resume_operations(&mut host_stream, 232);
    let resumed = read_message(&mut host_stream);
    assert_eq!(resumed.msg_type, MSG_OPERATIONS_RESUMED);
    assert_eq!(resumed.seq, 232);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn resume_operations_reopens_after_busy_quiesce_with_pending_operation() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        241,
        "sleep 60",
        0,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );

    send_quiesce_operations(&mut host_stream, 242);
    let busy = read_message(&mut host_stream);
    assert_eq!(busy.msg_type, MSG_ERROR);
    assert_eq!(busy.seq, 242);
    assert!(
        vsock_proto::decode_error(&busy.payload)
            .unwrap()
            .contains("guest operations still pending: 1")
    );

    send_resume_operations(&mut host_stream, 243);
    let resumed = read_message(&mut host_stream);
    assert_eq!(resumed.msg_type, MSG_OPERATIONS_RESUMED);
    assert_eq!(resumed.seq, 243);

    send_exec_start(
        &mut host_stream,
        244,
        "printf reopened",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    let (_chunks, reopened) = read_exec_result(&mut host_stream, 244);
    assert_eq!(
        reopened.termination,
        ExecTermination::Exited { exit_code: 0 }
    );
    assert_eq!(reopened.stdout, Some(b"reopened".to_vec()));

    send_exec_cancel(&mut host_stream, 241);
    let (_chunks, cancelled) = read_exec_result(&mut host_stream, 241);
    assert_eq!(cancelled.termination, ExecTermination::Cancelled);

    finish_guest_connection(handle, host_stream);
}
