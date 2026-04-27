//! Device pool for pre-validated NBD device indices.
//!
//! Instead of scanning sysfs on every `NbdCowDevice::create()`, this pool
//! maintains a queue of pre-validated device indices ready for immediate use.
//! Released devices enter a cooldown period before becoming available again,
//! preventing the "size stuck at 0" flake caused by reusing a device before
//! the kernel finishes cleanup.

use std::collections::{HashSet, VecDeque};
use std::time::{Duration, Instant};

use crate::error::{NbdCowError, Result};
use crate::netlink;

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

/// Pre-validated NBD device index pool.
///
/// Manages device indices as a host-level resource shared across factories
/// via `Arc<Mutex<DevicePool>>`, following the same pattern as `NetnsPool`.
pub struct DevicePool {
    active: bool,
    /// Validated free device indices ready for immediate acquire.
    ready: VecDeque<u32>,
    /// Recently released devices waiting for cooldown to expire.
    cooldown: VecDeque<CooldownSlot>,
    /// Background sysfs validation tasks.
    pending: tokio::task::JoinSet<Result<u32>>,
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
    /// the ready queue and avoid a synchronous sysfs scan on the first
    /// [`acquire()`](Self::acquire).
    pub fn new(config: DevicePoolConfig) -> Self {
        let max_devices = netlink::nbds_max();
        Self {
            active: true,
            ready: VecDeque::with_capacity(BUFFER_SIZE),
            cooldown: VecDeque::new(),
            pending: tokio::task::JoinSet::new(),
            max_devices,
            config,
            in_flight: HashSet::new(),
        }
    }

    /// Pre-warm the pool by scanning for free devices.
    pub async fn warmup(&mut self) {
        self.spawn_validations();

        // Wait for initial batch to complete
        while let Some(result) = self.pending.join_next().await {
            match result {
                Ok(Ok(index)) => {
                    if !self.ready.contains(&index) {
                        self.ready.push_back(index);
                    }
                }
                Ok(Err(e)) => tracing::debug!("warmup validation failed: {e}"),
                Err(e) => tracing::debug!("warmup task panicked: {e}"),
            }
            if self.ready.len() >= BUFFER_SIZE {
                break;
            }
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
    pub async fn acquire(&mut self) -> Result<u32> {
        if !self.active {
            return Err(NbdCowError::NoFreeDevice);
        }

        // Promote expired cooldown slots to ready queue
        self.promote_cooled_down();
        // Drain completed background tasks into ready queue
        self.drain_completed();

        // Tier 1: instant pop from ready queue
        if let Some(index) = self.ready.pop_front() {
            self.in_flight.insert(index);
            self.maybe_replenish();
            return Ok(index);
        }

        // Tier 2: await pending background validation
        while let Some(result) = self.pending.join_next().await {
            match result {
                Ok(Ok(index)) => {
                    self.in_flight.insert(index);
                    self.maybe_replenish();
                    return Ok(index);
                }
                Ok(Err(_)) | Err(_) => continue,
            }
        }

        // Tier 3: synchronous on-demand scan
        let max = self.max_devices;
        let tracked_indices = self.tracked_indices();
        let index = tokio::task::spawn_blocking(move || scan_free_device(max, &tracked_indices))
            .await
            .map_err(|e| {
                NbdCowError::Io(std::io::Error::other(format!("scan task panicked: {e}")))
            })??;

        self.in_flight.insert(index);
        self.maybe_replenish();
        Ok(index)
    }

    /// Release a device index back to the pool after disconnect.
    ///
    /// The device enters a cooldown period before it can be reused,
    /// giving the kernel time to finish teardown.
    pub fn release(&mut self, index: u32) {
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
    pub fn discard(&mut self, index: u32) {
        self.in_flight.remove(&index);
    }

    /// Clean up the pool: cancel pending tasks and clear queues.
    pub async fn cleanup(&mut self) {
        self.active = false;
        self.pending.abort_all();
        while self.pending.join_next().await.is_some() {}
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
                    self.ready.push_back(slot.index);
                }
                // If not free (recycled by another process), just drop it
            } else {
                break; // Cooldown queue is ordered by time
            }
        }
    }

    /// Drain completed pending tasks into the ready queue.
    ///
    /// Deduplicates against the ready queue: concurrent `spawn_blocking`
    /// tasks may discover the same free device index because each task
    /// snapshots `tracked_indices` at spawn time.
    fn drain_completed(&mut self) {
        while let Some(Ok(result)) = self.pending.try_join_next() {
            match result {
                Ok(index) => {
                    if !self.ready.contains(&index) && !self.in_flight.contains(&index) {
                        self.ready.push_back(index);
                    }
                }
                Err(e) => tracing::debug!("background validation failed: {e}"),
            }
        }
    }

    /// Spawn background validation tasks if the ready queue needs replenishment.
    fn maybe_replenish(&mut self) {
        let total_available = self.ready.len() + self.pending.len();
        if total_available >= BUFFER_SIZE {
            return;
        }

        self.spawn_validations();
    }

    /// Spawn background tasks to scan for free devices.
    fn spawn_validations(&mut self) {
        while self.pending.len() < MAX_PENDING
            && self.ready.len() + self.pending.len() < BUFFER_SIZE
        {
            let max = self.max_devices;
            let exclude = self.tracked_indices();
            self.pending
                .spawn_blocking(move || scan_free_device(max, &exclude));
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

    fn test_pool_with_in_flight(index: u32) -> DevicePool {
        DevicePool {
            active: true,
            // Keep the ready queue full so `release()` does not spawn host
            // sysfs validation tasks in this unit test.
            ready: VecDeque::from([0, 1, 2, 4]),
            cooldown: VecDeque::new(),
            pending: tokio::task::JoinSet::new(),
            max_devices: 8,
            config: DevicePoolConfig::default(),
            in_flight: HashSet::from([index]),
        }
    }

    #[test]
    fn release_ignores_duplicate_index() {
        let mut pool = test_pool_with_in_flight(3);

        pool.release(3);
        pool.release(3);

        assert_eq!(pool.cooldown.len(), 1);
        assert_eq!(pool.cooldown.front().map(|slot| slot.index), Some(3));
        assert!(pool.in_flight.is_empty());
    }
}
