use std::io::Read;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use vsock_proto::{ExecControlStatus, MSG_EXEC_CONTROL_RESULT};

use crate::threading::test_support::FailingThreadSpawner;

use super::super::forward::{forward_control_request, try_forward, try_forward_with_spawner};
use super::super::sink::{ControlSinkInner, ControlSinkState};
use super::super::{
    EXEC_CONTROL_WORKER_START_ERROR_PREFIX, EXEC_REQUEST_TIMEOUT_DIAGNOSTIC,
    MAX_PENDING_CONTROL_REQUESTS, THREAD_EXEC_CONTROL_FORWARD,
};
use super::support::{
    connected_sink, guest_writer_pair, owned_control_request, read_exec_control_result,
};

const CONTROL_PEER_READ_TIMEOUT: Duration = Duration::from_secs(3);

fn read_control_request(
    peer: &mut UnixStream,
    scenario: &str,
    expected_message_id: &str,
) -> process_control_ipc::ControlRequest {
    peer.set_read_timeout(Some(CONTROL_PEER_READ_TIMEOUT))
        .unwrap();
    let request = process_control_ipc::read_request(peer).unwrap_or_else(|error| {
        panic!(
            "{scenario}: expected control request {expected_message_id} before peer read timeout: {error}"
        )
    });
    assert_eq!(
        request.message_id, expected_message_id,
        "{scenario}: unexpected control request message id"
    );
    request
}

#[test]
fn pending_exec_control_timeout_before_sink_connection_releases_slot() {
    let sink = Arc::new(ControlSinkState::new());
    let pending_slot = sink.reserve_pending_slot().unwrap();
    let (writer, mut host) = guest_writer_pair();

    forward_control_request(
        Arc::clone(&sink),
        pending_slot,
        owned_control_request(29, 19, 0, "msg-timeout"),
        writer,
    );

    let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
    assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(seq, 29);
    assert_eq!(status, ExecControlStatus::SinkTimeout);
    assert_eq!(message_id, "msg-timeout");
    assert_eq!(diagnostic, EXEC_REQUEST_TIMEOUT_DIAGNOSTIC);
    assert_eq!(sink.pending.load(Ordering::Acquire), 0);
}
#[test]
fn exec_control_queue_full_rejects_without_leaking_pending_slots() {
    let sink = Arc::new(ControlSinkState::new());
    let (writer, _host) = guest_writer_pair();
    let mut pending_slots = Vec::new();

    for _ in 0..MAX_PENDING_CONTROL_REQUESTS {
        pending_slots.push(sink.reserve_pending_slot().unwrap());
    }
    assert_eq!(
        sink.pending.load(Ordering::Acquire),
        MAX_PENDING_CONTROL_REQUESTS
    );

    let immediate = try_forward(
        Arc::clone(&sink),
        owned_control_request(199, 12, 5000, "msg-overflow"),
        writer,
    )
    .expect("overflow request should be rejected synchronously");
    assert_eq!(immediate.0, ExecControlStatus::QueueFull);
    assert_eq!(immediate.1, "exec control queue is full");
    assert_eq!(
        sink.pending.load(Ordering::Acquire),
        MAX_PENDING_CONTROL_REQUESTS
    );

    drop(pending_slots);
    assert_eq!(sink.pending.load(Ordering::Acquire), 0);
}
#[test]
fn exec_control_worker_spawn_failure_releases_slot_without_forwarding_payload() {
    let (sink, mut peer) = connected_sink();
    peer.set_nonblocking(true).unwrap();
    let (writer, _host) = guest_writer_pair();

    let immediate = try_forward_with_spawner(
        Arc::clone(&sink),
        owned_control_request(31, 18, 5000, "msg-spawn-fails"),
        writer,
        FailingThreadSpawner::fail_once(THREAD_EXEC_CONTROL_FORWARD),
    )
    .expect("worker spawn failure should return an immediate result");

    assert_eq!(immediate.0, ExecControlStatus::SinkError);
    assert_eq!(
        immediate.1,
        format!(
            "{EXEC_CONTROL_WORKER_START_ERROR_PREFIX}: injected thread spawn failure for {THREAD_EXEC_CONTROL_FORWARD}"
        )
    );
    assert_eq!(sink.pending.load(Ordering::Acquire), 0);

    let mut byte = [0u8];
    let error = peer
        .read(&mut byte)
        .expect_err("failed forwarding worker should not send a control request");
    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
}
#[test]
fn pending_control_slot_holds_existing_slot_until_drop() {
    let sink = Arc::new(ControlSinkState::new());

    {
        let _slot = sink.reserve_pending_slot().unwrap();
        assert_eq!(sink.pending.load(Ordering::Acquire), 1);
    }

    assert_eq!(sink.pending.load(Ordering::Acquire), 0);
}
#[test]
fn pending_control_slot_releases_when_result_send_fails() {
    let (sink, mut peer) = connected_sink();
    let pending_slot = sink.reserve_pending_slot().unwrap();
    let (writer, host) = guest_writer_pair();
    drop(host);

    std::thread::scope(|scope| {
        let worker_sink = Arc::clone(&sink);
        let worker = scope.spawn(move || {
            forward_control_request(
                worker_sink,
                pending_slot,
                owned_control_request(12, 8, 5000, "msg-send-fails"),
                writer,
            );
        });

        let request = read_control_request(&mut peer, "result-send failure", "msg-send-fails");
        process_control_ipc::write_response(
            &mut peer,
            &process_control_ipc::ControlResponse {
                message_id: request.message_id,
                status: process_control_ipc::ControlResponseStatus::Accepted,
                diagnostic: String::new(),
            },
        )
        .unwrap();

        worker
            .join()
            .expect("result-send failure forwarding worker should complete");
    });

    assert_eq!(sink.pending.load(Ordering::Acquire), 0);
}
#[test]
fn mismatched_control_response_message_id_marks_sink_failed() {
    let (sink, mut peer) = connected_sink();
    let pending_slot = sink.reserve_pending_slot().unwrap();
    let (writer, mut host) = guest_writer_pair();

    let (msg_type, seq, status, message_id, diagnostic) = std::thread::scope(|scope| {
        let worker_sink = Arc::clone(&sink);
        let worker = scope.spawn(move || {
            forward_control_request(
                worker_sink,
                pending_slot,
                owned_control_request(12, 8, 5000, "msg-original"),
                writer,
            );
        });

        read_control_request(&mut peer, "response message id mismatch", "msg-original");
        process_control_ipc::write_response(
            &mut peer,
            &process_control_ipc::ControlResponse {
                message_id: "msg-other".to_owned(),
                status: process_control_ipc::ControlResponseStatus::Accepted,
                diagnostic: String::new(),
            },
        )
        .unwrap();

        let result = read_exec_control_result(&mut host);
        worker
            .join()
            .expect("response message id mismatch forwarding worker should complete");
        result
    });

    assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(seq, 12);
    assert_eq!(status, ExecControlStatus::SinkError);
    assert_eq!(message_id, "msg-original");
    assert_eq!(
        diagnostic,
        "exec control sink message id mismatch: expected msg-original, got msg-other"
    );
    assert_eq!(sink.pending.load(Ordering::Acquire), 0);
    assert!(matches!(
        *sink.inner.lock().unwrap_or_else(|e| e.into_inner()),
        ControlSinkInner::Failed(_)
    ));
}
#[test]
fn timed_out_control_sink_is_marked_failed() {
    let (sink, mut peer) = connected_sink();
    let pending_slot = sink.reserve_pending_slot().unwrap();
    let (writer, mut host) = guest_writer_pair();
    let (msg_type, seq, status, message_id, diagnostic) = std::thread::scope(|scope| {
        let worker_sink = Arc::clone(&sink);
        let worker = scope.spawn(move || {
            forward_control_request(
                worker_sink,
                pending_slot,
                owned_control_request(12, 8, 250, "msg-timeout"),
                writer,
            );
        });

        let request = read_control_request(&mut peer, "control response timeout", "msg-timeout");
        assert_eq!(request.payload, b"payload");

        let result = read_exec_control_result(&mut host);
        worker
            .join()
            .expect("control response timeout forwarding worker should complete");
        result
    });

    assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(seq, 12);
    assert_eq!(status, ExecControlStatus::SinkTimeout);
    assert_eq!(message_id, "msg-timeout");
    assert!(!diagnostic.is_empty());
    assert_eq!(sink.pending.load(Ordering::Acquire), 0);
    assert!(matches!(
        *sink.inner.lock().unwrap_or_else(|e| e.into_inner()),
        ControlSinkInner::Failed(_)
    ));
}
