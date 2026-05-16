use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::time::Instant;
use vsock_proto::{
    Decoder, ExecCapturedOutput, ExecOutputStream, ExecTermination, MSG_EXEC_OUTPUT,
    MSG_EXEC_RESULT, MSG_EXEC_START, MSG_PING, MSG_PONG, MSG_READY, RawMessage,
};

use crate::{
    ConnectionState, VsockHost,
    operation_tracker::{NormalOperationFence, NormalOperationReadiness},
};

pub(crate) fn make_pair() -> (UnixStream, UnixStream) {
    UnixStream::pair().unwrap()
}

/// Perform mock guest handshake: send ready, receive ping, send pong.
pub(crate) async fn mock_handshake(stream: &mut UnixStream, decoder: &mut Decoder) {
    let ready = vsock_proto::encode(MSG_READY, 0, &[]).unwrap();
    stream.write_all(&ready).await.unwrap();

    let mut buf = [0u8; 1024];
    let n = stream.read(&mut buf).await.unwrap();
    let msgs = decoder.decode(&buf[..n]).unwrap();
    assert_eq!(msgs[0].msg_type, MSG_PING);

    let pong = vsock_proto::encode(MSG_PONG, msgs[0].seq, &[]).unwrap();
    stream.write_all(&pong).await.unwrap();
}

pub(crate) async fn host_from_stream(stream: UnixStream) -> io::Result<VsockHost> {
    let deadline = Instant::now() + Duration::from_secs(5);
    VsockHost::from_stream(stream, deadline).await
}

pub(crate) fn operation_count(host: &VsockHost) -> usize {
    let guard = host.shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match &*guard {
        ConnectionState::Connected { operations, .. } => operations.len(),
        ConnectionState::Closed { .. } => 0,
    }
}

pub(crate) fn is_connected(host: &VsockHost) -> bool {
    let guard = host.shared.state.lock().unwrap_or_else(|e| e.into_inner());
    matches!(&*guard, ConnectionState::Connected { .. })
}

pub(crate) fn normal_operation_readiness(host: &VsockHost) -> NormalOperationReadiness {
    host.shared.normal_operations.readiness()
}

pub(crate) fn fence_normal_operations(host: &VsockHost) -> NormalOperationFence {
    host.shared
        .normal_operations
        .try_fence()
        .expect("normal operations should fence")
}

pub(crate) fn poison_connection(host: &VsockHost) {
    host.shared.poison_connection();
}

pub(crate) fn drop_started_pending_normal_request_write_guard(host: &VsockHost) {
    let mut guard = crate::PendingNormalRequestWriteGuard::new(Arc::clone(&host.shared));
    guard.mark_started();
    drop(guard);
}

pub(crate) async fn read_guest_message(
    stream: &mut UnixStream,
    decoder: &mut Decoder,
) -> RawMessage {
    let mut buf = [0u8; 4096];
    loop {
        let n = stream.read(&mut buf).await.unwrap();
        assert_ne!(n, 0, "connection closed before message");
        let mut msgs = decoder.decode(&buf[..n]).unwrap();
        if !msgs.is_empty() {
            return msgs.remove(0);
        }
    }
}

pub(crate) async fn read_guest_messages(
    stream: &mut UnixStream,
    decoder: &mut Decoder,
    count: usize,
) -> Vec<RawMessage> {
    let mut messages = Vec::new();
    let mut buf = [0u8; 4096];
    while messages.len() < count {
        let n = stream.read(&mut buf).await.unwrap();
        assert_ne!(n, 0, "connection closed before messages");
        messages.extend(decoder.decode(&buf[..n]).unwrap());
    }
    messages
}

pub(crate) async fn setup_host_and_guest() -> (VsockHost, UnixStream, Decoder) {
    let (host_stream, mut guest) = make_pair();
    let host_task = tokio::spawn(async move { host_from_stream(host_stream).await.unwrap() });
    let mut decoder = Decoder::new();
    mock_handshake(&mut guest, &mut decoder).await;
    let host = host_task.await.unwrap();
    (host, guest, decoder)
}

fn exec_result_payload(termination: ExecTermination, stdout: &[u8], stderr: &[u8]) -> Vec<u8> {
    vsock_proto::encode_exec_result(
        termination,
        12,
        ExecCapturedOutput::Captured {
            bytes: stdout,
            truncated: false,
        },
        ExecCapturedOutput::Captured {
            bytes: stderr,
            truncated: false,
        },
        "",
    )
    .unwrap()
}

pub(crate) async fn send_exec_result(
    stream: &mut UnixStream,
    seq: u32,
    termination: ExecTermination,
    stdout: &[u8],
    stderr: &[u8],
) {
    let payload = exec_result_payload(termination, stdout, stderr);
    let frame = vsock_proto::encode(MSG_EXEC_RESULT, seq, &payload).unwrap();
    stream.write_all(&frame).await.unwrap();
}

pub(crate) async fn send_stream_exec_result(
    stream: &mut UnixStream,
    seq: u32,
    termination: ExecTermination,
    stderr: &[u8],
) {
    let payload = vsock_proto::encode_exec_result(
        termination,
        12,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Captured {
            bytes: stderr,
            truncated: false,
        },
        "",
    )
    .unwrap();
    let frame = vsock_proto::encode(MSG_EXEC_RESULT, seq, &payload).unwrap();
    stream.write_all(&frame).await.unwrap();
}

pub(crate) async fn send_raw_exec_result(stream: &mut UnixStream, seq: u32, payload: Vec<u8>) {
    let frame = vsock_proto::encode(MSG_EXEC_RESULT, seq, &payload).unwrap();
    stream.write_all(&frame).await.unwrap();
}

pub(crate) async fn send_discarded_exec_result(
    stream: &mut UnixStream,
    seq: u32,
    termination: ExecTermination,
) {
    let payload = vsock_proto::encode_exec_result(
        termination,
        12,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    send_raw_exec_result(stream, seq, payload).await;
}

pub(crate) async fn send_exec_output(
    stream: &mut UnixStream,
    seq: u32,
    output_seq: u32,
    output_stream: ExecOutputStream,
    chunk: &[u8],
    truncated: bool,
) {
    let payload =
        vsock_proto::encode_exec_output(output_stream, output_seq, chunk, truncated).unwrap();
    let frame = vsock_proto::encode(MSG_EXEC_OUTPUT, seq, &payload).unwrap();
    stream.write_all(&frame).await.unwrap();
}

pub(crate) async fn wait_for_operation_count(host: &VsockHost, expected: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while operation_count(host) != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

pub(crate) async fn assert_connection_accepts_exec_operation(
    host: &Arc<VsockHost>,
    guest: &mut UnixStream,
    decoder: &mut Decoder,
) {
    let exec_task = {
        let host = Arc::clone(host);
        tokio::spawn(async move { host.exec("echo ok", 5000, &[], false).await })
    };
    let msg = read_guest_message(guest, decoder).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
    assert_eq!(decoded.command, "echo ok");
    assert_eq!(decoded.label, "exec");
    send_exec_result(
        guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"ok",
        b"",
    )
    .await;
    let exec_result = exec_task.await.unwrap().unwrap();
    assert_eq!(exec_result.stdout, b"ok");
}
