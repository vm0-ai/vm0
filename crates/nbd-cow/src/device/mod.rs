use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::error::Result;
use crate::{cow, error, netlink};
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

mod connection;
mod create;
mod finalizer;
mod pooled;

pub use connection::is_our_thread;
pub use pooled::{DestroyRetryPolicy, KeptCow, PooledDestroyError, PooledNbdCowDevice};

use connection::{
    ConnectedDevice, DeviceOwnership, OwnedDisconnectState, device_ownership,
    disconnect_connected_if_owned_result_critical_section,
};

/// An NBD COW block device backed by a base image and sparse COW file.
///
/// The device appears as `/dev/nbdN` and can be used as a Firecracker rootfs.
/// Writes go to an in-memory buffer that is periodically flushed to a sparse COW file.
/// Reads check the buffer, then COW file, then base image.
pub struct NbdCowDevice {
    /// NBD device index (N in /dev/nbdN).
    device_index: u32,
    /// Path to the block device (e.g., /dev/nbd0).
    device_path: PathBuf,
    /// Path to the sparse COW file.
    cow_file: PathBuf,
    /// Shared COW layer (also held by dispatch tasks).
    cow: Arc<RwLock<cow::CowLayer>>,
    /// Background server task handles (one per connection).
    server_handles: Vec<JoinHandle<()>>,
    /// Shutdown signal for all server tasks.
    shutdown: CancellationToken,
    /// Set to true after shutdown_inner completes, so Drop doesn't double-disconnect.
    disconnected: bool,
    /// TID of the thread that called netlink::connect_device(). The kernel
    /// records this in `/sys/block/nbdN/pid`. We save it so we can still
    /// identify the device as ours even after the connecting tokio worker
    /// thread has exited (at which point `/proc/self/task/{tid}` disappears).
    connect_tid: u32,
}

impl NbdCowDevice {
    /// NBD device index (N in `/dev/nbdN`).
    pub fn device_index(&self) -> u32 {
        self.device_index
    }

    /// Path to the block device (e.g., `/dev/nbd0`).
    pub fn device_path(&self) -> &Path {
        &self.device_path
    }

    /// Path to the sparse COW file.
    pub fn cow_file(&self) -> &Path {
        &self.cow_file
    }

    /// Log COW device status for debugging.
    pub async fn log_status(&self) {
        let cow = self.cow.read().await;
        tracing::info!(
            device_index = self.device_index,
            device_path = %self.device_path.display(),
            dirty_blocks = cow.dirty_block_count(),
            buffered_blocks = cow.buffered_block_count(),
            buffer_bytes = cow.buffer_bytes(),
            "NBD COW device status"
        );
    }

    /// Mark the device as abandoned without performing cleanup.
    ///
    /// Use as a last resort when netlink disconnect fails. Cancels tasks
    /// and marks the device as disconnected so Drop becomes a no-op.
    /// The device persists in the kernel until `runner gc` cleans it up.
    pub fn abandon(&mut self) {
        tracing::warn!(
            device_index = self.device_index,
            "NBD device abandoned — requires `runner gc` for cleanup"
        );
        self.shutdown.cancel();
        for handle in self.server_handles.drain(..) {
            handle.abort();
        }
        self.disconnected = true;
    }

    /// Destroy the device, removing the COW file and bitmap.
    pub async fn destroy(&mut self) -> Result<()> {
        self.shutdown_inner(false).await?;
        remove_cow_files(&self.cow_file)
    }

    /// Destroy the device but keep the COW file for snapshot persistence.
    ///
    /// Saves the dirty bitmap as a sidecar file (`{cow_file}.bitmap`)
    /// so that a future `create()` call with the same paths can restore
    /// the dirty state and serve reads from the COW file correctly.
    pub async fn destroy_keep_cow(&mut self) -> Result<()> {
        self.shutdown_inner(true).await
    }

    async fn shutdown_inner(&mut self, save_bitmap: bool) -> Result<()> {
        self.prepare_shutdown(save_bitmap).await?;
        self.disconnect_for_shutdown().await?;
        self.wait_for_kernel_release().await;
        Ok(())
    }

    async fn prepare_shutdown(&mut self, save_bitmap: bool) -> Result<()> {
        // Signal all dispatch tasks to stop
        self.shutdown.cancel();

        // Wait for all tasks to complete (they will flush on shutdown)
        for handle in self.server_handles.drain(..) {
            let _ = handle.await;
        }

        // Tasks are stopped — we have exclusive logical access to the COW layer.
        // Save bitmap before disconnecting if keeping the COW file.
        if save_bitmap {
            let cow = self.cow.read().await;
            cow.save_bitmap(&self.bitmap_path())?;
        }

        Ok(())
    }

    async fn disconnect_for_shutdown(&mut self) -> Result<()> {
        // Disconnect via netlink, only if we still own the device. On shared
        // hosts, another runner may have already disconnected our device and
        // recycled the index; blindly calling disconnect(device_index) would
        // tear down the new owner's device. Keep the ownership check inside the
        // blocking critical section so queueing cannot widen that race window.
        if !self.disconnected {
            let connected = ConnectedDevice {
                index: self.device_index,
                connect_tid: self.connect_tid,
            };
            let state = disconnect_connected_if_owned_result_critical_section(connected).await?;
            self.apply_owned_disconnect_state(state);
        }

        Ok(())
    }

    fn apply_owned_disconnect_state(&mut self, state: OwnedDisconnectState) {
        match state {
            OwnedDisconnectState::Disconnected => {
                self.disconnected = true;
            }
            OwnedDisconnectState::Foreign(pid) => {
                self.disconnected = true;
                tracing::warn!(
                    device_index = self.device_index,
                    foreign_pid = pid,
                    "skipping disconnect: device recycled by another process"
                );
            }
        }
    }

    async fn wait_for_kernel_release(&self) {
        // Wait for kernel to release the device (poll pid file)
        let pid_path = format!("/sys/block/nbd{}/pid", self.device_index);
        for _ in 0..10 {
            match std::fs::read_to_string(&pid_path) {
                Ok(content) => {
                    let pid = content.trim();
                    if pid == "-1" || pid == "0" || pid.is_empty() {
                        break;
                    }
                }
                Err(_) => break, // pid file gone means device released
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// Check if we still own the NBD device by comparing the sysfs PID
    /// against the TID we recorded at connect time.
    ///
    /// The kernel records the connecting thread's TID (via `task_pid_nr`) in
    /// `/sys/block/nbdN/pid`. We compare it to `self.connect_tid` rather than
    /// probing `/proc/self/task/` because the connecting tokio worker thread
    /// may have exited by the time we clean up, which would make the old
    /// `is_our_thread()` check return false and skip disconnect — leaking the
    /// device.
    fn device_ownership(&self) -> DeviceOwnership {
        device_ownership(self.device_index, self.connect_tid)
    }

    fn bitmap_path(&self) -> PathBuf {
        cow::bitmap_path_for(&self.cow_file)
    }
}

pub(super) fn remove_cow_files(cow_file: &Path) -> Result<()> {
    remove_file_if_exists(cow_file)?;
    remove_file_if_exists(&cow::bitmap_path_for(cow_file))?;
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(error::NbdCowError::Io(std::io::Error::new(
            e.kind(),
            format!("failed to remove {}: {e}", path.display()),
        ))),
    }
}

/// Best-effort cleanup on drop: cancel tasks and disconnect the NBD device.
/// This ensures leaked devices are cleaned up even if `destroy()` is not called
/// (e.g., test panics).
///
/// **Note:** Drop aborts dispatch tasks immediately without waiting for them to
/// flush buffered writes. Any data in the write buffer that has not been flushed
/// is silently lost. Always call [`destroy()`](Self::destroy) or
/// [`destroy_keep_cow()`](Self::destroy_keep_cow) for clean shutdown with data
/// persistence guarantees.
impl Drop for NbdCowDevice {
    fn drop(&mut self) {
        self.shutdown.cancel();
        // Abort all server tasks (they may be blocked on socket I/O)
        for handle in self.server_handles.drain(..) {
            handle.abort();
        }
        // Only disconnect if shutdown_inner hasn't already done it AND we
        // still own the device. Another runner's cleanup may have already
        // disconnected our index and a third runner may have recycled it.
        if !self.disconnected
            && matches!(self.device_ownership(), DeviceOwnership::Ours)
            && let Err(e) = netlink::disconnect(self.device_index)
        {
            tracing::warn!(
                device_index = self.device_index,
                error = %e,
                "NBD disconnect failed during drop"
            );
        }
    }
}
