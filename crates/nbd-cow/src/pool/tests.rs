use super::*;
use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use crate::device_lock::{self, NbdDeviceClaim};
use crate::error::{NbdCowError, Result};
use tokio::sync::oneshot;
use tokio::task::JoinSet;

use super::scan::scan_and_claim_with;
use super::state::CooldownSlot;

fn always_free(_: u32) -> bool {
    true
}

fn never_free(_: u32) -> bool {
    false
}

fn test_pool(
    max_devices: u32,
    cooldown: Duration,
    lock_dir: &Path,
    device_appears_free: DeviceFreeCheck,
) -> DevicePool {
    DevicePool::new_with_options(
        DevicePoolConfig { cooldown },
        max_devices,
        lock_dir.to_path_buf(),
        device_appears_free,
    )
}

fn pending_scan_result(result: Result<NbdDeviceClaim>) -> JoinSet<Result<NbdDeviceClaim>> {
    let mut pending = JoinSet::new();
    pending.spawn(async move { result });
    pending
}

fn pending_controlled_scan() -> (
    JoinSet<Result<NbdDeviceClaim>>,
    oneshot::Sender<Result<NbdDeviceClaim>>,
) {
    let mut pending = JoinSet::new();
    let (complete, complete_rx) = oneshot::channel();
    pending.spawn(async move { complete_rx.await.unwrap_or(Err(NbdCowError::NoFreeDevice)) });
    (pending, complete)
}

fn handle_with_scan_result(pool: DevicePool, result: Result<NbdDeviceClaim>) -> DevicePoolHandle {
    DevicePoolHandle::from_pool_with_pending(pool, pending_scan_result(result))
}

async fn wait_for_scan_waiter(handle: &DevicePoolHandle) {
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if handle.snapshot().await.waiting_acquires > 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("acquire did not wait for scan");
}

fn claim(index: u32, lock_dir: &Path) -> NbdDeviceClaim {
    NbdDeviceClaim::new_for_test(index, lock_dir)
}

fn lease(index: u32, lock_dir: &Path) -> DeviceLease {
    DeviceLease::new_for_test(index, lock_dir)
}

fn test_pool_with_in_flight(index: u32, lock_dir: &Path) -> DevicePool {
    let mut pool = test_pool(
        8,
        DevicePoolConfig::default().cooldown,
        lock_dir,
        always_free,
    );
    pool.in_flight.insert(index);
    pool
}

fn test_pool_for_pending_scan(lock_dir: &Path) -> DevicePool {
    test_pool(
        0,
        DevicePoolConfig::default().cooldown,
        lock_dir,
        always_free,
    )
}

mod cleanup;
mod cooldown;
mod lease;
mod scan;
mod waiting;
