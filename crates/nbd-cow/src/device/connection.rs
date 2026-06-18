use crate::error::{self, Result};
use crate::{netlink, pool};

pub(super) async fn run_netlink_critical_section<T>(
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

pub(super) struct ConnectDeviceOutcome {
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

    pub(super) fn into_parts(
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

pub(super) async fn connect_device_with_state_critical_section(
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

pub(super) struct DisconnectOutcome {
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

    pub(super) fn into_result(mut self) -> Result<()> {
        match self.result.take() {
            Some(result) => result,
            None => Err(error::NbdCowError::Io(std::io::Error::other(
                "disconnect outcome consumed twice",
            ))),
        }
    }

    pub(super) fn into_parts(mut self) -> Result<(pool::DeviceLease, Result<()>)> {
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

pub(super) async fn disconnect_device_critical_section(device_index: u32) -> Result<()> {
    run_netlink_critical_section("NBD disconnect", move || {
        DisconnectOutcome::new(device_index, netlink::disconnect(device_index))
    })
    .await?
    .into_result()
}

pub(super) async fn disconnect_device_with_lease_critical_section(
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

pub(super) struct OwnedDisconnectOutcome {
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

    pub(super) fn into_parts(mut self) -> Result<(pool::DeviceLease, bool)> {
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

pub(super) struct OwnedDisconnectResultOutcome {
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

    pub(super) fn into_parts(
        mut self,
    ) -> Result<(pool::DeviceLease, Result<OwnedDisconnectState>)> {
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

pub(super) async fn disconnect_connected_if_owned_critical_section(
    connected: ConnectedDevice,
) -> Result<bool> {
    run_netlink_critical_section("owned NBD disconnect", move || {
        disconnect_connected_if_owned(connected)
    })
    .await
}

pub(super) async fn disconnect_connected_if_owned_result_critical_section(
    connected: ConnectedDevice,
) -> Result<OwnedDisconnectState> {
    run_netlink_critical_section("owned NBD disconnect", move || {
        disconnect_connected_if_owned_result_with(connected, device_ownership, netlink::disconnect)
    })
    .await?
}

pub(super) async fn disconnect_connected_if_owned_result_with_lease_critical_section(
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

pub(super) async fn disconnect_connected_if_owned_with_lease_critical_section(
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
pub(super) enum DeviceOwnership {
    /// We own the device (sysfs PID matches our PID).
    Ours,
    /// Another process owns the device (with its PID).
    Foreign(u32),
    /// Cannot determine ownership (sysfs read failed).
    Unknown(std::io::Error),
}

#[derive(Clone, Copy)]
pub(super) struct ConnectedDevice {
    pub(super) index: u32,
    pub(super) connect_tid: u32,
}

pub(super) enum OwnedDisconnectState {
    Disconnected,
    Foreign(u32),
}

pub(super) fn device_ownership(device_index: u32, connect_tid: u32) -> DeviceOwnership {
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

pub(super) fn disconnect_connected_if_owned(connected: ConnectedDevice) -> bool {
    disconnect_connected_if_owned_with(connected, device_ownership, netlink::disconnect)
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

#[cfg(test)]
mod tests {
    use super::*;

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
