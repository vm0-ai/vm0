//! COW slot producer for Firecracker VMs.
//!
//! Pre-creates one-shot COW slots in bounded background workers to reduce
//! sandbox creation latency. A slot is consumed by one sandbox and is never
//! returned to this producer.

mod actor;
mod create;
mod slot;
mod state;

#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;

pub(crate) use actor::CowPoolHandle;
#[cfg(test)]
use slot::destroy_slot_sync;
pub(crate) use slot::{PreparedCowSlot, destroy_prepared_slot_async};
use slot::{PrewarmedSlot, destroy_slot_async};

/// Number of ready COW slots to keep warm in steady state.
const BUFFER_SIZE: usize = 4;

/// Maximum simultaneous blocking slot creation workers.
const MAX_CONCURRENT_SLOT_CREATIONS: usize = 4;

/// Maximum simultaneous prepared-slot teardowns during producer shutdown.
const MAX_CONCURRENT_SLOT_TEARDOWNS: usize = MAX_CONCURRENT_SLOT_CREATIONS;

/// Maximum slots still owned by the producer pipeline (ready + pending).
const MAX_SLOTS: usize = 256;

/// Backoff for warm-buffer retries after background creation failures.
const WARM_RETRY_BACKOFF: Duration = Duration::from_secs(1);

type AcquireResult = Result<PreparedCowSlot, CowPoolError>;
type SlotSpawner =
    Arc<dyn Fn(CowPoolConfig) -> JoinHandle<Result<PreparedCowSlot, CowPoolError>> + Send + Sync>;

#[cfg(test)]
#[derive(Debug)]
struct CowPoolSnapshot {
    ready: usize,
    pending: usize,
    teardowns: usize,
    waiters: usize,
    pipeline_slots: usize,
    warm_retry_scheduled: bool,
}

/// Configuration for creating a [`CowPoolHandle`].
#[derive(Clone)]
pub(crate) struct CowPoolConfig {
    /// Base directory for workspaces (for example, `{base_dir}/workspaces`).
    pub workspaces_dir: PathBuf,
    /// Read-only base image used by every prepared COW device.
    pub base_image: PathBuf,
    /// Base image size in bytes (for creating sparse COW files in fresh mode).
    pub base_size: u64,
    /// Snapshot golden COW file path (`None` = fresh mode).
    pub golden_cow: Option<PathBuf>,
    /// Shared pool of validated host NBD devices.
    pub device_pool: nbd_cow::pool::DevicePoolHandle,
}

/// Pool error type.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CowPoolError {
    #[error("COW file creation failed: {0}")]
    CowFileCreation(String),
    #[error("COW device creation failed: {0}")]
    CowDeviceCreation(String),
    #[error("slot limit reached (max {max})")]
    SlotLimitReached { max: usize },
    #[error("pool actor stopped")]
    ActorStopped,
    #[error("pool is not active")]
    NotActive,
}
