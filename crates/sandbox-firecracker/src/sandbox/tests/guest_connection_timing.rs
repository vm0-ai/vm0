use std::time::{Duration, Instant};

use guest_control_client::GuestControlClient;
use guest_control_proto::{MSG_PONG, MSG_READY};
use sandbox::{SandboxGuestConnectionPhase, SandboxStartObserver, SandboxStartStage};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use super::super::guest_connection_timing::record_guest_connection_timing;

#[derive(Default)]
struct Observer {
    phases: Vec<(SandboxGuestConnectionPhase, Duration, Duration, bool)>,
}

impl SandboxStartObserver for Observer {
    fn record_stage(&mut self, _: SandboxStartStage, _: Duration, _: bool) {}

    fn record_guest_connection_phase(
        &mut self,
        phase: SandboxGuestConnectionPhase,
        duration: Duration,
        remaining: Duration,
        success: bool,
    ) {
        self.phases.push((phase, duration, remaining, success));
    }
}

#[tokio::test]
async fn real_connection_timeline_partitions_full_and_remaining_waits() {
    // Each timeline is produced by the public client against a real socket;
    // no hand-constructed milestone record or scheduling-duration assertion.
    for remaining_point in 0..3 {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("guest").display().to_string();
        let socket = format!("{base}_{}", guest_control_proto::VSOCK_PORT);
        let submitted = Instant::now();
        let task = tokio::spawn(async move {
            GuestControlClient::wait_for_connection_with_timing(&base, Duration::from_secs(30))
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while !std::path::Path::new(&socket).exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let before_connect = Instant::now();
        let mut guest = UnixStream::connect(&socket).await.unwrap();
        guest
            .write_all(&guest_control_proto::encode(MSG_READY, 0, &[]).unwrap())
            .await
            .unwrap();
        let ping = guest_control_proto::encode(guest_control_proto::MSG_PING, 1, &[]).unwrap();
        let mut received = vec![0; ping.len()];
        guest.read_exact(&mut received).await.unwrap();
        assert_eq!(received, ping);
        let before_pong = Instant::now();
        guest
            .write_all(&guest_control_proto::encode(MSG_PONG, 1, &[]).unwrap())
            .await
            .unwrap();
        let (result, timing) = task.await.unwrap();
        let client = result.unwrap();
        let remaining_started = match remaining_point {
            0 => before_connect,
            1 => before_pong,
            _ => Instant::now(),
        };
        let observed = Instant::now();
        let mut observer = Observer::default();
        record_guest_connection_timing(
            &mut observer,
            timing,
            submitted,
            remaining_started,
            observed,
        );
        assert_eq!(observer.phases.len(), 8);
        assert_eq!(
            observer
                .phases
                .iter()
                .map(|record| record.0)
                .collect::<Vec<_>>(),
            SandboxGuestConnectionPhase::ALL
        );
        assert!(
            observer
                .phases
                .iter()
                .all(|(_, full, remaining, success)| *success && remaining <= full)
        );
        assert_eq!(
            observer
                .phases
                .iter()
                .map(|record| record.1)
                .sum::<Duration>(),
            observed.duration_since(submitted)
        );
        assert_eq!(
            observer
                .phases
                .iter()
                .map(|record| record.2)
                .sum::<Duration>(),
            observed.duration_since(remaining_started)
        );
        if remaining_point == 2 {
            for (phase, _, remaining, _) in &observer.phases {
                if *phase != SandboxGuestConnectionPhase::TaskHandoff {
                    assert_eq!(
                        *remaining,
                        Duration::ZERO,
                        "{phase:?} completed before the parent wait"
                    );
                }
            }
        }
        drop(client);
        let mut eof = [0];
        assert_eq!(guest.read(&mut eof).await.unwrap(), 0);
    }
}

#[tokio::test]
async fn real_connection_eof_records_failed_phase_and_successful_error_handoff() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("guest").display().to_string();
    let socket = format!("{base}_{}", guest_control_proto::VSOCK_PORT);
    let submitted = Instant::now();
    let task = tokio::spawn(async move {
        GuestControlClient::wait_for_connection_with_timing(&base, Duration::from_secs(30)).await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !std::path::Path::new(&socket).exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let guest = UnixStream::connect(&socket).await.unwrap();
    drop(guest);
    let (result, timing) = task.await.unwrap();
    assert_eq!(
        result.err().unwrap().kind(),
        std::io::ErrorKind::ConnectionReset
    );
    let observed = Instant::now();
    let mut observer = Observer::default();
    record_guest_connection_timing(&mut observer, timing, submitted, submitted, observed);
    let phases: Vec<_> = observer
        .phases
        .iter()
        .map(|record| (record.0, record.3))
        .collect();
    assert_eq!(
        phases,
        vec![
            (SandboxGuestConnectionPhase::TaskSchedule, true),
            (SandboxGuestConnectionPhase::ListenerSetup, true),
            (SandboxGuestConnectionPhase::Accept, true),
            (SandboxGuestConnectionPhase::Ready, false),
            (SandboxGuestConnectionPhase::TaskHandoff, true),
        ]
    );
    assert!(observer.phases.iter().all(|record| record.1 == record.2));
    assert_eq!(
        observer
            .phases
            .iter()
            .map(|record| record.2)
            .sum::<Duration>(),
        observed.duration_since(submitted)
    );
    assert!(!std::path::Path::new(&socket).exists());
}
