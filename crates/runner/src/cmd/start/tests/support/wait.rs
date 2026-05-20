use super::super::super::*;
use super::env::MockRunEnv;
use std::future::Future;

use crate::idle_pool::ParkingState;

const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(10);

pub(super) enum WaitProbe<T> {
    Ready(T),
    Pending(String),
}

pub(super) async fn wait_for_probe<T, F, Fut>(timeout: Duration, mut probe: F) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = WaitProbe<T>>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match probe().await {
            WaitProbe::Ready(value) => return value,
            WaitProbe::Pending(message) => {
                assert!(tokio::time::Instant::now() < deadline, "{message}");
                tokio::time::sleep(WAIT_POLL_INTERVAL).await;
            }
        }
    }
}

pub(in super::super) async fn assert_run_exits_within(
    run_handle: tokio::task::JoinHandle<RunnerResult<()>>,
    timeout: Duration,
    timeout_msg: &str,
) {
    match tokio::time::timeout(timeout, run_handle).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(e))) => panic!("run() returned error: {e}"),
        Ok(Err(e)) => panic!("task panicked: {e}"),
        Err(_) => panic!("{timeout_msg}"),
    }
}

/// Poll until `budget.allocated().2` (running_count) reaches `expected`.
///
/// The active budget lease is dropped after `provider.complete()` in the
/// spawned job task, so `wait_completion()` returning does NOT guarantee
/// the budget has been released yet. This helper avoids fixed sleeps as
/// synchronization.
pub(in super::super) async fn wait_budget_count(
    budget: &ResourceBudget,
    expected: usize,
    timeout: Duration,
) {
    wait_for_probe(timeout, || async {
        let actual = budget.allocated().2;
        if actual == expected {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "budget count did not reach {expected} within {timeout:?} (actual: {actual})",
            ))
        }
    })
    .await;
}

pub(in super::super) async fn wait_idle_pool_len(
    pool: &SharedIdlePool,
    expected: usize,
    timeout: Duration,
) {
    wait_for_probe(timeout, || async {
        let actual = pool.lock().await.len();
        if actual == expected {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "idle pool length did not reach {expected} within {timeout:?} (actual: {actual})",
            ))
        }
    })
    .await;
}

pub(in super::super) async fn wait_idle_pool_sessions(
    pool: &SharedIdlePool,
    expected: &[&str],
    timeout: Duration,
) {
    let mut expected: Vec<String> = expected
        .iter()
        .map(|session| (*session).to_string())
        .collect();
    expected.sort_unstable();
    wait_for_probe(timeout, || async {
        let actual = pool.lock().await.held_sessions();
        if actual == expected {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "idle pool sessions did not reach {expected:?} within {timeout:?} (actual: {actual:?})",
            ))
        }
    })
    .await;
}

pub(in super::super) async fn wait_sandbox_lifecycle_counts(
    overrides: &sandbox_mock::MockSandboxOverrides,
    expected_park: u32,
    expected_unpark: u32,
    timeout: Duration,
) {
    wait_for_probe(timeout, || async {
        let actual_park = overrides.park_call_count();
        let actual_unpark = overrides.unpark_call_count();
        if actual_park == expected_park && actual_unpark == expected_unpark {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "sandbox lifecycle counts did not reach park={expected_park} unpark={expected_unpark} within {timeout:?} (actual park={actual_park} unpark={actual_unpark})",
            ))
        }
    })
    .await;
}

/// Poll until the idle pool parking state reaches `expected`.
pub(in super::super) async fn wait_parking_state(
    pool: &SharedIdlePool,
    expected: ParkingState,
    timeout: Duration,
) {
    wait_for_probe(timeout, || async {
        let actual = pool.lock().await.parking_state();
        if actual == expected {
            WaitProbe::Ready(())
        } else {
            WaitProbe::Pending(format!(
                "idle pool parking state did not reach {expected:?} within {timeout:?} (actual: {actual:?})",
            ))
        }
    })
    .await;
}

pub(in super::super) async fn wait_cancel_token(
    tokens: &Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    run_id: RunId,
    timeout: Duration,
) -> CancellationToken {
    wait_for_probe(timeout, || async {
        let token = tokens.lock().await.get(&run_id).cloned();
        if let Some(token) = token {
            WaitProbe::Ready(token)
        } else {
            WaitProbe::Pending(format!(
                "cancel token for {run_id} not found within {timeout:?}",
            ))
        }
    })
    .await
}

pub(in super::super) async fn wait_cancel_token_removed(
    tokens: &Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    run_id: RunId,
    timeout: Duration,
) {
    wait_for_probe(timeout, || async {
        let present = tokens.lock().await.contains_key(&run_id);
        if present {
            WaitProbe::Pending(format!(
                "cancel token for {run_id} still present after {timeout:?}",
            ))
        } else {
            WaitProbe::Ready(())
        }
    })
    .await;
}

pub(in super::super) async fn wait_discover_entered(env: &MockRunEnv, timeout: Duration) {
    assert!(
        env.handle.wait_discover_entered(timeout).await,
        "run() did not enter discover_fut select! within {timeout:?}"
    );
}

pub(in super::super) async fn wait_budget_exhausted_reactor(env: &MockRunEnv, timeout: Duration) {
    env.start_observer
        .wait_budget_exhausted_reactor(timeout)
        .await;
}

pub(in super::super) async fn wait_idle_cleanup_processed_with_expired_entries(
    env: &MockRunEnv,
    timeout: Duration,
) -> usize {
    env.start_observer
        .wait_idle_cleanup_processed_with_expired_entries(timeout)
        .await
}
