pub mod cow;
pub mod error;
pub mod netlink;
pub mod protocol;
pub mod server;

use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use error::Result;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// Default block size: 4KB (matching dm-snapshot chunk size).
pub const BLOCK_SIZE: usize = 4096;

/// Default number of connections per NBD device.
pub const NUM_CONNECTIONS: usize = 4;

/// Default write buffer flush threshold: 4MB.
pub const DEFAULT_FLUSH_THRESHOLD: usize = 4 * 1024 * 1024;

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
}

impl NbdCowDevice {
    /// Create a new NBD COW device.
    ///
    /// 1. Finds a free NBD device index
    /// 2. Creates socketpairs (NUM_CONNECTIONS connections)
    /// 3. Spawns dispatch tasks for each connection
    /// 4. Connects via netlink
    pub async fn create(base_image: &Path, cow_file: &Path, size: u64) -> Result<Self> {
        let shutdown = CancellationToken::new();

        // Create COW layer
        let cow_layer = cow::CowLayer::new(
            base_image,
            cow_file,
            size,
            BLOCK_SIZE,
            DEFAULT_FLUSH_THRESHOLD,
        )?;
        let cow_layer = Arc::new(RwLock::new(cow_layer));

        // Create socketpairs and spawn server tasks
        let mut client_fds = Vec::with_capacity(NUM_CONNECTIONS);
        let mut server_handles = Vec::with_capacity(NUM_CONNECTIONS);

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

        // Atomically find a free device and connect — retries on EBUSY so
        // concurrent runners don't race for the same device index.
        let device_index = match netlink::find_and_connect(&client_fds, size, BLOCK_SIZE as u64) {
            Ok(idx) => idx,
            Err(e) => {
                shutdown.cancel();
                for handle in server_handles {
                    handle.abort();
                }
                return Err(e);
            }
        };
        let device_path = PathBuf::from(format!("/dev/nbd{device_index}"));

        // Force-set the device size via ioctl.
        // On some kernels, reconnecting to a previously-used device index via
        // netlink does not properly propagate the size to the block layer,
        // leaving the device at 0 bytes. The NBD_SET_SIZE ioctl forces the
        // kernel to update the block device capacity.
        //
        // NBD_SET_SIZE = _IO(0xab, 2) = 0xab02
        const NBD_SET_SIZE: libc::Ioctl = 0xab02;
        let dev_fd = std::fs::File::open(&device_path)?;
        let ret = unsafe { libc::ioctl(dev_fd.as_raw_fd(), NBD_SET_SIZE, size as libc::c_ulong) };
        drop(dev_fd);
        if ret < 0 {
            tracing::warn!(
                device_index,
                "NBD_SET_SIZE ioctl failed: {}",
                std::io::Error::last_os_error()
            );
        }

        Ok(Self {
            device_index,
            device_path,
            cow_file: cow_file.to_path_buf(),
            cow: cow_layer,
            server_handles,
            shutdown,
            disconnected: false,
        })
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
    /// The kernel will eventually timeout and release the device.
    pub fn abandon(&mut self) {
        tracing::warn!(
            device_index = self.device_index,
            "NBD device abandoned — relying on kernel timeout for cleanup"
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

        // Disconnect via netlink (after tasks are done)
        if let Err(e) = netlink::disconnect(self.device_index) {
            tracing::warn!("NBD disconnect failed for nbd{}: {e}", self.device_index);
        }
        self.disconnected = true;

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

    fn bitmap_path(&self) -> PathBuf {
        cow::bitmap_path_for(&self.cow_file)
    }
}

/// Best-effort cleanup on drop: cancel tasks and disconnect the NBD device.
/// This ensures leaked devices are cleaned up even if `destroy()` is not called
/// (e.g., test panics).
impl Drop for NbdCowDevice {
    fn drop(&mut self) {
        self.shutdown.cancel();
        // Abort all server tasks (they may be blocked on socket I/O)
        for handle in self.server_handles.drain(..) {
            handle.abort();
        }
        // Only disconnect if shutdown_inner hasn't already done it,
        // to avoid disconnecting a device that was recycled by another runner.
        if !self.disconnected {
            let _ = netlink::disconnect(self.device_index);
        }
    }
}
