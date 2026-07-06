use std::io::Read;
use std::os::unix::net::UnixStream;

use vsock_proto::{ExecControlNonce, ExecControlStatus};

use super::super::ExecControlRegistry;

pub(super) const NONCE: ExecControlNonce = *b"0123456789abcdef";

pub(super) fn unique_test_nonce(seed: u64) -> ExecControlNonce {
    let mut nonce = [0u8; 16];
    nonce[..8].copy_from_slice(&u64::from(std::process::id()).to_be_bytes());
    nonce[8..].copy_from_slice(&seed.to_be_bytes());
    nonce
}

pub(super) fn resolve_error(
    registry: &ExecControlRegistry,
    target_seq: u32,
    nonce: ExecControlNonce,
) -> (ExecControlStatus, &'static str) {
    match registry.resolve(target_seq, nonce) {
        Ok(_) => panic!("expected exec control resolve to fail"),
        Err(error) => error,
    }
}

pub(super) fn read_exec_control_result(
    stream: &mut UnixStream,
) -> (u8, u32, ExecControlStatus, String, String) {
    let mut hdr = [0u8; 4];
    stream.read_exact(&mut hdr).unwrap();
    let body_len = u32::from_be_bytes(hdr) as usize;
    let mut body = vec![0u8; body_len];
    stream.read_exact(&mut body).unwrap();
    let mut full = Vec::with_capacity(4 + body_len);
    full.extend_from_slice(&hdr);
    full.extend_from_slice(&body);
    let mut decoder = vsock_proto::Decoder::new();
    let messages = decoder.decode(&full).unwrap();
    assert_eq!(messages.len(), 1);
    let result = vsock_proto::decode_exec_control_result(&messages[0].payload).unwrap();
    (
        messages[0].msg_type,
        messages[0].seq,
        result.status,
        result.message_id.to_owned(),
        result.diagnostic.to_owned(),
    )
}
