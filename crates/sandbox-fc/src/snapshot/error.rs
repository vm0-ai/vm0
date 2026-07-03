use crate::api::ApiError;

/// Errors that can occur during Firecracker snapshot creation.
///
/// These are the backend-specific errors returned by direct calls to
/// [`create_snapshot`](super::create_snapshot). When snapshotting is invoked
/// through [`FirecrackerSnapshotProvider`](super::FirecrackerSnapshotProvider),
/// they are converted into the provider-neutral `sandbox::SnapshotError`
/// categories.
///
/// A failed attempt should be treated as not producing a usable snapshot.
/// Cleanup is best-effort on most failure paths: stale output artifacts are
/// removed at the start of the next attempt where possible, while some backend
/// resources may need the runner garbage collector or operator inspection.
#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    /// Host or guest setup failed before a valid snapshot was finalized.
    ///
    /// This includes prerequisite checks, output/work/socket path setup, COW
    /// file and NBD device preparation, network namespace setup/acquisition,
    /// and guest pre-warm command execution. Retry is meaningful after fixing
    /// the reported prerequisite/configuration issue or after a transient
    /// resource failure clears.
    #[error("setup failed: {0}")]
    Setup(String),
    /// The Firecracker launch path failed at the process boundary.
    ///
    /// This includes failing to spawn the `unshare`/network-namespace
    /// Firecracker command and cases where that launch chain exits early and an
    /// API timeout is reclassified with the captured process stderr. The
    /// snapshot output is not valid.
    #[error("firecracker process failed: {0}")]
    Process(String),
    /// Snapshot resource teardown failed after the workflow had otherwise
    /// reached the finalization phase.
    ///
    /// Currently this is used when `destroy_keep_cow` exhausts its retries.
    /// The NBD device is abandoned for later garbage collection and the
    /// snapshot is aborted rather than publishing a COW file without a trusted
    /// bitmap sidecar.
    #[error("teardown failed: {0}")]
    Teardown(String),
    /// The Firecracker API failed while waiting for readiness, configuring the
    /// VM, starting the instance, pausing it, or asking Firecracker to write
    /// snapshot state and memory files.
    #[error("api error: {0}")]
    Api(#[from] ApiError),
    /// The guest did not establish the expected vsock readiness connection, or
    /// the listener task failed while waiting for it.
    ///
    /// Firecracker may already be running when this happens, but the snapshot
    /// workflow has not reached the pre-warm, pause, or snapshot stages.
    #[error("vsock connection failed: {0}")]
    Vsock(String),
    /// A host filesystem I/O operation failed while creating directories,
    /// moving finalized COW artifacts, or syncing the output directory.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl SnapshotError {
    pub(super) fn into_sandbox_error(self) -> sandbox::SnapshotError {
        match self {
            Self::Setup(msg) => sandbox::SnapshotError::Setup(msg),
            Self::Process(msg) => sandbox::SnapshotError::Process(msg),
            Self::Teardown(msg) => sandbox::SnapshotError::Teardown(msg),
            Self::Api(api_err) => sandbox::SnapshotError::Api(api_err.to_string()),
            Self::Vsock(msg) => sandbox::SnapshotError::Vsock(msg),
            Self::Io(io_err) => sandbox::SnapshotError::Io(io_err),
        }
    }
}
