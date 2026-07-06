use std::io::Read;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::{Duration, Instant};

use vsock_proto::{ExecControlNonce, ExecControlStatus};

use crate::writer::GuestWriter;

use super::super::forward::OwnedExecControlRequest;
use super::super::sink::{ControlSinkInner, ControlSinkState, ControlStreamState};
use super::super::{ExecControlRegistry, request_deadline};

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

pub(super) fn guest_writer_pair() -> (GuestWriter, UnixStream) {
    let (guest, host) = UnixStream::pair().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    (GuestWriter::new(guest), host)
}

pub(super) fn owned_control_request(
    response_seq: u32,
    target_seq: u32,
    timeout_ms: u32,
    message_id: &str,
) -> OwnedExecControlRequest {
    OwnedExecControlRequest {
        response_seq,
        target_seq,
        deadline: request_deadline(timeout_ms),
        control_nonce: NONCE,
        message_id: message_id.to_owned(),
        payload: b"payload".to_vec(),
    }
}

pub(super) fn connected_sink() -> (Arc<ControlSinkState>, UnixStream) {
    let sink = Arc::new(ControlSinkState::new());
    let (stream, peer) = UnixStream::pair().unwrap();
    sink.connect(stream);
    (sink, peer)
}

pub(super) fn connected_stream_handle(sink: &ControlSinkState) -> Arc<ControlStreamState> {
    match &*sink.inner.lock().unwrap_or_else(|e| e.into_inner()) {
        ControlSinkInner::Connected(connected) => Arc::clone(&connected.stream),
        _ => panic!("sink should be connected"),
    }
}

pub(super) fn wait_for_sink_state(
    sink: &ControlSinkState,
    timeout: Duration,
    description: &str,
    matches_state: impl Fn(&ControlSinkInner) -> bool,
) {
    let mut guard = sink.inner.lock().unwrap_or_else(|e| e.into_inner());
    let deadline = Instant::now() + timeout;
    while !matches_state(&guard) {
        let now = Instant::now();
        assert!(now < deadline, "{description}");
        let (next_guard, _) = sink
            .ready
            .wait_timeout(guard, deadline.duration_since(now))
            .unwrap_or_else(|e| e.into_inner());
        guard = next_guard;
    }
}
