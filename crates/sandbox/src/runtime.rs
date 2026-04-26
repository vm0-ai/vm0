use async_trait::async_trait;

use crate::config::{FactoryConfig, RuntimeConfig};
use crate::error::Result;
use crate::factory::SandboxFactory;

/// Manages shared resources (e.g., loop device cache, network pools) and
/// creates sandbox factories that share those resources.
///
/// All factories created by this runtime **must** be shut down before calling
/// [`SandboxRuntime::shutdown`].
#[async_trait]
pub trait SandboxRuntime: Send + Sync {
    /// Create a new sandbox factory for the given profile configuration.
    ///
    /// The returned factory is fully initialized (`startup()` has been called)
    /// and ready to create sandboxes.
    async fn create_factory(&self, config: FactoryConfig) -> Result<Box<dyn SandboxFactory>>;

    /// Release shared resources (network pools, device caches).
    async fn shutdown(&mut self);
}

/// Constructs a [`SandboxRuntime`] from configuration.
///
/// This trait decouples the runner from the concrete runtime implementation.
/// The runner calls [`RuntimeProvider::create_runtime`] when shared resources
/// are needed (e.g., after proxy setup provides the port), without knowing
/// which backend is in use.
#[async_trait]
pub trait RuntimeProvider: Send + Sync {
    /// Create a runtime from runtime-wide configuration.
    ///
    /// `config` contains inputs discovered before backend initialization, such
    /// as proxy ports shared by every factory created from the returned runtime.
    /// Implementations may validate these values and initialize
    /// backend-specific shared resources while creating the runtime.
    ///
    /// On success, the returned runtime is ready for
    /// [`SandboxRuntime::create_factory`] calls. This does not create, start, or
    /// initialize any factory; factory startup remains part of
    /// [`SandboxRuntime::create_factory`].
    ///
    /// The caller owns the returned runtime and is responsible for eventually
    /// calling [`SandboxRuntime::shutdown`] after all factories created from it
    /// have been shut down.
    ///
    /// Returns an error if the backend cannot initialize the runtime. The trait
    /// does not guarantee retry semantics after an error.
    async fn create_runtime(&self, config: RuntimeConfig) -> Result<Box<dyn SandboxRuntime>>;
}
