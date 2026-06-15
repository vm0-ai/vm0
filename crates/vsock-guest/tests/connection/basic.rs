use std::io::Write;

use vsock_proto::{self, MSG_ERROR, MSG_PING, MSG_PONG};

use super::support::{finish_guest_connection, read_message, start_guest_connection};

#[test]
fn basic_messages_route_through_connection() {
    let (handle, mut host_stream) = start_guest_connection();

    let ping = vsock_proto::encode(MSG_PING, 7, &[]).unwrap();
    host_stream.write_all(&ping).unwrap();
    let pong = read_message(&mut host_stream);
    assert_eq!(pong.msg_type, MSG_PONG);
    assert_eq!(pong.seq, 7);
    assert!(pong.payload.is_empty());

    let unknown = vsock_proto::encode(0xAA, 8, &[]).unwrap();
    host_stream.write_all(&unknown).unwrap();
    let error = read_message(&mut host_stream);
    assert_eq!(error.msg_type, MSG_ERROR);
    assert_eq!(error.seq, 8);
    assert_eq!(
        vsock_proto::decode_error(&error.payload).unwrap(),
        "Unknown message type: 0xAA"
    );

    finish_guest_connection(handle, host_stream);
}
