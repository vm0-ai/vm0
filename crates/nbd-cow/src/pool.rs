//! Device pool for pre-validated NBD device indices.
//!
//! Instead of scanning sysfs on every pooled COW device creation, this pool
//! maintains a queue of pre-validated device indices ready for immediate use.
//! Released devices enter a cooldown period before becoming available again,
//! preventing the "size stuck at 0" flake caused by reusing a device before
//! the kernel finishes cleanup.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::error::{NbdCowError, Result};
use crate::netlink;
use tokio::sync::{mpsc, watch};

/// Number of pre-validated device indices to maintain in the ready queue.
const BUFFER_SIZE: usize = 4;

/// Maximum background validation tasks running concurrently.
const MAX_PENDING: usize = 4;

/// Default cooldown period (milliseconds) after disconnecting a device.
const DEFAULT_COOLDOWN_MS: u64 = 500;

/// A device index with a timestamp marking when it was released.
struct CooldownSlot {
    index: u32,
    released_at: Instant,
}

/// Owned authority for a checked-out NBD device index.
///
/// This intentionally does not implement `Clone` or `Copy`: returning an index
/// to the pool must consume the lease, not copied diagnostic metadata.
pub struct DeviceLease {
    index: u32,
}

impl DeviceLease {
    fn new(index: u32) -> Self {
        Self { index }
    }

    /// NBD device index (N in `/dev/nbdN`).
    pub fn index(&self) -> u32 {
        self.index
    }
}

/// Configuration for the device pool.
pub struct DevicePoolConfig {
    /// Cooldown period before a released device can be reused.
    pub cooldown: Duration,
}

impl Default for DevicePoolConfig {
    fn default() -> Self {
        Self {
            cooldown: Duration::from_millis(DEFAULT_COOLDOWN_MS),
        }
    }
}

/// Cloneable handle to the shared NBD device pool.
#[derive(Clone)]
pub struct DevicePoolHandle {
    inner: Arc<tokio::sync::Mutex<DevicePool>>,
}

enum AcquireStep {
    Ready(DeviceLease),
    WaitForPending(watch::Receiver<u64>),
    Scan { max: u32, exclude: Vec<u32> },
}

impl DevicePoolHandle {
    /// Create a new shared device pool handle.
    pub fn new(config: DevicePoolConfig) -> Self {
        Self {
            inner: Arc::new(tokio::sync::Mutex::new(DevicePool::new(config))),
        }
    }

    /// Wrap an existing pool.
    pub fn from_pool(pool: DevicePool) -> Self {
        Self {
            inner: Arc::new(tokio::sync::Mutex::new(pool)),
        }
    }

    /// Pre-warm the underlying pool.
    pub async fn warmup(&self) {
        self.inner.lock().await.warmup().await;
    }

    /// Clean up the underlying pool.
    pub async fn cleanup(&self) {
        self.inner.lock().await.cleanup().await;
    }

    pub(crate) async fn acquire(&self) -> Result<DeviceLease> {
        loop {
            let step = {
                let mut pool = self.inner.lock().await;
                pool.acquire_step()?
            };

            match step {
                AcquireStep::Ready(lease) => return Ok(lease),
                AcquireStep::WaitForPending(mut pending_rx) => {
                    let _ = pending_rx.changed().await;
                }
                AcquireStep::Scan { max, exclude } => {
                    let index =
                        tokio::task::spawn_blocking(move || scan_free_device(max, &exclude))
                            .await
                            .map_err(|e| {
                                NbdCowError::Io(std::io::Error::other(format!(
                                    "scan task panicked: {e}"
                                )))
                            })??;
                    if let Some(lease) = self.finish_acquire_candidate(index).await? {
                        return Ok(lease);
                    }
                }
            }
        }
    }

    pub(crate) async fn release_clean(&self, lease: DeviceLease) {
        self.inner.lock().await.release(lease);
    }

    pub(crate) async fn discard(&self, lease: DeviceLease) {
        self.inner.lock().await.discard(lease);
    }

    pub(crate) async fn retire_uncertain(&self, lease: DeviceLease) {
        self.inner.lock().await.retire_uncertain(lease);
    }

    async fn finish_acquire_candidate(&self, index: u32) -> Result<Option<DeviceLease>> {
        self.inner.lock().await.finish_acquire_candidate(index)
    }
}

/// Pre-validated NBD device index pool.
///
/// Manages device indices as a host-level resource. Production callers should
/// share it through [`DevicePoolHandle`] so pool release authority stays tied to
/// owned device leases.
pub struct DevicePool {
    active: bool,
    /// Validated free device indices ready for immediate acquire.
    ready: VecDeque<u32>,
    /// Recently released devices waiting for cooldown to expire.
    cooldown: VecDeque<CooldownSlot>,
    /// Background sysfs validation tasks.
    pending: tokio::task::JoinSet<()>,
    /// Number of validation tasks whose result has not been drained yet.
    pending_count: usize,
    /// Completed validation results from background tasks.
    validation_tx: mpsc::UnboundedSender<Result<u32>>,
    validation_rx: mpsc::UnboundedReceiver<Result<u32>>,
    /// Versioned notification for completed validation results.
    validation_watch_tx: watch::Sender<u64>,
    validation_watch_rx: watch::Receiver<u64>,
    /// Total number of NBD devices (from sysfs nbds_max).
    max_devices: u32,
    /// Pool configuration.
    config: DevicePoolConfig,
    /// Indices returned by `acquire()` but not yet `release()`d or `discard()`ed.
    /// Prevents background scans from rediscovering devices that are in use.
    in_flight: HashSet<u32>,
}

impl DevicePool {
    /// Create a new device pool.
    ///
    /// Reads `nbds_max` from sysfs to determine the device range.
    /// Call [`warmup()`](Self::warmup) before first use to pre-populate
    /// the ready queue and avoid a synchronous sysfs scan on first use.
    pub fn new(config: DevicePoolConfig) -> Self {
        let max_devices = netlink::nbds_max();
        let (validation_tx, validation_rx) = mpsc::unbounded_channel();
        let (validation_watch_tx, validation_watch_rx) = watch::channel(0);
        Self {
            active: true,
            ready: VecDeque::with_capacity(BUFFER_SIZE),
            cooldown: VecDeque::new(),
            pending: tokio::task::JoinSet::new(),
            pending_count: 0,
            validation_tx,
            validation_rx,
            validation_watch_tx,
            validation_watch_rx,
            max_devices,
            config,
            in_flight: HashSet::new(),
        }
    }

    /// Pre-warm the pool by scanning for free devices.
    pub async fn warmup(&mut self) {
        self.spawn_validations();

        // Wait for initial batch to complete
        loop {
            self.drain_completed();
            if self.ready.len() >= BUFFER_SIZE || self.pending_count == 0 {
                break;
            }

            let mut pending_rx = self.pending_notification();
            self.drain_completed();
            if self.ready.len() >= BUFFER_SIZE || self.pending_count == 0 {
                break;
            }
            let _ = pending_rx.changed().await;
        }

        tracing::info!(
            ready = self.ready.len(),
            max_devices = self.max_devices,
            "device pool warmed up"
        );
    }

    /// Acquire a pre-validated device index.
    ///
    /// Three-tier strategy:
    /// 1. Pop from ready queue (instant)
    /// 2. Await a pending background validation
    /// 3. Synchronous on-demand scan (fallback)
    #[cfg(test)]
    pub(crate) async fn acquire(&mut self) -> Result<DeviceLease> {
        loop {
            match self.acquire_step()? {
                AcquireStep::Ready(lease) => return Ok(lease),
                AcquireStep::WaitForPending(mut pending_rx) => {
                    let _ = pending_rx.changed().await;
                }
                AcquireStep::Scan { max, exclude } => {
                    let index =
                        tokio::task::spawn_blocking(move || scan_free_device(max, &exclude))
                            .await
                            .map_err(|e| {
                                NbdCowError::Io(std::io::Error::other(format!(
                                    "scan task panicked: {e}"
                                )))
                            })??;
                    if let Some(lease) = self.finish_acquire_candidate(index)? {
                        return Ok(lease);
                    }
                }
            }
        }
    }

    fn acquire_step(&mut self) -> Result<AcquireStep> {
        if !self.active {
            return Err(NbdCowError::NoFreeDevice);
        }

        // Promote expired cooldown slots to ready queue
        self.promote_cooled_down();
        self.drain_completed();

        // Tier 1: instant pop from ready queue
        if let Some(lease) = self.pop_ready_lease() {
            return Ok(AcquireStep::Ready(lease));
        }

        // Tier 2: wait for background validation outside the pool lock.
        if self.pending_count > 0 {
            let pending_rx = self.pending_notification();
            // Close the lost-wakeup gap: if a task completed before we cloned
            // the watch receiver, its result is now visible on the channel.
            self.drain_completed();
            if let Some(lease) = self.pop_ready_lease() {
                return Ok(AcquireStep::Ready(lease));
            }
            if self.pending_count > 0 {
                return Ok(AcquireStep::WaitForPending(pending_rx));
            }
        }

        // Tier 3: synchronous on-demand scan outside the pool lock.
        Ok(AcquireStep::Scan {
            max: self.max_devices,
            exclude: self.tracked_indices(),
        })
    }

    fn pop_ready_lease(&mut self) -> Option<DeviceLease> {
        let index = self.ready.pop_front()?;
        self.in_flight.insert(index);
        self.maybe_replenish();
        Some(DeviceLease::new(index))
    }

    fn pending_notification(&self) -> watch::Receiver<u64> {
        self.validation_watch_rx.clone()
    }

    fn finish_acquire_candidate(&mut self, index: u32) -> Result<Option<DeviceLease>> {
        if !self.active {
            return Err(NbdCowError::NoFreeDevice);
        }
        if self.is_tracked(index) {
            return Ok(None);
        }
        self.in_flight.insert(index);
        self.maybe_replenish();
        Ok(Some(DeviceLease::new(index)))
    }

    /// Release a device index back to the pool after disconnect.
    ///
    /// The device enters a cooldown period before it can be reused,
    /// giving the kernel time to finish teardown.
    pub(crate) fn release(&mut self, lease: DeviceLease) {
        let index = lease.index;
        if !self.active {
            return;
        }
        if !self.in_flight.remove(&index) {
            tracing::warn!(
                device_index = index,
                "device release ignored because index is not in flight"
            );
            return;
        }
        self.cooldown.push_back(CooldownSlot {
            index,
            released_at: Instant::now(),
        });
        self.maybe_replenish();
    }

    /// Stop tracking an in-flight index without returning it to the pool.
    ///
    /// Used when `connect_device` fails with EBUSY — the device belongs to
    /// another process and should not enter cooldown. Background scans will
    /// rediscover it later if it becomes free.
    pub(crate) fn discard(&mut self, lease: DeviceLease) {
        let index = lease.index;
        self.in_flight.remove(&index);
    }

    /// Retire a device whose post-owner state is uncertain.
    ///
    /// This is intentionally conservative: the index must still pass through
    /// cooldown and sysfs validation before it can become ready again.
    pub(crate) fn retire_uncertain(&mut self, lease: DeviceLease) {
        self.release(lease);
    }

    /// Clean up the pool: cancel pending tasks and clear queues.
    pub async fn cleanup(&mut self) {
        self.active = false;
        if !self.in_flight.is_empty() {
            tracing::warn!(
                in_flight = self.in_flight.len(),
                "device pool cleanup with outstanding leases"
            );
        }
        self.validation_watch_tx
            .send_modify(|version| *version = version.wrapping_add(1));
        self.pending.abort_all();
        while self.pending.join_next().await.is_some() {}
        self.pending_count = 0;
        while self.validation_rx.try_recv().is_ok() {
            // Drop completed validation results after shutdown.
        }
        self.ready.clear();
        self.cooldown.clear();
        self.in_flight.clear();
        tracing::info!("device pool cleanup complete");
    }

    /// Move expired cooldown slots to the ready queue.
    fn promote_cooled_down(&mut self) {
        let now = Instant::now();
        while let Some(front) = self.cooldown.front() {
            if now.duration_since(front.released_at) >= self.config.cooldown {
                let Some(slot) = self.cooldown.pop_front() else {
                    break;
                };
                // Re-validate via sysfs before promoting
                if netlink::device_appears_free(slot.index) {
                    self.push_ready_if_untracked(slot.index);
                }
                // If not free (recycled by another process), just drop it
            } else {
                break; // Cooldown queue is ordered by time
            }
        }
    }

    /// Spawn background validation tasks if the ready queue needs replenishment.
    fn maybe_replenish(&mut self) {
        self.drain_completed();
        let total_available = self.ready.len() + self.pending_count;
        if total_available >= BUFFER_SIZE {
            return;
        }

        self.spawn_validations();
    }

    /// Spawn background tasks to scan for free devices.
    fn spawn_validations(&mut self) {
        while self.pending_count < MAX_PENDING
            && self.ready.len() + self.pending_count < BUFFER_SIZE
        {
            let max = self.max_devices;
            let exclude = self.tracked_indices();
            let validation_tx = self.validation_tx.clone();
            let validation_watch_tx = self.validation_watch_tx.clone();
            self.pending_count += 1;
            self.pending.spawn(async move {
                let result = match tokio::task::spawn_blocking(move || {
                    scan_free_device(max, &exclude)
                })
                .await
                {
                    Ok(result) => result,
                    Err(e) => Err(NbdCowError::Io(std::io::Error::other(format!(
                        "scan task panicked: {e}"
                    )))),
                };
                let _ = validation_tx.send(result);
                validation_watch_tx.send_modify(|version| *version = version.wrapping_add(1));
            });
        }
    }

    /// Drain completed validation results into the ready queue.
    fn drain_completed(&mut self) {
        loop {
            match self.validation_rx.try_recv() {
                Ok(result) => {
                    self.pending_count = self.pending_count.saturating_sub(1);
                    if let Ok(index) = result {
                        self.push_ready_if_untracked(index);
                    }
                }
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => break,
            }
        }

        while let Some(result) = self.pending.try_join_next() {
            if result.is_err() {
                self.pending_count = self.pending_count.saturating_sub(1);
            }
        }
    }

    /// Collect all indices currently tracked by the pool (ready + cooldown + in-flight)
    /// to exclude from background scanning. Prevents duplicate indices in
    /// the ready queue from concurrent scan tasks.
    fn tracked_indices(&self) -> Vec<u32> {
        self.ready
            .iter()
            .copied()
            .chain(self.cooldown.iter().map(|s| s.index))
            .chain(self.in_flight.iter().copied())
            .collect()
    }

    fn is_tracked(&self, index: u32) -> bool {
        self.ready.contains(&index)
            || self.in_flight.contains(&index)
            || self.cooldown.iter().any(|slot| slot.index == index)
    }

    fn push_ready_if_untracked(&mut self, index: u32) -> bool {
        if self.is_tracked(index) {
            return false;
        }
        self.ready.push_back(index);
        true
    }
}

impl Drop for DevicePool {
    fn drop(&mut self) {
        if self.active {
            tracing::warn!("DevicePool dropped without cleanup — call cleanup() first");
        }
    }
}

/// Scan sysfs for a single free device, excluding given indices.
///
/// Starts from a random offset to distribute usage across runners.
fn scan_free_device(max_devices: u32, exclude: &[u32]) -> Result<u32> {
    if max_devices == 0 {
        return Err(NbdCowError::NoFreeDevice);
    }

    let start = netlink::random_offset(max_devices);

    for n in 0..max_devices {
        let i = (start + n) % max_devices;
        if exclude.contains(&i) {
            continue;
        }
        if netlink::device_appears_free(i) {
            return Ok(i);
        }
    }

    Err(NbdCowError::NoFreeDevice)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validation_channel() -> (
        mpsc::UnboundedSender<Result<u32>>,
        mpsc::UnboundedReceiver<Result<u32>>,
    ) {
        mpsc::unbounded_channel()
    }

    fn queue_validation_result(pool: &mut DevicePool, result: Result<u32>) {
        pool.pending_count += 1;
        pool.validation_tx.send(result).unwrap();
        pool.validation_watch_tx
            .send_modify(|version| *version = version.wrapping_add(1));
    }

    fn complete_validation(
        validation_tx: &mpsc::UnboundedSender<Result<u32>>,
        validation_watch_tx: &watch::Sender<u64>,
        result: Result<u32>,
    ) {
        validation_tx.send(result).unwrap();
        validation_watch_tx.send_modify(|version| *version = version.wrapping_add(1));
    }

    async fn wait_for_validation_waiter(validation_watch_tx: &watch::Sender<u64>) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if validation_watch_tx.receiver_count() > 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("acquire did not wait for validation");
    }

    fn test_pool_with_in_flight(index: u32) -> DevicePool {
        let (validation_tx, validation_rx) = validation_channel();
        let (validation_watch_tx, validation_watch_rx) = watch::channel(0);
        DevicePool {
            active: true,
            // Keep the ready queue full so `release()` does not spawn host
            // sysfs validation tasks in this unit test.
            ready: VecDeque::from([0, 1, 2, 4]),
            cooldown: VecDeque::new(),
            pending: tokio::task::JoinSet::new(),
            pending_count: 0,
            validation_tx,
            validation_rx,
            validation_watch_tx,
            validation_watch_rx,
            max_devices: 8,
            config: DevicePoolConfig::default(),
            in_flight: HashSet::from([index]),
        }
    }

    fn test_pool_for_pending_scan() -> DevicePool {
        let (validation_tx, validation_rx) = validation_channel();
        let (validation_watch_tx, validation_watch_rx) = watch::channel(0);
        DevicePool {
            active: true,
            ready: VecDeque::new(),
            cooldown: VecDeque::new(),
            pending: tokio::task::JoinSet::new(),
            pending_count: 0,
            validation_tx,
            validation_rx,
            validation_watch_tx,
            validation_watch_rx,
            max_devices: 0,
            config: DevicePoolConfig::default(),
            in_flight: HashSet::new(),
        }
    }

    #[test]
    fn release_consumes_lease_and_enters_cooldown() {
        let mut pool = test_pool_with_in_flight(3);

        pool.release(DeviceLease::new(3));

        assert_eq!(pool.cooldown.len(), 1);
        assert_eq!(pool.cooldown.front().map(|slot| slot.index), Some(3));
        assert!(pool.in_flight.is_empty());
    }

    #[test]
    fn retire_uncertain_enters_cooldown() {
        let mut pool = test_pool_with_in_flight(3);

        pool.retire_uncertain(DeviceLease::new(3));

        assert_eq!(pool.cooldown.len(), 1);
        assert_eq!(pool.cooldown.front().map(|slot| slot.index), Some(3));
        assert!(pool.in_flight.is_empty());
    }

    #[tokio::test]
    async fn cleanup_with_outstanding_lease_does_not_panic() {
        let mut pool = test_pool_with_in_flight(3);

        pool.cleanup().await;

        assert!(!pool.active);
        assert!(pool.in_flight.is_empty());
    }

    #[tokio::test]
    async fn cleanup_rejects_acquire() {
        let mut pool = test_pool_for_pending_scan();

        pool.cleanup().await;

        let result = pool.acquire().await;
        assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
    }

    #[tokio::test]
    async fn acquire_rejects_duplicate_pending_validation_result() {
        let mut pool = test_pool_for_pending_scan();
        pool.in_flight.insert(3);
        queue_validation_result(&mut pool, Ok(3));

        let result = pool.acquire().await;

        assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
        assert!(pool.in_flight.contains(&3));
        assert!(pool.ready.is_empty());
    }

    #[tokio::test]
    async fn handle_acquire_waiting_for_validation_does_not_block_release() {
        let mut pool = test_pool_for_pending_scan();
        pool.pending_count = 1;
        pool.in_flight.insert(3);
        let validation_tx = pool.validation_tx.clone();
        let validation_watch_tx = pool.validation_watch_tx.clone();
        let handle = DevicePoolHandle::from_pool(pool);
        let acquire_task = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });

        wait_for_validation_waiter(&validation_watch_tx).await;
        tokio::time::timeout(
            Duration::from_secs(1),
            handle.release_clean(DeviceLease::new(3)),
        )
        .await
        .expect("release blocked behind pending acquire");
        {
            let pool = handle.inner.lock().await;
            assert_eq!(pool.cooldown.front().map(|slot| slot.index), Some(3));
        }

        complete_validation(&validation_tx, &validation_watch_tx, Ok(4));
        let lease = tokio::time::timeout(Duration::from_secs(1), acquire_task)
            .await
            .expect("acquire did not finish after validation")
            .expect("acquire task panicked")
            .expect("acquire failed");
        assert_eq!(lease.index(), 4);
        handle.discard(lease).await;
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn cleanup_wakes_handle_acquire_waiting_for_validation() {
        let mut pool = test_pool_for_pending_scan();
        pool.pending_count = 1;
        let validation_watch_tx = pool.validation_watch_tx.clone();
        let handle = DevicePoolHandle::from_pool(pool);
        let acquire_task = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });

        wait_for_validation_waiter(&validation_watch_tx).await;
        tokio::time::timeout(Duration::from_secs(1), handle.cleanup())
            .await
            .expect("cleanup blocked behind pending acquire");

        let result = tokio::time::timeout(Duration::from_secs(1), acquire_task)
            .await
            .expect("acquire did not finish after cleanup")
            .expect("acquire task panicked");
        assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
    }

    #[tokio::test]
    async fn warmup_skips_already_tracked_validation_results() {
        let mut pool = test_pool_for_pending_scan();
        pool.ready.push_back(4);
        pool.cooldown.push_back(CooldownSlot {
            index: 5,
            released_at: Instant::now(),
        });
        pool.in_flight.insert(3);
        queue_validation_result(&mut pool, Ok(3));
        queue_validation_result(&mut pool, Ok(4));
        queue_validation_result(&mut pool, Ok(5));
        queue_validation_result(&mut pool, Ok(6));

        pool.warmup().await;

        let ready: Vec<u32> = pool.ready.iter().copied().collect();
        assert_eq!(ready, vec![4, 6]);
        assert_eq!(pool.cooldown.front().map(|slot| slot.index), Some(5));
        assert!(pool.in_flight.contains(&3));
    }
}
