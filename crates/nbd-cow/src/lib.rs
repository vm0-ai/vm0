//! In-process NBD copy-on-write block devices.
//!
//! This crate exposes a Linux NBD device backed by a read-only base image and a
//! sparse copy-on-write (COW) file. [`pool::DevicePoolHandle::create_cow_device`]
//! connects the device,
//! starts the request dispatch tasks, and serves reads from pending writes, the
//! COW file, then the base image. Writes are buffered in memory and flushed to
//! the sparse COW file according to [`DEFAULT_FLUSH_THRESHOLD`].
//!
//! Important defaults are exposed as [`BLOCK_SIZE`], [`NUM_CONNECTIONS`], and
//! [`DEFAULT_FLUSH_THRESHOLD`].
//!
//! The layered implementation is split across:
//! - [`cow`] for COW storage and dirty bitmap persistence.
//! - [`pool`] for host-locked `/dev/nbdN` device claim allocation.
//! - [`netlink`] for Linux NBD generic netlink setup and disconnect.
//! - [`server`] for the in-process NBD dispatch loop.
//! - [`protocol`] for NBD transmission protocol parsing and serialization.
//! - [`error`] for crate error and result types.
//!
//! Call pooled-device finalizers when the device should be shut down cleanly.
//! Dropping a device only performs best-effort cleanup and may discard buffered
//! writes that were not flushed.

pub mod cow;
pub mod device_lock;
pub mod error;
pub mod netlink;
pub mod pool;
pub mod protocol;
pub mod server;

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use error::Result;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// Default block size: 4KB (matches typical filesystem block size and kernel page size).
pub const BLOCK_SIZE: usize = 4096;

/// Default number of connections per NBD device.
pub const NUM_CONNECTIONS: usize = 4;

/// Default write buffer flush threshold: 4MB.
pub const DEFAULT_FLUSH_THRESHOLD: usize = 4 * 1024 * 1024;

/// Retry policy for clean COW device finalization.
#[derive(Clone, Copy, Debug)]
pub struct DestroyRetryPolicy {
    /// Number of destroy attempts. Values below 1 are treated as 1 attempt.
    pub attempts: u32,
    /// Delay between attempts.
    pub delay: Duration,
}

impl DestroyRetryPolicy {
    fn attempts(self) -> u32 {
        self.attempts.max(1)
    }
}

/// Paths produced by a successful keep-COW finalizer.
#[derive(Debug)]
pub struct KeptCow {
    /// Preserved COW file path.
    pub cow_file: PathBuf,
    /// Persisted dirty bitmap sidecar path.
    pub bitmap_file: PathBuf,
}

struct PooledCowFinalizer<T: Send + 'static> {
    handle: Option<JoinHandle<Result<T>>>,
}

impl<T: Send + 'static> PooledCowFinalizer<T> {
    fn new(handle: JoinHandle<Result<T>>) -> Self {
        Self {
            handle: Some(handle),
        }
    }
}

impl<T: Send + 'static> Future for PooledCowFinalizer<T> {
    type Output = Result<T>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let Some(handle) = this.handle.as_mut() else {
            return Poll::Ready(Err(error::NbdCowError::Io(std::io::Error::other(
                "pooled NBD COW finalizer polled after completion",
            ))));
        };

        match Pin::new(handle).poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(result) => {
                this.handle.take();
                Poll::Ready(finish_finalizer_join(result))
            }
        }
    }
}

impl<T: Send + 'static> Drop for PooledCowFinalizer<T> {
    fn drop(&mut self) {
        let Some(handle) = self.handle.take() else {
            return;
        };

        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(observe_detached_finalizer(handle));
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "pooled NBD COW finalizer future dropped outside Tokio runtime; continuing without observer"
                );
            }
        }
    }
}

fn finish_finalizer_join<T>(
    result: std::result::Result<Result<T>, tokio::task::JoinError>,
) -> Result<T> {
    match result {
        Ok(result) => result,
        Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
        Err(e) => Err(error::NbdCowError::Io(std::io::Error::other(format!(
            "pooled NBD COW finalizer task was cancelled: {e}"
        )))),
    }
}

async fn observe_detached_finalizer<T: Send + 'static>(handle: JoinHandle<Result<T>>) {
    match handle.await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "detached pooled NBD COW finalizer failed");
        }
        Err(e) if e.is_panic() => {
            tracing::error!(error = %e, "detached pooled NBD COW finalizer panicked");
        }
        Err(e) => {
            tracing::warn!(error = %e, "detached pooled NBD COW finalizer task was cancelled");
        }
    }
}

/// Result of checking NBD device ownership via sysfs PID.
enum DeviceOwnership {
    /// We own the device (sysfs PID matches our PID).
    Ours,
    /// Another process owns the device (with its PID).
    Foreign(u32),
    /// Cannot determine ownership (sysfs read failed).
    Unknown(std::io::Error),
}

#[derive(Clone, Copy)]
struct ConnectedDevice {
    index: u32,
    connect_tid: u32,
}

struct CreateAttemptGuard {
    pool: pool::DevicePoolHandle,
    device_index: u32,
    lease: Option<pool::DeviceLease>,
    shutdown: CancellationToken,
    server_handles: Vec<JoinHandle<()>>,
    connected: Option<ConnectedDevice>,
}

impl CreateAttemptGuard {
    fn new(pool: pool::DevicePoolHandle, lease: pool::DeviceLease) -> Self {
        let device_index = lease.index();
        Self {
            pool,
            device_index,
            lease: Some(lease),
            shutdown: CancellationToken::new(),
            server_handles: Vec::with_capacity(NUM_CONNECTIONS),
            connected: None,
        }
    }

    fn device_index(&self) -> u32 {
        self.device_index
    }

    fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    fn push_server_handle(&mut self, handle: JoinHandle<()>) {
        self.server_handles.push(handle);
    }

    fn mark_connected(&mut self, connect_tid: u32) {
        self.connected = Some(ConnectedDevice {
            index: self.device_index(),
            connect_tid,
        });
    }

    async fn abort_servers(&mut self) {
        self.shutdown.cancel();
        abort_server_handles(std::mem::take(&mut self.server_handles)).await;
    }

    async fn release_clean(mut self) {
        self.abort_servers().await;
        if let Some(lease) = self.lease.take() {
            self.pool.release_clean(lease).await;
        }
    }

    async fn discard(mut self) {
        self.abort_servers().await;
        if let Some(lease) = self.lease.take() {
            self.pool.discard(lease).await;
        }
    }

    async fn retire_uncertain(mut self) {
        self.abort_servers().await;
        if let Some(lease) = self.lease.take() {
            self.pool.retire_uncertain(lease).await;
        }
    }

    async fn disconnect_owned_and_release(mut self) {
        self.abort_servers().await;
        let disconnected = self
            .connected
            .take()
            .is_some_and(disconnect_connected_if_owned);
        if let Some(lease) = self.lease.take() {
            if disconnected {
                self.pool.release_clean(lease).await;
            } else {
                self.pool.retire_uncertain(lease).await;
            }
        }
    }

    async fn disconnect_and_release(mut self) -> bool {
        self.abort_servers().await;
        let disconnected = self
            .connected
            .take()
            .is_some_and(|connected| netlink::disconnect(connected.index).is_ok());
        if let Some(lease) = self.lease.take() {
            if disconnected {
                self.pool.release_clean(lease).await;
            } else {
                self.pool.retire_uncertain(lease).await;
            }
        }
        disconnected
    }

    fn into_device(
        mut self,
        cow_file: &Path,
        cow_layer: Arc<RwLock<cow::CowLayer>>,
    ) -> Result<(NbdCowDevice, pool::DeviceLease)> {
        let Some(connected) = self.connected else {
            return Err(error::NbdCowError::Io(std::io::Error::other(
                "connected device missing during NBD COW create",
            )));
        };
        let Some(lease) = self.lease.take() else {
            return Err(error::NbdCowError::Io(std::io::Error::other(
                "pool lease missing during NBD COW create",
            )));
        };
        self.connected = None;
        let shutdown = std::mem::replace(&mut self.shutdown, CancellationToken::new());
        let server_handles = std::mem::take(&mut self.server_handles);

        Ok((
            NbdCowDevice {
                device_index: connected.index,
                device_path: PathBuf::from(format!("/dev/nbd{}", connected.index)),
                cow_file: cow_file.to_path_buf(),
                cow: cow_layer,
                server_handles,
                shutdown,
                disconnected: false,
                connect_tid: connected.connect_tid,
            },
            lease,
        ))
    }
}

impl Drop for CreateAttemptGuard {
    fn drop(&mut self) {
        self.shutdown.cancel();
        for handle in self.server_handles.drain(..) {
            handle.abort();
        }
        if let Some(connected) = self.connected.take() {
            disconnect_connected_if_owned(connected);
        }
        if let Some(lease) = self.lease.take() {
            let device_index = lease.index();
            tracing::warn!(
                device_index,
                "NBD COW create attempt dropped before completion; retiring pool lease as uncertain"
            );
            self.pool.retire_uncertain_detached(lease);
        }
    }
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
    /// 1. Acquires a host-locked device claim from the pool
    /// 2. Creates socketpairs (NUM_CONNECTIONS connections)
    /// 3. Spawns dispatch tasks for each connection
    /// 4. Connects via netlink to the specific device
    ///
    /// Two retry loops:
    /// - **Inner (EBUSY):** If the kernel reports the claimed device is busy
    ///   (for example, a non-cooperating owner or stale sysfs observation), try a
    ///   different device. This has its own budget (up to 16 retries) separate
    ///   from the size-verification loop.
    /// - **Outer (size-stuck-at-0):** If the kernel hasn't finished tearing down
    ///   a previous connection, disconnect, release with cooldown, and retry
    ///   with fresh sockets. Up to 5 retries with 200ms sleep between attempts.
    async fn create_inner(
        base_image: &Path,
        cow_file: &Path,
        size: u64,
        device_pool: &pool::DevicePoolHandle,
    ) -> Result<(Self, pool::DeviceLease)> {
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
            let attempt = loop {
                let lease = device_pool.acquire().await?;
                let mut attempt = CreateAttemptGuard::new(device_pool.clone(), lease);
                let device_index = attempt.device_index();

                // Fresh shutdown token and socketpairs for each attempt
                let mut client_fds = Vec::with_capacity(NUM_CONNECTIONS);

                let setup_err = (|| -> Result<()> {
                    for _ in 0..NUM_CONNECTIONS {
                        let (client_fd, server_fd) = netlink::create_socketpair()?;
                        client_fds.push(client_fd);

                        let cow = cow_layer.clone();
                        let token = attempt.shutdown_token();
                        let handle = tokio::spawn(async move {
                            if let Err(e) = server::dispatch(server_fd, cow, token).await {
                                tracing::error!("NBD dispatch error: {e}");
                            }
                        });
                        attempt.push_server_handle(handle);
                    }
                    Ok(())
                })();
                if let Err(e) = setup_err {
                    // Release device back — connect was never attempted, device
                    // is still free in kernel. No cooldown needed but release()
                    // adds one defensively.
                    attempt.release_clean().await;
                    return Err(e);
                }

                match netlink::connect_device_with_state(
                    device_index,
                    &client_fds,
                    size,
                    BLOCK_SIZE as u64,
                ) {
                    Ok(connected) => {
                        attempt.mark_connected(connected.connect_tid);
                        break attempt;
                    }
                    Err(netlink::ConnectDeviceError::DefiniteAfterSend {
                        source: error::NbdCowError::NetlinkErrno { errno, .. },
                    }) if errno == libc::EBUSY => {
                        ebusy_count += 1;
                        tracing::info!(
                            device_index,
                            ebusy_count,
                            "EBUSY on connect, trying next device"
                        );
                        if ebusy_count > MAX_EBUSY_RETRIES {
                            attempt.discard().await;
                            return Err(error::NbdCowError::NoFreeDevice);
                        }
                        // Device is owned by another process or otherwise busy.
                        // Stop tracking without cooldown; a future demand scan
                        // will rediscover it once it frees.
                        attempt.discard().await;
                        continue;
                    }
                    Err(netlink::ConnectDeviceError::AmbiguousAfterSend {
                        connect_tid,
                        source,
                    }) => {
                        // The kernel may have accepted NBD_CMD_CONNECT even
                        // though userspace failed while observing completion.
                        // Record a provisional candidate so cleanup can
                        // disconnect only if sysfs still proves we own it.
                        attempt.mark_connected(connect_tid);
                        attempt.disconnect_owned_and_release().await;
                        return Err(source);
                    }
                    Err(connect_error) => {
                        // Connect failed with non-EBUSY error. Device may be in
                        // an unknown kernel state — retire with cooldown so it
                        // gets re-validated before reuse.
                        attempt.retire_uncertain().await;
                        return Err(connect_error.into_source());
                    }
                }
            };
            let device_index = attempt.device_index();

            // Verify the device got the correct size via sysfs.
            if netlink::verify_device_size(device_index, size).await {
                return attempt.into_device(cow_file, cow_layer);
            }

            // Size is wrong — disconnect, release with cooldown, and retry.
            tracing::info!(
                device_index,
                attempt = size_attempt + 1,
                "device size 0 after connect, disconnecting and retrying"
            );
            attempt.disconnect_and_release().await;
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
        device_ownership(self.device_index, self.connect_tid)
    }

    fn bitmap_path(&self) -> PathBuf {
        cow::bitmap_path_for(&self.cow_file)
    }
}

fn device_ownership(device_index: u32, connect_tid: u32) -> DeviceOwnership {
    let pid_path = format!("/sys/block/nbd{device_index}/pid");
    match std::fs::read_to_string(&pid_path) {
        Ok(contents) => {
            let tid: u32 = contents.trim().parse().unwrap_or(0);
            if tid == connect_tid {
                DeviceOwnership::Ours
            } else {
                DeviceOwnership::Foreign(tid)
            }
        }
        Err(e) => DeviceOwnership::Unknown(e),
    }
}

fn disconnect_connected_if_owned(connected: ConnectedDevice) -> bool {
    disconnect_connected_if_owned_with(connected, device_ownership, netlink::disconnect)
}

fn disconnect_connected_if_owned_with(
    connected: ConnectedDevice,
    ownership: impl FnOnce(u32, u32) -> DeviceOwnership,
    disconnect: impl FnOnce(u32) -> Result<()>,
) -> bool {
    match ownership(connected.index, connected.connect_tid) {
        DeviceOwnership::Ours => {
            if let Err(e) = disconnect(connected.index) {
                tracing::warn!(
                    device_index = connected.index,
                    error = %e,
                    "NBD disconnect failed during cancelled create"
                );
                false
            } else {
                true
            }
        }
        DeviceOwnership::Foreign(pid) => {
            tracing::warn!(
                device_index = connected.index,
                foreign_pid = pid,
                "skipping cancelled-create disconnect: device recycled by another process"
            );
            false
        }
        DeviceOwnership::Unknown(err) => {
            tracing::warn!(
                device_index = connected.index,
                error = %err,
                "skipping cancelled-create disconnect: cannot read device pid"
            );
            false
        }
    }
}

impl pool::DevicePoolHandle {
    /// Create a pooled NBD COW device.
    pub async fn create_cow_device(
        &self,
        base_image: &Path,
        cow_file: &Path,
        size: u64,
    ) -> Result<PooledNbdCowDevice> {
        let (device, lease) = NbdCowDevice::create_inner(base_image, cow_file, size, self).await?;
        Ok(PooledNbdCowDevice {
            device,
            lease: LeaseGuard::new(lease, self.clone()),
            pool: self.clone(),
        })
    }
}

async fn abort_server_handles(handles: Vec<JoinHandle<()>>) {
    for handle in &handles {
        handle.abort();
    }
    for handle in handles {
        let _ = handle.await;
    }
}

#[derive(Clone, Copy)]
enum DestroyMode {
    RemoveCow,
    KeepCow,
}

impl DestroyMode {
    async fn run(self, device: &mut NbdCowDevice) -> Result<()> {
        match self {
            Self::RemoveCow => device.destroy().await,
            Self::KeepCow => device.destroy_keep_cow().await,
        }
    }
}

/// A COW device whose NBD pool ownership is tied to the device lifecycle.
pub struct PooledNbdCowDevice {
    device: NbdCowDevice,
    lease: LeaseGuard,
    pool: pool::DevicePoolHandle,
}

struct LeaseGuard {
    lease: Option<pool::DeviceLease>,
    pool: pool::DevicePoolHandle,
}

impl LeaseGuard {
    fn new(lease: pool::DeviceLease, pool: pool::DevicePoolHandle) -> Self {
        Self {
            lease: Some(lease),
            pool,
        }
    }

    fn take(&mut self) -> Option<pool::DeviceLease> {
        self.lease.take()
    }
}

impl Drop for LeaseGuard {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            let device_index = lease.index();
            tracing::warn!(
                device_index,
                "pooled NBD COW device dropped without finalizer; retiring pool lease as uncertain"
            );
            self.pool.retire_uncertain_detached(lease);
        }
    }
}

impl PooledNbdCowDevice {
    /// NBD device index (N in `/dev/nbdN`), for diagnostics only.
    pub fn device_index(&self) -> u32 {
        self.device.device_index()
    }

    /// Path to the block device (e.g., `/dev/nbd0`).
    pub fn device_path(&self) -> &Path {
        self.device.device_path()
    }

    /// Path to the sparse COW file.
    pub fn cow_file(&self) -> &Path {
        self.device.cow_file()
    }

    /// Log COW device status for debugging.
    pub async fn log_status(&self) {
        self.device.log_status().await;
    }

    /// Destroy the device, removing the COW file and bitmap.
    ///
    /// Finalization starts immediately. Dropping the returned future does not
    /// cancel cleanup; it continues in the background and logs its result.
    /// Must be called from a Tokio runtime.
    pub fn destroy_with_retries(
        self,
        policy: DestroyRetryPolicy,
    ) -> impl std::future::Future<Output = Result<()>> + Send + 'static {
        // Once finalization starts, let it run to completion even if the caller's
        // future is cancelled. Otherwise dropping the owned device mid-finalizer
        // can disconnect best-effort but leave the pool lease in flight.
        //
        // This must spawn before returning the Future: an `async fn` body would
        // not run if the returned future was dropped before its first poll.
        Self::run_finalizer(async move { self.destroy_with_retries_inner(policy).await })
    }

    async fn destroy_with_retries_inner(self, policy: DestroyRetryPolicy) -> Result<()> {
        let Self {
            mut device,
            mut lease,
            pool,
        } = self;
        Self::destroy_with_mode(
            &mut device,
            &mut lease,
            &pool,
            policy,
            DestroyMode::RemoveCow,
        )
        .await
    }

    /// Destroy the device while preserving COW data for snapshot persistence.
    ///
    /// Finalization starts immediately. Dropping the returned future does not
    /// cancel cleanup; it continues in the background and logs its result.
    /// Must be called from a Tokio runtime.
    pub fn destroy_keep_cow_with_retries(
        self,
        policy: DestroyRetryPolicy,
    ) -> impl std::future::Future<Output = Result<KeptCow>> + Send + 'static {
        // See destroy_with_retries(): the COW file must either be finalized or
        // abandoned with the lease retired even if the awaiting task is dropped.
        Self::run_finalizer(async move { self.destroy_keep_cow_with_retries_inner(policy).await })
    }

    async fn destroy_keep_cow_with_retries_inner(
        self,
        policy: DestroyRetryPolicy,
    ) -> Result<KeptCow> {
        let Self {
            mut device,
            mut lease,
            pool,
        } = self;
        let cow_file = device.cow_file().to_path_buf();
        let bitmap_file = device.bitmap_path();
        Self::destroy_with_mode(&mut device, &mut lease, &pool, policy, DestroyMode::KeepCow)
            .await?;

        Ok(KeptCow {
            cow_file,
            bitmap_file,
        })
    }

    async fn destroy_with_mode(
        device: &mut NbdCowDevice,
        lease: &mut LeaseGuard,
        pool: &pool::DevicePoolHandle,
        policy: DestroyRetryPolicy,
        mode: DestroyMode,
    ) -> Result<()> {
        let attempts = policy.attempts();

        match mode.run(device).await {
            Ok(()) => {
                Self::release_clean(pool, lease).await;
                Ok(())
            }
            Err(mut last_err) => {
                for _ in 1..attempts {
                    tokio::time::sleep(policy.delay).await;
                    match mode.run(device).await {
                        Ok(()) => {
                            Self::release_clean(pool, lease).await;
                            return Ok(());
                        }
                        Err(e) => last_err = e,
                    }
                }

                device.abandon();
                Self::retire_uncertain(pool, lease).await;
                Err(last_err)
            }
        }
    }

    /// Mark the device as abandoned and retire the pool lease as uncertain.
    ///
    /// Must be called from a Tokio runtime.
    pub fn abandon(self) -> impl std::future::Future<Output = ()> + Send + 'static {
        let finalizer = Self::run_finalizer(async move {
            self.abandon_inner().await;
            Ok(())
        });
        async move {
            if let Err(e) = finalizer.await {
                tracing::warn!(error = %e, "pooled NBD COW abandon finalizer failed");
            }
        }
    }

    async fn abandon_inner(self) {
        let Self {
            mut device,
            mut lease,
            pool,
        } = self;
        device.abandon();
        Self::retire_uncertain(&pool, &mut lease).await;
    }

    fn run_finalizer<T>(
        future: impl std::future::Future<Output = Result<T>> + Send + 'static,
    ) -> PooledCowFinalizer<T>
    where
        T: Send + 'static,
    {
        PooledCowFinalizer::new(tokio::spawn(future))
    }

    async fn release_clean(pool: &pool::DevicePoolHandle, lease: &mut LeaseGuard) {
        if let Some(lease) = lease.take() {
            pool.release_clean(lease).await;
        }
    }

    async fn retire_uncertain(pool: &pool::DevicePoolHandle, lease: &mut LeaseGuard) {
        if let Some(lease) = lease.take() {
            pool.retire_uncertain(lease).await;
        }
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

    const TEST_DEVICE_INDEX: u32 = 1_000_000;

    fn create_test_base_image(path: &Path) {
        let file = std::fs::File::create(path).expect("create base image");
        file.set_len(BLOCK_SIZE as u64).expect("size base image");
    }

    struct PooledDestroyHarness {
        _tmp: tempfile::TempDir,
        cow_file: PathBuf,
        bitmap_file: PathBuf,
        bitmap_tmp_path: PathBuf,
        pool: pool::DevicePoolHandle,
        device: PooledNbdCowDevice,
    }

    impl PooledDestroyHarness {
        fn new() -> Self {
            let tmp = tempfile::tempdir().expect("tempdir");
            let base = tmp.path().join("base.img");
            let cow_file = tmp.path().join("cow.img");
            let bitmap_file = cow::bitmap_path_for(&cow_file);
            let bitmap_tmp_path = PathBuf::from(format!("{}.tmp", bitmap_file.display()));
            let lock_dir = tmp.path().join("locks");
            std::fs::create_dir(&lock_dir).expect("create lock dir");
            create_test_base_image(&base);
            std::fs::write(&cow_file, b"cow").expect("write cow file");

            let pool = pool::DevicePoolHandle::new(pool::DevicePoolConfig::default());
            let cow = cow::CowLayer::new(
                &base,
                &cow_file,
                BLOCK_SIZE as u64,
                BLOCK_SIZE,
                DEFAULT_FLUSH_THRESHOLD,
            )
            .expect("create cow layer");
            let device = PooledNbdCowDevice {
                device: NbdCowDevice {
                    device_index: TEST_DEVICE_INDEX,
                    device_path: PathBuf::from(format!("/dev/nbd{TEST_DEVICE_INDEX}")),
                    cow_file: cow_file.clone(),
                    cow: Arc::new(RwLock::new(cow)),
                    server_handles: Vec::new(),
                    shutdown: CancellationToken::new(),
                    disconnected: true,
                    connect_tid: 0,
                },
                lease: LeaseGuard::new(
                    pool::DeviceLease::new_for_test(TEST_DEVICE_INDEX, &lock_dir),
                    pool.clone(),
                ),
                pool: pool.clone(),
            };

            Self {
                _tmp: tmp,
                cow_file,
                bitmap_file,
                bitmap_tmp_path,
                pool,
                device,
            }
        }

        fn write_bitmap_sidecar(&self) {
            std::fs::write(&self.bitmap_file, b"bitmap").expect("write bitmap file");
        }

        fn create_blocking_bitmap_tmp_dir(&self) {
            std::fs::create_dir(&self.bitmap_tmp_path).expect("create bitmap tmp dir");
        }

        fn create_transient_bitmap_tmp_symlink(&self) {
            std::os::unix::fs::symlink(
                self.bitmap_file
                    .parent()
                    .expect("bitmap path parent")
                    .join("missing-parent")
                    .join("bitmap.tmp"),
                &self.bitmap_tmp_path,
            )
            .expect("create broken bitmap tmp symlink");
        }
    }

    fn zero_attempt_destroy_policy() -> DestroyRetryPolicy {
        DestroyRetryPolicy {
            attempts: 0,
            delay: std::time::Duration::from_secs(60),
        }
    }

    #[tokio::test]
    async fn pooled_finalizer_starts_before_returned_future_is_polled() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();

        let finalizer = PooledNbdCowDevice::run_finalizer(async move {
            let _ = started_tx.send(());
            finish_rx.await.map_err(|e| {
                error::NbdCowError::Io(std::io::Error::other(format!(
                    "test finalizer release dropped: {e}"
                )))
            })?;
            let _ = done_tx.send(());
            Ok(())
        });

        started_rx.await.unwrap();
        drop(finalizer);
        finish_tx.send(()).unwrap();

        tokio::time::timeout(std::time::Duration::from_secs(1), done_rx)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    #[should_panic(expected = "pooled finalizer panic")]
    async fn pooled_finalizer_propagates_panic_when_awaited() {
        let finalizer =
            PooledNbdCowDevice::run_finalizer::<()>(
                async move { panic!("pooled finalizer panic") },
            );

        let _ = finalizer.await;
    }

    #[tokio::test]
    async fn destroy_with_retries_zero_attempts_runs_once_and_removes_files() {
        let harness = PooledDestroyHarness::new();
        harness.write_bitmap_sidecar();
        let PooledDestroyHarness {
            _tmp,
            cow_file,
            bitmap_file,
            pool,
            device,
            ..
        } = harness;

        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            device.destroy_with_retries(zero_attempt_destroy_policy()),
        )
        .await
        .expect("destroy should not sleep before first attempt")
        .expect("destroy");

        assert!(!cow_file.exists());
        assert!(!bitmap_file.exists());
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn destroy_keep_cow_zero_attempts_returns_preserved_paths() {
        let PooledDestroyHarness {
            _tmp,
            cow_file,
            bitmap_file,
            pool,
            device,
            ..
        } = PooledDestroyHarness::new();

        let kept = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            device.destroy_keep_cow_with_retries(zero_attempt_destroy_policy()),
        )
        .await
        .expect("destroy should not sleep before first attempt")
        .expect("destroy keep cow");

        assert_eq!(kept.cow_file, cow_file);
        assert_eq!(kept.bitmap_file, bitmap_file);
        assert!(kept.cow_file.exists());
        assert!(kept.bitmap_file.exists());
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn destroy_keep_cow_zero_attempts_returns_first_error_without_retry_sleep() {
        let harness = PooledDestroyHarness::new();
        harness.create_blocking_bitmap_tmp_dir();
        let PooledDestroyHarness {
            _tmp,
            cow_file,
            bitmap_file,
            pool,
            device,
            ..
        } = harness;

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            device.destroy_keep_cow_with_retries(zero_attempt_destroy_policy()),
        )
        .await
        .expect("destroy should not sleep before returning the first error");

        assert!(result.is_err());
        assert!(cow_file.exists());
        assert!(!bitmap_file.exists());
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn destroy_keep_cow_exhausts_retries_and_returns_error() {
        let harness = PooledDestroyHarness::new();
        harness.create_blocking_bitmap_tmp_dir();
        let PooledDestroyHarness {
            _tmp,
            cow_file,
            bitmap_file,
            bitmap_tmp_path,
            pool,
            device,
        } = harness;

        let result = device
            .destroy_keep_cow_with_retries(DestroyRetryPolicy {
                attempts: 2,
                delay: std::time::Duration::ZERO,
            })
            .await;

        assert!(result.is_err());
        assert!(cow_file.exists());
        assert!(!bitmap_file.exists());
        assert!(bitmap_tmp_path.is_dir());
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn destroy_keep_cow_retries_after_first_error_and_returns_preserved_paths() {
        let harness = PooledDestroyHarness::new();
        harness.create_transient_bitmap_tmp_symlink();
        let PooledDestroyHarness {
            _tmp,
            cow_file,
            bitmap_file,
            bitmap_tmp_path,
            pool,
            device,
        } = harness;

        let kept = device
            .destroy_keep_cow_with_retries(DestroyRetryPolicy {
                attempts: 2,
                delay: std::time::Duration::ZERO,
            })
            .await
            .expect("destroy keep cow should retry after tmp-file failure");

        assert_eq!(kept.cow_file, cow_file);
        assert_eq!(kept.bitmap_file, bitmap_file);
        assert!(kept.cow_file.exists());
        assert!(kept.bitmap_file.exists());
        assert!(!bitmap_tmp_path.exists());
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn abort_server_handles_waits_for_task_cleanup() {
        struct DropNotify(Option<tokio::sync::oneshot::Sender<()>>);

        impl Drop for DropNotify {
            fn drop(&mut self) {
                if let Some(tx) = self.0.take() {
                    let _ = tx.send(());
                }
            }
        }

        let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _notify = DropNotify(Some(dropped_tx));
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });

        started_rx.await.unwrap();
        abort_server_handles(vec![handle]).await;

        tokio::time::timeout(std::time::Duration::from_secs(1), dropped_rx)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn create_attempt_guard_drop_aborts_dispatch_task() {
        struct DropNotify(Option<tokio::sync::oneshot::Sender<()>>);

        impl Drop for DropNotify {
            fn drop(&mut self) {
                if let Some(tx) = self.0.take() {
                    let _ = tx.send(());
                }
            }
        }

        let lock_dir = tempfile::tempdir().expect("tempdir");
        let pool = pool::DevicePoolHandle::new(pool::DevicePoolConfig::default());
        let mut guard = CreateAttemptGuard::new(
            pool.clone(),
            pool::DeviceLease::new_for_test(3, lock_dir.path()),
        );
        let token = guard.shutdown_token();
        let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();

        guard.push_server_handle(tokio::spawn(async move {
            let _notify = DropNotify(Some(dropped_tx));
            let _ = started_tx.send(());
            token.cancelled().await;
        }));

        started_rx.await.unwrap();
        drop(guard);

        tokio::time::timeout(std::time::Duration::from_secs(1), dropped_rx)
            .await
            .unwrap()
            .unwrap();
        pool.cleanup().await;
    }

    #[test]
    fn disconnect_connected_if_owned_disconnects_matching_owner() {
        let calls = std::cell::Cell::new(0);
        let connected = ConnectedDevice {
            index: 7,
            connect_tid: 42,
        };

        let disconnected = disconnect_connected_if_owned_with(
            connected,
            |index, tid| {
                assert_eq!(index, 7);
                assert_eq!(tid, 42);
                DeviceOwnership::Ours
            },
            |index| {
                assert_eq!(index, 7);
                calls.set(calls.get() + 1);
                Ok(())
            },
        );

        assert!(disconnected);
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn disconnect_connected_if_owned_skips_foreign_owner() {
        let connected = ConnectedDevice {
            index: 7,
            connect_tid: 42,
        };

        let disconnected = disconnect_connected_if_owned_with(
            connected,
            |index, tid| {
                assert_eq!(index, 7);
                assert_eq!(tid, 42);
                DeviceOwnership::Foreign(100)
            },
            |_| panic!("foreign device must not be disconnected"),
        );

        assert!(!disconnected);
    }

    #[test]
    fn disconnect_connected_if_owned_skips_unknown_owner() {
        let connected = ConnectedDevice {
            index: 7,
            connect_tid: 42,
        };

        let disconnected = disconnect_connected_if_owned_with(
            connected,
            |index, tid| {
                assert_eq!(index, 7);
                assert_eq!(tid, 42);
                DeviceOwnership::Unknown(std::io::Error::other("sysfs unavailable"))
            },
            |_| panic!("unknown ownership must not be disconnected"),
        );

        assert!(!disconnected);
    }

    #[test]
    fn disconnect_connected_if_owned_reports_disconnect_error() {
        let connected = ConnectedDevice {
            index: 7,
            connect_tid: 42,
        };

        let disconnected = disconnect_connected_if_owned_with(
            connected,
            |_, _| DeviceOwnership::Ours,
            |_| {
                Err(error::NbdCowError::Io(std::io::Error::other(
                    "disconnect failed",
                )))
            },
        );

        assert!(!disconnected);
    }

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
