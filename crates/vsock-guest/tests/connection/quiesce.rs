use std::io::Write;

use vsock_proto::{
    self, ExecOutputPolicy, ExecTermination, MSG_EXEC_START, MSG_MEMORY_SNAPSHOT,
    MSG_MEMORY_SNAPSHOT_RESULT, MSG_OPERATIONS_QUIESCED, MSG_OPERATIONS_RESUMED,
    MSG_QUIESCE_OPERATIONS, MSG_RESUME_OPERATIONS, MSG_WRITE_FILE, MSG_WRITE_FILES,
    MSG_WRITE_PRIVATE_FILES, WriteFileBatchEntry,
};

use super::support::*;

fn assert_error_contains(stream: &mut impl std::io::Read, seq: u32, expected_fragment: &str) {
    let error = read_error_response(stream, seq);
    assert!(
        error.contains(expected_fragment),
        "expected error to contain {expected_fragment:?}, got {error:?}",
    );
}

#[test]
fn quiesce_busy_fences_new_exec_operations_until_pending_exec_finishes() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        201,
        "sleep 60",
        LONG_RUNNING_EXEC_TIMEOUT_MS,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );

    send_quiesce_operations(&mut host_stream, 202);
    assert_error_contains(&mut host_stream, 202, "guest operations still pending: 1");

    send_exec_start(
        &mut host_stream,
        203,
        "printf should-not-run",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    assert_error_contains(&mut host_stream, 203, "guest operations are quiescing");

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
fn memory_snapshot_requires_fully_quiesced_connection() {
    let (handle, mut host_stream) = start_guest_connection();

    send_control_payload(&mut host_stream, MSG_MEMORY_SNAPSHOT, 207, &[]);
    assert_error_contains(
        &mut host_stream,
        207,
        "guest operations are not fully quiesced",
    );

    send_exec_start(
        &mut host_stream,
        208,
        "sleep 60",
        LONG_RUNNING_EXEC_TIMEOUT_MS,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    send_quiesce_operations(&mut host_stream, 209);
    assert_error_contains(&mut host_stream, 209, "guest operations still pending: 1");

    send_control_payload(&mut host_stream, MSG_MEMORY_SNAPSHOT, 210, &[]);
    assert_error_contains(
        &mut host_stream,
        210,
        "guest operations are not fully quiesced",
    );

    send_exec_cancel(&mut host_stream, 208);
    let (_chunks, cancelled) = read_exec_result(&mut host_stream, 208);
    assert_eq!(cancelled.termination, ExecTermination::Cancelled);

    send_quiesce_operations(&mut host_stream, 211);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);

    send_control_payload(&mut host_stream, MSG_MEMORY_SNAPSHOT, 212, &[]);
    let response = read_message(&mut host_stream);
    assert_eq!(response.msg_type, MSG_MEMORY_SNAPSHOT_RESULT);
    assert_eq!(response.seq, 212);
    let snapshot = vsock_proto::decode_memory_snapshot(&response.payload).unwrap();
    assert!(snapshot.mem_total_bytes > 0);
    assert!(snapshot.mem_available_bytes <= snapshot.mem_total_bytes);
    assert!(snapshot.swap_free_bytes <= snapshot.swap_total_bytes);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn malformed_memory_snapshot_request_preserves_quiesced_state() {
    let (handle, mut host_stream) = start_guest_connection();

    send_quiesce_operations(&mut host_stream, 213);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);

    send_control_payload(&mut host_stream, MSG_MEMORY_SNAPSHOT, 214, b"unexpected");
    assert_error_contains(
        &mut host_stream,
        214,
        "memory_snapshot payload must be empty",
    );

    send_control_payload(&mut host_stream, MSG_MEMORY_SNAPSHOT, 215, &[]);
    let response = read_message(&mut host_stream);
    assert_eq!(response.msg_type, MSG_MEMORY_SNAPSHOT_RESULT);
    assert_eq!(response.seq, 215);
    vsock_proto::decode_memory_snapshot(&response.payload).unwrap();

    finish_guest_connection(handle, host_stream);
}

#[test]
fn quiesced_connection_rejects_file_write_variants_without_creating_files() {
    for (variant, msg_type) in [
        ("write-file", MSG_WRITE_FILE),
        ("write-files", MSG_WRITE_FILES),
        ("write-private-files", MSG_WRITE_PRIVATE_FILES),
    ] {
        let (handle, mut host_stream) = start_guest_connection();
        let path = unique_tmp_path(&format!("quiesce-{variant}"), ".txt");

        send_quiesce_operations(&mut host_stream, 211);
        let quiesced = read_message(&mut host_stream);
        assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);

        let payload = if msg_type == MSG_WRITE_FILE {
            vsock_proto::encode_write_file(path.as_str(), b"blocked", false, false).unwrap()
        } else {
            vsock_proto::encode_write_files(&[WriteFileBatchEntry {
                path: path.as_str(),
                content: b"blocked",
            }])
            .unwrap()
        };
        let msg = vsock_proto::encode(msg_type, 212, &payload).unwrap();
        host_stream.write_all(&msg).unwrap();

        assert_error_contains(&mut host_stream, 212, "guest operations are quiescing");
        assert!(!std::path::Path::new(path.as_str()).exists());

        send_resume_operations(&mut host_stream, 213);
        let resumed = read_message(&mut host_stream);
        assert_eq!(resumed.msg_type, MSG_OPERATIONS_RESUMED);

        finish_guest_connection(handle, host_stream);
    }
}

#[test]
fn quiesced_connection_rejects_file_write_zero_sequences_before_quiesce_state() {
    for (msg_type, operation_label) in [
        (MSG_WRITE_FILE, "write_file"),
        (MSG_WRITE_FILES, "write_files"),
        (MSG_WRITE_PRIVATE_FILES, "write_private_files"),
    ] {
        let (handle, mut host_stream) = start_guest_connection();

        send_quiesce_operations(&mut host_stream, 214);
        let quiesced = read_message(&mut host_stream);
        assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);

        send_control_payload(&mut host_stream, msg_type, 0, b"bad");
        let error = read_error_response(&mut host_stream, 0);
        assert_eq!(
            error,
            format!("{operation_label} requires non-zero sequence")
        );

        finish_guest_connection(handle, host_stream);
    }
}

#[test]
fn quiesced_connection_rejects_new_operation_without_decoding_payload() {
    let (handle, mut host_stream) = start_guest_connection();

    send_quiesce_operations(&mut host_stream, 216);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);

    let malformed_start = vsock_proto::encode(MSG_EXEC_START, 217, b"malformed").unwrap();
    host_stream.write_all(&malformed_start).unwrap();
    assert_error_contains(&mut host_stream, 217, "guest operations are quiescing");

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
    assert_error_contains(&mut host_stream, 225, "guest operations are quiescing");

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
    assert_error_contains(
        &mut host_stream,
        227,
        "quiesce_operations payload must be empty",
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
    assert_error_contains(
        &mut host_stream,
        230,
        "resume_operations payload must be empty",
    );

    send_exec_start(
        &mut host_stream,
        231,
        "printf should-not-run",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    assert_error_contains(&mut host_stream, 231, "guest operations are quiescing");

    send_resume_operations(&mut host_stream, 232);
    let resumed = read_message(&mut host_stream);
    assert_eq!(resumed.msg_type, MSG_OPERATIONS_RESUMED);
    assert_eq!(resumed.seq, 232);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn resume_operations_reopens_without_losing_pending_operation() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        241,
        "sleep 60",
        LONG_RUNNING_EXEC_TIMEOUT_MS,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );

    send_quiesce_operations(&mut host_stream, 242);
    assert_error_contains(&mut host_stream, 242, "guest operations still pending: 1");

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

    send_quiesce_operations(&mut host_stream, 245);
    assert_error_contains(&mut host_stream, 245, "guest operations still pending: 1");

    send_exec_cancel(&mut host_stream, 241);
    let (_chunks, cancelled) = read_exec_result(&mut host_stream, 241);
    assert_eq!(cancelled.termination, ExecTermination::Cancelled);

    send_quiesce_operations(&mut host_stream, 246);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    assert_eq!(quiesced.seq, 246);
    assert!(quiesced.payload.is_empty());

    finish_guest_connection(handle, host_stream);
}
