use std::io::{Read, Write};

use vsock_proto::{
    self, MSG_ERROR, MSG_PING, MSG_PONG, MSG_QUIESCE_OPERATIONS, MSG_RESUME_OPERATIONS,
};

pub(crate) fn read_message(stream: &mut impl Read) -> vsock_proto::RawMessage {
    let mut hdr = [0u8; 4];
    stream.read_exact(&mut hdr).unwrap();
    let body_len = u32::from_be_bytes(hdr) as usize;
    let mut body = vec![0u8; body_len];
    stream.read_exact(&mut body).unwrap();

    let mut full = Vec::with_capacity(4 + body_len);
    full.extend_from_slice(&hdr);
    full.extend_from_slice(&body);
    let mut decoder = vsock_proto::Decoder::new();
    let msgs = decoder.decode(&full).unwrap();
    assert_eq!(msgs.len(), 1);
    msgs.into_iter().next().unwrap()
}

/// Read one framed message from the stream and discard it.
pub(crate) fn read_and_discard_message(stream: &mut impl Read) {
    let _ = read_message(stream);
}

pub(crate) fn read_error_response(stream: &mut impl Read, seq: u32) -> String {
    let msg = read_message(stream);
    assert_eq!(msg.msg_type, MSG_ERROR);
    assert_eq!(msg.seq, seq);
    vsock_proto::decode_error(&msg.payload).unwrap().to_owned()
}

pub(crate) fn assert_ping_pong<T>(stream: &mut T, seq: u32)
where
    T: Read + Write,
{
    let ping = vsock_proto::encode(MSG_PING, seq, &[]).unwrap();
    stream.write_all(&ping).unwrap();
    let pong = read_message(stream);
    assert_eq!(pong.msg_type, MSG_PONG);
    assert_eq!(pong.seq, seq);
    assert!(pong.payload.is_empty());
}

fn send_empty_control(stream: &mut impl Write, msg_type: u8, seq: u32) {
    let msg = vsock_proto::encode(msg_type, seq, &[]).unwrap();
    stream.write_all(&msg).unwrap();
}

pub(crate) fn send_control_payload(
    stream: &mut impl Write,
    msg_type: u8,
    seq: u32,
    payload: &[u8],
) {
    let msg = vsock_proto::encode(msg_type, seq, payload).unwrap();
    stream.write_all(&msg).unwrap();
}

pub(crate) fn send_quiesce_operations(stream: &mut impl Write, seq: u32) {
    send_empty_control(stream, MSG_QUIESCE_OPERATIONS, seq);
}

pub(crate) fn send_resume_operations(stream: &mut impl Write, seq: u32) {
    send_empty_control(stream, MSG_RESUME_OPERATIONS, seq);
}
