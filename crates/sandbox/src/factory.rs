use async_trait::async_trait;

use crate::config::SandboxConfig;
use crate::error::Result;
use crate::sandbox::Sandbox;

#[async_trait]
pub trait SandboxFactory: Send + Sync {
    fn name(&self) -> &str;
    async fn create(&self, config: SandboxConfig) -> Result<Box<dyn Sandbox>>;
    async fn destroy(&self, sandbox: Box<dyn Sandbox>);
}
