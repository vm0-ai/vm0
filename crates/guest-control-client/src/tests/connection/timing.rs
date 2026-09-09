use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

use guest_control_proto::{MSG_PING, MSG_PONG, MSG_READY, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;

use super::super::support::MockGuest;
use super::unique_vsock_paths;
use crate::GuestControlClient;

async fn wait_for_listener(path: &Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !path.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn timed_connection_preserves_milestones_and_decoder_handoff() {
    let (base, listener) = unique_vsock_paths("timing");
    let task = tokio::spawn(async move {
        GuestControlClient::wait_for_connection_with_timing(&base, Duration::from_secs(30)).await
    });
    wait_for_listener(&listener).await;
    let connect_released = Instant::now();
    let mut guest = MockGuest::new(UnixStream::connect(&listener).await.unwrap());
    let ready_released = Instant::now();
    guest.send_empty_response(MSG_READY, 0).await;
    let ping = guest.expect_message(MSG_PING).await;
    assert_eq!(ping.seq, 1);
    assert!(!listener.exists());

    guest.send_empty_response(MSG_PONG, 99).await;
    tokio::task::yield_now().await;
    assert!(
        !task.is_finished(),
        "an unrelated PONG cannot finish the handshake"
    );

    // A partial next frame must stay in the handshake decoder until the
    // background reader receives its remainder after the real request.
    let ack = guest_control_proto::encode(MSG_SHUTDOWN_ACK, 2, &[]).unwrap();
    let (prefix, suffix) = ack.split_at(3);
    let mut bytes = guest_control_proto::encode(MSG_PONG, ping.seq, &[]).unwrap();
    bytes.extend_from_slice(prefix);
    let pong_released = Instant::now();
    guest.stream_mut().write_all(&bytes).await.unwrap();
    let (result, timing) = task.await.unwrap();
    let host = result.unwrap();

    let bound = timing.listener_bound.unwrap();
    let accepted = timing.accepted.unwrap();
    let ready = timing.ready.unwrap();
    let written = timing.ping_written.unwrap();
    let pong = timing.pong_received.unwrap();
    assert!(timing.started <= bound);
    assert!(bound <= connect_released);
    assert!(connect_released <= accepted);
    assert!(accepted <= ready);
    assert!(ready_released <= ready);
    assert!(ready <= written && written <= pong);
    assert!(pong_released <= pong && pong <= timing.completed);

    let shutdown = tokio::spawn(async move { host.shutdown(Duration::from_secs(5)).await });
    let request = guest.expect_message(MSG_SHUTDOWN).await;
    assert_eq!(request.seq, 2);
    guest.stream_mut().write_all(suffix).await.unwrap();
    shutdown.await.unwrap().unwrap();
}

#[tokio::test]
async fn timed_connection_retains_eof_phase_without_later_milestones() {
    for after_ready in [false, true] {
        let (base, listener) = unique_vsock_paths("timing-eof");
        let task = tokio::spawn(async move {
            GuestControlClient::wait_for_connection_with_timing(&base, Duration::from_secs(30))
                .await
        });
        wait_for_listener(&listener).await;
        let mut guest = MockGuest::new(UnixStream::connect(&listener).await.unwrap());
        if after_ready {
            guest.send_empty_response(MSG_READY, 0).await;
            guest.expect_message(MSG_PING).await;
        }
        drop(guest);
        let (result, timing) = task.await.unwrap();
        assert_eq!(result.err().unwrap().kind(), io::ErrorKind::ConnectionReset);
        assert!(timing.listener_bound.is_some());
        assert!(timing.accepted.is_some());
        assert_eq!(timing.ready.is_some(), after_ready);
        assert_eq!(timing.ping_written.is_some(), after_ready);
        assert!(timing.pong_received.is_none());
        assert!(timing.completed >= timing.accepted.unwrap());
        assert!(!listener.exists());
    }
}

#[tokio::test(start_paused = true)]
async fn timed_connection_keeps_one_deadline_for_accept_and_handshake() {
    for connect in [false, true] {
        let (base, listener) = unique_vsock_paths("timing-deadline");
        let timeout = Duration::from_secs(10);
        let started = tokio::time::Instant::now();
        let task = tokio::spawn(async move {
            GuestControlClient::wait_for_connection_with_timing(&base, timeout).await
        });
        tokio::task::yield_now().await;
        assert!(listener.exists());
        let mut guest = None;
        if connect {
            tokio::time::advance(Duration::from_secs(4)).await;
            let mut connected = MockGuest::new(UnixStream::connect(&listener).await.unwrap());
            connected.send_empty_response(MSG_READY, 0).await;
            connected.expect_message(MSG_PING).await;
            guest = Some(connected);
        }
        let (result, timing) = task.await.unwrap();
        assert_eq!(result.err().unwrap().kind(), io::ErrorKind::TimedOut);
        assert_eq!(started.elapsed(), timeout);
        // Production milestones use the host clock, not the paused Tokio clock.
        assert!(timing.completed >= timing.started);
        assert!(timing.listener_bound.is_some());
        assert_eq!(timing.accepted.is_some(), connect);
        assert_eq!(timing.ping_written.is_some(), connect);
        assert!(timing.pong_received.is_none());
        assert!(!listener.exists());
        drop(guest);
    }
}

#[tokio::test]
async fn timed_connection_abort_unlinks_listener_and_closes_accepted_stream() {
    for connect in [false, true] {
        let (base, listener) = unique_vsock_paths("timing-abort");
        let task = tokio::spawn(async move {
            GuestControlClient::wait_for_connection_with_timing(&base, Duration::from_secs(30))
                .await
        });
        wait_for_listener(&listener).await;
        let mut guest = None;
        if connect {
            let mut connected = MockGuest::new(UnixStream::connect(&listener).await.unwrap());
            connected.send_empty_response(MSG_READY, 0).await;
            connected.expect_message(MSG_PING).await;
            guest = Some(connected);
        }
        task.abort();
        assert!(task.await.err().unwrap().is_cancelled());
        assert!(!listener.exists());
        if let Some(mut guest) = guest {
            guest.expect_eof().await;
        }
    }
}

#[tokio::test]
async fn timed_connection_setup_failure_does_not_claim_listener_completion() {
    let (base, listener) = unique_vsock_paths("timing-overflow");
    let (result, timing) =
        GuestControlClient::wait_for_connection_with_timing(&base, Duration::MAX).await;
    assert_eq!(result.err().unwrap().kind(), io::ErrorKind::InvalidInput);
    assert!(timing.listener_bound.is_none());
    assert!(timing.accepted.is_none());
    assert!(timing.ready.is_none());
    assert!(timing.ping_written.is_none());
    assert!(timing.pong_received.is_none());
    assert!(timing.completed >= timing.started);
    assert!(!listener.exists());
}
