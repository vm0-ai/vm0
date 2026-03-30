pub mod cow;
pub mod error;
pub mod netlink;
pub mod protocol;
pub mod server;

use std::path::{Path, PathBuf};

use error::{NbdCowError, Result};
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
    /// Unique identifier for this device.
    pub id: String,
    /// NBD device index (N in /dev/nbdN).
    device_index: u32,
    /// Path to the block device (e.g., /dev/nbd0).
    device_path: PathBuf,
    /// Path to the sparse COW file.
    cow_file: PathBuf,
    /// Background server task handles (one per connection).
    server_handles: Vec<JoinHandle<()>>,
    /// Shutdown signal for all server tasks.
    shutdown: CancellationToken,
}

impl NbdCowDevice {
    /// Create a new NBD COW device.
    ///
    /// 1. Finds a free NBD device index
    /// 2. Creates socketpairs (NUM_CONNECTIONS connections)
    /// 3. Spawns dispatch tasks for each connection
    /// 4. Connects via netlink
    pub async fn create(base_image: &Path, cow_file: &Path, size: u64) -> Result<Self> {
        let id = uuid::Uuid::new_v4().to_string();
        let device_index = netlink::find_free_device()?;
        let device_path = PathBuf::from(format!("/dev/nbd{device_index}"));
        let shutdown = CancellationToken::new();

        // Create COW layer
        let cow_layer = cow::CowLayer::new(base_image, size, BLOCK_SIZE, DEFAULT_FLUSH_THRESHOLD)?;
        let cow_layer = std::sync::Arc::new(tokio::sync::Mutex::new(cow_layer));

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

        // Connect via netlink
        netlink::connect(device_index, &client_fds, size, BLOCK_SIZE as u32)?;

        Ok(Self {
            id,
            device_index,
            device_path,
            cow_file: cow_file.to_path_buf(),
            server_handles,
            shutdown,
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

    /// Destroy the device, removing the COW file.
    pub async fn destroy(&mut self) -> Result<()> {
        self.shutdown_inner().await?;

        // Remove COW file
        if self.cow_file.exists() {
            std::fs::remove_file(&self.cow_file).map_err(NbdCowError::Io)?;
        }

        Ok(())
    }

    /// Destroy the device but keep the COW file for snapshot persistence.
    pub async fn destroy_keep_cow(&mut self) -> Result<()> {
        self.shutdown_inner().await
    }

    async fn shutdown_inner(&mut self) -> Result<()> {
        // Signal all dispatch tasks to stop
        self.shutdown.cancel();

        // Disconnect via netlink
        netlink::disconnect(self.device_index)?;

        // Wait for all tasks to complete
        for handle in self.server_handles.drain(..) {
            let _ = handle.await;
        }

        Ok(())
    }
}
