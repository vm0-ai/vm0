use std::any::Any;
use std::time::Duration;

use async_trait::async_trait;

use crate::error::Result;
use crate::types::{ExecRequest, ExecResult, ProcessExit, SpawnHandle};

/// The `Any` bound allows `SandboxFactory::destroy()` to downcast
/// `Box<dyn Sandbox>` back to the concrete type for backend-specific cleanup.
#[async_trait]
pub trait Sandbox: Send + Sync + Any {
    // -- identity --
    fn id(&self) -> &str;
    /// The network-visible source IP address for this sandbox.
    /// Used as the key for proxy VM registration.
    fn source_ip(&self) -> &str;

    // -- lifecycle --
    async fn start(&mut self) -> Result<()>;
    async fn stop(&mut self) -> Result<()>;
    async fn kill(&mut self) -> Result<()>;

    // -- operations --
    async fn exec(&self, request: &ExecRequest<'_>) -> Result<ExecResult>;
    async fn write_file(&self, path: &str, content: &[u8]) -> Result<()>;
    async fn spawn_watch(&self, request: &ExecRequest<'_>) -> Result<SpawnHandle>;
    async fn wait_exit(&self, handle: SpawnHandle, timeout: Duration) -> Result<ProcessExit>;
}
