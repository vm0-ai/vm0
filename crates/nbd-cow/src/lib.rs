//! In-process NBD copy-on-write block devices.
//!
//! This crate exposes a Linux NBD device backed by a read-only base image and a
//! sparse copy-on-write (COW) file. [`NbdCowDevice::create`] connects the device,
//! starts the request dispatch tasks, and serves reads from pending writes, the
//! COW file, then the base image. Writes are buffered in memory and flushed to
//! the sparse COW file according to [`DEFAULT_FLUSH_THRESHOLD`].
//!
//! Important defaults are exposed as [`BLOCK_SIZE`], [`NUM_CONNECTIONS`], and
//! [`DEFAULT_FLUSH_THRESHOLD`].
//!
//! The layered implementation is split across:
//! - [`cow`] for COW storage and dirty bitmap persistence.
//! - [`pool`] for pre-validated `/dev/nbdN` device allocation.
//! - [`netlink`] for Linux NBD generic netlink setup and disconnect.
//! - [`server`] for the in-process NBD dispatch loop.
//! - [`protocol`] for NBD transmission protocol parsing and serialization.
//! - [`error`] for crate error and result types.
//!
//! Call [`NbdCowDevice::destroy`] or [`NbdCowDevice::destroy_keep_cow`] when the
//! device should be shut down cleanly. Dropping a device only performs
//! best-effort cleanup and may discard buffered writes that were not flushed.

pub mod cow;
pub mod error;
pub mod netlink;
pub mod pool;
pub mod protocol;
pub mod server;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use error::Result;
use tokio::sync::{Mutex, RwLock};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// Default block size: 4KB (matches typical filesystem block size and kernel page size).
pub const BLOCK_SIZE: usize = 4096;

/// Default number of connections per NBD device.
pub const NUM_CONNECTIONS: usize = 4;

/// Default write buffer flush threshold: 4MB.
pub const DEFAULT_FLUSH_THRESHOLD: usize = 4 * 1024 * 1024;

/// Result of checking NBD device ownership via sysfs PID.
enum DeviceOwnership {
    /// We own the device (sysfs PID matches our PID).
    Ours,
    /// Another process owns the device (with its PID).
    Foreign(u32),
    /// Cannot determine ownership (sysfs read failed).
    Unknown(std::io::Error),
}

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
    /// Create a new NBD COW device.
    ///
    /// 1. Acquires a pre-validated device index from the pool
    /// 2. Creates socketpairs (NUM_CONNECTIONS connections)
    /// 3. Spawns dispatch tasks for each connection
    /// 4. Connects via netlink to the specific device
    ///
    /// Two retry loops:
    /// - **Inner (EBUSY):** If another process grabbed the device between pool
    ///   validation and our connect, try a different device. This has its own
    ///   budget (up to 16 retries) separate from the size-verification loop.
    /// - **Outer (size-stuck-at-0):** If the kernel hasn't finished tearing down
    ///   a previous connection, disconnect, release with cooldown, and retry
    ///   with fresh sockets. Up to 5 retries with 200ms sleep between attempts.
    pub async fn create(
        base_image: &Path,
        cow_file: &Path,
        size: u64,
        device_pool: &Mutex<pool::DevicePool>,
    ) -> Result<Self> {
        // Create COW layer
        let cow_layer = cow::CowLayer::new(
            base_image,
            cow_file,
            size,
            BLOCK_SIZE,
            DEFAULT_FLUSH_THRESHOLD,
        )?;
        let cow_layer = Arc::new(RwLock::new(cow_layer));

        // Outer retry loop: handles "size stuck at 0" (kernel teardown timing).
        // Inner retry loop: handles EBUSY (device grabbed by another process).
        const MAX_SIZE_RETRIES: u32 = 5;
        const MAX_EBUSY_RETRIES: u32 = 16;
        let mut last_err_idx: u32 = 0;

        for size_attempt in 0..=MAX_SIZE_RETRIES {
            // Inner loop: acquire from pool and try to connect.
            // EBUSY retries get a fresh device without consuming the outer budget.
            let mut ebusy_count: u32 = 0;
            let (device_index, shutdown, server_handles, connect_tid) = loop {
                let device_index = device_pool.lock().await.acquire().await?;

                // Fresh shutdown token and socketpairs for each attempt
                let shutdown = CancellationToken::new();
                let mut client_fds = Vec::with_capacity(NUM_CONNECTIONS);
                let mut server_handles = Vec::with_capacity(NUM_CONNECTIONS);

                let setup_err = (|| -> Result<()> {
                    for _ in 0..NUM_CONNECTIONS {
                        let (client_fd, server_fd) = netlink::create_socketpair()?;
                        client_fds.push(client_fd);

                        let cow = cow_layer.clone();
                        let token = shutdown.clone();
                        let handle = tokio::spawn(async move {
                            if let Err(e) = server::dispatch(server_fd, cow, token).await {
                                tracing::error!("NBD dispatch error: {e}");
                            }
                        });
                        server_handles.push(handle);
                    }
                    Ok(())
                })();
                if let Err(e) = setup_err {
                    shutdown.cancel();
                    for handle in server_handles {
                        handle.abort();
                    }
                    // Release device back — connect was never attempted, device
                    // is still free in kernel. No cooldown needed but release()
                    // adds one defensively.
                    device_pool.lock().await.release(device_index);
                    return Err(e);
                }

                match netlink::connect_device(device_index, &client_fds, size, BLOCK_SIZE as u64) {
                    Ok(()) => {
                        // Record the TID of the thread that connected — the kernel
                        // stores this in /sys/block/nbdN/pid via task_pid_nr().
                        let tid = unsafe { libc::gettid() } as u32;
                        break (device_index, shutdown, server_handles, tid);
                    }
                    Err(error::NbdCowError::NetlinkErrno { errno, .. }) if errno == libc::EBUSY => {
                        ebusy_count += 1;
                        tracing::debug!(
                            device_index,
                            ebusy_count,
                            "EBUSY on connect, trying next device"
                        );
                        shutdown.cancel();
                        for handle in server_handles {
                            handle.abort();
                        }
                        if ebusy_count > MAX_EBUSY_RETRIES {
                            device_pool.lock().await.discard(device_index);
                            return Err(error::NbdCowError::NoFreeDevice);
                        }
                        // Device is owned by another process — stop tracking
                        // without cooldown. Background scan will rediscover
                        // if it frees.
                        device_pool.lock().await.discard(device_index);
                        continue;
                    }
                    Err(e) => {
                        shutdown.cancel();
                        for handle in server_handles {
                            handle.abort();
                        }
                        // Connect failed with non-EBUSY error. Device may be in
                        // an unknown kernel state — release with cooldown so it
                        // gets re-validated before reuse.
                        device_pool.lock().await.release(device_index);
                        return Err(e);
                    }
                }
            };

            // Verify the device got the correct size via sysfs.
            if netlink::verify_device_size(device_index, size).await {
                let device_path = PathBuf::from(format!("/dev/nbd{device_index}"));
                return Ok(Self {
                    device_index,
                    device_path,
                    cow_file: cow_file.to_path_buf(),
                    cow: cow_layer,
                    server_handles,
                    shutdown,
                    disconnected: false,
                    connect_tid,
                });
            }

            // Size is wrong — disconnect, release with cooldown, and retry.
            tracing::debug!(
                device_index,
                attempt = size_attempt + 1,
                "device size 0 after connect, disconnecting and retrying"
            );
            let _ = netlink::disconnect(device_index);
            device_pool.lock().await.release(device_index);
            shutdown.cancel();
            for handle in server_handles {
                handle.abort();
            }
            last_err_idx = device_index;

            if size_attempt < MAX_SIZE_RETRIES {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }

        Err(error::NbdCowError::Io(std::io::Error::other(format!(
            "device size stuck at 0 after {MAX_SIZE_RETRIES} connect retries \
             on nbd{last_err_idx} — kernel may not have finished releasing \
             the previous connection",
        ))))
    }

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

        // Remove COW file and bitmap
        let _ = std::fs::remove_file(&self.cow_file);
        let _ = std::fs::remove_file(self.bitmap_path());

        Ok(())
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

        // Disconnect via netlink — attempt exactly once, only if we still own
        // the device. On shared hosts, another runner may have already
        // disconnected our device and recycled the index; blindly calling
        // disconnect(device_index) would tear down the new owner's device.
        if !self.disconnected {
            match self.device_ownership() {
                DeviceOwnership::Ours => {
                    netlink::disconnect(self.device_index)?;
                    self.disconnected = true;
                }
                DeviceOwnership::Foreign(pid) => {
                    self.disconnected = true;
                    tracing::warn!(
                        device_index = self.device_index,
                        foreign_pid = pid,
                        "skipping disconnect: device recycled by another process"
                    );
                }
                DeviceOwnership::Unknown(err) => {
                    self.disconnected = true;
                    tracing::warn!(
                        device_index = self.device_index,
                        error = %err,
                        "skipping disconnect: cannot read device pid"
                    );
                }
            }
        }

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

        Ok(())
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
        let pid_path = format!("/sys/block/nbd{}/pid", self.device_index);
        match std::fs::read_to_string(&pid_path) {
            Ok(contents) => {
                let tid: u32 = contents.trim().parse().unwrap_or(0);
                if tid == self.connect_tid {
                    DeviceOwnership::Ours
                } else {
                    DeviceOwnership::Foreign(tid)
                }
            }
            Err(e) => DeviceOwnership::Unknown(e),
        }
    }

    fn bitmap_path(&self) -> PathBuf {
        cow::bitmap_path_for(&self.cow_file)
    }
}

/// Check if a TID belongs to our process by probing `/proc/self/task/{tid}`.
///
/// The kernel NBD driver records the connecting thread's TID (not TGID) in
/// sysfs. In a multi-threaded tokio runtime the connecting worker thread has
/// a TID different from the process TGID returned by `std::process::id()`.
/// This function handles both cases: TID == TGID (main thread) and
/// TID != TGID (worker threads).
pub fn is_our_thread(tid: u32) -> bool {
    tid == std::process::id() || std::path::Path::new(&format!("/proc/self/task/{tid}")).exists()
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify is_our_thread correctly identifies the main thread (TID == TGID).
    #[test]
    fn is_our_thread_main_thread() {
        assert!(is_our_thread(std::process::id()));
    }

    /// Verify is_our_thread identifies a spawned thread's TID as ours.
    /// This exercises the /proc/self/task/{tid} path used by tokio workers.
    #[test]
    fn is_our_thread_worker_thread() {
        // Use a running thread to ensure /proc/self/task/{tid} exists.
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            let tid = unsafe { libc::gettid() } as u32;
            tx.send(tid).unwrap();
            // Keep thread alive until main reads the TID and checks it.
            std::thread::park();
            tid
        });
        let worker_tid = rx.recv().unwrap();
        assert_ne!(
            worker_tid,
            std::process::id(),
            "worker TID should differ from TGID"
        );
        assert!(
            is_our_thread(worker_tid),
            "worker thread TID should be recognized as ours"
        );
        handle.thread().unpark();
        handle.join().unwrap();
    }

    /// Verify is_our_thread rejects a TID that doesn't belong to our process.
    #[test]
    fn is_our_thread_foreign_tid() {
        // PID 1 (init) is never one of our threads.
        assert!(!is_our_thread(1));
        // A very large TID that doesn't exist.
        assert!(!is_our_thread(u32::MAX));
    }
}
