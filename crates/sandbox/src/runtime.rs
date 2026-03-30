use async_trait::async_trait;

use crate::config::FactoryConfig;
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
