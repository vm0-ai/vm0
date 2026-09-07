use std::time::Duration;

use tokio::sync::watch;
use tracing::{info, warn};

use crate::api::ApiClient;
use crate::sandbox::SandboxState;

/// Target guest memory headroom in MiB.
/// Inflate compares `free_memory` against this target, while deflate compares
/// `available_memory` against it.
const TARGET_FREE_MIB: i64 = 256;
/// Inflate only when `free_memory` (`MemFree`) exceeds target by this much
/// (MiB).
/// Larger than deflate hysteresis — we're less aggressive reclaiming memory
/// than returning it, because guest memory pressure is more urgent.
const INFLATE_HYSTERESIS_MIB: i64 = 128;
/// Deflate when `available_memory` (`MemAvailable`) drops below target by this
/// much (MiB).
/// Smaller than inflate hysteresis — respond faster to guest memory pressure.
/// Crossing this boundary releases the entire active balloon target so Guest
/// control liveness does not depend on the amount previously reclaimed.
const DEFLATE_HYSTERESIS_MIB: i64 = 64;
/// Guest available-memory pressure boundary used by both the continuous
/// controller and one-shot idle park inflation.
pub(crate) const PRESSURE_AVAILABLE_MIB: i64 = TARGET_FREE_MIB - DEFLATE_HYSTERESIS_MIB;
/// Maximum MiB to inflate in a single tick.
/// Caps the per-tick increase to prevent sudden memory pressure spikes in the
/// guest when a large amount of free memory is detected on the first tick.
const MAX_INFLATE_PER_TICK_MIB: u32 = 256;
/// Minimum supported guest memory — never inflate beyond
/// `memory_mb - MIN_GUEST_MIB`.
///
/// Exposed to the rest of the crate so that idle-park logic in `sandbox.rs`
/// can use the same lower bound when one-shot inflating on idle transitions.
pub(crate) const MIN_GUEST_MIB: u32 = guest_contracts::process_containment::MIN_PROFILE_MEMORY_MB;
/// Poll interval for balloon stats.
const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// Fast-start polling while a post-unpark controller protects the lifecycle's
/// target-zero deflation from reactive policy. The cumulative 975 ms window
/// covers the observed approximately 0.79-second deflation before normal
/// polling resumes.
const UNPARK_DEFLATE_FAST_POLL_INTERVALS: [Duration; 8] = [
    Duration::from_millis(25),
    Duration::from_millis(50),
    Duration::from_millis(100),
    Duration::from_millis(100),
    Duration::from_millis(100),
    Duration::from_millis(200),
    Duration::from_millis(200),
    Duration::from_millis(200),
];
/// How often to emit balloon status logs (in ticks).
/// 12 ticks × 5s = 60s.
const STATUS_INTERVAL_TICKS: u64 = 12;

pub(crate) struct ControllerHandle {
    task: Option<tokio::task::JoinHandle<()>>,
}

enum ControllerStartup {
    Active,
    AwaitUnparkDeflation { log_id: String },
}

impl ControllerHandle {
    fn spawn(
        client: ApiClient,
        memory_mb: u32,
        state_rx: watch::Receiver<SandboxState>,
        startup: ControllerStartup,
    ) -> Self {
        Self {
            task: Some(tokio::spawn(run_loop(client, memory_mb, state_rx, startup))),
        }
    }

    pub(crate) fn abort(mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }

    pub(crate) async fn abort_and_join(mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
    }

    #[cfg(test)]
    pub(crate) fn from_task_for_test(task: tokio::task::JoinHandle<()>) -> Self {
        Self { task: Some(task) }
    }

    #[cfg(test)]
    pub(crate) fn id(&self) -> tokio::task::Id {
        self.task
            .as_ref()
            .expect("controller handle task must be present")
            .id()
    }

    #[cfg(test)]
    pub(crate) async fn wait_for_test(mut self) -> Result<(), tokio::task::JoinError> {
        self.task
            .take()
            .expect("controller handle task must be present")
            .await
    }
}

impl Drop for ControllerHandle {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Spawn the balloon controller loop.
pub(crate) fn spawn(
    client: ApiClient,
    memory_mb: u32,
    state_rx: watch::Receiver<SandboxState>,
) -> ControllerHandle {
    ControllerHandle::spawn(client, memory_mb, state_rx, ControllerStartup::Active)
}

/// Spawn the controller after unpark without putting physical balloon
/// deflation on the run-start critical path.
///
/// The task observes exact target-zero convergence in the background before
/// entering normal reactive policy, so contradictory statistics from the
/// in-flight lifecycle transition cannot reverse the deflation request.
pub(crate) fn spawn_after_unpark_deflation(
    client: ApiClient,
    memory_mb: u32,
    state_rx: watch::Receiver<SandboxState>,
    log_id: String,
) -> ControllerHandle {
    ControllerHandle::spawn(
        client,
        memory_mb,
        state_rx,
        ControllerStartup::AwaitUnparkDeflation { log_id },
    )
}

async fn run_loop(
    client: ApiClient,
    memory_mb: u32,
    mut state_rx: watch::Receiver<SandboxState>,
    startup: ControllerStartup,
) {
    let max_inflate = memory_mb.saturating_sub(MIN_GUEST_MIB);
    if max_inflate == 0 {
        info!(
            memory_mb,
            MIN_GUEST_MIB, "balloon controller disabled: memory_mb <= MIN_GUEST_MIB"
        );
        return;
    }
    if let ControllerStartup::AwaitUnparkDeflation { log_id } = startup
        && !wait_for_unpark_deflation(&client, &mut state_rx, &log_id).await
    {
        return;
    }
    let mut interval = tokio::time::interval(POLL_INTERVAL);
    let mut tick_count: u64 = 0;

    loop {
        tokio::select! {
            _ = interval.tick() => {
                tick(&client, max_inflate, tick_count).await;
                tick_count += 1;
            }
            _ = wait_for_crash_or_stop(&mut state_rx) => {
                return;
            }
        }
    }
}

async fn wait_for_unpark_deflation(
    client: &ApiClient,
    state_rx: &mut watch::Receiver<SandboxState>,
    log_id: &str,
) -> bool {
    let started_at = tokio::time::Instant::now();
    let mut sample_count = 0_u32;
    let mut fast_poll_intervals = UNPARK_DEFLATE_FAST_POLL_INTERVALS.into_iter();

    loop {
        let stats = tokio::select! {
            stats = client.get_balloon_statistics() => stats,
            () = wait_for_crash_or_stop(state_rx) => return false,
        };
        let poll_interval = match stats {
            Ok(stats) => {
                sample_count = sample_count.saturating_add(1);
                if stats.target_mib == 0 && stats.actual_mib == 0 {
                    info!(
                        id = %log_id,
                        target_mib = stats.target_mib,
                        actual_mib = stats.actual_mib,
                        elapsed_ms = started_at.elapsed().as_millis(),
                        sample_count,
                        "balloon deflation completed after unpark"
                    );
                    return true;
                }
                fast_poll_intervals.next().unwrap_or(POLL_INTERVAL)
            }
            Err(error) => {
                warn!(
                    id = %log_id,
                    %error,
                    "balloon deflation status unavailable after unpark"
                );
                POLL_INTERVAL
            }
        };

        tokio::select! {
            () = tokio::time::sleep(poll_interval) => {}
            () = wait_for_crash_or_stop(state_rx) => return false,
        }
    }
}

async fn wait_for_crash_or_stop(state_rx: &mut watch::Receiver<SandboxState>) {
    loop {
        if matches!(
            *state_rx.borrow_and_update(),
            SandboxState::Crashed | SandboxState::Stopped
        ) {
            return;
        }
        if state_rx.changed().await.is_err() {
            return;
        }
    }
}

/// Single tick of the balloon controller.
///
/// Uses two different memory metrics for inflate vs deflate decisions:
///
/// - **Inflate** uses `free_memory` (kernel `MemFree`) — only truly unused pages,
///   excluding reclaimable page cache. This prevents the balloon from evicting
///   file cache that improves guest I/O performance.
/// - **Deflate** uses `available_memory` (kernel `MemAvailable`) — includes
///   reclaimable cache, providing a more sensitive signal for memory pressure.
///   When apps allocate memory, the kernel reclaims cache first, so `available`
///   drops before `free` does, giving earlier deflate response.
///
/// Thresholds:
/// - Inflate when `free_memory > TARGET_FREE + INFLATE_HYSTERESIS`
/// - Deflate when `available_memory < TARGET_FREE - DEFLATE_HYSTERESIS`
/// - No action in between to prevent oscillation
async fn tick(client: &ApiClient, max_inflate: u32, tick_count: u64) {
    let stats = match client.get_balloon_statistics().await {
        Ok(s) => s,
        Err(e) => {
            warn!(error = %e, "balloon stats fetch failed");
            return;
        }
    };

    let current = stats.actual_mib;
    let free_mib = stats.free_memory.map(|b| b / (1024 * 1024));
    let available_mib = stats.available_memory.map(|b| b / (1024 * 1024));

    // Periodic status snapshot
    if tick_count.is_multiple_of(STATUS_INTERVAL_TICKS) {
        info!(
            actual_mib = current,
            free_mib = ?free_mib,
            available_mib = ?available_mib,
            max_inflate,
            "balloon status"
        );
    }

    // Derive feedback candidates from the actual size, then merge them with
    // the requested target in the selected direction. This preserves a more
    // aggressive in-flight request without stacking target-relative steps.

    // Inflate decision: use free_memory (excludes reclaimable cache)
    if let Some(free_mib) = free_mib
        && free_mib > TARGET_FREE_MIB + INFLATE_HYSTERESIS_MIB
    {
        let reclaim = (free_mib - TARGET_FREE_MIB) as u32;
        let reclaim = reclaim.min(MAX_INFLATE_PER_TICK_MIB);
        let candidate_target = current.saturating_add(reclaim).min(max_inflate);
        let new_target = stats.target_mib.max(candidate_target);
        if new_target > stats.target_mib {
            info!(current, new_target, free_mib, "balloon inflate");
            if let Err(e) = client.patch_balloon(new_target).await {
                warn!(error = %e, "balloon inflate failed");
            }
        }
        return;
    }

    // Deflate decision: use available_memory (includes reclaimable cache).
    //
    // Inflation is deliberately gradual to avoid creating pressure, but
    // pressure relief must not depend on physical convergence before the
    // controller can request more. An actual-relative partial target can stay
    // pinned when Firecracker's actual size stalls, retaining most of the
    // balloon while control work competes with workload reclaim. Request the
    // full active allocation back in one policy action; Firecracker still owns
    // the physical deflation progress.
    if let Some(available_mib) = available_mib
        && available_mib < PRESSURE_AVAILABLE_MIB
    {
        let new_target = 0;
        if stats.target_mib != new_target {
            info!(current, new_target, available_mib, "balloon deflate");
            if let Err(e) = client.patch_balloon(new_target).await {
                warn!(error = %e, "balloon deflate failed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::PathBuf;

    use crate::api::test_support::{MockFirecrackerApi, MockRequest, MockResponse};

    const LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(1);

    struct DropNotify(Option<tokio::sync::oneshot::Sender<()>>);

    impl Drop for DropNotify {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }

    async fn await_task_exit(handle: tokio::task::JoinHandle<()>, context: &str) {
        let result = tokio::time::timeout(LIFECYCLE_TIMEOUT, handle)
            .await
            .unwrap_or_else(|_| panic!("{context} did not exit within {LIFECYCLE_TIMEOUT:?}"));
        result.unwrap_or_else(|e| panic!("{context} task failed: {e}"));
    }

    async fn await_controller_exit(handle: ControllerHandle, context: &str) {
        let result = tokio::time::timeout(LIFECYCLE_TIMEOUT, handle.wait_for_test())
            .await
            .unwrap_or_else(|_| panic!("{context} did not exit within {LIFECYCLE_TIMEOUT:?}"));
        result.unwrap_or_else(|e| panic!("{context} task failed: {e}"));
    }

    async fn await_wait_for_crash_or_stop(
        mut state_rx: watch::Receiver<SandboxState>,
        context: &str,
    ) {
        tokio::time::timeout(LIFECYCLE_TIMEOUT, wait_for_crash_or_stop(&mut state_rx))
            .await
            .unwrap_or_else(|_| panic!("{context} did not exit within {LIFECYCLE_TIMEOUT:?}"));
    }

    fn missing_api_sock_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("missing-api.sock");
        (dir, sock_path)
    }

    /// Run one tick against a mock Firecracker API and return the PATCH body if
    /// the tick issued one.
    async fn run_tick_with_mock(stats_json: &str, max_inflate: u32) -> Option<String> {
        run_tick_with_mock_at(stats_json, max_inflate, 0).await
    }

    fn assert_firecracker_request(request: &MockRequest, method: &str, path: &str) {
        assert_eq!(request.method, method, "raw request: {}", request.raw);
        assert_eq!(request.path, path, "raw request: {}", request.raw);
    }

    async fn run_tick_with_mock_at(
        stats_json: &str,
        max_inflate: u32,
        tick_count: u64,
    ) -> Option<String> {
        let mut api = MockFirecrackerApi::with_responses([
            MockResponse::ok_body(stats_json),
            MockResponse::no_content(),
        ]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path).unwrap();
        tick(&client, max_inflate, tick_count).await;

        let requests = api.drain_requests();
        assert!(
            (1..=2).contains(&requests.len()),
            "expected GET stats and optional PATCH, got {requests:#?}"
        );
        assert_firecracker_request(&requests[0], "GET", "/balloon/statistics");

        requests.get(1).map(|request| {
            assert_firecracker_request(request, "PATCH", "/balloon");
            request.body.clone()
        })
    }

    fn patch_amount_mib(body: &str) -> u64 {
        let parsed: serde_json::Value =
            serde_json::from_str(body).unwrap_or_else(|e| panic!("parse PATCH body {body:?}: {e}"));
        parsed["amount_mib"]
            .as_u64()
            .unwrap_or_else(|| panic!("PATCH body missing numeric amount_mib: {body}"))
    }

    #[tokio::test]
    async fn controller_handle_drop_aborts_task() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel();
        let handle = ControllerHandle::from_task_for_test(tokio::spawn(async move {
            let _notify = DropNotify(Some(dropped_tx));
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        }));

        tokio::time::timeout(LIFECYCLE_TIMEOUT, started_rx)
            .await
            .expect("controller task should start")
            .expect("controller task start notification should be sent");
        drop(handle);

        tokio::time::timeout(LIFECYCLE_TIMEOUT, dropped_rx)
            .await
            .expect("controller task should be aborted when handle is dropped")
            .expect("controller task drop notification should be sent");
    }

    #[tokio::test]
    async fn wait_for_crash_or_stop_returns_on_stopped() {
        let (state_tx, state_rx) = watch::channel(SandboxState::Running);
        state_tx.send(SandboxState::Stopped).unwrap();

        await_wait_for_crash_or_stop(state_rx, "stopped waiter").await;
    }

    #[tokio::test]
    async fn wait_for_crash_or_stop_returns_on_crashed() {
        let (state_tx, state_rx) = watch::channel(SandboxState::Running);
        state_tx.send(SandboxState::Crashed).unwrap();

        await_wait_for_crash_or_stop(state_rx, "crashed waiter").await;
    }

    #[tokio::test]
    async fn wait_for_crash_or_stop_returns_when_sender_dropped() {
        let (state_tx, state_rx) = watch::channel(SandboxState::Running);
        drop(state_tx);

        await_wait_for_crash_or_stop(state_rx, "closed-channel waiter").await;
    }

    #[tokio::test]
    async fn wait_for_crash_or_stop_ignores_intermediate_states() {
        let (state_tx, mut state_rx) = watch::channel(SandboxState::Created);
        let handle = tokio::spawn(async move {
            wait_for_crash_or_stop(&mut state_rx).await;
        });

        tokio::task::yield_now().await;
        assert!(
            !handle.is_finished(),
            "Created should not stop the balloon controller"
        );

        state_tx.send(SandboxState::Running).unwrap();
        tokio::task::yield_now().await;
        assert!(
            !handle.is_finished(),
            "Running should not stop the balloon controller"
        );

        state_tx.send(SandboxState::Stopping).unwrap();
        tokio::task::yield_now().await;
        assert!(
            !handle.is_finished(),
            "Stopping should not stop the balloon controller"
        );

        state_tx.send(SandboxState::Stopped).unwrap();
        await_task_exit(handle, "intermediate-state waiter").await;
    }

    #[tokio::test]
    async fn spawn_exits_immediately_when_memory_at_or_below_min_guest() {
        for memory_mb in [MIN_GUEST_MIB, MIN_GUEST_MIB - 1] {
            let (_dir, sock_path) = missing_api_sock_path();
            let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
            let context = format!("small-memory balloon controller ({memory_mb} MiB)");
            let client = ApiClient::new(&sock_path).unwrap();

            await_controller_exit(spawn(client, memory_mb, state_rx), &context).await;
        }
    }

    async fn assert_spawn_exits_on_state(state: SandboxState) {
        let (_dir, sock_path) = missing_api_sock_path();
        let (state_tx, state_rx) = watch::channel(SandboxState::Running);
        let client = ApiClient::new(&sock_path).unwrap();
        let handle = spawn(client, MIN_GUEST_MIB + 1, state_rx);

        state_tx.send(state).unwrap();
        let context = format!("balloon controller after {state:?}");
        await_controller_exit(handle, &context).await;
    }

    #[tokio::test]
    async fn spawn_exits_when_state_stopped() {
        assert_spawn_exits_on_state(SandboxState::Stopped).await;
    }

    #[tokio::test]
    async fn spawn_exits_when_state_crashed() {
        assert_spawn_exits_on_state(SandboxState::Crashed).await;
    }

    #[tokio::test(start_paused = true)]
    async fn unpark_deflation_guard_retries_statistics_errors_without_patching() {
        let mut api = MockFirecrackerApi::with_responses([
            MockResponse::bad_request_fault("statistics unavailable"),
            MockResponse::ok_body(
                r#"{"target_mib":0,"actual_mib":0,"target_pages":0,"actual_pages":0}"#,
            ),
        ]);
        let client = ApiClient::new(api.socket_path()).unwrap();
        let (_state_tx, mut state_rx) = watch::channel(SandboxState::Running);
        let guard = tokio::spawn(async move {
            wait_for_unpark_deflation(&client, &mut state_rx, "test-unpark-retry").await
        });

        let first_request = api.next_request().await;
        assert_firecracker_request(&first_request, "GET", "/balloon/statistics");
        tokio::task::yield_now().await;
        tokio::time::advance(POLL_INTERVAL).await;

        let second_request = api.next_request().await;
        assert_firecracker_request(&second_request, "GET", "/balloon/statistics");
        assert!(
            guard.await.unwrap(),
            "exact deflation should release the guard"
        );
        assert!(
            api.drain_requests().is_empty(),
            "the startup guard must never patch balloon policy"
        );
    }

    #[tokio::test]
    async fn controller_after_unpark_deflation_exits_when_sandbox_stops() {
        let (mut api, _bind_tx) = MockFirecrackerApi::deferred_repeating(
            MockResponse::internal_error_raw("unused response"),
        );
        let client = ApiClient::new(api.socket_path()).unwrap();
        let (state_tx, state_rx) = watch::channel(SandboxState::Running);
        let controller = spawn_after_unpark_deflation(
            client,
            MIN_GUEST_MIB + 1,
            state_rx,
            "test-unpark-stop".into(),
        );

        tokio::task::yield_now().await;
        state_tx.send(SandboxState::Stopped).unwrap();

        await_controller_exit(controller, "post-unpark controller after stop").await;
        assert!(
            api.drain_requests().is_empty(),
            "cancellation must not issue a policy request"
        );
    }

    #[tokio::test]
    async fn tick_inflates_on_high_free_memory() {
        // free_memory = 1 GiB (1024 MiB), well above inflate threshold (384 MiB).
        // Uncapped reclaim would be 1024 - 256 = 768, but per-tick cap limits to 256.
        // available_memory is high too but inflate decision uses free_memory.
        let stats = r#"{"target_mib":0,"actual_mib":0,"target_pages":0,"actual_pages":0,"free_memory":1073741824,"available_memory":1073741824}"#;
        let patch = run_tick_with_mock(stats, 1536).await;
        assert!(patch.is_some(), "expected PATCH call for inflate");
        let body = patch.unwrap();
        let amount = patch_amount_mib(&body);
        assert_eq!(
            amount, 256,
            "expected per-tick cap of {MAX_INFLATE_PER_TICK_MIB}, got {amount}"
        );
    }

    #[tokio::test]
    async fn tick_keeps_more_aggressive_pending_inflate_target() {
        // The guest has only reached 500 MiB of a 1000 MiB target. The
        // actual-relative candidate is 756 MiB, so the existing target should
        // remain in flight without a redundant PATCH.
        let stats = r#"{"target_mib":1000,"actual_mib":500,"target_pages":256000,"actual_pages":128000,"free_memory":1073741824,"available_memory":1073741824}"#;
        let patch = run_tick_with_mock(stats, 1536).await;
        assert!(
            patch.is_none(),
            "should preserve a more aggressive pending inflate target"
        );
    }

    #[tokio::test]
    async fn tick_advances_pending_inflate_to_more_aggressive_candidate() {
        // The 700 MiB target is ahead of actual but behind the 756 MiB
        // actual-relative candidate, so the controller should advance it.
        let stats = r#"{"target_mib":700,"actual_mib":500,"target_pages":179200,"actual_pages":128000,"free_memory":1073741824,"available_memory":1073741824}"#;
        let patch = run_tick_with_mock(stats, 1536)
            .await
            .expect("expected PATCH advancing pending inflation");
        assert_eq!(patch_amount_mib(&patch), 756);
    }

    #[tokio::test]
    async fn tick_reverses_pending_deflate_on_high_free_memory() {
        // A target below actual means deflation is in flight. A new inflate
        // signal should cross the actual size immediately: 500 + 256 = 756.
        let stats = r#"{"target_mib":0,"actual_mib":500,"target_pages":0,"actual_pages":128000,"free_memory":1073741824,"available_memory":1073741824}"#;
        let patch = run_tick_with_mock(stats, 1536)
            .await
            .expect("expected PATCH reversing pending deflation");
        assert_eq!(patch_amount_mib(&patch), 756);
    }

    #[tokio::test]
    async fn tick_no_inflate_when_free_low_but_available_high() {
        // Simulates guest with lots of page cache:
        // free_memory = 200 MiB (below inflate threshold 384), available = 600 MiB.
        // Should NOT inflate — free memory is in hysteresis band.
        let stats = r#"{"target_mib":0,"actual_mib":0,"target_pages":0,"actual_pages":0,"free_memory":209715200,"available_memory":629145600}"#;
        let patch = run_tick_with_mock(stats, 1536).await;
        assert!(
            patch.is_none(),
            "should not inflate when free_memory is low despite high available_memory"
        );
    }

    #[tokio::test]
    async fn tick_releases_full_balloon_on_low_available_memory() {
        // available_memory = 128 MiB, below deflate threshold (192 MiB).
        // free_memory = 50 MiB (also low, no inflate).
        let stats = r#"{"target_mib":512,"actual_mib":512,"target_pages":131072,"actual_pages":131072,"free_memory":52428800,"available_memory":134217728}"#;
        let patch = run_tick_with_mock(stats, 1536).await;
        assert!(patch.is_some(), "expected PATCH call for deflate");
        let body = patch.unwrap();
        let amount = patch_amount_mib(&body);
        assert_eq!(
            amount, 0,
            "expected full pressure relief for 128 MiB available memory, got {amount}"
        );
    }

    #[tokio::test]
    async fn tick_releases_high_retention_near_pressure_boundary() {
        // A 4-GiB Guest can retain 3072 MiB. Just below the 192-MiB pressure
        // boundary, the retired policy requested only partial relief. When
        // physical actual stalled behind that pending target, its
        // actual-relative candidate could not continue toward zero.
        let stats = r#"{"target_mib":3072,"actual_mib":3072,"target_pages":786432,"actual_pages":786432,"free_memory":52428800,"available_memory":200278016}"#;
        let patch = run_tick_with_mock(stats, 3072)
            .await
            .expect("expected PATCH releasing high balloon retention");
        assert_eq!(patch_amount_mib(&patch), 0);
    }

    #[tokio::test]
    async fn tick_preserves_pending_unpark_deflate_target() {
        // Unpark has requested target 0, but the guest still reports 1250 MiB.
        // Low available memory must not replace the pending zero target with
        // the stale actual-relative candidate of 1122 MiB.
        let stats = r#"{"target_mib":0,"actual_mib":1250,"target_pages":0,"actual_pages":320000,"free_memory":52428800,"available_memory":134217728}"#;
        let patch = run_tick_with_mock(stats, 1536).await;
        assert!(
            patch.is_none(),
            "should preserve the pending zero target from unpark"
        );
    }

    #[tokio::test]
    async fn tick_completes_pending_partial_deflate_on_pressure() {
        // A partial deflate target from an older controller must not retain a
        // multi-tick pressure path after the new policy takes ownership.
        let stats = r#"{"target_mib":400,"actual_mib":500,"target_pages":102400,"actual_pages":128000,"free_memory":52428800,"available_memory":134217728}"#;
        let patch = run_tick_with_mock(stats, 1536)
            .await
            .expect("expected PATCH completing pending deflation");
        assert_eq!(patch_amount_mib(&patch), 0);
    }

    #[tokio::test]
    async fn tick_reverses_pending_inflate_on_low_available_memory() {
        // A target above actual means inflation is in flight. Guest pressure
        // must reverse it directly to full relief.
        let stats = r#"{"target_mib":1000,"actual_mib":500,"target_pages":256000,"actual_pages":128000,"free_memory":52428800,"available_memory":134217728}"#;
        let patch = run_tick_with_mock(stats, 1536)
            .await
            .expect("expected PATCH reversing pending inflation");
        assert_eq!(patch_amount_mib(&patch), 0);
    }

    #[tokio::test]
    async fn tick_releases_low_retention_on_pressure() {
        // Full relief also applies when the retained balloon is smaller than
        // the old deficit-sized step.
        let stats = r#"{"target_mib":100,"actual_mib":100,"target_pages":25600,"actual_pages":25600,"free_memory":0,"available_memory":0}"#;
        let patch = run_tick_with_mock(stats, 1536).await;
        assert!(patch.is_some(), "expected PATCH call for deflate");
        let body = patch.unwrap();
        let amount = patch_amount_mib(&body);
        assert_eq!(
            amount, 0,
            "expected full pressure-relief target of 0, got {amount}"
        );
    }

    #[tokio::test]
    async fn tick_no_action_in_hysteresis_band() {
        // free_memory = 300 MiB (below inflate threshold 384)
        // available_memory = 300 MiB (above deflate threshold 192)
        // Both in hysteresis band — no action.
        let stats = r#"{"target_mib":100,"actual_mib":100,"target_pages":25600,"actual_pages":25600,"free_memory":314572800,"available_memory":314572800}"#;
        let patch = run_tick_with_mock(stats, 1536).await;
        assert!(patch.is_none(), "expected no PATCH call in hysteresis band");
    }

    #[tokio::test]
    async fn tick_respects_max_inflate() {
        // free_memory = 2 GiB and the supplied maximum inflation is 512 MiB.
        // Per-tick cap (256) < max_inflate (512), so cap wins.
        let stats = r#"{"target_mib":0,"actual_mib":0,"target_pages":0,"actual_pages":0,"free_memory":2147483648,"available_memory":2147483648}"#;
        let patch = run_tick_with_mock(stats, 512).await;
        assert!(patch.is_some(), "expected PATCH call");
        let body = patch.unwrap();
        let amount = patch_amount_mib(&body);
        assert_eq!(
            amount, 256,
            "expected per-tick cap of {MAX_INFLATE_PER_TICK_MIB}, got {amount}"
        );
    }

    #[tokio::test]
    async fn tick_inflate_cap_limited_by_max_inflate() {
        // free_memory = 1 GiB, current already at 1400 of max 1536.
        // Remaining headroom = 1536 - 1400 = 136 < per-tick cap (256).
        // So max_inflate wins: target = 1536.
        let stats = r#"{"target_mib":1400,"actual_mib":1400,"target_pages":358400,"actual_pages":358400,"free_memory":1073741824,"available_memory":1073741824}"#;
        let patch = run_tick_with_mock(stats, 1536).await;
        assert!(patch.is_some(), "expected PATCH call");
        let body = patch.unwrap();
        let amount = patch_amount_mib(&body);
        assert_eq!(
            amount, 1536,
            "expected clamped to max_inflate, got {amount}"
        );
    }

    #[tokio::test]
    async fn tick_no_action_when_max_inflate_zero() {
        // memory_mb <= MIN_GUEST_MIB → max_inflate = 0 → controller effectively disabled
        let stats = r#"{"target_mib":0,"actual_mib":0,"target_pages":0,"actual_pages":0,"free_memory":1073741824,"available_memory":1073741824}"#;
        let patch = run_tick_with_mock(stats, 0).await;
        assert!(patch.is_none(), "expected no PATCH when max_inflate is 0");
    }

    #[tokio::test]
    async fn tick_handles_missing_memory_stats() {
        // Stats without free_memory or available_memory — should skip
        let stats = r#"{"target_mib":0,"actual_mib":0,"target_pages":0,"actual_pages":0}"#;
        let patch = run_tick_with_mock(stats, 1536).await;
        assert!(
            patch.is_none(),
            "expected no PATCH when memory stats missing"
        );
    }

    #[tokio::test]
    async fn tick_no_deflate_when_available_memory_missing() {
        // free_memory present but low (no inflate), available_memory absent — should not deflate.
        let stats = r#"{"target_mib":512,"actual_mib":512,"target_pages":131072,"actual_pages":131072,"free_memory":52428800}"#;
        let patch = run_tick_with_mock(stats, 1536).await;
        assert!(
            patch.is_none(),
            "expected no PATCH when available_memory missing"
        );
    }

    #[tokio::test]
    async fn tick_handles_api_error() {
        let mut api = MockFirecrackerApi::with_responses([
            MockResponse::bad_request_fault("stats not enabled"),
            MockResponse::no_content(),
        ]);
        let sock_path = api.socket_path().to_path_buf();
        let client = ApiClient::new(&sock_path).unwrap();
        // Should not panic — just logs warning and returns.
        tick(&client, 1536, 0).await;

        let requests = api.drain_requests();
        assert_eq!(
            requests.len(),
            1,
            "expected only GET stats after API error, got {requests:#?}"
        );
        assert_firecracker_request(&requests[0], "GET", "/balloon/statistics");
    }

    #[tokio::test]
    async fn tick_status_log_does_not_trigger_action() {
        // tick_count=0 is a status tick (multiple of 12). In hysteresis band — no PATCH.
        // Verifies that the status logging path doesn't interfere with decision logic.
        let stats = r#"{"target_mib":100,"actual_mib":100,"target_pages":25600,"actual_pages":25600,"free_memory":314572800,"available_memory":314572800}"#;
        let patch = run_tick_with_mock_at(stats, 1536, 0).await;
        assert!(patch.is_none(), "status tick should not trigger PATCH");
    }

    #[tokio::test]
    async fn tick_non_status_tick_still_inflates() {
        // tick_count=1 is NOT a status tick. Should still inflate normally.
        let stats = r#"{"target_mib":0,"actual_mib":0,"target_pages":0,"actual_pages":0,"free_memory":1073741824,"available_memory":1073741824}"#;
        let patch = run_tick_with_mock_at(stats, 1536, 1).await;
        assert!(patch.is_some(), "non-status tick should still inflate");
    }
}
