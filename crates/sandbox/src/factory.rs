use async_trait::async_trait;

use crate::config::SandboxConfig;
use crate::error::Result;
use crate::sandbox::Sandbox;

#[async_trait]
pub trait SandboxFactory: Send + Sync {
    fn name(&self) -> &str;
    /// Initialize factory resources (pools, connections, etc.).
    /// Must be called before `create()` or `destroy()`.
    async fn startup(&mut self) -> Result<()>;
    async fn create(&self, config: SandboxConfig) -> Result<Box<dyn Sandbox>>;
    async fn destroy(&self, sandbox: Box<dyn Sandbox>);
    /// Release all factory-level resources.
    /// Requires exclusive ownership — callers sharing via `Arc` must
    /// first recover ownership (e.g. `Arc::try_unwrap`) after all
    /// concurrent users have been dropped.
    async fn shutdown(&mut self);
}
