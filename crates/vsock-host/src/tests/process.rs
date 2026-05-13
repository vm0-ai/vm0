use std::io;
use std::sync::Arc;
use std::time::Duration;

use super::support::{host_from_stream, make_pair, mock_handshake, send_command_result};
use crate::{ConnectionState, VsockHost};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Notify, oneshot};
use tokio::time::Instant;
use vsock_proto::{
    CommandTermination, Decoder, MSG_COMMAND_START, MSG_ERROR, MSG_PROCESS_EXIT, MSG_SPAWN_WATCH,
    MSG_SPAWN_WATCH_RESULT, MSG_STDOUT_CHUNK,
};

fn registration_counts(host: &VsockHost) -> (usize, usize, usize) {
    let guard = host.shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match &*guard {
        ConnectionState::Connected {
            pending, process, ..
        } => {
            let (pending_stdout, stdout_senders) = process.registration_counts();
            (pending.len(), pending_stdout, stdout_senders)
        }
        ConnectionState::Closed { .. } => (0, 0, 0),
    }
}

#[tokio::test]
async fn test_spawn_watch_and_wait() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

        let payload = vsock_proto::encode_spawn_watch_result(42);
        let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();

        let exit_payload = vsock_proto::encode_process_exit(42, 0, b"done", b"");
        let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();
        guest.write_all(&exit_msg).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let (pid, mut stdout_rx) = host
        .spawn_watch("sleep 1", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(pid, 42);
    assert!(
        stdout_rx.recv().await.is_none(),
        "buffered spawn_watch must not keep a stdout stream registered",
    );

    let event = host
        .wait_for_exit(42, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(event.pid, 42);
    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"done");
}

#[tokio::test]
async fn test_cached_exit_event() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

        let payload = vsock_proto::encode_spawn_watch_result(99);
        let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
        let exit_payload = vsock_proto::encode_process_exit(99, 1, b"", b"error");
        let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();

        let mut combined = resp;
        combined.extend_from_slice(&exit_msg);
        guest.write_all(&combined).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let (pid, _stdout_rx) = host
        .spawn_watch("false", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(pid, 99);

    let event = host
        .wait_for_exit(99, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(event.exit_code, 1);
    assert_eq!(event.stderr, b"error");
}

#[tokio::test]
async fn test_spawn_watch_error_response_cleans_up() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);
        let err_payload = vsock_proto::encode_error("no such command");
        let err_resp = vsock_proto::encode(MSG_ERROR, msgs[0].seq, &err_payload).unwrap();
        guest.write_all(&err_resp).await.unwrap();

        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);
        let ok_payload = vsock_proto::encode_spawn_watch_result(222);
        let ok_resp =
            vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &ok_payload).unwrap();
        guest.write_all(&ok_resp).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();

    let err = host
        .spawn_watch("bad-cmd", 0, &[], false, true, None)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no such command"));
    assert_eq!(
        registration_counts(&host),
        (0, 0, 0),
        "streaming spawn_watch error must clean pending stdout registration",
    );

    let (pid, _stdout_rx) = host
        .spawn_watch("good-cmd", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(pid, 222);
}

#[tokio::test]
async fn test_spawn_watch_malformed_result_cleans_up() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        let bad_payload = b"\x00\x01\x02";
        let bad_resp =
            vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, bad_payload).unwrap();
        guest.write_all(&bad_resp).await.unwrap();

        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        let ok_payload = vsock_proto::encode_spawn_watch_result(333);
        let ok_resp =
            vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &ok_payload).unwrap();
        guest.write_all(&ok_resp).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();

    let err = host
        .spawn_watch("bad-payload-cmd", 0, &[], false, true, None)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        registration_counts(&host),
        (0, 0, 0),
        "malformed streaming spawn_watch result must clean pending stdout registration",
    );

    let (pid, _stdout_rx) = host
        .spawn_watch("good-cmd", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(pid, 333);
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
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

        let payload = vsock_proto::encode_spawn_watch_result(444);
        let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();

        let exit_payload = vsock_proto::encode_process_exit(444, 0, b"after-malformed", b"");
        let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();
        guest.write_all(&exit_msg).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let (pid, _stdout_rx) = host
        .spawn_watch("after-malformed", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(pid, 444);

    let event = host
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(event.exit_code, 0);
    assert_eq!(event.stdout, b"after-malformed");
}

#[tokio::test]
async fn test_dropped_stdout_receiver_removes_stream_registration() {
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
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

            let payload = vsock_proto::encode_spawn_watch_result(555);
            let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
            guest.write_all(&resp).await.unwrap();

            send_chunk.notified().await;
            let chunk_payload = vsock_proto::encode_stdout_chunk(555, b"orphaned chunk");
            let chunk = vsock_proto::encode(MSG_STDOUT_CHUNK, 0, &chunk_payload).unwrap();
            guest.write_all(&chunk).await.unwrap();

            send_exit.notified().await;
            let exit_payload = vsock_proto::encode_process_exit(555, 0, b"", b"");
            let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();
            guest.write_all(&exit_msg).await.unwrap();

            let mut discard = [0u8; 1];
            let _ = guest.read(&mut discard).await;
        });
    }

    let host = host_from_stream(host_stream).await.unwrap();
    let (pid, stdout_rx) = host
        .spawn_watch("streaming", 0, &[], false, true, None)
        .await
        .unwrap();
    assert_eq!(pid, 555);
    assert_eq!(registration_counts(&host), (0, 0, 1));

    drop(stdout_rx);
    send_chunk.notify_one();

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if registration_counts(&host) == (0, 0, 0) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("dropped stdout receiver should remove stream registration");

    send_exit.notify_one();
    let event = host
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(event.exit_code, 0);
}

#[tokio::test]
async fn test_spawn_watch_cancel_cleans_up_registrations() {
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
            assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);
            request_seen.notify_one();

            release_guest.notified().await;
        });
    }

    let host = Arc::new(host_from_stream(host_stream).await.unwrap());
    let task_host = Arc::clone(&host);
    let task = tokio::spawn(async move {
        task_host
            .spawn_watch("long-running", 0, &[], false, true, None)
            .await
    });

    tokio::time::timeout(Duration::from_secs(5), request_seen.notified())
        .await
        .expect("guest should receive spawn_watch request");
    assert_eq!(registration_counts(&host), (1, 1, 0));

    task.abort();
    let _ = task.await;
    assert_eq!(
        registration_counts(&host),
        (0, 0, 0),
        "aborted spawn_watch future must clean pending registrations",
    );

    release_guest.notify_one();
}

#[tokio::test]
async fn test_spawn_watch_after_close_returns_immediately() {
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

    let start = Instant::now();
    let err = host
        .spawn_watch("long-running", 0, &[], false, false, None)
        .await
        .unwrap_err();
    assert!(
        matches!(
            err.kind(),
            io::ErrorKind::ConnectionReset | io::ErrorKind::BrokenPipe
        ),
        "expected ConnectionReset or BrokenPipe, got {:?}",
        err.kind()
    );
    assert!(
        start.elapsed() < Duration::from_secs(1),
        "spawn_watch should fail immediately, took {:?}",
        start.elapsed()
    );
}

#[tokio::test]
async fn test_wait_for_exit_no_lost_notification() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

        let payload = vsock_proto::encode_spawn_watch_result(88);
        let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();

        let exit_payload = vsock_proto::encode_process_exit(88, 7, b"quick", b"");
        let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();
        guest.write_all(&exit_msg).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let (pid, _stdout_rx) = host
        .spawn_watch("quick-exit", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(pid, 88);

    let event = host
        .wait_for_exit(88, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(event.pid, 88);
    assert_eq!(event.exit_code, 7);
    assert_eq!(event.stdout, b"quick");
}

#[tokio::test]
async fn test_wait_for_exit_connection_closed() {
    let (host_stream, mut guest) = make_pair();
    let (close_tx, close_rx) = oneshot::channel();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

        let payload = vsock_proto::encode_spawn_watch_result(77);
        let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();

        let _ = close_rx.await;
        drop(guest);
    });

    let host = Arc::new(host_from_stream(host_stream).await.unwrap());
    let (pid, _stdout_rx) = host
        .spawn_watch("long-running", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(pid, 77);

    let host_for_wait = Arc::clone(&host);
    let wait_task = tokio::spawn(async move {
        host_for_wait
            .wait_for_exit(77, Duration::from_secs(5))
            .await
    });
    close_tx.send(()).unwrap();

    let err = wait_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn test_wait_for_exit_returns_cached_event_after_close() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);

        let result_payload = vsock_proto::encode_spawn_watch_result(111);
        let result =
            vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &result_payload).unwrap();
        let exit_payload = vsock_proto::encode_process_exit(111, 3, b"cached-output", b"err");
        let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();

        let mut combined = result;
        combined.extend_from_slice(&exit_msg);
        guest.write_all(&combined).await.unwrap();
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let (pid, _stdout_rx) = host
        .spawn_watch("quick-exit", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(pid, 111);

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();

    let event = host
        .wait_for_exit(pid, Duration::from_secs(5))
        .await
        .expect("cached exit event must survive the Connected -> Closed transition");
    assert_eq!(event.pid, 111);
    assert_eq!(event.exit_code, 3);
    assert_eq!(event.stdout, b"cached-output");
    assert_eq!(event.stderr, b"err");
}

#[tokio::test]
async fn test_wait_for_exit_timeout() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        let payload = vsock_proto::encode_spawn_watch_result(55);
        let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, msgs[0].seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let (pid, _stdout_rx) = host
        .spawn_watch("long-running", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(pid, 55);

    let err = host
        .wait_for_exit(pid, Duration::from_millis(100))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
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
        assert_eq!(msgs[0].msg_type, MSG_SPAWN_WATCH);
        let spawn_seq = msgs[0].seq;

        let payload = vsock_proto::encode_spawn_watch_result(50);
        let resp = vsock_proto::encode(MSG_SPAWN_WATCH_RESULT, spawn_seq, &payload).unwrap();
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
        let exit_msg = vsock_proto::encode(MSG_PROCESS_EXIT, 0, &exit_payload).unwrap();
        guest.write_all(&exit_msg).await.unwrap();

        let mut discard = [0u8; 1];
        let _ = guest.read(&mut discard).await;
    });

    let host = Arc::new(host_from_stream(host_stream).await.unwrap());
    let (pid, _stdout_rx) = host
        .spawn_watch("long-running", 0, &[], false, false, None)
        .await
        .unwrap();
    assert_eq!(pid, 50);

    let host2 = Arc::clone(&host);
    let wait_task =
        tokio::spawn(async move { host2.wait_for_exit(50, Duration::from_secs(5)).await });

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
