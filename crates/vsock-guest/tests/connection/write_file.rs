use std::io::Write;

use vsock_proto::{self, MSG_WRITE_FILE, MSG_WRITE_FILE_RESULT};

use super::support::{
    finish_guest_connection, read_message, start_guest_connection, unique_tmp_path,
};

#[test]
fn write_file_seq_zero_is_not_rejected_as_invalid_sequence() {
    let (handle, mut host_stream) = start_guest_connection();
    let path = unique_tmp_path("write-file-seq-zero", ".txt");

    let payload = vsock_proto::encode_write_file(path.as_str(), b"ok", false, false).unwrap();
    let msg = vsock_proto::encode(MSG_WRITE_FILE, 0, &payload).unwrap();
    host_stream.write_all(&msg).unwrap();

    let response = read_message(&mut host_stream);
    assert_eq!(response.msg_type, MSG_WRITE_FILE_RESULT);
    assert_eq!(response.seq, 0);
    let (_success, error) = vsock_proto::decode_write_file_result(&response.payload).unwrap();
    assert!(
        !error.contains("non-zero sequence"),
        "write_file seq=0 should reach the write_file handler, got: {error}"
    );

    finish_guest_connection(handle, host_stream);
}
