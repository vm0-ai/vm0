use std::time::Duration;

use guest_control_proto::{ExecControlStatus, MSG_EXEC_CONTROL_RESULT};

use super::super::sink::ControlSinkInner;
use super::super::{
    EXEC_REQUEST_TIMEOUT_DIAGNOSTIC, ExecControlRegistry, handle_exec_control, is_timeout,
};
use super::support::{
    connected_stream_handle, guest_writer_pair, read_exec_control_result, unique_test_nonce,
    wait_for_sink_state,
};

#[test]
fn connected_control_peer_closure_retains_typed_status_for_later_requests() {
    for close_before_request in [true, false] {
        let nonce = unique_test_nonce(32755 + u64::from(close_before_request));
        let registry = ExecControlRegistry::default();
        let registration = registry.register(55, nonce, true).unwrap();
        let endpoint = registration.bootstrap_endpoint.as_ref().unwrap();
        let sink = registry.resolve(55, nonce).unwrap();
        let mut peer = process_control_ipc::connect_abstract(endpoint).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        process_control_ipc::write_hello(&mut peer).unwrap();
        wait_for_sink_state(
            &sink,
            Duration::from_secs(3),
            "sink should connect",
            |inner| matches!(inner, ControlSinkInner::Connected(_)),
        );
        let connected = connected_stream_handle(&sink);
        let (writer, mut host) = guest_writer_pair();
        let payload =
            guest_control_proto::encode_exec_control(55, nonce, "cancel", b"payload", 5000)
                .unwrap();
        if close_before_request {
            drop(peer);
            handle_exec_control(56, &payload, &registry, &writer).unwrap();
        } else {
            handle_exec_control(56, &payload, &registry, &writer).unwrap();
            let request = process_control_ipc::read_request(&mut peer).unwrap();
            assert_eq!(request.message_id, "cancel");
            drop(peer);
        }
        let (_, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
        assert_eq!(seq, 56);
        assert_eq!(status, ExecControlStatus::SinkClosed);
        assert_eq!(message_id, "cancel");
        assert!(!diagnostic.is_empty());

        // Existing queued stream owners and new requests retain the first cause.
        let error = match connected.lock_until(super::super::request_deadline(5000), &sink.active) {
            Ok(_) => panic!("closed peer should reject queued stream owners"),
            Err(error) => error,
        };
        assert!(matches!(error,
            super::super::sink::ControlStreamLockError::SinkError(failure)
                if failure.status() == ExecControlStatus::SinkClosed && failure.diagnostic() == diagnostic
        ));
        handle_exec_control(57, &payload, &registry, &writer).unwrap();
        let (_, seq, status, _, next_diagnostic) = read_exec_control_result(&mut host);
        assert_eq!(seq, 57);
        assert_eq!(status, ExecControlStatus::SinkClosed);
        assert_eq!(next_diagnostic, diagnostic);
    }
}

#[test]
fn handle_exec_control_forwards_to_connected_sink() {
    let forward_nonce = unique_test_nonce(8);

    let registry = ExecControlRegistry::default();
    let registration = registry.register(8, forward_nonce, true).unwrap();
    let endpoint = registration.bootstrap_endpoint.clone().unwrap();
    let client = std::thread::spawn(move || {
        let mut stream = process_control_ipc::connect_abstract(&endpoint).unwrap();
        process_control_ipc::write_hello(&mut stream).unwrap();
        let request = process_control_ipc::read_request(&mut stream).unwrap();
        assert_eq!(request.message_id, "msg-1");
        assert_eq!(request.payload, b"payload");
        process_control_ipc::write_response(
            &mut stream,
            &process_control_ipc::ControlResponse {
                message_id: request.message_id,
                status: process_control_ipc::ControlResponseStatus::Accepted,
                diagnostic: String::new(),
            },
        )
        .unwrap();
    });

    let (writer, mut host) = guest_writer_pair();
    let payload =
        guest_control_proto::encode_exec_control(8, forward_nonce, "msg-1", b"payload", 5000)
            .unwrap();

    handle_exec_control(11, &payload, &registry, &writer).unwrap();

    let (msg_type, seq, status, message_id, _) = read_exec_control_result(&mut host);
    assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(seq, 11);
    assert_eq!(status, ExecControlStatus::Delivered);
    assert_eq!(message_id, "msg-1");

    client.join().unwrap();
}

#[test]
fn handle_exec_control_forwards_maximum_payload_to_connected_sink() {
    let forward_nonce = unique_test_nonce(22);

    let registry = ExecControlRegistry::default();
    let registration = registry.register(22, forward_nonce, true).unwrap();
    let endpoint = registration.bootstrap_endpoint.clone().unwrap();
    let control_payload = vec![0xA5; guest_control_proto::EXEC_CONTROL_MAX_PAYLOAD_BYTES];
    let payload = guest_control_proto::encode_exec_control(
        22,
        forward_nonce,
        "msg-max-payload",
        &control_payload,
        5000,
    )
    .unwrap();
    let client = std::thread::spawn(move || {
        let mut stream = process_control_ipc::connect_abstract(&endpoint).unwrap();
        process_control_ipc::write_hello(&mut stream).unwrap();
        let request = process_control_ipc::read_request(&mut stream).unwrap();
        assert_eq!(request.message_id, "msg-max-payload");
        assert_eq!(request.payload, control_payload);
        process_control_ipc::write_response(
            &mut stream,
            &process_control_ipc::ControlResponse {
                message_id: request.message_id,
                status: process_control_ipc::ControlResponseStatus::Accepted,
                diagnostic: String::new(),
            },
        )
        .unwrap();
    });

    let (writer, mut host) = guest_writer_pair();
    handle_exec_control(44, &payload, &registry, &writer).unwrap();

    let (msg_type, seq, status, message_id, _) = read_exec_control_result(&mut host);
    assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(seq, 44);
    assert_eq!(status, ExecControlStatus::Delivered);
    assert_eq!(message_id, "msg-max-payload");

    client.join().unwrap();
}

#[test]
fn handle_exec_control_waits_for_sink_connection() {
    let forward_nonce = unique_test_nonce(9);

    let registry = ExecControlRegistry::default();
    let registration = registry.register(9, forward_nonce, true).unwrap();
    let endpoint = registration.bootstrap_endpoint.clone().unwrap();
    let (writer, mut host) = guest_writer_pair();
    let payload =
        guest_control_proto::encode_exec_control(9, forward_nonce, "msg-1", b"payload", 5000)
            .unwrap();

    handle_exec_control(11, &payload, &registry, &writer).unwrap();

    let mut stream = process_control_ipc::connect_abstract(&endpoint).unwrap();
    process_control_ipc::write_hello(&mut stream).unwrap();
    let request = process_control_ipc::read_request(&mut stream).unwrap();
    assert_eq!(request.message_id, "msg-1");
    assert_eq!(request.payload, b"payload");
    process_control_ipc::write_response(
        &mut stream,
        &process_control_ipc::ControlResponse {
            message_id: request.message_id,
            status: process_control_ipc::ControlResponseStatus::Accepted,
            diagnostic: String::new(),
        },
    )
    .unwrap();

    let (msg_type, seq, status, message_id, _) = read_exec_control_result(&mut host);
    assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(seq, 11);
    assert_eq!(status, ExecControlStatus::Delivered);
    assert_eq!(message_id, "msg-1");
}
#[test]
fn timeout_before_sink_connection_does_not_poison_later_delivery() {
    let forward_nonce = unique_test_nonce(16);

    let registry = ExecControlRegistry::default();
    let registration = registry.register(16, forward_nonce, true).unwrap();
    let endpoint = registration.bootstrap_endpoint.clone().unwrap();
    let (writer, mut host) = guest_writer_pair();
    let payload = guest_control_proto::encode_exec_control(
        16,
        forward_nonce,
        "msg-before-connect",
        b"payload",
        0,
    )
    .unwrap();

    handle_exec_control(41, &payload, &registry, &writer).unwrap();
    let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
    assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(seq, 41);
    assert_eq!(status, ExecControlStatus::SinkTimeout);
    assert_eq!(message_id, "msg-before-connect");
    assert_eq!(diagnostic, EXEC_REQUEST_TIMEOUT_DIAGNOSTIC);

    let client = std::thread::spawn(move || {
        let mut stream = process_control_ipc::connect_abstract(&endpoint).unwrap();
        process_control_ipc::write_hello(&mut stream).unwrap();
        let request = process_control_ipc::read_request(&mut stream).unwrap();
        assert_eq!(request.message_id, "msg-after-timeout");
        assert_eq!(request.payload, b"payload");
        process_control_ipc::write_response(
            &mut stream,
            &process_control_ipc::ControlResponse {
                message_id: request.message_id,
                status: process_control_ipc::ControlResponseStatus::Accepted,
                diagnostic: String::new(),
            },
        )
        .unwrap();
    });

    let payload = guest_control_proto::encode_exec_control(
        16,
        forward_nonce,
        "msg-after-timeout",
        b"payload",
        5000,
    )
    .unwrap();
    handle_exec_control(42, &payload, &registry, &writer).unwrap();
    let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
    assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(seq, 42);
    assert_eq!(status, ExecControlStatus::Delivered);
    assert_eq!(message_id, "msg-after-timeout");
    assert_eq!(diagnostic, "");

    client.join().unwrap();
}
#[test]
fn non_terminal_control_responses_do_not_close_sink() {
    let forward_nonce = unique_test_nonce(11);

    let registry = ExecControlRegistry::default();
    let registration = registry.register(11, forward_nonce, true).unwrap();
    let endpoint = registration.bootstrap_endpoint.clone().unwrap();
    let client = std::thread::spawn(move || {
        let mut stream = process_control_ipc::connect_abstract(&endpoint).unwrap();
        process_control_ipc::write_hello(&mut stream).unwrap();

        let request = process_control_ipc::read_request(&mut stream).unwrap();
        assert_eq!(request.message_id, "msg-rejected");
        process_control_ipc::write_response(
            &mut stream,
            &process_control_ipc::ControlResponse {
                message_id: request.message_id,
                status: process_control_ipc::ControlResponseStatus::Rejected,
                diagnostic: "denied".to_owned(),
            },
        )
        .unwrap();

        let request = process_control_ipc::read_request(&mut stream).unwrap();
        assert_eq!(request.message_id, "msg-queue-full");
        process_control_ipc::write_response(
            &mut stream,
            &process_control_ipc::ControlResponse {
                message_id: request.message_id,
                status: process_control_ipc::ControlResponseStatus::QueueFull,
                diagnostic: "pending inputs full".to_owned(),
            },
        )
        .unwrap();

        let request = process_control_ipc::read_request(&mut stream).unwrap();
        assert_eq!(request.message_id, "msg-error");
        process_control_ipc::write_response(
            &mut stream,
            &process_control_ipc::ControlResponse {
                message_id: request.message_id,
                status: process_control_ipc::ControlResponseStatus::Error,
                diagnostic: "temporary error".to_owned(),
            },
        )
        .unwrap();

        let request = process_control_ipc::read_request(&mut stream).unwrap();
        assert_eq!(request.message_id, "msg-after-error");
        process_control_ipc::write_response(
            &mut stream,
            &process_control_ipc::ControlResponse {
                message_id: request.message_id,
                status: process_control_ipc::ControlResponseStatus::Accepted,
                diagnostic: String::new(),
            },
        )
        .unwrap();
    });

    let (writer, mut host) = guest_writer_pair();

    let payload = guest_control_proto::encode_exec_control(
        11,
        forward_nonce,
        "msg-rejected",
        b"payload",
        5000,
    )
    .unwrap();
    handle_exec_control(21, &payload, &registry, &writer).unwrap();
    let (_, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
    assert_eq!(seq, 21);
    assert_eq!(status, ExecControlStatus::Rejected);
    assert_eq!(message_id, "msg-rejected");
    assert_eq!(diagnostic, "denied");

    let payload = guest_control_proto::encode_exec_control(
        11,
        forward_nonce,
        "msg-queue-full",
        b"payload",
        5000,
    )
    .unwrap();
    handle_exec_control(22, &payload, &registry, &writer).unwrap();
    let (_, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
    assert_eq!(seq, 22);
    assert_eq!(status, ExecControlStatus::QueueFull);
    assert_eq!(message_id, "msg-queue-full");
    assert_eq!(diagnostic, "pending inputs full");

    let payload =
        guest_control_proto::encode_exec_control(11, forward_nonce, "msg-error", b"payload", 5000)
            .unwrap();
    handle_exec_control(23, &payload, &registry, &writer).unwrap();
    let (_, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
    assert_eq!(seq, 23);
    assert_eq!(status, ExecControlStatus::SinkError);
    assert_eq!(message_id, "msg-error");
    assert_eq!(diagnostic, "temporary error");

    let payload = guest_control_proto::encode_exec_control(
        11,
        forward_nonce,
        "msg-after-error",
        b"payload",
        5000,
    )
    .unwrap();
    handle_exec_control(24, &payload, &registry, &writer).unwrap();
    let (_, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
    assert_eq!(seq, 24);
    assert_eq!(status, ExecControlStatus::Delivered);
    assert_eq!(message_id, "msg-after-error");
    assert_eq!(diagnostic, "");

    client.join().unwrap();
}
#[test]
fn pending_exec_control_returns_inactive_when_operation_releases() {
    let forward_nonce = unique_test_nonce(10);

    let registry = ExecControlRegistry::default();
    let registration = registry.register(10, forward_nonce, true).unwrap();
    let (writer, mut host) = guest_writer_pair();
    let payload = guest_control_proto::encode_exec_control(
        10,
        forward_nonce,
        "msg-release",
        b"payload",
        5000,
    )
    .unwrap();

    handle_exec_control(13, &payload, &registry, &writer).unwrap();
    registration.guard.release();

    let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
    assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(seq, 13);
    assert_eq!(status, ExecControlStatus::Inactive);
    assert_eq!(message_id, "msg-release");
    assert_eq!(diagnostic, "exec operation is not active");
}
#[test]
fn pending_exec_control_returns_inactive_when_operation_drops() {
    let forward_nonce = unique_test_nonce(17);

    let registry = ExecControlRegistry::default();
    let registration = registry.register(17, forward_nonce, true).unwrap();
    let (writer, mut host) = guest_writer_pair();
    let payload =
        guest_control_proto::encode_exec_control(17, forward_nonce, "msg-drop", b"payload", 5000)
            .unwrap();

    handle_exec_control(33, &payload, &registry, &writer).unwrap();
    drop(registration);

    let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
    assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(seq, 33);
    assert_eq!(status, ExecControlStatus::Inactive);
    assert_eq!(message_id, "msg-drop");
    assert_eq!(diagnostic, "exec operation is not active");
}
#[test]
fn failed_control_sink_handshake_returns_sink_error() {
    let forward_nonce = unique_test_nonce(13);

    let registry = ExecControlRegistry::default();
    let registration = registry.register(13, forward_nonce, true).unwrap();
    let endpoint = registration.bootstrap_endpoint.clone().unwrap();
    let sink = registry.resolve(13, forward_nonce).unwrap();

    let stream = process_control_ipc::connect_abstract(&endpoint).unwrap();
    drop(stream);

    wait_for_sink_state(
        &sink,
        Duration::from_secs(1),
        "control sink should mark failed when peer disconnects before hello",
        |inner| matches!(inner, ControlSinkInner::Failed(_)),
    );

    let (writer, mut host) = guest_writer_pair();
    let payload = guest_control_proto::encode_exec_control(
        13,
        forward_nonce,
        "msg-handshake-failed",
        b"payload",
        5000,
    )
    .unwrap();

    handle_exec_control(31, &payload, &registry, &writer).unwrap();

    let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
    assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(seq, 31);
    assert_eq!(status, ExecControlStatus::SinkError);
    assert_eq!(message_id, "msg-handshake-failed");
    assert!(!diagnostic.is_empty());
}
#[test]
fn operation_release_interrupts_control_sink_handshake() {
    let handshake_nonce = unique_test_nonce(15);

    let registry = ExecControlRegistry::default();
    let registration = registry.register(15, handshake_nonce, true).unwrap();
    let endpoint = registration.bootstrap_endpoint.clone().unwrap();
    let sink = registry.resolve(15, handshake_nonce).unwrap();
    let mut stream = process_control_ipc::connect_abstract(&endpoint).unwrap();

    wait_for_sink_state(
        &sink,
        Duration::from_secs(1),
        "control sink should enter handshaking after accept",
        |inner| matches!(inner, ControlSinkInner::Handshaking(_)),
    );

    registration.guard.release();

    let guard = sink.inner.lock().unwrap_or_else(|e| e.into_inner());
    assert!(matches!(*guard, ControlSinkInner::Closed));
    drop(guard);

    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    let error = process_control_ipc::read_request(&mut stream).unwrap_err();
    assert!(
        !is_timeout(&error),
        "operation release should interrupt the accepted handshake stream"
    );
}
#[test]
fn operation_drop_interrupts_control_sink_handshake() {
    let handshake_nonce = unique_test_nonce(18);

    let registry = ExecControlRegistry::default();
    let registration = registry.register(18, handshake_nonce, true).unwrap();
    let endpoint = registration.bootstrap_endpoint.clone().unwrap();
    let sink = registry.resolve(18, handshake_nonce).unwrap();
    let mut stream = process_control_ipc::connect_abstract(&endpoint).unwrap();

    wait_for_sink_state(
        &sink,
        Duration::from_secs(1),
        "control sink should enter handshaking after accept",
        |inner| matches!(inner, ControlSinkInner::Handshaking(_)),
    );

    drop(registration);

    let guard = sink.inner.lock().unwrap_or_else(|e| e.into_inner());
    assert!(matches!(*guard, ControlSinkInner::Closed));
    drop(guard);

    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    let error = process_control_ipc::read_request(&mut stream).unwrap_err();
    assert!(
        !is_timeout(&error),
        "operation drop should interrupt the accepted handshake stream"
    );
}
