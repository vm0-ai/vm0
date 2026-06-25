use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::error::{self, Result};
use crate::{BLOCK_SIZE, DEFAULT_FLUSH_THRESHOLD, NUM_CONNECTIONS, cow, netlink, pool, server};
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::NbdCowDevice;
use super::connection::{
    ConnectedDevice, OwnedDisconnectState, connect_device_with_state_critical_section,
    disconnect_connected_if_owned, disconnect_connected_if_owned_result_critical_section,
    disconnect_connected_if_owned_result_with_lease_critical_section,
    disconnect_device_with_lease_critical_section,
};

struct CreateAttemptGuard {
    pool: pool::DevicePoolHandle,
    device_index: u32,
    lease: Option<pool::DeviceLease>,
    shutdown: CancellationToken,
    server_handles: Vec<JoinHandle<()>>,
    connected: Option<ConnectedDevice>,
}

#[derive(Clone, Copy)]
enum CreateDisconnectCleanupMode {
    AmbiguousConnect,
    SizeRetry,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CreateDisconnectStatus {
    Disconnected,
    Uncertain,
}

impl CreateDisconnectStatus {
    fn from_owned_result(result: &Result<OwnedDisconnectState>) -> Self {
        match result {
            Ok(OwnedDisconnectState::Disconnected) => Self::Disconnected,
            // In create cleanup, a foreign owner means this attempt did not
            // prove its provisional device was disconnected.
            Ok(OwnedDisconnectState::Foreign(_)) | Err(_) => Self::Uncertain,
        }
    }

    fn from_unconditional_result(result: &Result<()>) -> Self {
        match result {
            Ok(()) => Self::Disconnected,
            Err(_) => Self::Uncertain,
        }
    }

    fn is_clean(self) -> bool {
        matches!(self, Self::Disconnected)
    }
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

    async fn disconnect_owned_and_release(self) {
        self.disconnect_for_cleanup_and_release(CreateDisconnectCleanupMode::AmbiguousConnect)
            .await;
    }

    async fn disconnect_and_release(self) -> bool {
        self.disconnect_for_cleanup_and_release(CreateDisconnectCleanupMode::SizeRetry)
            .await
    }

    async fn disconnect_for_cleanup_and_release(
        mut self,
        mode: CreateDisconnectCleanupMode,
    ) -> bool {
        self.abort_servers().await;
        let status = match self.connected.take() {
            Some(connected) => self.disconnect_current_for_cleanup(mode, connected).await,
            None => CreateDisconnectStatus::Uncertain,
        };
        if let Some(lease) = self.lease.take() {
            if status.is_clean() {
                self.pool.release_clean(lease).await;
            } else {
                self.pool.retire_uncertain(lease).await;
            }
        }
        status.is_clean()
    }

    async fn disconnect_current_for_cleanup(
        &mut self,
        mode: CreateDisconnectCleanupMode,
        connected: ConnectedDevice,
    ) -> CreateDisconnectStatus {
        match mode {
            CreateDisconnectCleanupMode::AmbiguousConnect => {
                self.disconnect_owned_for_cleanup(mode, connected).await
            }
            CreateDisconnectCleanupMode::SizeRetry => {
                self.disconnect_size_retry_for_cleanup(connected).await
            }
        }
    }

    async fn disconnect_size_retry_for_cleanup(
        &mut self,
        connected: ConnectedDevice,
    ) -> CreateDisconnectStatus {
        let Some(lease) = self.take_lease() else {
            tracing::warn!(
                device_index = connected.index,
                "pool lease missing during create retry cleanup; using owned NBD disconnect fallback"
            );
            return self
                .disconnect_owned_for_cleanup(CreateDisconnectCleanupMode::SizeRetry, connected)
                .await;
        };

        match disconnect_device_with_lease_critical_section(
            connected.index,
            self.pool.clone(),
            lease,
        )
        .await
        {
            Ok(outcome) => match outcome.into_parts() {
                Ok((lease, disconnect_result)) => {
                    self.restore_lease(lease);
                    self.unconditional_disconnect_status(connected, disconnect_result)
                }
                Err(e) => {
                    tracing::warn!(
                        device_index = connected.index,
                        error = %e,
                        "NBD disconnect result failed during create retry cleanup"
                    );
                    CreateDisconnectStatus::Uncertain
                }
            },
            Err(e) => {
                tracing::warn!(
                    device_index = connected.index,
                    error = %e,
                    "NBD disconnect task failed during create retry cleanup"
                );
                CreateDisconnectStatus::Uncertain
            }
        }
    }

    async fn disconnect_owned_for_cleanup(
        &mut self,
        mode: CreateDisconnectCleanupMode,
        connected: ConnectedDevice,
    ) -> CreateDisconnectStatus {
        match self.take_lease() {
            Some(lease) => {
                match disconnect_connected_if_owned_result_with_lease_critical_section(
                    connected,
                    self.pool.clone(),
                    lease,
                )
                .await
                {
                    Ok(outcome) => match outcome.into_parts() {
                        Ok((lease, disconnect_result)) => {
                            self.restore_lease(lease);
                            self.owned_disconnect_status(mode, connected, disconnect_result)
                        }
                        Err(e) => {
                            log_owned_disconnect_result_failed(mode, connected, &e);
                            CreateDisconnectStatus::Uncertain
                        }
                    },
                    Err(e) => {
                        log_owned_disconnect_task_failed(mode, connected, &e);
                        CreateDisconnectStatus::Uncertain
                    }
                }
            }
            None => match disconnect_connected_if_owned_result_critical_section(connected).await {
                Ok(disconnect_state) => {
                    self.owned_disconnect_status(mode, connected, Ok(disconnect_state))
                }
                Err(e) => {
                    log_owned_disconnect_failed(mode, connected, &e);
                    CreateDisconnectStatus::Uncertain
                }
            },
        }
    }

    fn owned_disconnect_status(
        &self,
        mode: CreateDisconnectCleanupMode,
        connected: ConnectedDevice,
        disconnect_result: Result<OwnedDisconnectState>,
    ) -> CreateDisconnectStatus {
        let status = CreateDisconnectStatus::from_owned_result(&disconnect_result);
        match disconnect_result {
            Ok(OwnedDisconnectState::Disconnected) => {}
            Ok(OwnedDisconnectState::Foreign(pid)) => {
                log_owned_disconnect_foreign(mode, connected, pid);
            }
            Err(e) => {
                log_owned_disconnect_failed(mode, connected, &e);
            }
        }
        status
    }

    fn unconditional_disconnect_status(
        &self,
        connected: ConnectedDevice,
        disconnect_result: Result<()>,
    ) -> CreateDisconnectStatus {
        let status = CreateDisconnectStatus::from_unconditional_result(&disconnect_result);
        if let Err(e) = disconnect_result {
            tracing::warn!(
                device_index = connected.index,
                error = %e,
                "NBD disconnect failed during create retry cleanup"
            );
        }
        status
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

fn log_owned_disconnect_result_failed(
    mode: CreateDisconnectCleanupMode,
    connected: ConnectedDevice,
    error: &error::NbdCowError,
) {
    match mode {
        CreateDisconnectCleanupMode::AmbiguousConnect => {
            tracing::warn!(
                device_index = connected.index,
                error = %error,
                "owned NBD disconnect result failed during create cleanup"
            );
        }
        CreateDisconnectCleanupMode::SizeRetry => {
            tracing::warn!(
                device_index = connected.index,
                error = %error,
                "owned NBD disconnect result failed during create retry cleanup"
            );
        }
    }
}

fn log_owned_disconnect_task_failed(
    mode: CreateDisconnectCleanupMode,
    connected: ConnectedDevice,
    error: &error::NbdCowError,
) {
    match mode {
        CreateDisconnectCleanupMode::AmbiguousConnect => {
            tracing::warn!(
                device_index = connected.index,
                error = %error,
                "owned NBD disconnect task failed during create cleanup"
            );
        }
        CreateDisconnectCleanupMode::SizeRetry => {
            tracing::warn!(
                device_index = connected.index,
                error = %error,
                "owned NBD disconnect task failed during create retry cleanup"
            );
        }
    }
}

fn log_owned_disconnect_failed(
    mode: CreateDisconnectCleanupMode,
    connected: ConnectedDevice,
    error: &error::NbdCowError,
) {
    match mode {
        CreateDisconnectCleanupMode::AmbiguousConnect => {
            tracing::warn!(
                device_index = connected.index,
                error = %error,
                "owned NBD disconnect failed during create cleanup"
            );
        }
        CreateDisconnectCleanupMode::SizeRetry => {
            tracing::warn!(
                device_index = connected.index,
                error = %error,
                "owned NBD disconnect failed during create retry cleanup"
            );
        }
    }
}

fn log_owned_disconnect_foreign(
    mode: CreateDisconnectCleanupMode,
    connected: ConnectedDevice,
    foreign_pid: u32,
) {
    match mode {
        CreateDisconnectCleanupMode::AmbiguousConnect => {
            tracing::warn!(
                device_index = connected.index,
                foreign_pid,
                "skipping create cleanup disconnect: device recycled by another process"
            );
        }
        CreateDisconnectCleanupMode::SizeRetry => {
            tracing::warn!(
                device_index = connected.index,
                foreign_pid,
                "skipping create retry cleanup disconnect: device recycled by another process"
            );
        }
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
    pub(super) async fn create_inner(
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
}

async fn abort_server_handles(handles: Vec<JoinHandle<()>>) {
    for handle in &handles {
        handle.abort();
    }
    for handle in handles {
        let _ = handle.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_disconnect_status_maps_owned_results() {
        let disconnected: Result<OwnedDisconnectState> = Ok(OwnedDisconnectState::Disconnected);
        assert_eq!(
            CreateDisconnectStatus::from_owned_result(&disconnected),
            CreateDisconnectStatus::Disconnected
        );
        assert!(CreateDisconnectStatus::from_owned_result(&disconnected).is_clean());

        let foreign: Result<OwnedDisconnectState> = Ok(OwnedDisconnectState::Foreign(100));
        assert_eq!(
            CreateDisconnectStatus::from_owned_result(&foreign),
            CreateDisconnectStatus::Uncertain
        );
        assert!(!CreateDisconnectStatus::from_owned_result(&foreign).is_clean());

        let unknown: Result<OwnedDisconnectState> = Err(error::NbdCowError::Io(
            std::io::Error::other("ownership unknown"),
        ));
        assert_eq!(
            CreateDisconnectStatus::from_owned_result(&unknown),
            CreateDisconnectStatus::Uncertain
        );
        assert!(!CreateDisconnectStatus::from_owned_result(&unknown).is_clean());
    }

    #[test]
    fn create_disconnect_status_maps_unconditional_results() {
        let disconnected: Result<()> = Ok(());
        assert_eq!(
            CreateDisconnectStatus::from_unconditional_result(&disconnected),
            CreateDisconnectStatus::Disconnected
        );
        assert!(CreateDisconnectStatus::from_unconditional_result(&disconnected).is_clean());

        let failed: Result<()> = Err(error::NbdCowError::Io(std::io::Error::other(
            "disconnect failed",
        )));
        assert_eq!(
            CreateDisconnectStatus::from_unconditional_result(&failed),
            CreateDisconnectStatus::Uncertain
        );
        assert!(!CreateDisconnectStatus::from_unconditional_result(&failed).is_clean());
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
}
