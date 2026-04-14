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
    /// PID of the sandbox's main process (e.g. firecracker).
    /// Used for host-side diagnostics like OOM detection.
    fn process_pid(&self) -> Option<u32> {
        None
    }

    // -- lifecycle --
    async fn start(&mut self) -> Result<()>;
    async fn stop(&mut self) -> Result<()>;
    async fn kill(&mut self) -> Result<()>;

    // -- idle transitions --

    /// Transition the sandbox into the idle/parked state.
    ///
    /// Implementations may reclaim guest memory (e.g. balloon inflate)
    /// and pause vCPUs to eliminate idle CPU overhead. A parked sandbox's
    /// `stop()` must handle the paused state (e.g. skip graceful guest
    /// shutdown and go straight to force-kill, since vCPUs cannot process
    /// vsock messages).
    ///
    /// Note: after a partial `unpark()` failure (e.g. vCPU resume
    /// succeeded but balloon deflate failed), the sandbox is flagged as
    /// "still parked" even though vCPUs may actually be running. `stop()`
    /// implementations must tolerate this — skipping graceful shutdown is
    /// still correct because the sandbox was idle with no user workload.
    ///
    /// Must be idempotent: calling `park()` on an already-parked sandbox
    /// returns `Ok(())` without side effects.
    ///
    /// On `Err`, the sandbox is left in a consistent "not parked" state
    /// (internal flags unchanged); the caller should destroy it (or
    /// retry) rather than attempt to use it for further work.
    async fn park(&mut self) -> Result<()> {
        Ok(())
    }

    /// Transition the sandbox back to the active state.
    ///
    /// Must be called before any further work is dispatched via `exec` /
    /// `spawn_watch` on a previously parked sandbox. Implementations
    /// should restore whatever state `park()` altered (resume vCPUs,
    /// balloon deflate, respawn background tickers, etc).
    ///
    /// Must be idempotent: calling `unpark()` on a sandbox that was
    /// never parked — or calling it repeatedly — returns `Ok(())`
    /// without side effects.
    ///
    /// On `Err`, the sandbox is left in a consistent "still parked"
    /// state; the caller should destroy it (or retry) rather than
    /// attempt to use it for further work.
    async fn unpark(&mut self) -> Result<()> {
        Ok(())
    }

    // -- operations --
    async fn exec(&self, request: &ExecRequest<'_>) -> Result<ExecResult>;
    async fn write_file(&self, path: &str, content: &[u8]) -> Result<()>;
    async fn spawn_watch(
        &self,
        request: &ExecRequest<'_>,
        stdout_log_path: Option<&str>,
    ) -> Result<SpawnHandle>;
    async fn wait_exit(&self, handle: SpawnHandle, timeout: Duration) -> Result<ProcessExit>;
}
