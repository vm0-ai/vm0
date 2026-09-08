use std::sync::atomic::{AtomicBool, Ordering};

use super::*;

#[tokio::test]
async fn guest_dns_readiness_observes_terminal_results_and_attempt_exhaustion() {
    use GuestDnsReadinessTermination as Termination;
    use SandboxDnsReadinessOutcome as Outcome;

    for (termination, answer, truncated, outcome, attempts) in [
        (
            Termination::Exited { exit_code: 0 },
            "192.0.2.1 STREAM\n",
            false,
            Outcome::Success,
            1,
        ),
        (Termination::StartFailed, "", false, Outcome::StartFailed, 1),
        (Termination::WaitFailed, "", false, Outcome::WaitFailed, 1),
        (
            Termination::Cancelled,
            "",
            false,
            Outcome::ProcessCancelled,
            1,
        ),
        (
            Termination::Exited { exit_code: 1 },
            "",
            false,
            Outcome::ExitNonZero,
            1,
        ),
        (
            Termination::Exited { exit_code: 0 },
            "203.0.113.1 STREAM\n",
            false,
            Outcome::UnexpectedAnswer,
            3,
        ),
        (
            Termination::Exited { exit_code: 0 },
            "192.0.2.1 STREAM\n",
            true,
            Outcome::OutputTruncated,
            1,
        ),
    ] {
        let (host, mut guest) = setup_host_and_guest().await;
        let mut observer = RecordingObserver::default();
        let started = Instant::now();
        let (result, ()) = tokio::join!(
            wait_for_guest_dns_readiness_with_policy(&host, TEST_POLICY, &mut observer),
            async {
                for _ in 0..attempts {
                    let request = read_message(&mut guest).await;
                    assert_readiness_request(&request);
                    send_result(
                        &mut guest,
                        &request,
                        termination,
                        answer.as_bytes(),
                        truncated,
                    )
                    .await;
                }
            },
        );
        assert_eq!(result.is_ok(), outcome == Outcome::Success);
        assert_eq!(observer.attempts.len(), attempts);
        for (index, record) in observer.attempts.iter().enumerate() {
            assert_eq!(record.attempt, index as u16 + 1);
            assert_eq!(record.final_attempt, index + 1 == attempts);
            assert_eq!(record.outcome, outcome);
            assert_eq!(record.guest_duration_ms, Some(1));
        }
        let child_total: Duration = observer.attempts.iter().map(|record| record.duration).sum();
        assert!(child_total <= started.elapsed());
        assert!(host.try_fence_normal_operations().is_ok());
    }
}

#[tokio::test]
async fn guest_dns_readiness_replays_failed_and_successful_attempts_only_after_retry_finishes() {
    struct DeferredObserver {
        ready: Arc<AtomicBool>,
        inner: RecordingObserver,
    }
    impl SandboxStartObserver for DeferredObserver {
        fn record_stage(&mut self, _: sandbox::SandboxStartStage, _: Duration, _: bool) {
            panic!("attempt observations must not synthesize a parent stage");
        }

        fn record_dns_readiness_attempt(&mut self, attempt: SandboxDnsReadinessAttempt) {
            assert!(
                self.ready.load(Ordering::Acquire),
                "observer ran between retries"
            );
            self.inner.record_dns_readiness_attempt(attempt);
        }
    }

    let (host, mut guest) = setup_host_and_guest().await;
    let ready = Arc::new(AtomicBool::new(false));
    let mut observer = DeferredObserver {
        ready: Arc::clone(&ready),
        inner: RecordingObserver::default(),
    };
    let (result, ()) = tokio::join!(
        wait_for_guest_dns_readiness_with_policy(&host, TEST_POLICY, &mut observer),
        async {
            let first = read_message(&mut guest).await;
            send_result(
                &mut guest,
                &first,
                GuestDnsReadinessTermination::Exited { exit_code: 2 },
                b"",
                false,
            )
            .await;
            let second = read_message(&mut guest).await;
            ready.store(true, Ordering::Release);
            send_result(
                &mut guest,
                &second,
                GuestDnsReadinessTermination::Exited { exit_code: 0 },
                b"192.0.2.1 DGRAM\n",
                false,
            )
            .await;
        },
    );
    result.unwrap();
    let records = observer.inner.attempts;
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].outcome, SandboxDnsReadinessOutcome::ExitNonZero);
    assert!(!records[0].final_attempt);
    assert_eq!(records[1].outcome, SandboxDnsReadinessOutcome::Success);
    assert!(records[1].final_attempt);
    assert_eq!(records[1].attempt, 2);
    assert!(
        records
            .iter()
            .all(|record| record.guest_duration_ms == Some(1))
    );
}

#[tokio::test]
async fn guest_dns_readiness_cancellation_retains_prefix_without_reopening_connection() {
    let (host, mut guest) = setup_host_and_guest().await;
    let mut observer = RecordingObserver::default();
    let mut readiness = Box::pin(wait_for_guest_dns_readiness_with_policy(
        &host,
        TEST_POLICY,
        &mut observer,
    ));
    tokio::select! {
        result = &mut readiness => panic!("readiness finished before cancellation: {result:?}"),
        () = async {
            let first = read_message(&mut guest).await;
            send_result(&mut guest, &first, GuestDnsReadinessTermination::TimedOut, b"", false).await;
            let second = read_message(&mut guest).await;
            assert_readiness_request(&second);
        } => {}
    }
    drop(readiness);
    assert_eq!(observer.attempts.len(), 2);
    assert_eq!(
        observer.attempts[0].outcome,
        SandboxDnsReadinessOutcome::ProcessTimeout
    );
    assert_eq!(observer.attempts[0].guest_duration_ms, Some(1));
    assert!(!observer.attempts[0].final_attempt);
    assert_eq!(
        observer.attempts[1].outcome,
        SandboxDnsReadinessOutcome::HostCancelled
    );
    assert_eq!(observer.attempts[1].guest_duration_ms, None);
    assert_eq!(observer.attempts[1].attempt, 2);
    assert!(observer.attempts[1].final_attempt);
    assert!(host.try_fence_normal_operations().is_err());
}

#[tokio::test]
async fn guest_dns_readiness_deadline_has_no_guest_measurement_and_retains_fencing() {
    let (host, mut guest) = setup_host_and_guest().await;
    let mut observer = RecordingObserver::default();
    let policy = ReadinessPolicy {
        total_timeout: Duration::from_millis(50),
        attempt_timeout: Duration::from_millis(50),
        max_attempts: 3,
    };
    tokio::time::pause();
    let (result, request) = tokio::join!(
        wait_for_guest_dns_readiness_with_policy(&host, policy, &mut observer),
        read_message(&mut guest),
    );
    assert_readiness_request(&request);
    assert_eq!(
        result.unwrap_err().last_failure,
        GuestDnsReadinessFailure::Deadline
    );
    assert_eq!(observer.attempts.len(), 1);
    assert_eq!(
        observer.attempts[0].outcome,
        SandboxDnsReadinessOutcome::Deadline
    );
    assert_eq!(observer.attempts[0].guest_duration_ms, None);
    assert!(observer.attempts[0].final_attempt);
    assert!(host.try_fence_normal_operations().is_err());
}
