use std::io;
use std::sync::Arc;
use std::time::Duration;

use super::support::{host_from_stream, make_pair, mock_handshake, send_command_result};
use crate::{ConnectionState, GuestProcessHandle, VsockHost};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Notify, oneshot};
use vsock_proto::{
    CommandTermination, Decoder, MSG_COMMAND_START, MSG_ERROR, MSG_PROCESS_EXIT, MSG_SPAWN_PROCESS,
    MSG_SPAWN_PROCESS_RESULT, MSG_STDOUT_CHUNK,
};

fn registration_counts(host: &VsockHost) -> (usize, usize, usize) {
    let guard = host.shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match &*guard {
        ConnectionState::Connected {
            pending, process, ..
        } => {
            let (operations, stdout_senders) = process.registration_counts();
            (pending.len(), operations, stdout_senders)
        }
        ConnectionState::Closed { .. } => (0, 0, 0),
    }
}

async fn wait_spawn(handle: GuestProcessHandle) -> io::Result<crate::ProcessExitEvent> {
    tokio::time::timeout(Duration::from_secs(5), handle.wait())
        .await
        .expect("spawn_process exit should arrive before timeout")
}

#[tokio::test]
async fn test_spawn_process_and_wait() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let spawn_seq = msgs[0].seq;

        let payload = vsock_proto::encode_spawn_process_result(42);
        let resp = vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();

        let exit_payload = vsock_proto::encode_process_exit(42, 0, b"done", b"");
        let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, spawn_seq, &exit_payload).unwrap();
        guest.write_all(&exit_msg).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let mut handle = host
        .spawn_process("sleep 1", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 42);
    assert!(
        handle.take_stdout_receiver().is_none(),
        "buffered spawn_process must not keep a stdout stream registered",
    );

    let event = wait_spawn(handle).await.unwrap();
    assert_eq!(event.pid, 42);
    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"done");
}

#[tokio::test]
async fn test_exit_event_before_wait() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let spawn_seq = msgs[0].seq;

        let payload = vsock_proto::encode_spawn_process_result(99);
        let resp = vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &payload).unwrap();
        let exit_payload = vsock_proto::encode_process_exit(99, 1, b"", b"error");
        let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, spawn_seq, &exit_payload).unwrap();

        let mut combined = resp;
        combined.extend_from_slice(&exit_msg);
        guest.write_all(&combined).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let handle = host
        .spawn_process("false", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 99);

    let event = wait_spawn(handle).await.unwrap();
    assert_eq!(event.exit_code, 1);
    assert_eq!(event.stderr, b"error");
}

#[tokio::test]
async fn test_spawn_process_error_response_cleans_up() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let err_payload = vsock_proto::encode_error("no such command");
        let err_resp = vsock_proto::encode(MSG_ERROR, msgs[0].seq, &err_payload).unwrap();
        guest.write_all(&err_resp).await.unwrap();

        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let ok_payload = vsock_proto::encode_spawn_process_result(222);
        let ok_resp =
            vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, msgs[0].seq, &ok_payload).unwrap();
        guest.write_all(&ok_resp).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();

    let err = host
        .spawn_process("bad-cmd", 0, &[], false, true, None)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no such command"));
    assert_eq!(
        registration_counts(&host),
        (0, 0, 0),
        "streaming spawn_process error must clean operation registration",
    );

    let handle = host
        .spawn_process("good-cmd", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 222);
}

#[tokio::test]
async fn test_spawn_process_malformed_result_cleans_up() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        let bad_payload = b"\x00\x01\x02";
        let bad_resp =
            vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, msgs[0].seq, bad_payload).unwrap();
        guest.write_all(&bad_resp).await.unwrap();

        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        let ok_payload = vsock_proto::encode_spawn_process_result(333);
        let ok_resp =
            vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, msgs[0].seq, &ok_payload).unwrap();
        guest.write_all(&ok_resp).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();

    let err = host
        .spawn_process("bad-payload-cmd", 0, &[], false, true, None)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        registration_counts(&host),
        (0, 0, 0),
        "malformed streaming spawn_process result must clean operation registration",
    );

    let handle = host
        .spawn_process("good-cmd", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 333);
}

#[tokio::test]
async fn test_spawn_process_connection_closed_before_result_cleans_up() {
    let (host_stream, mut guest) = make_pair();
    let request_seen = Arc::new(Notify::new());

    {
        let request_seen = Arc::clone(&request_seen);
        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
            request_seen.notify_one();
            drop(guest);
        });
    }

    let host = Arc::new(host_from_stream(host_stream).await.unwrap());
    let task_host = Arc::clone(&host);
    let task = tokio::spawn(async move {
        task_host
            .spawn_process("pending-result", 0, &[], false, true, None)
            .await
    });

    tokio::time::timeout(Duration::from_secs(5), request_seen.notified())
        .await
        .expect("guest should receive spawn_process request");

    let err = task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        registration_counts(&host),
        (0, 0, 0),
        "connection close while spawn_process is pending must clean registrations",
    );
}

#[tokio::test]
async fn test_malformed_unsolicited_process_frames_are_ignored() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let bad_stdout = vsock_proto::encode(MSG_STDOUT_CHUNK, 0, b"\x00\x01").unwrap();
        let bad_exit = vsock_proto::encode(MSG_PROCESS_EXIT, 0, b"\x00\x01").unwrap();
        let mut combined = bad_stdout;
        combined.extend_from_slice(&bad_exit);
        guest.write_all(&combined).await.unwrap();

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let spawn_seq = msgs[0].seq;

        let payload = vsock_proto::encode_spawn_process_result(444);
        let resp = vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();

        let exit_payload = vsock_proto::encode_process_exit(444, 0, b"after-malformed", b"");
        let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, spawn_seq, &exit_payload).unwrap();
        guest.write_all(&exit_msg).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let handle = host
        .spawn_process("after-malformed", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 444);

    let event = wait_spawn(handle).await.unwrap();
    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"after-malformed");
}

async fn assert_lifecycle_before_result_closes(
    msg_type: u8,
    payload: Vec<u8>,
    stream_stdout: bool,
) {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let spawn_seq = msgs[0].seq;

        let frame = vsock_proto::encode(msg_type, spawn_seq, &payload).unwrap();
        guest.write_all(&frame).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        host.spawn_process("early-lifecycle", 0, &[], false, stream_stdout, None),
    )
    .await
    .expect("pre-result lifecycle frame should close connection promptly");
    let err = result.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        registration_counts(&host),
        (0, 0, 0),
        "pre-result lifecycle frame must clean all registrations",
    );
}

#[tokio::test]
async fn test_stdout_chunk_before_spawn_process_result_closes_and_cleans_up() {
    assert_lifecycle_before_result_closes(
        MSG_STDOUT_CHUNK,
        vsock_proto::encode_stdout_chunk(777, b"early stdout"),
        true,
    )
    .await;
}

#[tokio::test]
async fn test_process_exit_before_spawn_process_result_closes_and_cleans_up() {
    assert_lifecycle_before_result_closes(
        MSG_PROCESS_EXIT,
        vsock_proto::encode_process_exit(777, 0, b"early stdout", b""),
        false,
    )
    .await;
}

#[tokio::test]
async fn test_dropped_stdout_receiver_removes_stream_sender() {
    let (host_stream, mut guest) = make_pair();
    let send_chunk = Arc::new(Notify::new());
    let send_exit = Arc::new(Notify::new());

    {
        let send_chunk = Arc::clone(&send_chunk);
        let send_exit = Arc::clone(&send_exit);
        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
            let spawn_seq = msgs[0].seq;

            let payload = vsock_proto::encode_spawn_process_result(555);
            let resp = vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            send_chunk.notified().await;
            let chunk_payload = vsock_proto::encode_stdout_chunk(555, b"orphaned chunk");
            let chunk = vsock_proto::encode(MSG_STDOUT_CHUNK, spawn_seq, &chunk_payload).unwrap();
            guest.write_all(&chunk).await.unwrap();

            send_exit.notified().await;
            let exit_payload = vsock_proto::encode_process_exit(555, 0, b"", b"");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, spawn_seq, &exit_payload).unwrap();
            guest.write_all(&exit_msg).await.unwrap();

            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });
    }

    let host = host_from_stream(host_stream).await.unwrap();
    let mut handle = host
        .spawn_process("streaming", 0, &[], false, true, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 555);
    assert_eq!(registration_counts(&host), (0, 1, 1));

    drop(handle.take_stdout_receiver());
    send_chunk.notify_one();

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if registration_counts(&host) == (0, 1, 0) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("dropped stdout receiver should remove stream sender");

    send_exit.notify_one();
    let event = wait_spawn(handle).await.unwrap();
    assert_eq!(event.exit_code, 0);
}

#[tokio::test]
async fn test_wait_drops_unclaimed_stdout_receiver() {
    let (host_stream, mut guest) = make_pair();
    let send_chunk = Arc::new(Notify::new());
    let send_exit = Arc::new(Notify::new());

    {
        let send_chunk = Arc::clone(&send_chunk);
        let send_exit = Arc::clone(&send_exit);
        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
            let spawn_seq = msgs[0].seq;

            let payload = vsock_proto::encode_spawn_process_result(556);
            let resp = vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            send_chunk.notified().await;
            let chunk_payload = vsock_proto::encode_stdout_chunk(556, b"unclaimed chunk");
            let chunk = vsock_proto::encode(MSG_STDOUT_CHUNK, spawn_seq, &chunk_payload).unwrap();
            guest.write_all(&chunk).await.unwrap();

            send_exit.notified().await;
            let exit_payload = vsock_proto::encode_process_exit(556, 0, b"", b"");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, spawn_seq, &exit_payload).unwrap();
            guest.write_all(&exit_msg).await.unwrap();

            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });
    }

    let host = host_from_stream(host_stream).await.unwrap();
    let handle = host
        .spawn_process("streaming", 0, &[], false, true, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 556);
    assert_eq!(registration_counts(&host), (0, 1, 1));

    let wait = handle.wait();
    tokio::pin!(wait);
    tokio::select! {
        biased;
        result = &mut wait => panic!("spawn wait completed before exit: {result:?}"),
        _ = tokio::task::yield_now() => {}
    }

    send_chunk.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if registration_counts(&host) == (0, 1, 0) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("wait should drop unclaimed stdout receiver before buffering chunks");

    send_exit.notify_one();
    let event = tokio::time::timeout(Duration::from_secs(5), &mut wait)
        .await
        .expect("spawn wait should complete")
        .unwrap();
    assert_eq!(event.exit_code, 0);
}

#[tokio::test]
async fn test_spawn_process_cancel_cleans_up_registrations() {
    let (host_stream, mut guest) = make_pair();
    let request_seen = Arc::new(Notify::new());
    let release_guest = Arc::new(Notify::new());

    {
        let request_seen = Arc::clone(&request_seen);
        let release_guest = Arc::clone(&release_guest);
        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
            request_seen.notify_one();

            release_guest.notified().await;
        });
    }

    let host = Arc::new(host_from_stream(host_stream).await.unwrap());
    let task_host = Arc::clone(&host);
    let task = tokio::spawn(async move {
        task_host
            .spawn_process("long-running", 0, &[], false, true, None)
            .await
    });

    tokio::time::timeout(Duration::from_secs(5), request_seen.notified())
        .await
        .expect("guest should receive spawn_process request");
    assert_eq!(registration_counts(&host), (1, 1, 1));

    task.abort();
    let _ = task.await;
    assert_eq!(
        registration_counts(&host),
        (0, 0, 0),
        "aborted spawn_process future must clean pending registrations",
    );

    release_guest.notify_one();
}

#[tokio::test]
async fn test_late_malformed_lifecycle_after_handle_drop_is_ignored() {
    let (host_stream, mut guest) = make_pair();
    let release_late_frames = Arc::new(Notify::new());

    {
        let release_late_frames = Arc::clone(&release_late_frames);
        tokio::spawn(async move {
            let mut decoder = Decoder::new();
            mock_handshake(&mut guest, &mut decoder).await;

            let mut buf = [0u8; 4096];
            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
            let dropped_seq = msgs[0].seq;
            let payload = vsock_proto::encode_spawn_process_result(66);
            let resp =
                vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, dropped_seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            release_late_frames.notified().await;
            let bad_stdout = vsock_proto::encode(MSG_STDOUT_CHUNK, dropped_seq, b"\x00").unwrap();
            let bad_exit = vsock_proto::encode(MSG_PROCESS_EXIT, dropped_seq, b"\x00").unwrap();
            guest.write_all(&bad_stdout).await.unwrap();
            guest.write_all(&bad_exit).await.unwrap();

            let n = guest.read(&mut buf).await.unwrap();
            let msgs = decoder.decode(&buf[..n]).unwrap();
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
            let next_seq = msgs[0].seq;
            let payload = vsock_proto::encode_spawn_process_result(67);
            let resp = vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, next_seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();
            let exit_payload = vsock_proto::encode_process_exit(67, 0, b"still-alive", b"");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, next_seq, &exit_payload).unwrap();
            guest.write_all(&exit_msg).await.unwrap();

            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });
    }

    let host = host_from_stream(host_stream).await.unwrap();
    let handle = host
        .spawn_process("drop-before-late-frame", 0, &[], false, true, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 66);
    drop(handle);
    assert_eq!(registration_counts(&host), (0, 0, 0));

    release_late_frames.notify_one();

    let next = host
        .spawn_process("next-spawn", 0, &[], false, false, None)
        .await
        .unwrap();
    let event = wait_spawn(next).await.unwrap();
    assert_eq!(event.pid, 67);
    assert_eq!(event.stdout, b"still-alive");
}

#[tokio::test]
async fn test_spawn_process_after_close_returns_immediately() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();

    let err = tokio::time::timeout(
        Duration::from_secs(5),
        host.spawn_process("long-running", 0, &[], false, false, None),
    )
    .await
    .expect("spawn_process should return when the connection is already closed")
    .unwrap_err();
    assert!(
        matches!(
            err.kind(),
            io::ErrorKind::ConnectionReset | io::ErrorKind::BrokenPipe
        ),
        "expected ConnectionReset or BrokenPipe, got {:?}",
        err.kind()
    );
}

#[tokio::test]
async fn test_spawn_process_exit_before_wait() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let spawn_seq = msgs[0].seq;

        let payload = vsock_proto::encode_spawn_process_result(88);
        let resp = vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();

        let exit_payload = vsock_proto::encode_process_exit(88, 7, b"quick", b"");
        let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, spawn_seq, &exit_payload).unwrap();
        guest.write_all(&exit_msg).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let handle = host
        .spawn_process("quick-exit", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 88);

    let event = wait_spawn(handle).await.unwrap();
    assert_eq!(event.pid, 88);
    assert_eq!(event.exit_code, 7);
    assert_eq!(event.stdout, b"quick");
}

#[tokio::test]
async fn test_spawn_process_connection_closed_while_waiting() {
    let (host_stream, mut guest) = make_pair();
    let (close_tx, close_rx) = oneshot::channel();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);

        let payload = vsock_proto::encode_spawn_process_result(77);
        let resp = vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, msgs[0].seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();

        let _ = close_rx.await;
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let handle = host
        .spawn_process("long-running", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 77);

    let wait_task = tokio::spawn(async move { handle.wait().await });
    close_tx.send(()).unwrap();

    let err = wait_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn test_spawn_process_exit_result_survives_close_before_wait() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let spawn_seq = msgs[0].seq;

        let result_payload = vsock_proto::encode_spawn_process_result(111);
        let result =
            vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &result_payload).unwrap();
        let exit_payload = vsock_proto::encode_process_exit(111, 3, b"early-output", b"err");
        let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, spawn_seq, &exit_payload).unwrap();

        let mut combined = result;
        combined.extend_from_slice(&exit_msg);
        guest.write_all(&combined).await.unwrap();
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let handle = host
        .spawn_process("quick-exit", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 111);

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();

    let event = wait_spawn(handle)
        .await
        .expect("exit result held by handle must survive connection close");
    assert_eq!(event.pid, 111);
    assert_eq!(event.exit_code, 3);
    assert_eq!(event.stdout, b"early-output");
    assert_eq!(event.stderr, b"err");
}

#[tokio::test]
async fn test_malformed_active_process_exit_closes_and_cleans_up() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let spawn_seq = msgs[0].seq;

        let result_payload = vsock_proto::encode_spawn_process_result(123);
        let result =
            vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &result_payload).unwrap();
        let bad_exit = vsock_proto::encode(MSG_PROCESS_EXIT, spawn_seq, b"\x00").unwrap();
        let mut combined = result;
        combined.extend_from_slice(&bad_exit);
        guest.write_all(&combined).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let handle = host
        .spawn_process("malformed-exit", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 123);

    let err = wait_spawn(handle).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        registration_counts(&host),
        (0, 0, 0),
        "malformed active process_exit must close and clean registrations",
    );
}

#[tokio::test]
async fn test_mismatched_active_process_exit_pid_closes_and_cleans_up() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let spawn_seq = msgs[0].seq;

        let result_payload = vsock_proto::encode_spawn_process_result(123);
        let result =
            vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &result_payload).unwrap();
        let wrong_pid_exit = vsock_proto::encode_process_exit(321, 0, b"wrong-pid", b"");
        let exit = vsock_proto::encode(MSG_PROCESS_EXIT, spawn_seq, &wrong_pid_exit).unwrap();
        let mut combined = result;
        combined.extend_from_slice(&exit);
        guest.write_all(&combined).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let handle = host
        .spawn_process("mismatched-exit-pid", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 123);

    let err = wait_spawn(handle).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        registration_counts(&host),
        (0, 0, 0),
        "mismatched active process_exit pid must close and clean registrations",
    );
}

async fn assert_bad_active_stdout_chunk_closes_and_cleans_up(payload: Vec<u8>) {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let spawn_seq = msgs[0].seq;

        let result_payload = vsock_proto::encode_spawn_process_result(123);
        let result =
            vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &result_payload).unwrap();
        let chunk = vsock_proto::encode(MSG_STDOUT_CHUNK, spawn_seq, &payload).unwrap();
        let mut combined = result;
        combined.extend_from_slice(&chunk);
        guest.write_all(&combined).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let mut handle = host
        .spawn_process("bad-stdout", 0, &[], false, true, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 123);
    let mut stdout_rx = handle.take_stdout_receiver().unwrap();

    let err = wait_spawn(handle).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    let received = tokio::time::timeout(Duration::from_secs(5), stdout_rx.recv())
        .await
        .expect("stdout receiver should close");
    assert!(received.is_none(), "bad stdout chunk must not be delivered");
    assert_eq!(
        registration_counts(&host),
        (0, 0, 0),
        "bad active stdout_chunk must close and clean registrations",
    );
}

#[tokio::test]
async fn test_malformed_active_stdout_chunk_closes_and_cleans_up() {
    assert_bad_active_stdout_chunk_closes_and_cleans_up(b"\x00".to_vec()).await;
}

#[tokio::test]
async fn test_mismatched_active_stdout_chunk_pid_closes_and_cleans_up() {
    assert_bad_active_stdout_chunk_closes_and_cleans_up(vsock_proto::encode_stdout_chunk(
        321,
        b"wrong-pid",
    ))
    .await;
}

#[tokio::test]
async fn test_buffered_active_stdout_chunk_closes_and_cleans_up() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let spawn_seq = msgs[0].seq;

        let result_payload = vsock_proto::encode_spawn_process_result(123);
        let result =
            vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &result_payload).unwrap();
        let chunk_payload = vsock_proto::encode_stdout_chunk(123, b"unexpected stream");
        let chunk = vsock_proto::encode(MSG_STDOUT_CHUNK, spawn_seq, &chunk_payload).unwrap();
        let mut combined = result;
        combined.extend_from_slice(&chunk);
        guest.write_all(&combined).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let handle = host
        .spawn_process("buffered-bad-stdout", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 123);

    let err = wait_spawn(handle).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        registration_counts(&host),
        (0, 0, 0),
        "stdout_chunk for buffered spawn_process must close and clean registrations",
    );
}

#[tokio::test]
async fn test_duplicate_spawn_process_result_cannot_overwrite_pid() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let spawn_seq = msgs[0].seq;

        let result_payload = vsock_proto::encode_spawn_process_result(123);
        let result =
            vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &result_payload).unwrap();
        guest.write_all(&result).await.unwrap();

        let duplicate_payload = vsock_proto::encode_spawn_process_result(321);
        let duplicate =
            vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &duplicate_payload).unwrap();
        guest.write_all(&duplicate).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let handle = host
        .spawn_process("duplicate-result", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 123);

    let err = wait_spawn(handle).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        registration_counts(&host),
        (0, 0, 0),
        "duplicate spawn_process_result must not overwrite recorded pid",
    );
}

#[tokio::test]
async fn test_duplicate_spawn_process_result_same_pid_closes_and_cleans_up() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let spawn_seq = msgs[0].seq;

        let result_payload = vsock_proto::encode_spawn_process_result(123);
        let result =
            vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &result_payload).unwrap();
        guest.write_all(&result).await.unwrap();

        let duplicate =
            vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &result_payload).unwrap();
        guest.write_all(&duplicate).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let handle = host
        .spawn_process("duplicate-same-pid-result", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 123);

    let err = wait_spawn(handle).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        registration_counts(&host),
        (0, 0, 0),
        "duplicate same-pid spawn_process_result must close and clean registrations",
    );
}

#[tokio::test]
async fn test_malformed_duplicate_spawn_process_result_closes_and_cleans_up() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let spawn_seq = msgs[0].seq;

        let result_payload = vsock_proto::encode_spawn_process_result(123);
        let result =
            vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &result_payload).unwrap();
        guest.write_all(&result).await.unwrap();

        let duplicate =
            vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, b"\x00\x01").unwrap();
        guest.write_all(&duplicate).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let handle = host
        .spawn_process("malformed-duplicate-result", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 123);

    let err = wait_spawn(handle).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        registration_counts(&host),
        (0, 0, 0),
        "malformed duplicate spawn_process_result must close and clean registrations",
    );
}

#[tokio::test]
async fn test_spawn_process_wait_future_drop_cleans_registration() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        let payload = vsock_proto::encode_spawn_process_result(55);
        let resp = vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, msgs[0].seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let handle = host
        .spawn_process("long-running", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 55);

    let wait = handle.wait();
    drop(wait);
    assert_eq!(registration_counts(&host), (0, 0, 0));
}

#[tokio::test]
async fn test_concurrent_spawn_process_routes_by_seq_not_pid() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];

        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let first_seq = msgs[0].seq;
        let payload = vsock_proto::encode_spawn_process_result(999);
        let resp = vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, first_seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();

        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let second_seq = msgs[0].seq;
        let payload = vsock_proto::encode_spawn_process_result(999);
        let resp = vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, second_seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();

        let second_chunk_payload = vsock_proto::encode_stdout_chunk(999, b"second");
        let first_chunk_payload = vsock_proto::encode_stdout_chunk(999, b"first");
        let second_exit_payload = vsock_proto::encode_process_exit(999, 22, b"", b"second err");
        let first_exit_payload = vsock_proto::encode_process_exit(999, 11, b"", b"first err");

        let mut frames =
            vsock_proto::encode(MSG_STDOUT_CHUNK, second_seq, &second_chunk_payload).unwrap();
        frames.extend_from_slice(
            &vsock_proto::encode(MSG_STDOUT_CHUNK, first_seq, &first_chunk_payload).unwrap(),
        );
        frames.extend_from_slice(
            &vsock_proto::encode(MSG_PROCESS_EXIT, second_seq, &second_exit_payload).unwrap(),
        );
        frames.extend_from_slice(
            &vsock_proto::encode(MSG_PROCESS_EXIT, first_seq, &first_exit_payload).unwrap(),
        );
        guest.write_all(&frames).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let mut first = host
        .spawn_process("first", 0, &[], false, true, None)
        .await
        .unwrap();
    let mut second = host
        .spawn_process("second", 0, &[], false, true, None)
        .await
        .unwrap();
    assert_eq!(first.pid(), 999);
    assert_eq!(second.pid(), 999);

    let mut first_stdout = first.take_stdout_receiver().unwrap();
    let mut second_stdout = second.take_stdout_receiver().unwrap();
    assert_eq!(second_stdout.recv().await.unwrap(), b"second");
    assert_eq!(first_stdout.recv().await.unwrap(), b"first");

    let second_exit = wait_spawn(second).await.unwrap();
    let first_exit = wait_spawn(first).await.unwrap();
    assert_eq!(second_exit.exit_code, 22);
    assert_eq!(second_exit.stderr, b"second err");
    assert_eq!(first_exit.exit_code, 11);
    assert_eq!(first_exit.stderr, b"first err");
}

#[tokio::test]
async fn test_concurrent_exec_and_wait_exit() {
    let (host_stream, mut guest) = make_pair();
    let (send_exit, exit_after_exec) = oneshot::channel();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_PROCESS);
        let spawn_seq = msgs[0].seq;

        let payload = vsock_proto::encode_spawn_process_result(50);
        let resp = vsock_proto::encode(MSG_SPAWN_PROCESS_RESULT, spawn_seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();

        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_COMMAND_START);
        let exec_seq = msgs[0].seq;

        send_command_result(
            &mut guest,
            exec_seq,
            CommandTermination::Exited { exit_code: 0 },
            b"concurrent",
            b"",
        )
        .await;

        let _ = exit_after_exec.await;
        let exit_payload = vsock_proto::encode_process_exit(50, 42, b"exited", b"");
        let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, spawn_seq, &exit_payload).unwrap();
        guest.write_all(&exit_msg).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = Arc::new(host_from_stream(host_stream).await.unwrap());
    let handle = host
        .spawn_process("long-running", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(handle.pid(), 50);

    let wait_task = tokio::spawn(async move { handle.wait().await });

    let exec_result = host
        .exec("echo concurrent", 5000, &[], false)
        .await
        .unwrap();
    assert_eq!(exec_result.exit_code, 0);
    assert_eq!(exec_result.stdout, b"concurrent");

    send_exit.send(()).unwrap();

    let exit_event = wait_task.await.unwrap().unwrap();
    assert_eq!(exit_event.pid, 50);
    assert_eq!(exit_event.exit_code, 42);
    assert_eq!(exit_event.stdout, b"exited");
}
