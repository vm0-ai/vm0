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

/// Error returned by detailed pooled COW destroy finalizers.
#[derive(Debug)]
pub struct PooledDestroyError {
    source: error::NbdCowError,
    backing_files_safe_to_delete: bool,
}

impl PooledDestroyError {
    fn device_cleanup(source: error::NbdCowError) -> Self {
        Self {
            source,
            backing_files_safe_to_delete: false,
        }
    }

    fn storage_cleanup(source: error::NbdCowError) -> Self {
        Self {
            source,
            backing_files_safe_to_delete: true,
        }
    }

    /// Whether the NBD device has been disconnected and backing files are no
    /// longer referenced by this pooled device.
    pub fn backing_files_safe_to_delete(&self) -> bool {
        self.backing_files_safe_to_delete
    }

    /// Consume this detailed error and return the underlying `nbd-cow` error.
    pub fn into_inner(self) -> error::NbdCowError {
        self.source
    }
}

impl std::fmt::Display for PooledDestroyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.source.fmt(f)
    }
}

impl std::error::Error for PooledDestroyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

impl From<error::NbdCowError> for PooledDestroyError {
    fn from(source: error::NbdCowError) -> Self {
        Self::device_cleanup(source)
    }
}

struct PooledCowFinalizer<T, E = error::NbdCowError>
where
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    handle: Option<JoinHandle<std::result::Result<T, E>>>,
}

impl<T, E> PooledCowFinalizer<T, E>
where
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    fn new(handle: JoinHandle<std::result::Result<T, E>>) -> Self {
        Self {
            handle: Some(handle),
        }
    }
}

impl<T, E> Future for PooledCowFinalizer<T, E>
where
    T: Send + 'static,
    E: From<error::NbdCowError> + std::fmt::Display + Send + 'static,
{
    type Output = std::result::Result<T, E>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let Some(handle) = this.handle.as_mut() else {
            return Poll::Ready(Err(E::from(error::NbdCowError::Io(std::io::Error::other(
                "pooled NBD COW finalizer polled after completion",
            )))));
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

impl<T, E> Drop for PooledCowFinalizer<T, E>
where
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
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

fn finish_finalizer_join<T, E>(
    result: std::result::Result<std::result::Result<T, E>, tokio::task::JoinError>,
) -> std::result::Result<T, E>
where
    E: From<error::NbdCowError>,
{
    match result {
        Ok(result) => result,
        Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
        Err(e) => Err(E::from(error::NbdCowError::Io(std::io::Error::other(
            format!("pooled NBD COW finalizer task was cancelled: {e}"),
        )))),
    }
}

async fn observe_detached_finalizer<T, E>(handle: JoinHandle<std::result::Result<T, E>>)
where
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
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

async fn run_netlink_critical_section<T>(
    operation: &'static str,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T>
where
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(value) => Ok(value),
        Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
        Err(e) => Err(error::NbdCowError::Io(std::io::Error::other(format!(
            "{operation} task was cancelled: {e}",
        )))),
    }
}

struct DeferredLease {
    pool: pool::DevicePoolHandle,
    lease: Option<pool::DeviceLease>,
}

impl DeferredLease {
    fn new(pool: pool::DevicePoolHandle, lease: pool::DeviceLease) -> Self {
        Self {
            pool,
            lease: Some(lease),
        }
    }

    fn take(&mut self) -> Option<pool::DeviceLease> {
        self.lease.take()
    }
}

impl Drop for DeferredLease {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            self.pool.retire_uncertain_detached(lease);
        }
    }
}

struct ConnectDeviceOutcome {
    device_index: u32,
    lease: DeferredLease,
    result: Option<std::result::Result<netlink::ConnectDeviceSuccess, netlink::ConnectDeviceError>>,
}

impl ConnectDeviceOutcome {
    fn new(
        device_index: u32,
        lease: DeferredLease,
        result: std::result::Result<netlink::ConnectDeviceSuccess, netlink::ConnectDeviceError>,
    ) -> Self {
        Self {
            device_index,
            lease,
            result: Some(result),
        }
    }

    fn into_parts(
        mut self,
    ) -> std::result::Result<
        (
            pool::DeviceLease,
            std::result::Result<netlink::ConnectDeviceSuccess, netlink::ConnectDeviceError>,
        ),
        netlink::ConnectDeviceError,
    > {
        let result = match self.result.take() {
            Some(result) => result,
            None => Err(netlink::ConnectDeviceError::NotSent {
                source: error::NbdCowError::Io(std::io::Error::other(
                    "connect device outcome consumed twice",
                )),
            })?,
        };
        match self.lease.take() {
            Some(lease) => Ok((lease, result)),
            None => Err(netlink::ConnectDeviceError::NotSent {
                source: error::NbdCowError::Io(std::io::Error::other(
                    "connect device lease consumed twice",
                )),
            }),
        }
    }
}

impl Drop for ConnectDeviceOutcome {
    fn drop(&mut self) {
        let Some(result) = self.result.take() else {
            return;
        };

        let connect_tid = match result {
            Ok(success) => success.connect_tid,
            Err(netlink::ConnectDeviceError::AmbiguousAfterSend { connect_tid, .. }) => connect_tid,
            Err(
                netlink::ConnectDeviceError::NotSent { .. }
                | netlink::ConnectDeviceError::DefiniteAfterSend { .. },
            ) => return,
        };

        tracing::warn!(
            device_index = self.device_index,
            connect_tid,
            "NBD connect result dropped before observation; disconnecting owned device"
        );
        disconnect_connected_if_owned(ConnectedDevice {
            index: self.device_index,
            connect_tid,
        });
    }
}

async fn connect_device_with_state_critical_section(
    device_index: u32,
    client_fds: Vec<std::os::fd::OwnedFd>,
    size: u64,
    block_size: u64,
    pool: pool::DevicePoolHandle,
    lease: pool::DeviceLease,
) -> std::result::Result<ConnectDeviceOutcome, netlink::ConnectDeviceError> {
    let deferred_lease = DeferredLease::new(pool, lease);
    let outcome = run_netlink_critical_section("NBD connect", move || {
        ConnectDeviceOutcome::new(
            device_index,
            deferred_lease,
            netlink::connect_device_with_state(device_index, &client_fds, size, block_size),
        )
    })
    .await
    .map_err(|source| netlink::ConnectDeviceError::NotSent { source })?;

    Ok(outcome)
}

struct DisconnectOutcome {
    device_index: u32,
    lease: Option<DeferredLease>,
    result: Option<Result<()>>,
}

impl DisconnectOutcome {
    fn new(device_index: u32, result: Result<()>) -> Self {
        Self {
            device_index,
            lease: None,
            result: Some(result),
        }
    }

    fn with_lease(device_index: u32, lease: DeferredLease, result: Result<()>) -> Self {
        Self {
            device_index,
            lease: Some(lease),
            result: Some(result),
        }
    }

    fn into_result(mut self) -> Result<()> {
        match self.result.take() {
            Some(result) => result,
            None => Err(error::NbdCowError::Io(std::io::Error::other(
                "disconnect outcome consumed twice",
            ))),
        }
    }

    fn into_parts(mut self) -> Result<(pool::DeviceLease, Result<()>)> {
        let result = match self.result.take() {
            Some(result) => result,
            None => Err(error::NbdCowError::Io(std::io::Error::other(
                "disconnect outcome consumed twice",
            )))?,
        };
        let lease = match self.lease.as_mut().and_then(DeferredLease::take) {
            Some(lease) => lease,
            None => {
                return Err(error::NbdCowError::Io(std::io::Error::other(
                    "disconnect outcome lease consumed twice",
                )));
            }
        };
        Ok((lease, result))
    }
}

impl Drop for DisconnectOutcome {
    fn drop(&mut self) {
        if let Some(Err(e)) = self.result.take() {
            tracing::warn!(
                device_index = self.device_index,
                error = %e,
                "detached NBD disconnect failed"
            );
        }
    }
}

async fn disconnect_device_critical_section(device_index: u32) -> Result<()> {
    run_netlink_critical_section("NBD disconnect", move || {
        DisconnectOutcome::new(device_index, netlink::disconnect(device_index))
    })
    .await?
    .into_result()
}

async fn disconnect_device_with_lease_critical_section(
    device_index: u32,
    pool: pool::DevicePoolHandle,
    lease: pool::DeviceLease,
) -> Result<DisconnectOutcome> {
    let deferred_lease = DeferredLease::new(pool, lease);
    run_netlink_critical_section("NBD disconnect", move || {
        DisconnectOutcome::with_lease(
            device_index,
            deferred_lease,
            netlink::disconnect(device_index),
        )
    })
    .await
}

struct OwnedDisconnectOutcome {
    lease: DeferredLease,
    disconnected: Option<bool>,
}

impl OwnedDisconnectOutcome {
    fn new(lease: DeferredLease, disconnected: bool) -> Self {
        Self {
            lease,
            disconnected: Some(disconnected),
        }
    }

    fn into_parts(mut self) -> Result<(pool::DeviceLease, bool)> {
        let disconnected = self.disconnected.take().ok_or_else(|| {
            error::NbdCowError::Io(std::io::Error::other(
                "owned disconnect outcome consumed twice",
            ))
        })?;
        let lease = self.lease.take().ok_or_else(|| {
            error::NbdCowError::Io(std::io::Error::other(
                "owned disconnect outcome lease consumed twice",
            ))
        })?;
        Ok((lease, disconnected))
    }
}

struct OwnedDisconnectResultOutcome {
    lease: DeferredLease,
    result: Option<Result<OwnedDisconnectState>>,
}

impl OwnedDisconnectResultOutcome {
    fn new(lease: DeferredLease, result: Result<OwnedDisconnectState>) -> Self {
        Self {
            lease,
            result: Some(result),
        }
    }

    fn into_parts(mut self) -> Result<(pool::DeviceLease, Result<OwnedDisconnectState>)> {
        let result = self.result.take().ok_or_else(|| {
            error::NbdCowError::Io(std::io::Error::other(
                "owned disconnect result outcome consumed twice",
            ))
        })?;
        let lease = self.lease.take().ok_or_else(|| {
            error::NbdCowError::Io(std::io::Error::other(
                "owned disconnect result outcome lease consumed twice",
            ))
        })?;
        Ok((lease, result))
    }
}

async fn disconnect_connected_if_owned_critical_section(
    connected: ConnectedDevice,
) -> Result<bool> {
    run_netlink_critical_section("owned NBD disconnect", move || {
        disconnect_connected_if_owned(connected)
    })
    .await
}

async fn disconnect_connected_if_owned_result_critical_section(
    connected: ConnectedDevice,
) -> Result<OwnedDisconnectState> {
    run_netlink_critical_section("owned NBD disconnect", move || {
        disconnect_connected_if_owned_result_with(connected, device_ownership, netlink::disconnect)
    })
    .await?
}

async fn disconnect_connected_if_owned_result_with_lease_critical_section(
    connected: ConnectedDevice,
    pool: pool::DevicePoolHandle,
    lease: pool::DeviceLease,
) -> Result<OwnedDisconnectResultOutcome> {
    let deferred_lease = DeferredLease::new(pool, lease);
    run_netlink_critical_section("owned NBD disconnect", move || {
        OwnedDisconnectResultOutcome::new(
            deferred_lease,
            disconnect_connected_if_owned_result_with(
                connected,
                device_ownership,
                netlink::disconnect,
            ),
        )
    })
    .await
}

async fn disconnect_connected_if_owned_with_lease_critical_section(
    connected: ConnectedDevice,
    pool: pool::DevicePoolHandle,
    lease: pool::DeviceLease,
) -> Result<OwnedDisconnectOutcome> {
    let deferred_lease = DeferredLease::new(pool, lease);
    run_netlink_critical_section("owned NBD disconnect", move || {
        OwnedDisconnectOutcome::new(deferred_lease, disconnect_connected_if_owned(connected))
    })
    .await
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

enum OwnedDisconnectState {
    Disconnected,
    Foreign(u32),
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

    fn take_lease(&mut self) -> Option<pool::DeviceLease> {
        self.lease.take()
    }

    fn restore_lease(&mut self, lease: pool::DeviceLease) {
        self.lease = Some(lease);
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
        let disconnected = match self.connected.take() {
            Some(connected) => match self.take_lease() {
                Some(lease) => match disconnect_connected_if_owned_with_lease_critical_section(
                    connected,
                    self.pool.clone(),
                    lease,
                )
                .await
                {
                    Ok(outcome) => match outcome.into_parts() {
                        Ok((lease, disconnected)) => {
                            self.restore_lease(lease);
                            disconnected
                        }
                        Err(e) => {
                            tracing::warn!(
                                device_index = connected.index,
                                error = %e,
                                "owned NBD disconnect result failed during create cleanup"
                            );
                            false
                        }
                    },
                    Err(e) => {
                        tracing::warn!(
                            device_index = connected.index,
                            error = %e,
                            "owned NBD disconnect task failed during create cleanup"
                        );
                        false
                    }
                },
                None => match disconnect_connected_if_owned_critical_section(connected).await {
                    Ok(disconnected) => disconnected,
                    Err(e) => {
                        tracing::warn!(
                            device_index = connected.index,
                            error = %e,
                            "owned NBD disconnect task failed during create cleanup"
                        );
                        false
                    }
                },
            },
            None => false,
        };
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
        let disconnected = match self.connected.take() {
            Some(connected) => match self.take_lease() {
                Some(lease) => match disconnect_device_with_lease_critical_section(
                    connected.index,
                    self.pool.clone(),
                    lease,
                )
                .await
                {
                    Ok(outcome) => match outcome.into_parts() {
                        Ok((lease, disconnect_result)) => {
                            self.restore_lease(lease);
                            match disconnect_result {
                                Ok(()) => true,
                                Err(e) => {
                                    tracing::warn!(
                                        device_index = connected.index,
                                        error = %e,
                                        "NBD disconnect failed during create retry cleanup"
                                    );
                                    false
                                }
                            }
                        }
                        Err(e) => {
                            tracing::warn!(
                                device_index = connected.index,
                                error = %e,
                                "NBD disconnect result failed during create retry cleanup"
                            );
                            false
                        }
                    },
                    Err(e) => {
                        tracing::warn!(
                            device_index = connected.index,
                            error = %e,
                            "NBD disconnect task failed during create retry cleanup"
                        );
                        false
                    }
                },
                None => match disconnect_device_critical_section(connected.index).await {
                    Ok(()) => true,
                    Err(e) => {
                        tracing::warn!(
                            device_index = connected.index,
                            error = %e,
                            "NBD disconnect task failed during create retry cleanup"
                        );
                        false
                    }
                },
            },
            None => false,
        };
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

                let connect_result = match attempt.take_lease() {
                    Some(lease) => {
                        match connect_device_with_state_critical_section(
                            device_index,
                            client_fds,
                            size,
                            BLOCK_SIZE as u64,
                            device_pool.clone(),
                            lease,
                        )
                        .await
                        {
                            Ok(outcome) => match outcome.into_parts() {
                                Ok((lease, result)) => {
                                    attempt.restore_lease(lease);
                                    result
                                }
                                Err(e) => Err(e),
                            },
                            Err(e) => Err(e),
                        }
                    }
                    None => Err(netlink::ConnectDeviceError::NotSent {
                        source: error::NbdCowError::Io(std::io::Error::other(
                            "pool lease missing during NBD connect",
                        )),
                    }),
                };

                match connect_result {
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

fn device_ownership(device_index: u32, connect_tid: u32) -> DeviceOwnership {
    let pid_path = format!("/sys/block/nbd{device_index}/pid");
    match std::fs::read_to_string(&pid_path) {
        Ok(contents) => device_ownership_from_pid_contents(device_index, connect_tid, &contents),
        Err(e) => DeviceOwnership::Unknown(e),
    }
}

fn device_ownership_from_pid_contents(
    device_index: u32,
    connect_tid: u32,
    contents: &str,
) -> DeviceOwnership {
    let pid = contents.trim();
    if pid == "-1" || pid == "0" || pid.is_empty() {
        return DeviceOwnership::Foreign(0);
    }

    match pid.parse::<u32>() {
        Ok(tid) if tid == connect_tid => DeviceOwnership::Ours,
        Ok(tid) => DeviceOwnership::Foreign(tid),
        Err(e) => DeviceOwnership::Unknown(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid NBD device pid for nbd{device_index}: {e}"),
        )),
    }
}

fn disconnect_connected_if_owned(connected: ConnectedDevice) -> bool {
    disconnect_connected_if_owned_with(connected, device_ownership, netlink::disconnect)
}

fn remove_cow_files(cow_file: &Path) -> Result<()> {
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

fn disconnect_connected_if_owned_result_with(
    connected: ConnectedDevice,
    ownership: impl FnOnce(u32, u32) -> DeviceOwnership,
    disconnect: impl FnOnce(u32) -> Result<()>,
) -> Result<OwnedDisconnectState> {
    match ownership(connected.index, connected.connect_tid) {
        DeviceOwnership::Ours => {
            disconnect(connected.index)?;
            Ok(OwnedDisconnectState::Disconnected)
        }
        DeviceOwnership::Foreign(pid) => Ok(OwnedDisconnectState::Foreign(pid)),
        DeviceOwnership::Unknown(err) => Err(error::NbdCowError::Io(std::io::Error::new(
            err.kind(),
            format!(
                "cannot read NBD device ownership for nbd{}: {err}",
                connected.index
            ),
        ))),
    }
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

enum DestroyAttemptError {
    Device(error::NbdCowError),
    Storage(error::NbdCowError),
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

    fn restore(&mut self, lease: pool::DeviceLease) {
        debug_assert!(self.lease.is_none(), "restoring duplicate pool lease");
        self.lease = Some(lease);
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
        let finalizer = self.destroy_with_retries_detailed(policy);
        async move { finalizer.await.map_err(PooledDestroyError::into_inner) }
    }

    /// Destroy the device and distinguish NBD shutdown failures from COW file
    /// cleanup failures.
    ///
    /// Finalization starts immediately. When this returns an error with
    /// [`PooledDestroyError::backing_files_safe_to_delete`] set, the NBD device
    /// was released and callers may safely delete the containing workspace or
    /// snapshot attempt directory.
    pub fn destroy_with_retries_detailed(
        self,
        policy: DestroyRetryPolicy,
    ) -> impl std::future::Future<Output = std::result::Result<(), PooledDestroyError>> + Send + 'static
    {
        // Once finalization starts, let it run to completion even if the caller's
        // future is cancelled. Otherwise dropping the owned device mid-finalizer
        // can disconnect best-effort but leave the pool lease in flight.
        //
        // This must spawn before returning the Future: an `async fn` body would
        // not run if the returned future was dropped before its first poll.
        Self::run_finalizer(async move { self.destroy_with_retries_detailed_inner(policy).await })
    }

    async fn destroy_with_retries_detailed_inner(
        mut self,
        policy: DestroyRetryPolicy,
    ) -> std::result::Result<(), PooledDestroyError> {
        let pool = self.pool.clone();
        Self::destroy_with_mode(
            &mut self.device,
            &mut self.lease,
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
        mut self,
        policy: DestroyRetryPolicy,
    ) -> Result<KeptCow> {
        let pool = self.pool.clone();
        let cow_file = self.device.cow_file().to_path_buf();
        let bitmap_file = self.device.bitmap_path();
        Self::destroy_with_mode(
            &mut self.device,
            &mut self.lease,
            &pool,
            policy,
            DestroyMode::KeepCow,
        )
        .await
        .map_err(PooledDestroyError::into_inner)?;

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
    ) -> std::result::Result<(), PooledDestroyError> {
        let attempts = policy.attempts();

        let mut last_device_err = match Self::run_destroy_attempt(device, lease, pool, mode).await {
            Ok(()) => {
                Self::release_clean(pool, lease).await;
                return Ok(());
            }
            Err(DestroyAttemptError::Storage(source)) => {
                Self::release_clean(pool, lease).await;
                return Err(PooledDestroyError::storage_cleanup(source));
            }
            Err(DestroyAttemptError::Device(source)) => source,
        };

        for _ in 1..attempts {
            tokio::time::sleep(policy.delay).await;
            match Self::run_destroy_attempt(device, lease, pool, mode).await {
                Ok(()) => {
                    Self::release_clean(pool, lease).await;
                    return Ok(());
                }
                Err(DestroyAttemptError::Storage(source)) => {
                    Self::release_clean(pool, lease).await;
                    return Err(PooledDestroyError::storage_cleanup(source));
                }
                Err(DestroyAttemptError::Device(source)) => last_device_err = source,
            }
        }

        device.abandon();
        Self::retire_uncertain(pool, lease).await;
        Err(PooledDestroyError::device_cleanup(last_device_err))
    }

    async fn run_destroy_attempt(
        device: &mut NbdCowDevice,
        lease: &mut LeaseGuard,
        pool: &pool::DevicePoolHandle,
        mode: DestroyMode,
    ) -> std::result::Result<(), DestroyAttemptError> {
        match mode {
            DestroyMode::RemoveCow => {
                Self::shutdown_device_with_lease(device, lease, pool, false)
                    .await
                    .map_err(DestroyAttemptError::Device)?;
                remove_cow_files(&device.cow_file).map_err(DestroyAttemptError::Storage)
            }
            DestroyMode::KeepCow => Self::shutdown_device_with_lease(device, lease, pool, true)
                .await
                .map_err(DestroyAttemptError::Device),
        }
    }

    async fn shutdown_device_with_lease(
        device: &mut NbdCowDevice,
        lease: &mut LeaseGuard,
        pool: &pool::DevicePoolHandle,
        save_bitmap: bool,
    ) -> Result<()> {
        device.prepare_shutdown(save_bitmap).await?;

        if !device.disconnected {
            let connected = ConnectedDevice {
                index: device.device_index,
                connect_tid: device.connect_tid,
            };
            let Some(device_lease) = lease.take() else {
                return Err(error::NbdCowError::Io(std::io::Error::other(
                    "pool lease missing during pooled NBD shutdown",
                )));
            };
            let outcome = disconnect_connected_if_owned_result_with_lease_critical_section(
                connected,
                pool.clone(),
                device_lease,
            )
            .await?;
            let (device_lease, disconnect_result) = outcome.into_parts()?;
            lease.restore(device_lease);
            device.apply_owned_disconnect_state(disconnect_result?);
        }

        device.wait_for_kernel_release().await;
        Ok(())
    }

    /// Mark the device as abandoned and retire the pool lease as uncertain.
    ///
    /// Must be called from a Tokio runtime.
    pub fn abandon(self) -> impl std::future::Future<Output = ()> + Send + 'static {
        let finalizer = Self::run_finalizer(async move {
            self.abandon_inner().await;
            Ok::<(), error::NbdCowError>(())
        });
        async move {
            if let Err(e) = finalizer.await {
                tracing::warn!(error = %e, "pooled NBD COW abandon finalizer failed");
            }
        }
    }

    async fn abandon_inner(mut self) {
        let pool = self.pool.clone();
        self.device.abandon();
        Self::retire_uncertain(&pool, &mut self.lease).await;
    }

    fn run_finalizer<T, E>(
        future: impl std::future::Future<Output = std::result::Result<T, E>> + Send + 'static,
    ) -> PooledCowFinalizer<T, E>
    where
        T: Send + 'static,
        E: From<error::NbdCowError> + std::fmt::Display + Send + 'static,
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

        fn replace_cow_file_with_directory(&self) {
            std::fs::remove_file(&self.cow_file).expect("remove cow file");
            std::fs::create_dir(&self.cow_file).expect("create cow directory");
        }
    }

    fn zero_attempt_destroy_policy() -> DestroyRetryPolicy {
        DestroyRetryPolicy {
            attempts: 0,
            delay: std::time::Duration::from_secs(60),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn netlink_critical_section_current_thread_runtime_runs() {
        let value = run_netlink_critical_section("test netlink operation", || "connected")
            .await
            .unwrap();

        assert_eq!(value, "connected");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn netlink_critical_section_multi_thread_runtime_runs() {
        let value = run_netlink_critical_section("test netlink operation", || "connected")
            .await
            .unwrap();

        assert_eq!(value, "connected");
    }

    #[test]
    fn netlink_critical_section_block_on_multi_thread_runtime_runs() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let value = runtime.block_on(async {
            run_netlink_critical_section("test netlink operation", || "connected")
                .await
                .unwrap()
        });

        assert_eq!(value, "connected");
    }

    #[test]
    fn netlink_critical_section_entered_multi_thread_runtime_runs() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _guard = runtime.enter();
        let value = runtime.block_on(async {
            run_netlink_critical_section("test netlink operation", || "connected")
                .await
                .unwrap()
        });

        assert_eq!(value, "connected");
    }

    #[test]
    fn netlink_critical_section_local_set_multi_thread_runtime_runs() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let local = tokio::task::LocalSet::new();
        let value = local.block_on(&runtime, async {
            run_netlink_critical_section("test netlink operation", || "connected")
                .await
                .unwrap()
        });

        assert_eq!(value, "connected");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn netlink_critical_section_continues_after_awaiter_abort() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();

        let handle = tokio::spawn(async move {
            run_netlink_critical_section("test netlink operation", move || {
                let _ = started_tx.send(());
                finish_rx.recv().expect("finish signal");
                let _ = done_tx.send(());
            })
            .await
            .unwrap();
        });

        started_rx.await.unwrap();
        handle.abort();
        finish_tx.send(()).unwrap();

        tokio::time::timeout(std::time::Duration::from_secs(1), done_rx)
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn netlink_critical_section_queued_task_drops_unobserved_output() {
        struct DropNotify(Option<std::sync::mpsc::Sender<()>>);

        impl Drop for DropNotify {
            fn drop(&mut self) {
                if let Some(tx) = self.0.take() {
                    let _ = tx.send(());
                }
            }
        }

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .max_blocking_threads(1)
            .enable_time()
            .build()
            .unwrap();

        runtime.block_on(async {
            let (blocker_started_tx, blocker_started_rx) = tokio::sync::oneshot::channel();
            let (release_blocker_tx, release_blocker_rx) = std::sync::mpsc::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                let _ = blocker_started_tx.send(());
                release_blocker_rx.recv().unwrap();
            });
            blocker_started_rx.await.unwrap();

            let (dropped_tx, dropped_rx) = std::sync::mpsc::channel();
            let mut future = Box::pin(run_netlink_critical_section(
                "test netlink operation",
                move || DropNotify(Some(dropped_tx)),
            ));
            let waker = std::task::Waker::noop();
            let mut cx = std::task::Context::from_waker(waker);
            assert!(matches!(
                future.as_mut().poll(&mut cx),
                std::task::Poll::Pending
            ));
            drop(future);

            release_blocker_tx.send(()).unwrap();
            blocker.await.unwrap();

            tokio::task::spawn_blocking(move || {
                dropped_rx
                    .recv_timeout(std::time::Duration::from_secs(1))
                    .unwrap()
            })
            .await
            .unwrap();
        });
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
            Ok::<(), error::NbdCowError>(())
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
        let finalizer = PooledNbdCowDevice::run_finalizer::<(), error::NbdCowError>(async move {
            panic!("pooled finalizer panic")
        });

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
    async fn destroy_with_retries_reports_cow_removal_failure() {
        let harness = PooledDestroyHarness::new();
        harness.replace_cow_file_with_directory();
        let PooledDestroyHarness {
            _tmp,
            cow_file,
            pool,
            device,
            ..
        } = harness;

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            device.destroy_with_retries(zero_attempt_destroy_policy()),
        )
        .await
        .expect("destroy should not sleep before returning the first error");

        let err = result.expect_err("destroy should report cow removal failure");
        assert!(
            err.to_string().contains("failed to remove"),
            "unexpected error: {err}"
        );
        assert!(cow_file.is_dir());
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn detailed_destroy_reports_storage_failure_as_safe_to_delete() {
        let harness = PooledDestroyHarness::new();
        harness.replace_cow_file_with_directory();
        let PooledDestroyHarness { pool, device, .. } = harness;

        let err = device
            .destroy_with_retries_detailed(zero_attempt_destroy_policy())
            .await
            .expect_err("destroy should report cow removal failure");

        assert!(
            err.backing_files_safe_to_delete(),
            "storage cleanup errors must not be treated as NBD ownership failures"
        );
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn detailed_destroy_storage_failure_does_not_sleep_before_returning() {
        let harness = PooledDestroyHarness::new();
        harness.replace_cow_file_with_directory();
        let PooledDestroyHarness { pool, device, .. } = harness;

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            device.destroy_with_retries_detailed(DestroyRetryPolicy {
                attempts: 2,
                delay: std::time::Duration::from_secs(60),
            }),
        )
        .await
        .expect("storage cleanup failures should not wait for device retry delay");

        let err = result.expect_err("destroy should report cow removal failure");
        assert!(err.backing_files_safe_to_delete());
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
    fn device_ownership_parses_matching_pid_as_ours() {
        let ownership = device_ownership_from_pid_contents(7, 42, "42\n");

        assert!(matches!(ownership, DeviceOwnership::Ours));
    }

    #[test]
    fn device_ownership_treats_empty_or_nonpositive_pid_as_released() {
        for contents in ["", "0\n", "-1\n"] {
            let ownership = device_ownership_from_pid_contents(7, 42, contents);

            assert!(matches!(ownership, DeviceOwnership::Foreign(0)));
        }
    }

    #[test]
    fn device_ownership_reports_malformed_pid_as_unknown() {
        let ownership = device_ownership_from_pid_contents(7, 42, "not-a-pid\n");

        match ownership {
            DeviceOwnership::Unknown(e) => {
                assert_eq!(e.kind(), std::io::ErrorKind::InvalidData);
                assert!(e.to_string().contains("invalid NBD device pid for nbd7"));
            }
            _ => panic!("malformed pid must not be treated as released or foreign"),
        }
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
    fn disconnect_connected_if_owned_result_disconnects_matching_owner() {
        let calls = std::cell::Cell::new(0);
        let connected = ConnectedDevice {
            index: 7,
            connect_tid: 42,
        };

        let result = disconnect_connected_if_owned_result_with(
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
        )
        .expect("matching owner should disconnect");

        assert!(matches!(result, OwnedDisconnectState::Disconnected));
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
    fn disconnect_connected_if_owned_result_skips_foreign_owner() {
        let connected = ConnectedDevice {
            index: 7,
            connect_tid: 42,
        };

        let result = disconnect_connected_if_owned_result_with(
            connected,
            |index, tid| {
                assert_eq!(index, 7);
                assert_eq!(tid, 42);
                DeviceOwnership::Foreign(100)
            },
            |_| panic!("foreign device must not be disconnected"),
        )
        .expect("foreign owner should be reported");

        assert!(matches!(result, OwnedDisconnectState::Foreign(100)));
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
    fn disconnect_connected_if_owned_result_errors_on_unknown_owner() {
        let connected = ConnectedDevice {
            index: 7,
            connect_tid: 42,
        };

        let result = disconnect_connected_if_owned_result_with(
            connected,
            |index, tid| {
                assert_eq!(index, 7);
                assert_eq!(tid, 42);
                DeviceOwnership::Unknown(std::io::Error::other("sysfs unavailable"))
            },
            |_| panic!("unknown ownership must not be disconnected"),
        );

        match result {
            Err(error::NbdCowError::Io(e)) => {
                assert!(e.to_string().contains("cannot read NBD device ownership"));
            }
            Err(e) => panic!("expected I/O error, got {e}"),
            Ok(_) => panic!("unknown owner should fail shutdown ownership check"),
        }
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
