use std::sync::{Arc, Mutex, mpsc};
use std::task::{Context, Wake, Waker};
use std::thread::ThreadId;

use tokio::runtime::{Builder, Runtime};
use tokio::sync::{Notify, oneshot};

use super::*;
use crate::device_lock::try_acquire_device_claim_in;

const DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone, Copy)]
enum ConnectResult {
    Success,
    Ambiguous,
}

#[derive(Clone, Copy)]
enum Ownership {
    Ours,
    Foreign,
    Unknown,
}

#[derive(Debug)]
enum Event {
    Connect,
    Ownership(u32, Uuid, ThreadId),
    Disconnect(u32, ThreadId),
}

struct KernelState {
    result: ConnectResult,
    ownership: Ownership,
    events: mpsc::Sender<Event>,
    connect_gate: mpsc::Receiver<()>,
    ownership_gate: mpsc::Receiver<()>,
    disconnect_gate: mpsc::Receiver<()>,
}

#[derive(Clone)]
struct GatedKernel(Arc<Mutex<KernelState>>);

impl CreateKernel for GatedKernel {
    fn connect(
        &self,
        _: u32,
        _: &[std::os::fd::OwnedFd],
        _: u64,
        _: u64,
    ) -> (
        std::result::Result<netlink::ConnectDeviceSuccess, netlink::ConnectDeviceError>,
        NbdNetlinkConnectTiming,
    ) {
        let state = self.0.lock().unwrap();
        state.events.send(Event::Connect).unwrap();
        // Dropping the sender also releases the gate during test unwinding.
        let _ = state.connect_gate.recv();
        let connection_id = test_connection_id();
        let result = match state.result {
            ConnectResult::Success => Ok(netlink::ConnectDeviceSuccess { connection_id }),
            ConnectResult::Ambiguous => Err(netlink::ConnectDeviceError::AmbiguousAfterSend {
                connection_id,
                source: error::NbdCowError::Io(std::io::Error::other("connect reply lost")),
            }),
        };
        (result, NbdNetlinkConnectTiming::default())
    }

    async fn verify_size(&self, _: u32, _: u64) -> bool {
        panic!("connect critical section must not verify size")
    }

    fn ownership(&self, index: u32, id: Uuid) -> DeviceOwnership {
        let state = self.0.lock().unwrap();
        state
            .events
            .send(Event::Ownership(index, id, std::thread::current().id()))
            .unwrap();
        let _ = state.ownership_gate.recv();
        match state.ownership {
            Ownership::Ours => DeviceOwnership::Ours,
            Ownership::Foreign => DeviceOwnership::Foreign,
            Ownership::Unknown => {
                DeviceOwnership::Unknown(std::io::Error::other("sysfs unavailable"))
            }
        }
    }

    fn disconnect(&self, index: u32) -> Result<()> {
        let state = self.0.lock().unwrap();
        state
            .events
            .send(Event::Disconnect(index, std::thread::current().id()))
            .unwrap();
        let _ = state.disconnect_gate.recv();
        Ok(())
    }
}

struct CompletionWake(Notify);

impl Wake for CompletionWake {
    fn wake(self: Arc<Self>) {
        self.0.notify_one();
    }
}

#[derive(Clone, Copy)]
enum CancelAt {
    Queued,
    Running,
    Published,
}

struct Harness {
    // Release all synchronous gates before the runtime joins its workers,
    // including when an assertion fails while testing a blocking destructor.
    connect_gate: Option<mpsc::Sender<()>>,
    ownership_gate: Option<mpsc::Sender<()>>,
    disconnect_gate: Option<mpsc::Sender<()>>,
    events: mpsc::Receiver<Event>,
    kernel: GatedKernel,
    runtime: Runtime,
    pool: pool::DevicePoolHandle,
    lease: Option<pool::DeviceLease>,
    lock_dir: tempfile::TempDir,
}

impl Harness {
    fn new(result: ConnectResult, ownership: Ownership) -> Self {
        let runtime = Builder::new_multi_thread()
            .worker_threads(1)
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let (pool, lease, lock_dir) = runtime.block_on(acquired_test_lease());
        let (connect_tx, connect_gate) = mpsc::channel();
        let (ownership_tx, ownership_gate) = mpsc::channel();
        let (disconnect_tx, disconnect_gate) = mpsc::channel();
        let (events_tx, events) = mpsc::channel();
        Self {
            connect_gate: Some(connect_tx),
            ownership_gate: Some(ownership_tx),
            disconnect_gate: Some(disconnect_tx),
            events,
            kernel: GatedKernel(Arc::new(Mutex::new(KernelState {
                result,
                ownership,
                events: events_tx,
                connect_gate,
                ownership_gate,
                disconnect_gate,
            }))),
            runtime,
            pool,
            lease: Some(lease),
            lock_dir,
        }
    }

    fn next_event(&self) -> Event {
        self.events.recv_timeout(DEADLINE).unwrap()
    }

    fn block_on<T>(&self, future: impl std::future::Future<Output = T>) -> T {
        self.runtime.block_on(async {
            tokio::time::timeout(DEADLINE, future)
                .await
                .expect("test operation must complete")
        })
    }

    fn connected_outcome(&mut self) -> ConnectDeviceOutcome<GatedKernel> {
        self.connect_gate.take().unwrap().send(()).unwrap();
        let lease = self.lease.take().unwrap();
        let outcome = self.block_on(connect_device_with_state_critical_section(
            TEST_DEVICE_INDEX,
            Vec::new(),
            4096,
            4096,
            self.pool.clone(),
            lease,
            self.kernel.clone(),
        ));
        assert!(matches!(self.next_event(), Event::Connect));
        outcome.into_parts().1.unwrap()
    }

    fn assert_async_progress_and_lease_held(&self) {
        let pool = self.pool.clone();
        let (progress, observed) = mpsc::channel();
        self.runtime.spawn(async move {
            let _ = progress.send(pool.snapshot().await);
        });
        let snapshot = observed
            .recv_timeout(DEADLINE)
            .expect("async worker must progress while NBD cleanup is blocked");
        assert_eq!(
            snapshot.in_flight,
            [TEST_DEVICE_INDEX].into_iter().collect()
        );
        assert!(snapshot.cooldown.is_empty());
        assert!(
            try_acquire_device_claim_in(TEST_DEVICE_INDEX, self.lock_dir.path())
                .unwrap()
                .is_none()
        );
    }

    fn finish(&self) {
        self.runtime.block_on(async {
            tokio::time::timeout(DEADLINE, async {
                loop {
                    let snapshot = self.pool.snapshot().await;
                    if snapshot.in_flight.is_empty() {
                        assert_eq!(snapshot.cooldown, vec![TEST_DEVICE_INDEX]);
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("cleanup must retire its lease");
            self.pool.cleanup().await;
        });
        assert!(
            self.events.try_recv().is_err(),
            "unexpected extra kernel call"
        );
        assert!(
            try_acquire_device_claim_in(TEST_DEVICE_INDEX, self.lock_dir.path())
                .unwrap()
                .is_some()
        );
    }
}

fn cancelled_connect(result: ConnectResult, ownership: Ownership, cancel_at: CancelAt) {
    let mut harness = Harness::new(result, ownership);
    let (release_blocker, blocker_release) = mpsc::channel();
    let blocker = if matches!(cancel_at, CancelAt::Queued) {
        let (started, observed) = mpsc::channel();
        let blocker = harness.runtime.spawn_blocking(move || {
            started.send(()).unwrap();
            let _ = blocker_release.recv();
        });
        observed.recv_timeout(DEADLINE).unwrap();
        Some(blocker)
    } else {
        None
    };

    let (cancel, cancelled) = oneshot::channel();
    let (polled, poll_observed) = mpsc::channel();
    let pool = harness.pool.clone();
    let lease = harness.lease.take().unwrap();
    let kernel = harness.kernel.clone();
    let mut create = Some(harness.runtime.spawn(async move {
        let mut future = Box::pin(connect_device_with_state_critical_section(
            TEST_DEVICE_INDEX,
            Vec::new(),
            4096,
            4096,
            pool,
            lease,
            kernel,
        ));
        let completion = Arc::new(CompletionWake(Notify::new()));
        let waker = Waker::from(completion.clone());
        assert!(
            future
                .as_mut()
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
        );
        polled.send(std::thread::current().id()).unwrap();
        if matches!(cancel_at, CancelAt::Published) {
            // This wake belongs to the blocking JoinHandle: its output is
            // published, but the enclosing create future is never repolled.
            completion.0.notified().await;
        } else {
            cancelled.await.unwrap();
        }
        drop(future);
    }));
    let async_worker = poll_observed.recv_timeout(DEADLINE).unwrap();

    if matches!(cancel_at, CancelAt::Queued) {
        cancel.send(()).unwrap();
        harness.block_on(create.take().unwrap()).unwrap();
        release_blocker.send(()).unwrap();
        harness.block_on(blocker.unwrap()).unwrap();
        assert!(matches!(harness.next_event(), Event::Connect));
        harness.connect_gate.take().unwrap().send(()).unwrap();
    } else {
        assert!(matches!(harness.next_event(), Event::Connect));
        if matches!(cancel_at, CancelAt::Running) {
            cancel.send(()).unwrap();
            harness.block_on(create.take().unwrap()).unwrap();
        }
        harness.connect_gate.take().unwrap().send(()).unwrap();
    }

    let Event::Ownership(index, id, ownership_thread) = harness.next_event() else {
        panic!("expected ownership check");
    };
    harness.assert_async_progress_and_lease_held();
    assert_eq!(index, TEST_DEVICE_INDEX);
    assert_eq!(id, test_connection_id());
    assert_ne!(ownership_thread, async_worker);
    harness.ownership_gate.take().unwrap().send(()).unwrap();

    if matches!(ownership, Ownership::Ours) {
        let Event::Disconnect(index, disconnect_thread) = harness.next_event() else {
            panic!("expected owned disconnect");
        };
        harness.assert_async_progress_and_lease_held();
        assert_eq!(index, TEST_DEVICE_INDEX);
        assert_ne!(disconnect_thread, async_worker);
        harness.disconnect_gate.take().unwrap().send(()).unwrap();
    }
    if let Some(create) = create {
        harness.block_on(create).unwrap();
    }
    harness.finish();
}

#[test]
fn completed_unconsumed_connect_cleanup_keeps_async_worker_responsive() {
    for result in [ConnectResult::Success, ConnectResult::Ambiguous] {
        cancelled_connect(result, Ownership::Ours, CancelAt::Published);
    }
}

#[test]
fn queued_and_running_cancelled_connects_retain_lease_through_cleanup() {
    for cancel_at in [CancelAt::Queued, CancelAt::Running] {
        cancelled_connect(ConnectResult::Success, Ownership::Ours, cancel_at);
    }
}

#[test]
fn abandoned_connects_retire_without_disconnecting_foreign_or_unknown_owners() {
    for ownership in [Ownership::Foreign, Ownership::Unknown] {
        cancelled_connect(ConnectResult::Ambiguous, ownership, CancelAt::Published);
    }
}

#[test]
fn consuming_connect_outcome_returns_lease_without_cleanup() {
    let mut harness = Harness::new(ConnectResult::Success, Ownership::Ours);
    let outcome = harness.connected_outcome();
    let (lease, result) = outcome.into_parts().unwrap();
    assert_eq!(result.unwrap().connection_id, test_connection_id());
    harness.assert_async_progress_and_lease_held();
    harness.block_on(harness.pool.release_clean(lease));
    harness.finish();
}

#[test]
fn outcome_dropped_outside_runtime_uses_originating_blocking_pool() {
    let mut harness = Harness::new(ConnectResult::Success, Ownership::Foreign);
    let outcome = harness.connected_outcome();
    let dropper = std::thread::spawn(move || {
        assert!(tokio::runtime::Handle::try_current().is_err());
        drop(outcome);
    });
    assert!(matches!(harness.next_event(), Event::Ownership(..)));
    harness.assert_async_progress_and_lease_held();
    harness.ownership_gate.take().unwrap().send(()).unwrap();
    dropper.join().unwrap();
    harness.finish();
}

#[test]
fn queued_cleanup_keeps_lease_until_blocking_pool_can_run_it() {
    let mut harness = Harness::new(ConnectResult::Success, Ownership::Foreign);
    let outcome = harness.connected_outcome();
    let (release, released) = mpsc::channel();
    let (started, observed) = mpsc::channel();
    let blocker = harness.runtime.spawn_blocking(move || {
        started.send(()).unwrap();
        let _ = released.recv();
    });
    observed.recv_timeout(DEADLINE).unwrap();
    let (dropped, drop_observed) = mpsc::channel();
    let dropper = harness.runtime.spawn(async move {
        drop(outcome);
        let _ = dropped.send(());
    });
    drop_observed.recv_timeout(DEADLINE).unwrap();
    harness.assert_async_progress_and_lease_held();
    assert!(harness.events.try_recv().is_err());
    release.send(()).unwrap();
    harness.block_on(blocker).unwrap();
    harness.block_on(dropper).unwrap();
    assert!(matches!(harness.next_event(), Event::Ownership(..)));
    harness.ownership_gate.take().unwrap().send(()).unwrap();
    harness.finish();
}

#[test]
fn outcome_dropped_after_originating_runtime_shutdown_retires_without_kernel_io() {
    let mut harness = Harness::new(ConnectResult::Success, Ownership::Ours);
    let origin = Builder::new_current_thread().build().unwrap();
    let outcome = origin.block_on(async {
        ConnectDeviceOutcome::with_kernel(
            TEST_DEVICE_INDEX,
            DeferredLease::new(harness.pool.clone(), harness.lease.take().unwrap()),
            Ok(netlink::ConnectDeviceSuccess {
                connection_id: test_connection_id(),
            }),
            harness.kernel.clone(),
        )
    });
    drop(origin);
    harness.assert_async_progress_and_lease_held();
    let (dropped, observed) = mpsc::channel();
    let dropper = std::thread::spawn(move || {
        drop(outcome);
        let _ = dropped.send(());
    });
    observed.recv_timeout(DEADLINE).unwrap();
    dropper.join().unwrap();
    harness.finish();
}
