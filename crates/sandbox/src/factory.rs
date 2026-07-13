use async_trait::async_trait;
use std::time::Duration;

use crate::config::SandboxConfig;
use crate::error::Result;
use crate::sandbox::Sandbox;

/// Low-cardinality stages inside sandbox factory creation.
///
/// The current stage set matches the factory boundaries that runner telemetry
/// needs to attribute. Providers that do not expose a matching internal
/// boundary can ignore the observer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxCreateStage {
    CowPoolAcquire,
    WorkspaceDirRename,
    WorkspaceDrivePrepare,
    WorkspaceSeedSparseCopy,
    WorkspaceFreshFormat,
    SockDirPrepare,
    NetnsAcquire,
    NbdCowCreate,
}

impl SandboxCreateStage {
    /// All create stages in the stable order used by telemetry tests.
    pub const ALL: [Self; 8] = [
        Self::CowPoolAcquire,
        Self::WorkspaceDirRename,
        Self::WorkspaceDrivePrepare,
        Self::WorkspaceSeedSparseCopy,
        Self::WorkspaceFreshFormat,
        Self::SockDirPrepare,
        Self::NetnsAcquire,
        Self::NbdCowCreate,
    ];
}

/// Fixed NBD COW details nested under [`SandboxCreateStage::NbdCowCreate`].
///
/// [`Self::DeviceScan`] is nested inside [`Self::DeviceAcquire`]. Every other
/// duration is a peer contribution to the NBD create parent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxNbdCowCreateStage {
    CowLayerCreate,
    DeviceAcquire,
    DeviceScan,
    DispatchSetup,
    NetlinkConnect,
    SizeVerify,
    RetryCleanup,
    RetryDelay,
}

impl SandboxNbdCowCreateStage {
    /// All NBD COW detail stages in stable telemetry order.
    pub const ALL: [Self; 8] = [
        Self::CowLayerCreate,
        Self::DeviceAcquire,
        Self::DeviceScan,
        Self::DispatchSetup,
        Self::NetlinkConnect,
        Self::SizeVerify,
        Self::RetryCleanup,
        Self::RetryDelay,
    ];
}

/// Fixed details nested under [`SandboxNbdCowCreateStage::NetlinkConnect`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxNbdNetlinkConnectStage {
    BlockingTaskQueue,
    SocketSetup,
    FamilyResolve,
    ConnectCommand,
}

impl SandboxNbdNetlinkConnectStage {
    /// All NBD netlink connect stages in stable telemetry order.
    pub const ALL: [Self; 4] = [
        Self::BlockingTaskQueue,
        Self::SocketSetup,
        Self::FamilyResolve,
        Self::ConnectCommand,
    ];
}

/// Fixed low-cardinality NBD COW outcomes for sandbox-create telemetry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxNbdCowCreateOutcome {
    AcquireSourceDemandScan,
    AcquireSourceCooledClaim,
    EbusyRetriesNone,
    EbusyRetriesOne,
    EbusyRetriesMultiple,
    SizeZeroRetriesNone,
    SizeZeroRetriesOne,
    SizeZeroRetriesMultiple,
}

/// Receives low-cardinality sandbox factory create stage timings.
pub trait SandboxCreateObserver: Send {
    fn record_stage(&mut self, stage: SandboxCreateStage, duration: Duration, success: bool);

    /// Record one aggregate NBD COW detail stage.
    fn record_nbd_cow_stage(
        &mut self,
        _stage: SandboxNbdCowCreateStage,
        _duration: Duration,
        _success: bool,
    ) {
    }

    /// Record one aggregate stage nested inside NBD netlink connect.
    fn record_nbd_netlink_connect_stage(
        &mut self,
        _stage: SandboxNbdNetlinkConnectStage,
        _duration: Duration,
        _success: bool,
    ) {
    }

    /// Record one bounded NBD COW outcome.
    fn record_nbd_cow_outcome(&mut self, _outcome: SandboxNbdCowCreateOutcome) {}
}

/// Creates and owns the normal teardown path for sandboxes in one profile.
///
/// A factory is the per-profile object produced by
/// [`SandboxRuntime`](crate::SandboxRuntime) from a
/// [`FactoryConfig`](crate::FactoryConfig). It converts per-sandbox
/// [`SandboxConfig`] values into provider-specific [`Sandbox`] instances and
/// owns the normal explicit cleanup path for those instances.
///
/// # Lifecycle
///
/// Callers normally create a runtime, ask it for one or more factories, create
/// sandboxes through those factories, release each sandbox with
/// [`destroy`](Self::destroy), shut down each factory with
/// [`shutdown`](Self::shutdown), and only then shut down the runtime that
/// created the factories.
///
/// Dropping a sandbox may provide backend-specific emergency leak cleanup, but
/// it is not the normal lifecycle path and must not be treated as evidence that
/// explicit factory teardown completed successfully.
///
/// # Sharing and shutdown
///
/// Factories are `Send + Sync` so runner lifecycle code can share trait
/// objects across async tasks while sandboxes are active. Final shutdown still
/// requires `&mut self`, so callers that wrap a factory in shared ownership
/// must first stop concurrent use and recover exclusive ownership.
#[async_trait]
pub trait SandboxFactory: Send + Sync {
    /// Human-readable name for this factory implementation (e.g. "firecracker").
    fn name(&self) -> &str;
    /// Deterministic hash of internal configuration that affects snapshot output.
    ///
    /// Used by the runner to build a composite cache key for pre-warmed
    /// snapshots. The hash covers boot args, guest network parameters, and
    /// any other factory-specific settings baked into the snapshot. It must not
    /// include random values or secrets.
    fn config_hash(&self) -> String;
    /// Create a new sandbox instance with the given per-sandbox configuration.
    ///
    /// The returned sandbox belongs to this factory's lifecycle and should be
    /// released through [`destroy`](Self::destroy) on the normal teardown path.
    async fn create(&self, config: SandboxConfig) -> Result<Box<dyn Sandbox>>;
    /// Create a sandbox while reporting create-stage timings to `observer`.
    ///
    /// The default implementation preserves existing factory behavior for
    /// providers that do not expose internal create-stage attribution.
    async fn create_with_observer(
        &self,
        config: SandboxConfig,
        _observer: &mut dyn SandboxCreateObserver,
    ) -> Result<Box<dyn Sandbox>> {
        self.create(config).await
    }

    /// Explicitly tear down a sandbox created by this factory.
    ///
    /// This is the normal resource-release path for sandbox-owned provider
    /// resources such as processes, devices, directories, and factory pools.
    async fn destroy(&self, sandbox: Box<dyn Sandbox>);
    /// Release all factory-level resources.
    ///
    /// Requires exclusive ownership: callers sharing via `Arc` must
    /// first recover ownership (e.g. `Arc::try_unwrap`) after all
    /// concurrent users have been dropped.
    async fn shutdown(&mut self);
}
