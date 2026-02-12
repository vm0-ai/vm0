use async_trait::async_trait;

use crate::config::SandboxConfig;
use crate::error::Result;
use crate::sandbox::Sandbox;

#[async_trait]
pub trait SandboxFactory: Send + Sync {
    /// Human-readable name for this factory implementation (e.g. "firecracker").
    fn name(&self) -> &str;
    /// Content hash of all internal configuration that affects snapshot output.
    ///
    /// Used by the runner to build a composite cache key for pre-warmed
    /// snapshots.  The hash covers boot args, guest network parameters, and
    /// any other factory-specific settings baked into the snapshot.
    fn config_hash(&self) -> String;
    /// Initialize factory resources (pools, connections, etc.).
    /// Must be called before `create()` or `destroy()`.
    async fn startup(&mut self) -> Result<()>;
    /// Create a new sandbox instance with the given configuration.
    async fn create(&self, config: SandboxConfig) -> Result<Box<dyn Sandbox>>;
    /// Tear down a sandbox, releasing all resources back to the factory pools.
    async fn destroy(&self, sandbox: Box<dyn Sandbox>);
    /// Release all factory-level resources.
    /// Requires exclusive ownership — callers sharing via `Arc` must
    /// first recover ownership (e.g. `Arc::try_unwrap`) after all
    /// concurrent users have been dropped.
    async fn shutdown(&mut self);
}
