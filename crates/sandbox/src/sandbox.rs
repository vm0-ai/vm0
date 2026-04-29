//! The [`Sandbox`] trait — the core backend abstraction of this crate.
//!
//! A sandbox is a process-isolation environment (a Firecracker VM in
//! production, a mock harness in tests) that runs guest workloads on
//! behalf of the runner. Implementations are created by a
//! [`SandboxFactory`](crate::SandboxFactory) and handed to callers as
//! `Box<dyn Sandbox>`.
//!
//! # Lifecycle
//! ```text
//!   created  ──start()──▶  running  ──stop()/kill()──▶  stopped
//!                             │  ▲
//!                             └──┤ park()/unpark()
//! ```
//! - [`start`](Sandbox::start) boots the guest and must be called before
//!   any operation; subsequent `start` calls on the same instance fail.
//! - [`stop`](Sandbox::stop) asks the guest to shut down gracefully, then
//!   kills the backing process. [`kill`](Sandbox::kill) skips the graceful
//!   step. Both are idempotent and both end in the stopped state.
//! - [`park`](Sandbox::park) / [`unpark`](Sandbox::unpark) reclaim guest
//!   resources while the sandbox is idle; a parked sandbox must be
//!   unparked before further operations.
//!
//! # Operations
//! Once running, callers invoke [`exec`](Sandbox::exec) /
//! [`write_file`](Sandbox::write_file) / [`spawn_watch`](Sandbox::spawn_watch) /
//! [`wait_exit`](Sandbox::wait_exit) via the host-to-guest IPC channel
//! (vsock, in the Firecracker backend). Operations race against a crash
//! notifier so that a dying backend process surfaces as a specific
//! "backend crashed" error rather than an opaque IPC timeout.

use std::any::Any;
use std::time::Duration;

use async_trait::async_trait;

use crate::error::Result;
use crate::types::{ExecRequest, ExecResult, ProcessExit, SpawnHandle};

/// A process-isolation environment that runs guest workloads for the runner.
///
/// Implementations are created by a [`SandboxFactory`](crate::SandboxFactory)
/// and consumed as `Box<dyn Sandbox>`.
///
/// # Lifecycle
/// ```text
///   created  ──start()──▶  running  ──stop()/kill()──▶  stopped
///                             │  ▲
///                             └──┤ park()/unpark()
/// ```
/// - [`start`](Self::start) boots the guest; it must be called exactly
///   once and must precede any operation.
/// - [`stop`](Self::stop) asks the guest to shut down gracefully, then
///   kills the backing process. [`kill`](Self::kill) skips the graceful
///   step. Both are idempotent and both end in the stopped state.
/// - [`park`](Self::park) / [`unpark`](Self::unpark) reclaim guest
///   resources while idle; a parked sandbox must be unparked before
///   further operations.
///
/// # Operations
/// Once running, callers invoke [`exec`](Self::exec) /
/// [`write_file`](Self::write_file) / [`spawn_watch`](Self::spawn_watch) /
/// [`wait_exit`](Self::wait_exit) via the host-to-guest IPC channel
/// (vsock, in the Firecracker backend). Operations race against a crash
/// notifier so that a dying backend process surfaces as a specific
/// error rather than an opaque IPC timeout.
///
/// # Thread-safety and trait objects
/// Implementations are consumed as `Box<dyn Sandbox>` and shared across
/// tasks, hence `Send + Sync`. The `Any` bound allows
/// [`SandboxFactory::destroy()`](crate::SandboxFactory::destroy) to
/// downcast back to the concrete type for backend-specific cleanup.
///
/// # Panic/drop cleanup contract
/// Production backends must make dropping an active sandbox a best-effort
/// emergency cleanup path. If runner-side code unwinds before calling
/// [`SandboxFactory::destroy()`](crate::SandboxFactory::destroy), `Drop`
/// must not silently leave a VM process and associated host resources alive.
/// This fallback is only a safety net: callers must not treat drop-triggered
/// cleanup as proof that explicit destroy completed.
#[async_trait]
pub trait Sandbox: Send + Sync + Any {
    // -- identity --

    /// Stable identifier for this sandbox, unique within the runner
    /// process. Used in logs, metrics, and socket/path derivation.
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

    /// Boot the guest and make the sandbox ready to serve operations.
    ///
    /// Must only be called once per instance. Implementations must leave
    /// no leaked processes, sockets, or mounts on failure — a failed
    /// `start` is equivalent to a sandbox that was never started, and
    /// the caller may drop the instance without calling `stop`/`kill`.
    async fn start(&mut self) -> Result<()>;
    /// Shut the guest down gracefully, then terminate the backing process.
    ///
    /// The guest is first notified via the IPC channel (with an
    /// implementation-defined timeout) so user workloads can clean up;
    /// the backing process is killed regardless of whether the guest
    /// acknowledged. For a parked sandbox the graceful step is skipped
    /// (vCPUs are paused and cannot process the message) and the
    /// sandbox goes straight to force-kill — no user workload is lost
    /// because a parked sandbox is idle by definition.
    ///
    /// Idempotent: calling `stop` on an already-stopped (or concurrently
    /// stopping) sandbox returns `Ok(())` without side effects.
    async fn stop(&mut self) -> Result<()>;
    /// Terminate the backing process immediately, without a graceful
    /// guest shutdown. Prefer [`stop`](Self::stop) for normal teardown;
    /// reach for `kill` when the guest is unresponsive or the caller is
    /// already abandoning any in-flight work.
    ///
    /// Idempotent: calling `kill` on an already-stopped (or concurrently
    /// stopping) sandbox returns `Ok(())` without side effects.
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
    //
    // Operations require the sandbox to be running (post-`start`,
    // pre-`stop`/`kill`) and, if it was previously parked, unparked.
    // They race the guest IPC call against a crash notifier so a dying
    // backend process surfaces as a specific error rather than an
    // opaque IPC timeout.

    /// Run `request.cmd` in the guest, block until it exits or the
    /// request timeout expires, and return the captured output.
    ///
    /// Returns an error if the sandbox is not running or if the backing
    /// process crashes during execution.
    async fn exec(&self, request: &ExecRequest<'_>) -> Result<ExecResult>;
    /// Write `content` to `path` inside the guest, creating or
    /// truncating as needed. Returns an error if the sandbox is not
    /// running or if the backing process crashes.
    async fn write_file(&self, path: &str, content: &[u8]) -> Result<()>;
    /// Spawn `request.cmd` in the guest and return a handle for later
    /// supervision via [`wait_exit`](Self::wait_exit).
    ///
    /// `output` controls whether stdout is buffered into the final
    /// [`ProcessExit`] or streamed in real time through
    /// [`SpawnHandle::stdout_rx`], optionally
    /// teeing streamed chunks into a guest-side file.
    async fn spawn_watch(
        &self,
        request: &ExecRequest<'_>,
        output: crate::SpawnOutputMode<'_>,
    ) -> Result<SpawnHandle>;
    /// Wait for the process behind `handle` to exit, up to `timeout`.
    ///
    /// Consumes the handle. Returns an error if the sandbox is not
    /// running, if the backing process crashes, or if the timeout
    /// elapses before the guest process exits.
    async fn wait_exit(&self, handle: SpawnHandle, timeout: Duration) -> Result<ProcessExit>;
}
