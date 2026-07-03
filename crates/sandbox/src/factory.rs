use async_trait::async_trait;

use crate::config::SandboxConfig;
use crate::error::Result;
use crate::sandbox::Sandbox;

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
