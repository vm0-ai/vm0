use vsock_proto::MSG_WRITE_FILE;

use super::support::{
    assert_ping_pong, finish_guest_connection, read_error_response, send_control_payload,
    start_guest_connection,
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
fn malformed_write_file_payload_returns_error_and_keeps_connection_open() {
    let (handle, mut host_stream) = start_guest_connection();

    send_control_payload(&mut host_stream, MSG_WRITE_FILE, 31, b"bad");
    let error = read_error_response(&mut host_stream, 31);
    assert_eq!(error, "invalid payload: write_file path truncated");

    assert_ping_pong(&mut host_stream, 32);

    finish_guest_connection(handle, host_stream);
}
