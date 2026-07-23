use std::any::Any;
use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;

use crate::error::{Result, SandboxError, SandboxIdleTransition};
use crate::types::{
    CopyFileOptions, CopyFileResult, ExecRequest, ExecResult, GuestProcessHandle, ProcessExit,
    StartProcessRequest, WriteFileEntry,
};

/// Eligibility result after a sandbox successfully reaches the parked state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxParkOutcome {
    /// The parked sandbox may be admitted to an idle pool for later reuse.
    Reusable,
    /// The sandbox is validly parked but must be destroyed instead of reused.
    NonReusable(SandboxParkNonReusableReason),
}

/// Completed final guest exec together with the resulting parked state.
///
/// The exec result is transport-complete but may still be semantically
/// unacceptable to the lifecycle owner. The sandbox is validly parked in
/// either case and must be admitted or destroyed through a parked cleanup path.
pub struct SandboxFinalExecParkOutcome {
    /// Terminal result of the lifecycle-owned final guest exec.
    pub exec_result: ExecResult,
    /// Eligibility reported after the sandbox reached the parked state.
    pub park_outcome: SandboxParkOutcome,
}

/// Stable reason why a validly parked sandbox cannot be reused.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxParkNonReusableReason {
    /// The guest retained too much memory after the bounded park-time reclaim.
    SevereMemoryRetention,
}

impl SandboxParkNonReusableReason {
    /// Stable low-cardinality value for lifecycle logs and cleanup context.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SevereMemoryRetention => "severe_memory_retention",
        }
    }
}

/// Fixed low-cardinality stages on the sandbox start critical path.
///
/// Providers report only stages that apply to a start. The snapshot stage is
/// absent for a fresh boot, and the DNS stage is absent when the provider does
/// not perform a guest DNS readiness check. On a successful start, reported
/// stages are ordered, non-overlapping wall-clock intervals. Concurrent work
/// belongs to the interval that contains it; for example, guest connection
/// waiting measures only the residual wait after backend startup completes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxStartStage {
    /// Prepares and launches the backend through its control API readiness.
    BackendLaunch,
    /// Loads and resumes an applicable backend snapshot.
    SnapshotLoadResume,
    /// Waits for the residual guest control connection after backend startup.
    GuestConnectionWait,
    /// Proves that the configured guest DNS path is ready.
    GuestDnsReadiness,
    /// Publishes the guest and starts the remaining host runtime services.
    RuntimeFinalize,
}

impl SandboxStartStage {
    /// All start stages in stable catalog order.
    ///
    /// Providers can omit stages that do not apply. This order describes the
    /// successful critical path, not a completeness guarantee after failure or
    /// cancellation.
    pub const ALL: [Self; 5] = [
        Self::BackendLaunch,
        Self::SnapshotLoadResume,
        Self::GuestConnectionWait,
        Self::GuestDnsReadiness,
        Self::RuntimeFinalize,
    ];
}

/// Receives optional low-cardinality sandbox start timing records.
///
/// Providers that override [`Sandbox::start_with_observer`] invoke the callback
/// for every applicable stage when it resolves, before running failure
/// diagnostics or cleanup. Earlier successful callbacks remain valid when a
/// later stage fails. Cancellation can leave a completed prefix without a
/// callback for the in-progress stage. Implementations using the default method
/// report no stages.
///
/// For an overriding implementation, successful start stages are
/// non-overlapping and cover the provider start critical path after lifecycle
/// precondition checks. A failed parent start can additionally include
/// diagnostics and cleanup after the failed stage callback. Observer callbacks
/// are informational and never own lifecycle transitions or cleanup.
pub trait SandboxStartObserver: Send {
    /// Records one completed start stage.
    ///
    /// `success` is the result of this stage, not the final result of the full
    /// start. A provider invokes this callback at most once per applicable
    /// stage.
    fn record_stage(&mut self, stage: SandboxStartStage, duration: Duration, success: bool);
}

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
/// [`read_file`](Self::read_file) / [`copy_file`](Self::copy_file) /
/// [`write_file`](Self::write_file) / [`start_process`](Self::start_process) /
/// [`wait_process`](Self::wait_process) via the host-to-guest IPC channel
/// (vsock, in the Firecracker backend). Operations race against a crash
/// notifier so that a dying backend process surfaces as
/// [`BackendCrashed`](crate::SandboxOperationReason::BackendCrashed)
/// instead of an opaque IPC timeout.
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
    /// Host-side PID of the sandbox backing process (e.g. firecracker).
    /// Used for host diagnostics like OOM detection.
    fn host_process_pid(&self) -> Option<u32> {
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
    /// Start the sandbox while reporting provider-supported phase timings.
    ///
    /// This has the same lifecycle, success, failure, and cleanup contract as
    /// [`start`](Self::start). An overriding implementation reports each stage
    /// applicable to its provider and must not use observer callbacks as
    /// cleanup authority. The default implementation preserves existing
    /// provider behavior and emits no callbacks.
    async fn start_with_observer(
        &mut self,
        _observer: &mut dyn SandboxStartObserver,
    ) -> Result<()> {
        self.start().await
    }
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
    /// On success, the returned [`SandboxParkOutcome`] states whether the
    /// validly parked sandbox may enter an idle pool. A non-reusable outcome is
    /// not an operational failure; the lifecycle owner must destroy the parked
    /// sandbox through its parked cleanup path.
    ///
    /// Must be idempotent for a healthy already-parked sandbox: calling
    /// `park()` again returns the same successful eligibility outcome without
    /// side effects. Implementations may still return `Err` if lifecycle guards
    /// detect that the sandbox is internally dirty or otherwise not safe to
    /// reuse.
    ///
    /// On `Err`, the caller must not dispatch further work to the sandbox.
    /// The sandbox may be partially parked or marked internally dirty; the
    /// lifecycle owner should destroy it, or perform an explicit retry only
    /// when the implementation documents that retry as safe.
    async fn park(&mut self) -> Result<SandboxParkOutcome> {
        Ok(SandboxParkOutcome::Reusable)
    }

    /// Run one final normal guest exec and park without reopening operation
    /// admission between the exec and pause.
    ///
    /// Implementations must close admission to new normal/control operations
    /// before atomically ordering `request` after every previously admitted
    /// normal operation. A successful exec must remain fenced through guest
    /// quiesce and the completed park transition. A competing earlier operation
    /// may reject this transition, but it must not run after the final exec and
    /// still allow this method to succeed.
    ///
    /// A completed non-zero or otherwise semantically unacceptable exec result
    /// may still be returned after a valid park; the lifecycle owner decides
    /// whether to admit or destroy that parked sandbox. On `Err`, callers must
    /// not dispatch further work and should destroy the sandbox.
    ///
    /// Unlike [`park`](Self::park), this operation is not idempotent because its
    /// final exec must run exactly once on an active sandbox.
    async fn final_exec_and_park(
        &mut self,
        _request: &ExecRequest<'_>,
        _diagnostic_label: &'static str,
    ) -> Result<SandboxFinalExecParkOutcome> {
        Err(SandboxError::IdleTransition {
            transition: SandboxIdleTransition::Park,
            message: "final guest exec during park is not supported by this sandbox provider"
                .to_string(),
        })
    }

    /// Transition the sandbox back to the active state.
    ///
    /// Must be called before any further work is dispatched via `exec` /
    /// `start_process` on a previously parked sandbox. Implementations
    /// should restore whatever state `park()` altered (resume vCPUs,
    /// balloon deflate, respawn background tickers, etc).
    ///
    /// Must be idempotent for a healthy active sandbox: calling `unpark()`
    /// on a sandbox that was never parked — or calling it repeatedly —
    /// returns `Ok(())` without side effects. Implementations may still
    /// return `Err` if lifecycle guards detect that the sandbox is internally
    /// dirty or otherwise not safe to reuse.
    ///
    /// On `Err`, the caller must not dispatch further work to the sandbox.
    /// The sandbox may still be parked, partially unparked, or marked
    /// internally dirty; the lifecycle owner should destroy it, or perform an
    /// explicit retry only when the implementation documents that retry as
    /// safe.
    async fn unpark(&mut self) -> Result<()> {
        Ok(())
    }

    // -- operations --
    //
    // Operations that start new guest work require the sandbox to be running
    // (post-`start`, pre-`stop`/`kill`) and, if it was previously parked,
    // unparked. They use the trait-level backend-crash classification
    // contract documented above.
    //
    // `wait_process` is the exception: it consumes a `GuestProcessHandle` returned by
    // `start_process` and observes that handle's already-started backend exit
    // operation instead of starting new guest work.

    /// Run `request.cmd` in the guest, block until it exits or the
    /// request timeout expires, and return the captured output.
    ///
    /// Returns an error if the sandbox is not running or if the backing
    /// process crashes during execution.
    ///
    /// Implementations must honor the selected capture budget or report
    /// truncation explicitly in [`ExecResult`].
    async fn exec(&self, request: &ExecRequest<'_>) -> Result<ExecResult>;

    /// Run [`exec`](Self::exec) with a stable low-cardinality label for
    /// backend diagnostics.
    ///
    /// Labels must describe the operation type, not the raw command. Do not
    /// include user input, environment values, request payloads, or any other
    /// high-cardinality data.
    async fn exec_with_diagnostic_label(
        &self,
        request: &ExecRequest<'_>,
        _label: &'static str,
    ) -> Result<ExecResult> {
        self.exec(request).await
    }

    /// Read a small file from the guest.
    ///
    /// The guest path must be non-empty and must not contain NUL bytes.
    /// `max_bytes` must be positive and is subject to the backend read limit.
    ///
    /// Missing files return `Ok(None)`. Other read failures return an error.
    async fn read_file(&self, path: &str, max_bytes: u64) -> Result<Option<Vec<u8>>>;

    /// Stream a guest file to a host path and publish copied contents.
    ///
    /// A successful copy creates missing host parent directories as needed and
    /// atomically replaces an existing non-directory destination with a newly
    /// created private regular file. On Unix hosts, the published file has mode
    /// `0o600`. Metadata from an existing destination is not preserved.
    ///
    /// The guest path must be non-empty and must not contain NUL bytes.
    ///
    /// If [`CopyFileOptions::missing_ok`] is enabled, a backend result that
    /// reports the path does not resolve to a regular file is treated as
    /// success with `bytes_copied == 0` without publishing a host file or
    /// replacing an existing host file. Host-side setup and validation errors
    /// can still fail the operation, and setup may leave newly created parent
    /// directories behind.
    ///
    /// Failures before host publication leave an existing destination
    /// unchanged. An error reported after publication does not imply that the
    /// destination was rolled back.
    async fn copy_file(
        &self,
        path: &str,
        host_path: &Path,
        options: CopyFileOptions,
    ) -> Result<CopyFileResult>;

    /// Write `content` to `path` inside the guest, creating parent
    /// directories and truncating the file as needed. Returns an error if
    /// the sandbox is not running or if the backing process crashes.
    ///
    /// The guest path must be non-empty and must not contain NUL bytes.
    async fn write_file(&self, path: &str, content: &[u8]) -> Result<()>;

    /// Write multiple ordinary files inside the guest.
    ///
    /// Each entry has the same semantics as [`write_file`](Self::write_file):
    /// create parent directories, create or truncate the target file, and write
    /// the provided content without sudo or private runtime-file semantics.
    /// Every guest path must be non-empty and must not contain NUL bytes. An
    /// empty batch is accepted as a no-op.
    /// Callers are responsible for bounding the number of files and total
    /// content size. The default implementation preserves compatibility by
    /// writing entries sequentially with [`write_file`](Self::write_file).
    async fn write_files(&self, files: &[WriteFileEntry<'_>]) -> Result<()> {
        for file in files {
            self.write_file(file.path, file.content).await?;
        }
        Ok(())
    }

    /// Write `content` to a private runtime file inside the guest.
    ///
    /// Implementations should use guest runtime-private semantics: ensure
    /// parent directories are private, reject symlinked parent components, and
    /// write the file with private permissions. Generic workspace file writes
    /// should continue to use [`write_file`](Self::write_file).
    ///
    /// The guest path must be non-empty and must not contain NUL bytes.
    async fn write_private_file(&self, path: &str, content: &[u8]) -> Result<()>;

    /// Start `request.cmd` in the guest and return a handle for later
    /// supervision via [`wait_process`](Self::wait_process).
    ///
    /// `request.output` controls whether stdout is buffered into the final
    /// [`ProcessExit`] or streamed in real time through
    /// [`GuestProcessHandle::take_stdout_receiver`]. Callers that take the
    /// receiver are responsible for draining it while the process runs.
    async fn start_process(&self, request: &StartProcessRequest<'_>) -> Result<GuestProcessHandle>;
    /// Wait for the process behind `handle` to exit, up to `timeout`.
    ///
    /// Consumes the handle. If `stdout_rx` was not taken before waiting, the
    /// stream is discarded instead of being buffered without a reader. Returns
    /// an error if the backend exit operation is no longer available, if the
    /// backing process crashes before an exit result is delivered, or if the
    /// timeout elapses before the guest process exits.
    async fn wait_process(
        &self,
        handle: GuestProcessHandle,
        timeout: Duration,
    ) -> Result<ProcessExit>;
}
