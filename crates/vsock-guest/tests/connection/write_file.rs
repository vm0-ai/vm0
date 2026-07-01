use std::path::Path;

use vsock_proto::{self, MSG_WRITE_FILE, MSG_WRITE_FILES, WriteFileBatchEntry};

use super::support::{
    assert_ping_pong, finish_guest_connection, read_error_response, send_control_payload,
    start_guest_connection, unique_tmp_path,
};

#[test]
fn write_file_seq_zero_returns_error() {
    let (handle, mut host_stream) = start_guest_connection();

    send_control_payload(&mut host_stream, MSG_WRITE_FILE, 0, b"bad");
    let error = read_error_response(&mut host_stream, 0);
    assert_eq!(error, "write_file requires non-zero sequence");

    finish_guest_connection(handle, host_stream);
}

#[test]
fn write_file_seq_zero_does_not_write_valid_payload() {
    let (handle, mut host_stream) = start_guest_connection();
    let path = unique_tmp_path("write-file-seq-zero", ".txt");
    let payload = vsock_proto::encode_write_file(path.as_str(), b"should-not-write", false, false)
        .expect("encode write_file");

    send_control_payload(&mut host_stream, MSG_WRITE_FILE, 0, &payload);
    let error = read_error_response(&mut host_stream, 0);
    assert_eq!(error, "write_file requires non-zero sequence");
    assert!(!Path::new(path.as_str()).exists());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn write_files_seq_zero_does_not_write_valid_payload() {
    let (handle, mut host_stream) = start_guest_connection();
    let path = unique_tmp_path("write-files-seq-zero", ".txt");
    let payload = vsock_proto::encode_write_files(&[WriteFileBatchEntry {
        path: path.as_str(),
        content: b"should-not-write",
    }])
    .expect("encode write_files");

    send_control_payload(&mut host_stream, MSG_WRITE_FILES, 0, &payload);
    let error = read_error_response(&mut host_stream, 0);
    assert_eq!(error, "write_files requires non-zero sequence");
    assert!(!Path::new(path.as_str()).exists());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn malformed_write_file_payload_returns_error_and_keeps_connection_open() {
    let (handle, mut host_stream) = start_guest_connection();

    send_control_payload(&mut host_stream, MSG_WRITE_FILE, 31, b"bad");
    let error = read_error_response(&mut host_stream, 31);
    assert_eq!(error, "invalid payload: write_file path truncated");

    assert_ping_pong(&mut host_stream, 32);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn malformed_write_files_payload_returns_error_and_keeps_connection_open() {
    let (handle, mut host_stream) = start_guest_connection();

    send_control_payload(&mut host_stream, MSG_WRITE_FILES, 41, &[0, 1]);
    let error = read_error_response(&mut host_stream, 41);
    assert_eq!(error, "invalid payload: write_files path_len truncated");

    assert_ping_pong(&mut host_stream, 42);

    finish_guest_connection(handle, host_stream);
}
