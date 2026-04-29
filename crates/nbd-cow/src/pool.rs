//! Device pool for pre-validated NBD device indices.
//!
//! Instead of scanning sysfs on every pooled COW device creation, this pool
//! maintains a queue of pre-validated device indices ready for immediate use.
//! Released devices enter a cooldown period before becoming available again,
//! preventing the "size stuck at 0" flake caused by reusing a device before
//! the kernel finishes cleanup.

use std::collections::{HashSet, VecDeque};
use std::time::{Duration, Instant};

use crate::error::{NbdCowError, Result};
use crate::netlink;
use tokio::sync::{mpsc, oneshot};

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
    commands: mpsc::UnboundedSender<DevicePoolCommand>,
}

enum DevicePoolCommand {
    Warmup {
        done: oneshot::Sender<()>,
    },
    Acquire {
        respond_to: oneshot::Sender<Result<DeviceLease>>,
    },
    ReleaseClean {
        lease: DeviceLease,
        done: oneshot::Sender<()>,
    },
    Discard {
        lease: DeviceLease,
        done: oneshot::Sender<()>,
    },
    RetireUncertain {
        lease: DeviceLease,
        done: oneshot::Sender<()>,
    },
    Cleanup {
        done: oneshot::Sender<()>,
    },
    #[cfg(test)]
    Snapshot {
        respond_to: oneshot::Sender<DevicePoolSnapshot>,
    },
}

struct DevicePoolActor {
    pool: DevicePool,
    commands: mpsc::UnboundedReceiver<DevicePoolCommand>,
}

#[derive(Clone, Copy)]
enum ValidationPurpose {
    Background,
    Demand,
}

struct ValidationResult {
    purpose: ValidationPurpose,
    result: Result<u32>,
}

#[cfg(test)]
#[derive(Debug)]
struct DevicePoolSnapshot {
    cooldown: Vec<u32>,
    ready: Vec<u32>,
    in_flight: HashSet<u32>,
    waiting_acquires: usize,
}

impl DevicePoolHandle {
    /// Create a new shared device pool handle.
    ///
    /// Must be called from a Tokio runtime: the handle owns a background actor
    /// task that serializes all pool state transitions.
    pub fn new(config: DevicePoolConfig) -> Self {
        Self::from_pool(DevicePool::new(config))
    }

    fn from_pool(pool: DevicePool) -> Self {
        let (commands, command_rx) = mpsc::unbounded_channel();
        tokio::spawn(
            DevicePoolActor {
                pool,
                commands: command_rx,
            }
            .run(),
        );
        Self { commands }
    }

    /// Pre-warm the underlying pool.
    pub async fn warmup(&self) {
        let (done, done_rx) = oneshot::channel();
        if self
            .commands
            .send(DevicePoolCommand::Warmup { done })
            .is_ok()
        {
            let _ = done_rx.await;
        }
    }

    /// Clean up the underlying pool.
    pub async fn cleanup(&self) {
        let (done, done_rx) = oneshot::channel();
        if self
            .commands
            .send(DevicePoolCommand::Cleanup { done })
            .is_ok()
        {
            let _ = done_rx.await;
        }
    }

    pub(crate) async fn acquire(&self) -> Result<DeviceLease> {
        let (respond_to, response) = oneshot::channel();
        if self
            .commands
            .send(DevicePoolCommand::Acquire { respond_to })
            .is_err()
        {
            return Err(actor_stopped_error());
        }
        response.await.map_err(|_| actor_stopped_error())?
    }

    pub(crate) async fn release_clean(&self, lease: DeviceLease) {
        let (done, done_rx) = oneshot::channel();
        if self
            .commands
            .send(DevicePoolCommand::ReleaseClean { lease, done })
            .is_err()
        {
            tracing::warn!("device pool actor stopped before clean release");
            return;
        }
        let _ = done_rx.await;
    }

    pub(crate) async fn discard(&self, lease: DeviceLease) {
        let (done, done_rx) = oneshot::channel();
        if self
            .commands
            .send(DevicePoolCommand::Discard { lease, done })
            .is_err()
        {
            tracing::warn!("device pool actor stopped before discard");
            return;
        }
        let _ = done_rx.await;
    }

    pub(crate) async fn retire_uncertain(&self, lease: DeviceLease) {
        let (done, done_rx) = oneshot::channel();
        if self
            .commands
            .send(DevicePoolCommand::RetireUncertain { lease, done })
            .is_err()
        {
            tracing::warn!("device pool actor stopped before uncertain retire");
            return;
        }
        let _ = done_rx.await;
    }

    #[cfg(test)]
    async fn snapshot(&self) -> DevicePoolSnapshot {
        let (respond_to, response) = oneshot::channel();
        self.commands
            .send(DevicePoolCommand::Snapshot { respond_to })
            .expect("device pool actor stopped before snapshot");
        response.await.expect("device pool actor dropped snapshot")
    }
}

impl DevicePoolActor {
    async fn run(mut self) {
        loop {
            if self.pool.pending.is_empty() {
                let Some(command) = self.commands.recv().await else {
                    break;
                };
                self.handle_command(command).await;
            } else {
                tokio::select! {
                    command = self.commands.recv() => {
                        let Some(command) = command else {
                            break;
                        };
                        self.handle_command(command).await;
                    }
                    validation = self.pool.pending.join_next() => {
                        if let Some(validation) = validation {
                            self.pool.handle_validation_join(validation);
                        }
                    }
                }
            }
        }

        self.pool.abort_pending().await;
    }

    async fn handle_command(&mut self, command: DevicePoolCommand) {
        match command {
            DevicePoolCommand::Warmup { done } => {
                self.pool.warmup().await;
                let _ = done.send(());
            }
            DevicePoolCommand::Acquire { respond_to } => {
                self.pool.handle_acquire(respond_to);
            }
            DevicePoolCommand::ReleaseClean { lease, done } => {
                self.pool.release(lease);
                self.pool.ensure_waiting_progress();
                if self.pool.waiting_acquires.is_empty() {
                    self.pool.maybe_replenish();
                }
                let _ = done.send(());
            }
            DevicePoolCommand::Discard { lease, done } => {
                self.pool.discard(lease);
                self.pool.ensure_waiting_progress();
                let _ = done.send(());
            }
            DevicePoolCommand::RetireUncertain { lease, done } => {
                self.pool.retire_uncertain(lease);
                self.pool.ensure_waiting_progress();
                if self.pool.waiting_acquires.is_empty() {
                    self.pool.maybe_replenish();
                }
                let _ = done.send(());
            }
            DevicePoolCommand::Cleanup { done } => {
                self.pool.cleanup().await;
                let _ = done.send(());
            }
            #[cfg(test)]
            DevicePoolCommand::Snapshot { respond_to } => {
                let _ = respond_to.send(self.pool.snapshot());
            }
        }
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
    pending: tokio::task::JoinSet<ValidationResult>,
    /// Acquire requests waiting for validation or a released device.
    waiting_acquires: VecDeque<oneshot::Sender<Result<DeviceLease>>>,
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
        Self {
            active: true,
            ready: VecDeque::with_capacity(BUFFER_SIZE),
            cooldown: VecDeque::new(),
            pending: tokio::task::JoinSet::new(),
            waiting_acquires: VecDeque::new(),
            max_devices,
            config,
            in_flight: HashSet::new(),
        }
    }

    /// Pre-warm the pool by scanning for free devices.
    pub async fn warmup(&mut self) {
        if !self.active {
            return;
        }

        self.spawn_background_batch();

        while self.ready.len() < BUFFER_SIZE {
            let Some(validation) = self.pending.join_next().await else {
                break;
            };
            self.handle_validation_join(validation);
        }

        tracing::info!(
            ready = self.ready.len(),
            max_devices = self.max_devices,
            "device pool warmed up"
        );
    }

    fn handle_acquire(&mut self, respond_to: oneshot::Sender<Result<DeviceLease>>) {
        if !self.active {
            let _ = respond_to.send(Err(NbdCowError::NoFreeDevice));
            return;
        }

        self.promote_cooled_down();
        if let Some(index) = self.ready.pop_front() {
            if respond_to.send(Ok(DeviceLease::new(index))).is_ok() {
                self.in_flight.insert(index);
                self.maybe_replenish();
            } else {
                self.ready.push_front(index);
            }
            return;
        }

        self.waiting_acquires.push_back(respond_to);
        self.ensure_waiting_progress();
    }

    fn ensure_waiting_progress(&mut self) {
        if !self.active {
            self.fail_all_waiters();
            return;
        }

        self.promote_cooled_down();
        let assigned = self.satisfy_waiters_from_ready();
        if !self.waiting_acquires.is_empty() {
            self.spawn_demand_batch();
        } else if assigned {
            self.maybe_replenish();
        }
    }

    fn spawn_demand_batch(&mut self) {
        while self.active
            && self.pending.len() < MAX_PENDING
            && self.pending.len() < self.waiting_acquires.len()
        {
            self.spawn_validation(ValidationPurpose::Demand);
        }
    }

    fn handle_validation_join(
        &mut self,
        validation: std::result::Result<ValidationResult, tokio::task::JoinError>,
    ) {
        match validation {
            Ok(ValidationResult {
                purpose: _,
                result: Ok(index),
            }) => {
                let assigned = self.assign_candidate(index);
                self.ensure_waiting_progress();
                if assigned && self.waiting_acquires.is_empty() {
                    self.maybe_replenish();
                }
            }
            Ok(ValidationResult {
                purpose: ValidationPurpose::Demand,
                result: Err(e),
            }) => {
                self.fail_one_waiter(e);
                self.ensure_waiting_progress();
            }
            Ok(ValidationResult {
                purpose: ValidationPurpose::Background,
                result: Err(_),
            }) => {
                self.ensure_waiting_progress();
            }
            Err(e) => {
                if !self.waiting_acquires.is_empty() {
                    self.fail_one_waiter(NbdCowError::Io(std::io::Error::other(format!(
                        "device validation task failed: {e}"
                    ))));
                }
                self.ensure_waiting_progress();
            }
        }
    }

    fn satisfy_waiters_from_ready(&mut self) -> bool {
        let mut assigned = false;
        while let Some(respond_to) = self.waiting_acquires.pop_front() {
            let Some(index) = self.ready.pop_front() else {
                self.waiting_acquires.push_front(respond_to);
                break;
            };

            if respond_to.send(Ok(DeviceLease::new(index))).is_ok() {
                self.in_flight.insert(index);
                assigned = true;
            } else {
                self.ready.push_front(index);
            }
        }
        assigned
    }

    fn assign_candidate(&mut self, index: u32) -> bool {
        if self.is_tracked(index) {
            return false;
        }

        while let Some(respond_to) = self.waiting_acquires.pop_front() {
            if respond_to.send(Ok(DeviceLease::new(index))).is_ok() {
                self.in_flight.insert(index);
                return true;
            }
        }

        self.ready.push_back(index);
        false
    }

    fn fail_one_waiter(&mut self, mut error: NbdCowError) -> bool {
        while let Some(respond_to) = self.waiting_acquires.pop_front() {
            match respond_to.send(Err(error)) {
                Ok(()) => return true,
                Err(Err(e)) => error = e,
                Err(Ok(lease)) => {
                    self.ready.push_front(lease.index);
                    return false;
                }
            }
        }
        false
    }

    fn fail_all_waiters(&mut self) {
        while let Some(respond_to) = self.waiting_acquires.pop_front() {
            let _ = respond_to.send(Err(NbdCowError::NoFreeDevice));
        }
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
        self.fail_all_waiters();
        self.abort_pending().await;
        self.ready.clear();
        self.cooldown.clear();
        self.in_flight.clear();
        tracing::info!("device pool cleanup complete");
    }

    async fn abort_pending(&mut self) {
        self.pending.abort_all();
        while self.pending.join_next().await.is_some() {}
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
        if !self.active || !self.waiting_acquires.is_empty() {
            return;
        }
        self.spawn_background_batch();
    }

    fn spawn_background_batch(&mut self) {
        if !self.active {
            return;
        }

        while self.pending.len() < MAX_PENDING
            && self.ready.len() + self.pending.len() < BUFFER_SIZE
        {
            self.spawn_validation(ValidationPurpose::Background);
        }
    }

    /// Spawn a validation task to scan for a free device.
    fn spawn_validation(&mut self, purpose: ValidationPurpose) {
        let max = self.max_devices;
        let exclude = self.tracked_indices();
        self.pending.spawn(async move {
            let result =
                match tokio::task::spawn_blocking(move || scan_free_device(max, &exclude)).await {
                    Ok(result) => result,
                    Err(e) => Err(NbdCowError::Io(std::io::Error::other(format!(
                        "scan task panicked: {e}"
                    )))),
                };
            ValidationResult { purpose, result }
        });
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

    #[cfg(test)]
    fn snapshot(&self) -> DevicePoolSnapshot {
        DevicePoolSnapshot {
            cooldown: self.cooldown.iter().map(|slot| slot.index).collect(),
            ready: self.ready.iter().copied().collect(),
            in_flight: self.in_flight.clone(),
            waiting_acquires: self.waiting_acquires.len(),
        }
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

fn actor_stopped_error() -> NbdCowError {
    NbdCowError::Io(std::io::Error::other("device pool actor stopped"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue_validation_result(pool: &mut DevicePool, result: Result<u32>) {
        pool.pending.spawn(async move {
            ValidationResult {
                purpose: ValidationPurpose::Background,
                result,
            }
        });
    }

    fn queue_controlled_validation(pool: &mut DevicePool) -> oneshot::Sender<Result<u32>> {
        let (complete, complete_rx) = oneshot::channel();
        pool.pending.spawn(async move {
            ValidationResult {
                purpose: ValidationPurpose::Background,
                result: complete_rx.await.unwrap_or(Err(NbdCowError::NoFreeDevice)),
            }
        });
        complete
    }

    async fn wait_for_validation_waiter(handle: &DevicePoolHandle) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if handle.snapshot().await.waiting_acquires > 0 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("acquire did not wait for validation");
    }

    fn test_pool_with_in_flight(index: u32) -> DevicePool {
        DevicePool {
            active: true,
            // Keep the ready queue full so `release()` does not spawn host
            // sysfs validation tasks in this unit test.
            ready: VecDeque::from([0, 1, 2, 4]),
            cooldown: VecDeque::new(),
            pending: tokio::task::JoinSet::new(),
            waiting_acquires: VecDeque::new(),
            max_devices: 8,
            config: DevicePoolConfig::default(),
            in_flight: HashSet::from([index]),
        }
    }

    fn test_pool_for_pending_scan() -> DevicePool {
        DevicePool {
            active: true,
            ready: VecDeque::new(),
            cooldown: VecDeque::new(),
            pending: tokio::task::JoinSet::new(),
            waiting_acquires: VecDeque::new(),
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
        let handle = DevicePoolHandle::from_pool(test_pool_for_pending_scan());

        handle.cleanup().await;

        let result = handle.acquire().await;
        assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
    }

    #[tokio::test]
    async fn warmup_after_cleanup_does_not_restart_pool() {
        let mut pool = test_pool_for_pending_scan();

        pool.cleanup().await;
        pool.warmup().await;

        assert!(!pool.active);
        assert!(pool.pending.is_empty());
        assert!(pool.ready.is_empty());
    }

    #[tokio::test]
    async fn acquire_rejects_duplicate_pending_validation_result() {
        let mut pool = test_pool_for_pending_scan();
        pool.in_flight.insert(3);
        queue_validation_result(&mut pool, Ok(3));
        let handle = DevicePoolHandle::from_pool(pool);

        let result = handle.acquire().await;

        assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
        let snapshot = handle.snapshot().await;
        assert!(snapshot.in_flight.contains(&3));
        assert!(snapshot.ready.is_empty());
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn waiting_acquires_spawn_demand_validations_up_to_limit() {
        let mut pool = test_pool_for_pending_scan();
        let mut responses = Vec::new();

        for _ in 0..(MAX_PENDING + 2) {
            let (respond_to, response) = oneshot::channel();
            pool.handle_acquire(respond_to);
            responses.push(response);
        }

        assert_eq!(pool.waiting_acquires.len(), MAX_PENDING + 2);
        assert_eq!(pool.pending.len(), MAX_PENDING);
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn single_waiting_acquire_spawns_single_demand_validation() {
        let mut pool = test_pool_for_pending_scan();
        let (respond_to, _response) = oneshot::channel();

        pool.handle_acquire(respond_to);

        assert_eq!(pool.waiting_acquires.len(), 1);
        assert_eq!(pool.pending.len(), 1);
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn handle_acquire_waiting_for_validation_does_not_block_release() {
        let mut pool = test_pool_for_pending_scan();
        pool.in_flight.insert(3);
        let complete_validation = queue_controlled_validation(&mut pool);
        let handle = DevicePoolHandle::from_pool(pool);
        let acquire_task = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });

        wait_for_validation_waiter(&handle).await;
        tokio::time::timeout(
            Duration::from_secs(1),
            handle.release_clean(DeviceLease::new(3)),
        )
        .await
        .expect("release blocked behind pending acquire");
        assert_eq!(handle.snapshot().await.cooldown, vec![3]);

        complete_validation.send(Ok(4)).unwrap();
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
        let _complete_validation = queue_controlled_validation(&mut pool);
        let handle = DevicePoolHandle::from_pool(pool);
        let acquire_task = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });

        wait_for_validation_waiter(&handle).await;
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
