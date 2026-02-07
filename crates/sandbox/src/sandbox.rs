use async_trait::async_trait;

use crate::error::Result;
use crate::types::{ExecRequest, ExecResult, ProcessExit, SpawnHandle};

#[async_trait]
pub trait Sandbox: Send + Sync {
    async fn start(&mut self) -> Result<()>;
    async fn exec(&self, request: &ExecRequest<'_>) -> Result<ExecResult>;
    async fn write_file(&self, path: &str, content: &[u8]) -> Result<()>;
    async fn spawn_watch(&self, request: &ExecRequest<'_>) -> Result<SpawnHandle>;
    async fn wait_exit(&self, handle: SpawnHandle) -> Result<ProcessExit>;
    async fn stop(&mut self) -> Result<()>;
    async fn kill(&mut self) -> Result<()>;
    fn id(&self) -> &str;
}
