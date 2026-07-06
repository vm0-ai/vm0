use std::io;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use vsock_proto::{ExecControlStatus, MSG_EXEC_CONTROL_RESULT};

use super::super::forward::forward_control_request;
use super::super::sink::{ControlSinkInner, ControlSinkState, ControlStreamLockError};
use super::super::{EXEC_REQUEST_TIMEOUT_DIAGNOSTIC, request_deadline};
use super::support::{
    connected_sink, connected_stream_handle, guest_writer_pair, owned_control_request,
    read_exec_control_result,
};

#[test]
fn close_does_not_wait_for_busy_control_stream_lock() {
    let (sink, _peer) = connected_sink();
    let stream = connected_stream_handle(&sink);
    let stream_guard = stream
        .lock_until(request_deadline(5000), &sink.active)
        .unwrap();
    let (done_tx, done_rx) = std::sync::mpsc::channel();

    let worker = std::thread::spawn({
        let sink = Arc::clone(&sink);
        move || {
            sink.close();
            done_tx.send(()).unwrap();
        }
    });

    done_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("close should not wait for the control stream lock");
    drop(stream_guard);
    worker.join().unwrap();

    assert!(matches!(
        *sink.inner.lock().unwrap_or_else(|e| e.into_inner()),
        ControlSinkInner::Closed
    ));
}
#[test]
fn fail_does_not_wait_for_busy_control_stream_lock() {
    let (sink, _peer) = connected_sink();
    let stream = connected_stream_handle(&sink);
    let stream_guard = stream
        .lock_until(request_deadline(5000), &sink.active)
        .unwrap();
    let (done_tx, done_rx) = std::sync::mpsc::channel();

    let worker = std::thread::spawn({
        let sink = Arc::clone(&sink);
        move || {
            sink.fail("failed".to_owned());
            done_tx.send(()).unwrap();
        }
    });

    done_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("fail should not wait for the control stream lock");
    drop(stream_guard);
    worker.join().unwrap();

    assert!(matches!(
        *sink.inner.lock().unwrap_or_else(|e| e.into_inner()),
        ControlSinkInner::Failed(_)
    ));
}
#[test]
fn failed_control_sink_rejects_existing_connected_stream_handle() {
    let (sink, _peer) = connected_sink();
    let stream = connected_stream_handle(&sink);
    let stream_guard = stream
        .lock_until(request_deadline(5000), &sink.active)
        .unwrap();

    sink.fail("failed".to_owned());

    let error = match stream.lock_until(request_deadline(5000), &sink.active) {
        Ok(_) => panic!("failed sink should reject existing connected stream handles"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        ControlStreamLockError::SinkError(message) if message == "failed"
    ));
    drop(stream_guard);
}
#[test]
fn control_sink_failure_preserves_first_diagnostic() {
    let (sink, _peer) = connected_sink();
    let stream = connected_stream_handle(&sink);

    sink.fail("first failure".to_owned());
    sink.fail("second failure".to_owned());

    let error = match sink.wait_for_stream(request_deadline(5000)) {
        Ok(_) => panic!("failed sink should reject future stream lookups"),
        Err(error) => error,
    };
    assert_eq!(
        error,
        (ExecControlStatus::SinkError, "first failure".to_owned())
    );

    let error = match stream.lock_until(request_deadline(5000), &sink.active) {
        Ok(_) => panic!("failed stream gate should preserve the first failure"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        ControlStreamLockError::SinkError(message) if message == "first failure"
    ));
}
#[test]
fn queued_control_request_is_not_delivered_after_close() {
    let (sink, mut peer) = connected_sink();
    peer.set_nonblocking(true).unwrap();
    let stream = connected_stream_handle(&sink);
    let stream_guard = stream
        .lock_until(request_deadline(5000), &sink.active)
        .unwrap();
    let (writer, mut host) = guest_writer_pair();

    let pending_slot = sink.reserve_pending_slot().unwrap();
    let worker = std::thread::spawn({
        let sink = Arc::clone(&sink);
        move || {
            forward_control_request(
                sink,
                pending_slot,
                owned_control_request(17, 9, 5000, "msg-after-close"),
                writer,
            );
        }
    });

    sink.close();

    let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
    assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(seq, 17);
    assert_eq!(status, ExecControlStatus::Inactive);
    assert_eq!(message_id, "msg-after-close");
    assert_eq!(diagnostic, "exec operation is not active");
    worker.join().unwrap();
    assert_eq!(sink.pending.load(Ordering::Acquire), 0);
    drop(stream_guard);

    let err = process_control_ipc::read_request(&mut peer).unwrap_err();
    assert!(matches!(
        err.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset
    ));
}
#[test]
fn queued_control_request_is_not_delivered_after_fail() {
    let (sink, mut peer) = connected_sink();
    peer.set_nonblocking(true).unwrap();
    let stream = connected_stream_handle(&sink);
    let stream_guard = stream
        .lock_until(request_deadline(5000), &sink.active)
        .unwrap();
    let (writer, mut host) = guest_writer_pair();

    let pending_slot = sink.reserve_pending_slot().unwrap();
    let worker = std::thread::spawn({
        let sink = Arc::clone(&sink);
        move || {
            forward_control_request(
                sink,
                pending_slot,
                owned_control_request(23, 9, 5000, "msg-after-fail"),
                writer,
            );
        }
    });

    sink.fail("failed".to_owned());

    let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
    assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(seq, 23);
    assert_eq!(status, ExecControlStatus::SinkError);
    assert_eq!(message_id, "msg-after-fail");
    assert_eq!(diagnostic, "failed");
    worker.join().unwrap();
    assert_eq!(sink.pending.load(Ordering::Acquire), 0);

    let err = process_control_ipc::read_request(&mut peer).unwrap_err();
    assert!(matches!(
        err.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset
    ));
    drop(stream_guard);
}
#[test]
fn expired_connected_control_request_is_not_delivered() {
    let (sink, mut peer) = connected_sink();
    peer.set_nonblocking(true).unwrap();
    let stream = connected_stream_handle(&sink);
    let stream_guard = stream
        .lock_until(request_deadline(5000), &sink.active)
        .unwrap();
    let pending_slot = sink.reserve_pending_slot().unwrap();
    let (writer, mut host) = guest_writer_pair();

    let worker = std::thread::spawn({
        let sink = Arc::clone(&sink);
        move || {
            forward_control_request(
                sink,
                pending_slot,
                owned_control_request(19, 9, 0, "msg-expired-behind-lock"),
                writer,
            );
        }
    });

    let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
    worker.join().unwrap();

    assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(seq, 19);
    assert_eq!(status, ExecControlStatus::SinkTimeout);
    assert_eq!(message_id, "msg-expired-behind-lock");
    assert_eq!(diagnostic, EXEC_REQUEST_TIMEOUT_DIAGNOSTIC);
    assert_eq!(sink.pending.load(Ordering::Acquire), 0);
    assert!(matches!(
        *sink.inner.lock().unwrap_or_else(|e| e.into_inner()),
        ControlSinkInner::Connected(_)
    ));

    let err = process_control_ipc::read_request(&mut peer).unwrap_err();
    assert!(matches!(
        err.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset
    ));
    drop(stream_guard);
}
#[test]
fn close_interrupts_inflight_control_request() {
    let sink = Arc::new(ControlSinkState::new());
    let (stream, mut peer) = UnixStream::pair().unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    sink.connect(stream);
    let pending_slot = sink.reserve_pending_slot().unwrap();
    let (writer, mut host) = guest_writer_pair();
    let (done_tx, done_rx) = std::sync::mpsc::channel();

    let worker = std::thread::spawn({
        let sink = Arc::clone(&sink);
        move || {
            forward_control_request(
                sink,
                pending_slot,
                owned_control_request(18, 9, 5000, "msg-inflight-close"),
                writer,
            );
            done_tx.send(()).unwrap();
        }
    });

    let request = process_control_ipc::read_request(&mut peer).unwrap();
    assert_eq!(request.message_id, "msg-inflight-close");

    sink.close();
    done_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("close should interrupt an in-flight control read");
    worker.join().unwrap();

    let (msg_type, seq, status, message_id, diagnostic) = read_exec_control_result(&mut host);
    assert_eq!(msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(seq, 18);
    assert_eq!(status, ExecControlStatus::Inactive);
    assert_eq!(message_id, "msg-inflight-close");
    assert_eq!(diagnostic, "exec operation is not active");
    assert_eq!(sink.pending.load(Ordering::Acquire), 0);
}
