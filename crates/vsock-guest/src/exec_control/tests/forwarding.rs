use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use vsock_proto::{ExecControlStatus, MSG_EXEC_CONTROL_RESULT};

use crate::writer::GuestWriter;

use super::super::forward::{OwnedExecControlRequest, forward_control_request, try_forward};
use super::super::sink::{ControlSinkInner, ControlSinkState};
use super::super::{
    EXEC_REQUEST_TIMEOUT_DIAGNOSTIC, MAX_PENDING_CONTROL_REQUESTS, request_deadline,
};
use super::support::{NONCE, read_exec_control_result};

#[test]
fn pending_exec_control_timeout_before_sink_connection_releases_slot() {
    let sink = Arc::new(ControlSinkState::new());
    let pending_slot = sink.reserve_pending_slot().unwrap();
    let (guest, mut host) = UnixStream::pair().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();

    forward_control_request(
        Arc::clone(&sink),
        pending_slot,
        OwnedExecControlRequest {
            response_seq: 29,
            target_seq: 19,
            deadline: request_deadline(0),
            control_nonce: NONCE,
            message_id: "msg-timeout".to_owned(),
            payload: b"payload".to_vec(),
        },
        GuestWriter::new(guest),
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
    let (guest, _host) = UnixStream::pair().unwrap();
    let writer = GuestWriter::new(guest);
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
        OwnedExecControlRequest {
            response_seq: 199,
            target_seq: 12,
            deadline: request_deadline(5000),
            control_nonce: NONCE,
            message_id: "msg-overflow".to_owned(),
            payload: b"payload".to_vec(),
        },
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
    let sink = Arc::new(ControlSinkState::new());
    let (stream, peer) = UnixStream::pair().unwrap();
    sink.connect(stream);
    let pending_slot = sink.reserve_pending_slot().unwrap();

    let client = std::thread::spawn(move || {
        let mut peer = peer;
        let request = process_control_ipc::read_request(&mut peer).unwrap();
        process_control_ipc::write_response(
            &mut peer,
            &process_control_ipc::ControlResponse {
                message_id: request.message_id,
                status: process_control_ipc::ControlResponseStatus::Accepted,
                diagnostic: String::new(),
            },
        )
        .unwrap();
    });

    let (guest, host) = UnixStream::pair().unwrap();
    drop(host);
    forward_control_request(
        Arc::clone(&sink),
        pending_slot,
        OwnedExecControlRequest {
            response_seq: 12,
            target_seq: 8,
            deadline: request_deadline(5000),
            control_nonce: NONCE,
            message_id: "msg-send-fails".to_owned(),
            payload: b"payload".to_vec(),
        },
        GuestWriter::new(guest),
    );

    client.join().unwrap();
    assert_eq!(sink.pending.load(Ordering::Acquire), 0);
}
#[test]
fn mismatched_control_response_message_id_marks_sink_failed() {
    let sink = Arc::new(ControlSinkState::new());
    let (stream, peer) = UnixStream::pair().unwrap();
    sink.connect(stream);
    let pending_slot = sink.reserve_pending_slot().unwrap();

    let client = std::thread::spawn(move || {
        let mut peer = peer;
        let request = process_control_ipc::read_request(&mut peer).unwrap();
        assert_eq!(request.message_id, "msg-original");
        process_control_ipc::write_response(
            &mut peer,
            &process_control_ipc::ControlResponse {
                message_id: "msg-other".to_owned(),
                status: process_control_ipc::ControlResponseStatus::Accepted,
                diagnostic: String::new(),
            },
        )
        .unwrap();
    });

    let (guest, mut host) = UnixStream::pair().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    forward_control_request(
        Arc::clone(&sink),
        pending_slot,
        OwnedExecControlRequest {
            response_seq: 12,
            target_seq: 8,
            deadline: request_deadline(5000),
            control_nonce: NONCE,
            message_id: "msg-original".to_owned(),
            payload: b"payload".to_vec(),
        },
        GuestWriter::new(guest),
    );

    client.join().unwrap();
    let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
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
    let sink = Arc::new(ControlSinkState::new());
    let (stream, peer) = UnixStream::pair().unwrap();
    sink.connect(stream);
    let pending_slot = sink.reserve_pending_slot().unwrap();
    let (request_read_tx, request_read_rx) = std::sync::mpsc::channel();
    let (release_peer_tx, release_peer_rx) = std::sync::mpsc::channel();
    let client = std::thread::spawn(move || {
        let mut peer = peer;
        let request = process_control_ipc::read_request(&mut peer).unwrap();
        assert_eq!(request.message_id, "msg-timeout");
        assert_eq!(request.payload, b"payload");
        request_read_tx.send(()).unwrap();
        let _ = release_peer_rx.recv_timeout(Duration::from_secs(3));
    });

    let (guest, mut host) = UnixStream::pair().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let worker = std::thread::spawn({
        let sink = Arc::clone(&sink);
        move || {
            forward_control_request(
                sink,
                pending_slot,
                OwnedExecControlRequest {
                    response_seq: 12,
                    target_seq: 8,
                    deadline: request_deadline(250),
                    control_nonce: NONCE,
                    message_id: "msg-timeout".to_owned(),
                    payload: b"payload".to_vec(),
                },
                GuestWriter::new(guest),
            );
        }
    });

    request_read_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("control request should be delivered before response timeout");

    let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
    worker.join().unwrap();
    let _ = release_peer_tx.send(());
    client.join().unwrap();

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
