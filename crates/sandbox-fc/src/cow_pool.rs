//! COW slot producer for Firecracker VMs.
//!
//! Pre-creates one-shot COW slots in bounded background workers to reduce
//! sandbox creation latency. A slot is consumed by one sandbox and is never
//! returned to this producer.

use std::collections::VecDeque;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant as StdInstant};

use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::Instant as TokioInstant;
use tracing::{error, info, warn};

/// Number of ready COW slots to keep warm in steady state.
const BUFFER_SIZE: usize = 4;

/// Maximum simultaneous blocking slot creation workers.
const MAX_CONCURRENT_SLOT_CREATIONS: usize = 4;

/// Maximum slots still owned by the producer pipeline (ready + pending).
const MAX_SLOTS: usize = 256;

/// Backoff for warm-buffer retries after background creation failures.
const WARM_RETRY_BACKOFF: Duration = Duration::from_secs(1);

type AcquireResult = Result<PrewarmedSlot, CowPoolError>;
type SlotSpawner =
    Arc<dyn Fn(CowPoolConfig) -> JoinHandle<Result<PrewarmedSlot, CowPoolError>> + Send + Sync>;

#[cfg(test)]
#[derive(Debug)]
struct CowPoolSnapshot {
    ready: usize,
    pending: usize,
    waiters: usize,
    pipeline_slots: usize,
    warm_retry_scheduled: bool,
}

/// Configuration for creating a [`CowPoolHandle`].
#[derive(Clone)]
pub(crate) struct CowPoolConfig {
    /// Base directory for workspaces (for example, `{base_dir}/workspaces`).
    pub workspaces_dir: PathBuf,
    /// Base image size in bytes (for creating sparse COW files in fresh mode).
    pub base_size: u64,
    /// Snapshot golden COW file path (`None` = fresh mode).
    pub golden_cow: Option<PathBuf>,
}

struct SlotWorkspaceCleanup {
    /// Unique slot ID. Used as workspace directory name before checkout.
    id: String,
    /// Path to the workspace directory: `{workspaces_dir}/{id}/`.
    workspace: PathBuf,
    #[cfg(test)]
    teardown_gate: Option<SlotTeardownGate>,
}

impl SlotWorkspaceCleanup {
    fn new(id: String, workspace: PathBuf) -> Self {
        Self {
            id,
            workspace,
            #[cfg(test)]
            teardown_gate: None,
        }
    }

    fn remove_best_effort(self) -> PathBuf {
        let Self {
            id,
            workspace,
            #[cfg(test)]
            teardown_gate,
        } = self;
        #[cfg(test)]
        if let Some(teardown_gate) = teardown_gate {
            let _ = teardown_gate.started.send(workspace.clone());
            let _ = teardown_gate.release.recv();
        }
        match std::fs::remove_dir_all(&workspace) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => {
                warn!(id = %id, error = %e, "failed to delete pool workspace dir");
            }
        }
        workspace
    }
}

#[cfg(test)]
struct SlotTeardownGate {
    started: oneshot::Sender<PathBuf>,
    release: std::sync::mpsc::Receiver<()>,
}

/// A pre-warmed one-shot slot: workspace directory + COW file.
///
/// The caller must create the NBD device on acquire via
/// `DevicePoolHandle::create_cow_device()`.
pub(crate) struct PrewarmedSlot {
    /// Unique slot ID. Used as workspace directory name before checkout.
    id: String,
    /// Path to the workspace directory: `{workspaces_dir}/{id}/`.
    workspace: PathBuf,
    cleanup: Option<SlotWorkspaceCleanup>,
    #[cfg(test)]
    pub(crate) drop_notify: Option<oneshot::Sender<PathBuf>>,
}

impl PrewarmedSlot {
    pub(crate) fn new(id: String, workspace: PathBuf) -> Self {
        let cleanup = SlotWorkspaceCleanup::new(id.clone(), workspace.clone());
        Self {
            id,
            workspace,
            cleanup: Some(cleanup),
            #[cfg(test)]
            drop_notify: None,
        }
    }

    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub(crate) fn disarm_after_workspace_rename(mut self) {
        self.cleanup.take();
    }

    #[cfg(test)]
    fn set_teardown_gate(
        &mut self,
        started: oneshot::Sender<PathBuf>,
        release: std::sync::mpsc::Receiver<()>,
    ) {
        if let Some(cleanup) = self.cleanup.as_mut() {
            cleanup.teardown_gate = Some(SlotTeardownGate { started, release });
        }
    }

    /// Path to the COW file inside the workspace.
    #[cfg(test)]
    fn cow_file(&self) -> PathBuf {
        self.workspace().join("cow.img")
    }

    #[cfg(test)]
    fn notify_teardown(&mut self, workspace: PathBuf) {
        if let Some(drop_notify) = self.drop_notify.take() {
            let _ = drop_notify.send(workspace);
        }
    }

    #[cfg(not(test))]
    fn notify_teardown(&mut self, _workspace: PathBuf) {}
}

impl Drop for PrewarmedSlot {
    fn drop(&mut self) {
        // Fallback cleanup for forgotten, cancelled, or unwound slots. Normal
        // async cleanup paths should use `destroy_slot_async`.
        if let Some(cleanup) = self.cleanup.take() {
            let workspace = cleanup.remove_best_effort();
            self.notify_teardown(workspace);
        }
    }
}

impl std::fmt::Debug for PrewarmedSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrewarmedSlot")
            .field("id", &self.id())
            .field("workspace", &self.workspace())
            .finish_non_exhaustive()
    }
}

/// Pool error type.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CowPoolError {
    #[error("COW file creation failed: {0}")]
    CowFileCreation(String),
    #[error("slot limit reached (max {max})")]
    SlotLimitReached { max: usize },
    #[error("pool actor stopped")]
    ActorStopped,
    #[error("pool is not active")]
    NotActive,
}

/// Cloneable handle to the COW slot producer.
#[derive(Clone)]
pub(crate) struct CowPoolHandle {
    commands: mpsc::UnboundedSender<CowPoolCommand>,
    cleanup: mpsc::UnboundedSender<oneshot::Sender<()>>,
}

enum CowPoolCommand {
    Warmup {
        done: oneshot::Sender<()>,
    },
    Acquire {
        requested_at: StdInstant,
        respond_to: oneshot::Sender<AcquireResult>,
    },
    #[cfg(test)]
    Snapshot {
        respond_to: oneshot::Sender<CowPoolSnapshot>,
    },
}

struct CowPoolActor {
    pool: CowPool,
    commands: mpsc::UnboundedReceiver<CowPoolCommand>,
    cleanup: mpsc::UnboundedReceiver<oneshot::Sender<()>>,
}

#[derive(Clone, Copy, Debug)]
enum CreationPurpose {
    Demand,
    Warm,
}

struct SlotCreationOutcome {
    purpose: CreationPurpose,
    elapsed: Duration,
    result: Result<PrewarmedSlot, CowPoolError>,
}

struct AcquireWaiter {
    requested_at: StdInstant,
    respond_to: oneshot::Sender<AcquireResult>,
}

/// Single-owner state for the bounded one-shot COW slot producer.
struct CowPool {
    active: bool,
    ready: VecDeque<PrewarmedSlot>,
    pending: JoinSet<SlotCreationOutcome>,
    waiters: VecDeque<AcquireWaiter>,
    warmup_waiters: Vec<oneshot::Sender<()>>,
    buffer_size: usize,
    max_concurrent_creations: usize,
    max_slots: usize,
    warm_retry_backoff: Duration,
    warm_retry_at: Option<TokioInstant>,
    config: CowPoolConfig,
    slot_spawner: SlotSpawner,
}

impl CowPoolHandle {
    /// Create a new shared COW slot producer handle.
    ///
    /// Must be called from a Tokio runtime: the handle owns a background
    /// manager task that serializes all producer state transitions.
    pub(crate) fn new(config: CowPoolConfig) -> Self {
        Self::from_pool(CowPool::new(config))
    }

    fn from_pool(pool: CowPool) -> Self {
        let (commands, command_rx) = mpsc::unbounded_channel();
        let (cleanup, cleanup_rx) = mpsc::unbounded_channel();
        tokio::spawn(
            CowPoolActor {
                pool,
                commands: command_rx,
                cleanup: cleanup_rx,
            }
            .run(),
        );
        Self { commands, cleanup }
    }

    /// Pre-warm the initial ready-slot buffer.
    pub(crate) async fn warmup(&self) {
        let (done, done_rx) = oneshot::channel();
        if self.commands.send(CowPoolCommand::Warmup { done }).is_ok() {
            let _ = done_rx.await;
        }
    }

    /// Acquire a one-shot pre-warmed COW slot.
    pub(crate) async fn acquire(&self) -> Result<PrewarmedSlot, CowPoolError> {
        let (respond_to, response) = oneshot::channel();
        if self
            .commands
            .send(CowPoolCommand::Acquire {
                requested_at: StdInstant::now(),
                respond_to,
            })
            .is_err()
        {
            return Err(CowPoolError::ActorStopped);
        }
        response.await.map_err(|_| CowPoolError::ActorStopped)?
    }

    /// Clean up the producer. Pending blocking creation workers are drained.
    pub(crate) async fn cleanup(&self) {
        let (done, done_rx) = oneshot::channel();
        if self.cleanup.send(done).is_ok() {
            let _ = done_rx.await;
        }
    }

    #[cfg(test)]
    fn new_for_test(pool: CowPool) -> Self {
        Self::from_pool(pool)
    }

    #[cfg(test)]
    async fn snapshot(&self) -> CowPoolSnapshot {
        let (respond_to, response) = oneshot::channel();
        self.commands
            .send(CowPoolCommand::Snapshot { respond_to })
            .expect("COW pool actor stopped before snapshot");
        response.await.expect("COW pool actor dropped snapshot")
    }
}

impl CowPoolActor {
    async fn run(mut self) {
        let mut commands_open = true;
        let mut cleanup_open = true;
        loop {
            if !commands_open && !cleanup_open {
                break;
            }

            let retry_deadline = self.pool.warm_retry_at;
            let has_pending = !self.pool.pending.is_empty();
            tokio::select! {
                biased;

                // Cleanup must preempt queued acquires. Completed slot
                // creations and due warm retries must not be starved by a
                // busy command channel.
                cleanup = self.cleanup.recv(), if cleanup_open => {
                    match cleanup {
                        Some(done) => {
                            self.pool.cleanup().await;
                            let _ = done.send(());
                            return;
                        }
                        None => cleanup_open = false,
                    }
                }
                completion = self.pool.pending.join_next(), if has_pending => {
                    self.pool.handle_creation_join(completion).await;
                }
                () = sleep_until_deadline(retry_deadline), if retry_deadline.is_some() => {
                    self.pool.warm_retry_at = None;
                    self.pool.pump();
                    self.pool.maybe_finish_warmup();
                }
                command = self.commands.recv(), if commands_open => {
                    match command {
                        Some(command) => self.handle_command(command),
                        None => commands_open = false,
                    }
                }
            }
        }

        self.pool.cleanup().await;
    }

    fn handle_command(&mut self, command: CowPoolCommand) {
        match command {
            CowPoolCommand::Warmup { done } => self.pool.handle_warmup(done),
            CowPoolCommand::Acquire {
                requested_at,
                respond_to,
            } => self.pool.handle_acquire(requested_at, respond_to),
            #[cfg(test)]
            CowPoolCommand::Snapshot { respond_to } => {
                let _ = respond_to.send(self.pool.snapshot());
            }
        }
    }
}

async fn sleep_until_deadline(deadline: Option<TokioInstant>) {
    if let Some(deadline) = deadline {
        tokio::time::sleep_until(deadline).await;
    } else {
        std::future::pending::<()>().await;
    }
}

impl CowPool {
    /// Create a new producer without allocating resources.
    fn new(config: CowPoolConfig) -> Self {
        Self::new_with_options(
            config,
            BUFFER_SIZE,
            MAX_CONCURRENT_SLOT_CREATIONS,
            MAX_SLOTS,
            WARM_RETRY_BACKOFF,
            default_slot_spawner(),
        )
    }

    fn new_with_options(
        config: CowPoolConfig,
        buffer_size: usize,
        max_concurrent_creations: usize,
        max_slots: usize,
        warm_retry_backoff: Duration,
        slot_spawner: SlotSpawner,
    ) -> Self {
        Self {
            active: true,
            ready: VecDeque::with_capacity(buffer_size),
            pending: JoinSet::new(),
            waiters: VecDeque::new(),
            warmup_waiters: Vec::new(),
            buffer_size,
            max_concurrent_creations,
            max_slots,
            warm_retry_backoff,
            warm_retry_at: None,
            config,
            slot_spawner,
        }
    }

    fn handle_warmup(&mut self, done: oneshot::Sender<()>) {
        if !self.active {
            let _ = done.send(());
            return;
        }
        self.warmup_waiters.push(done);
        self.pump();
        self.maybe_finish_warmup();
    }

    fn handle_acquire(
        &mut self,
        requested_at: StdInstant,
        respond_to: oneshot::Sender<AcquireResult>,
    ) {
        if !self.active {
            let _ = respond_to.send(Err(CowPoolError::NotActive));
            return;
        }

        self.waiters.push_back(AcquireWaiter {
            requested_at,
            respond_to,
        });
        self.pump();
    }

    fn pump(&mut self) {
        if !self.active {
            return;
        }

        self.prune_closed_waiters();
        self.assign_ready_slots();
        while !self.waiters.is_empty()
            && self.ready.is_empty()
            && self.pending.is_empty()
            && self.pipeline_slots() >= self.max_slots
        {
            let _ = self.fail_one_waiter(CowPoolError::SlotLimitReached {
                max: self.max_slots,
            });
        }

        let desired_pipeline = self.desired_pipeline_slots();
        if desired_pipeline <= self.pipeline_slots() {
            return;
        }
        if self.waiters.is_empty() && self.warm_retry_at.is_some() {
            return;
        }

        let purpose = if self.waiters.is_empty() {
            CreationPurpose::Warm
        } else {
            CreationPurpose::Demand
        };

        while self.pipeline_slots() < desired_pipeline
            && self.pipeline_slots() < self.max_slots
            && self.pending.len() < self.max_concurrent_creations
        {
            if !self.spawn_slot_creation(purpose) {
                break;
            }
        }
    }

    fn desired_pipeline_slots(&self) -> usize {
        let desired = self.buffer_size.saturating_add(self.waiters.len());
        desired.min(self.max_slots)
    }

    fn pipeline_slots(&self) -> usize {
        self.ready.len() + self.pending.len()
    }

    fn prune_closed_waiters(&mut self) {
        self.waiters.retain(|waiter| !waiter.respond_to.is_closed());
    }

    fn assign_ready_slots(&mut self) {
        while let Some(slot) = self.ready.pop_front() {
            if let AssignOutcome::NoWaiter(slot) = self.assign_slot_to_waiter(slot) {
                self.ready.push_front(slot);
                break;
            }
        }
    }

    fn assign_slot_to_waiter(&mut self, mut slot: PrewarmedSlot) -> AssignOutcome {
        while let Some(waiter) = self.waiters.pop_front() {
            let waited_ms = waiter.requested_at.elapsed().as_millis() as u64;
            let slot_id = slot.id().to_owned();
            match waiter.respond_to.send(Ok(slot)) {
                Ok(()) => {
                    info!(
                        id = %slot_id,
                        waited_ms,
                        ready = self.ready.len(),
                        pending = self.pending.len(),
                        waiters = self.waiters.len(),
                        "acquired COW slot"
                    );
                    return AssignOutcome::Assigned;
                }
                Err(Ok(returned_slot)) => {
                    slot = returned_slot;
                }
                Err(Err(_)) => {
                    return AssignOutcome::Assigned;
                }
            }
        }
        AssignOutcome::NoWaiter(slot)
    }

    fn fail_one_waiter(&mut self, mut error: CowPoolError) -> Option<CowPoolError> {
        while let Some(waiter) = self.waiters.pop_front() {
            match waiter.respond_to.send(Err(error)) {
                Ok(()) => return None,
                Err(Err(returned_error)) => {
                    error = returned_error;
                }
                Err(Ok(slot)) => {
                    self.ready.push_front(slot);
                    return None;
                }
            }
        }
        Some(error)
    }

    fn spawn_slot_creation(&mut self, purpose: CreationPurpose) -> bool {
        if !self.active
            || self.pending.len() >= self.max_concurrent_creations
            || self.pipeline_slots() >= self.max_slots
        {
            return false;
        }

        let config = self.config.clone();
        let spawner = Arc::clone(&self.slot_spawner);
        self.pending.spawn(async move {
            let started = StdInstant::now();
            let handle = spawner(config);
            let result = handle
                .await
                .map_err(|e| CowPoolError::CowFileCreation(format!("join: {e}")))
                .and_then(|result| result);
            SlotCreationOutcome {
                purpose,
                elapsed: started.elapsed(),
                result,
            }
        });
        true
    }

    async fn handle_creation_join(
        &mut self,
        completion: Option<Result<SlotCreationOutcome, tokio::task::JoinError>>,
    ) {
        let Some(completion) = completion else {
            self.maybe_finish_warmup();
            return;
        };
        match completion {
            Ok(outcome) => self.handle_creation_outcome(outcome).await,
            Err(e) => {
                self.handle_creation_failure(CowPoolError::CowFileCreation(format!("join: {e}")));
            }
        }
        self.pump();
        self.maybe_finish_warmup();
    }

    async fn handle_creation_outcome(&mut self, outcome: SlotCreationOutcome) {
        let elapsed_ms = outcome.elapsed.as_millis() as u64;
        match outcome.result {
            Ok(slot) => {
                let slot_id = slot.id().to_owned();
                self.warm_retry_at = None;
                if self.active {
                    self.ready.push_back(slot);
                } else {
                    destroy_slot_async(slot).await;
                }
                info!(
                    id = %slot_id,
                    purpose = ?outcome.purpose,
                    elapsed_ms,
                    ready = self.ready.len(),
                    pending = self.pending.len(),
                    waiters = self.waiters.len(),
                    pipeline_slots = self.pipeline_slots(),
                    "COW slot created"
                );
            }
            Err(e) => {
                error!(
                    purpose = ?outcome.purpose,
                    elapsed_ms,
                    error = %e,
                    ready = self.ready.len(),
                    pending = self.pending.len(),
                    waiters = self.waiters.len(),
                    pipeline_slots = self.pipeline_slots(),
                    "COW slot creation failed"
                );
                self.handle_creation_failure(e);
            }
        }
    }

    fn handle_creation_failure(&mut self, error: CowPoolError) {
        if !self.active {
            return;
        }
        if let Some(error) = self.fail_one_waiter(error) {
            warn!(
                error = %error,
                backoff_ms = self.warm_retry_backoff.as_millis() as u64,
                "background COW slot creation failed; delaying warm retry"
            );
            self.schedule_warm_retry();
        } else if self.waiters.is_empty() {
            self.schedule_warm_retry();
        }
    }

    fn schedule_warm_retry(&mut self) {
        if self.warm_retry_at.is_none() {
            self.warm_retry_at = Some(TokioInstant::now() + self.warm_retry_backoff);
        }
    }

    fn maybe_finish_warmup(&mut self) {
        if !self.pending.is_empty() || self.warmup_waiters.is_empty() {
            return;
        }

        let waiters = std::mem::take(&mut self.warmup_waiters);
        for done in waiters {
            let _ = done.send(());
        }
        if self.ready.is_empty() {
            warn!(
                "COW pool warmup produced no ready slots - acquire calls will create slots on demand"
            );
        }
        info!(
            ready = self.ready.len(),
            buffer = self.buffer_size,
            "COW pool warmed up"
        );
    }

    /// Shut down the producer and drop all pool-owned slots.
    async fn cleanup(&mut self) {
        if !self.active && self.pending.is_empty() && self.ready.is_empty() {
            return;
        }

        let started = StdInstant::now();
        let pending_at_start = self.pending.len();
        let ready_at_start = self.ready.len();
        self.active = false;
        self.warm_retry_at = None;
        self.fail_all_waiters();
        self.finish_warmup_waiters();

        while let Some(slot) = self.ready.pop_front() {
            destroy_slot_async(slot).await;
        }

        while let Some(completion) = self.pending.join_next().await {
            self.handle_cleanup_completion(completion).await;
        }

        info!(
            pending_at_start,
            ready_at_start,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "COW pool cleanup complete"
        );
    }

    fn fail_all_waiters(&mut self) {
        while let Some(waiter) = self.waiters.pop_front() {
            let _ = waiter.respond_to.send(Err(CowPoolError::NotActive));
        }
    }

    fn finish_warmup_waiters(&mut self) {
        for done in std::mem::take(&mut self.warmup_waiters) {
            let _ = done.send(());
        }
    }

    async fn handle_cleanup_completion(
        &mut self,
        completion: Result<SlotCreationOutcome, tokio::task::JoinError>,
    ) {
        match completion {
            Ok(SlotCreationOutcome {
                result: Ok(slot),
                elapsed,
                ..
            }) => {
                let slot_id = slot.id().to_owned();
                info!(
                    id = %slot_id,
                    elapsed_ms = elapsed.as_millis() as u64,
                    "dropping late COW slot during cleanup"
                );
                destroy_slot_async(slot).await;
            }
            Ok(SlotCreationOutcome {
                result: Err(e),
                elapsed,
                ..
            }) => {
                error!(
                    error = %e,
                    elapsed_ms = elapsed.as_millis() as u64,
                    "pending COW slot creation failed during cleanup"
                );
            }
            Err(e) => {
                error!(error = %e, "pending COW slot task panicked during cleanup");
            }
        }
    }

    #[cfg(test)]
    fn snapshot(&self) -> CowPoolSnapshot {
        CowPoolSnapshot {
            ready: self.ready.len(),
            pending: self.pending.len(),
            waiters: self.waiters.len(),
            pipeline_slots: self.pipeline_slots(),
            warm_retry_scheduled: self.warm_retry_at.is_some(),
        }
    }
}

enum AssignOutcome {
    Assigned,
    NoWaiter(PrewarmedSlot),
}

impl Drop for CowPool {
    fn drop(&mut self) {
        if self.active || !self.pending.is_empty() || !self.waiters.is_empty() {
            warn!(
                active = self.active,
                ready = self.ready.len(),
                pending = self.pending.len(),
                waiters = self.waiters.len(),
                pipeline_slots = self.pipeline_slots(),
                "CowPool dropped without cleanup"
            );
        }
    }
}

fn default_slot_spawner() -> SlotSpawner {
    Arc::new(|config| tokio::task::spawn_blocking(move || create_slot(&config)))
}

// ---------------------------------------------------------------------------
// Slot creation and teardown helpers
// ---------------------------------------------------------------------------

/// Create a pre-warmed slot: workspace directory + COW file.
fn create_slot(config: &CowPoolConfig) -> Result<PrewarmedSlot, CowPoolError> {
    let id = uuid::Uuid::new_v4().to_string();
    let workspace = config.workspaces_dir.join(&id);
    let cow_file = workspace.join("cow.img");

    if let Err(e) = create_cow_file(config, &workspace, &cow_file) {
        // Best-effort cleanup: remove any partially-created workspace.
        let _ = std::fs::remove_dir_all(&workspace);
        return Err(e);
    }

    Ok(PrewarmedSlot::new(id, workspace))
}

/// Create the COW file: sparse-copy from golden image or allocate fresh.
fn create_cow_file(
    config: &CowPoolConfig,
    workspace: &Path,
    cow_file: &Path,
) -> Result<(), CowPoolError> {
    std::fs::create_dir_all(workspace).map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
    match &config.golden_cow {
        Some(golden) => {
            sparse_copy(golden, cow_file)?;
            // Also copy the bitmap sidecar if it exists (for snapshot restore).
            let golden_bitmap = PathBuf::from(format!("{}.bitmap", golden.display()));
            if golden_bitmap.exists() {
                let cow_bitmap = PathBuf::from(format!("{}.bitmap", cow_file.display()));
                sparse_copy(&golden_bitmap, &cow_bitmap)?;
            }
        }
        None => {
            let f = std::fs::File::create(cow_file)
                .map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
            f.set_len(config.base_size)
                .map_err(|e| CowPoolError::CowFileCreation(e.to_string()))?;
        }
    }
    Ok(())
}

/// Synchronous sparse copy via `cp --sparse=always`.
fn sparse_copy(src: &Path, dst: &Path) -> Result<(), CowPoolError> {
    let output = std::process::Command::new("cp")
        .arg("--sparse=always")
        .arg(src)
        .arg(dst)
        .output()
        .map_err(|e| CowPoolError::CowFileCreation(format!("exec cp: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CowPoolError::CowFileCreation(format!(
            "cp --sparse=always failed: {stderr}"
        )));
    }
    Ok(())
}

/// Best-effort synchronous teardown of a pre-warmed slot.
///
/// Removes the workspace directory (which contains the COW file).
pub(crate) fn destroy_slot_sync(mut slot: PrewarmedSlot) {
    if let Some(cleanup) = slot.cleanup.take() {
        let workspace = cleanup.remove_best_effort();
        slot.notify_teardown(workspace);
    }
}

/// Best-effort teardown of a pre-warmed slot on Tokio's blocking pool.
///
/// The blocking task is spawned before this returns so dropping the returned
/// future cannot make the slot fall back to synchronous `Drop` on the caller.
pub(crate) fn destroy_slot_async(slot: PrewarmedSlot) -> impl std::future::Future<Output = ()> {
    let teardown = tokio::task::spawn_blocking(move || destroy_slot_sync(slot));
    async move {
        if let Err(e) = teardown.await {
            warn!(error = %e, "COW slot teardown task failed");
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn test_config(dir: &Path) -> CowPoolConfig {
        CowPoolConfig {
            workspaces_dir: dir.to_owned(),
            base_size: 64 * 1024 * 1024,
            golden_cow: None,
        }
    }

    fn test_slot(dir: &Path, id: &str) -> PrewarmedSlot {
        let workspace = dir.join(id);
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("cow.img"), b"cow").unwrap();
        PrewarmedSlot::new(id.to_owned(), workspace)
    }

    fn test_slot_with_drop_notify(
        dir: &Path,
        id: &str,
    ) -> (PrewarmedSlot, oneshot::Receiver<PathBuf>) {
        let (drop_notify, dropped) = oneshot::channel();
        let mut slot = test_slot(dir, id);
        slot.drop_notify = Some(drop_notify);
        (slot, dropped)
    }

    fn test_slot_with_teardown_gate(
        dir: &Path,
        id: &str,
    ) -> (
        PrewarmedSlot,
        oneshot::Receiver<PathBuf>,
        std::sync::mpsc::Sender<()>,
        oneshot::Receiver<PathBuf>,
    ) {
        let (teardown_started, started) = oneshot::channel();
        let (release, teardown_release) = std::sync::mpsc::channel();
        let (mut slot, dropped) = test_slot_with_drop_notify(dir, id);
        slot.set_teardown_gate(teardown_started, teardown_release);
        (slot, started, release, dropped)
    }

    fn test_pool_with_spawner(
        config: CowPoolConfig,
        buffer_size: usize,
        max_concurrent_creations: usize,
        max_slots: usize,
        warm_retry_backoff: Duration,
        slot_spawner: SlotSpawner,
    ) -> CowPool {
        CowPool::new_with_options(
            config,
            buffer_size,
            max_concurrent_creations,
            max_slots,
            warm_retry_backoff,
            slot_spawner,
        )
    }

    type ControlledSlotRequest = oneshot::Sender<Result<PrewarmedSlot, CowPoolError>>;

    struct ControlledSpawner {
        requests: Arc<Mutex<VecDeque<ControlledSlotRequest>>>,
    }

    impl ControlledSpawner {
        fn new() -> (Self, SlotSpawner) {
            let requests = Arc::new(Mutex::new(VecDeque::new()));
            let spawner_requests = Arc::clone(&requests);
            let spawner: SlotSpawner = Arc::new(move |_config| {
                let (complete, complete_rx) = oneshot::channel();
                spawner_requests.lock().unwrap().push_back(complete);
                tokio::spawn(async move {
                    complete_rx
                        .await
                        .unwrap_or_else(|_| Err(CowPoolError::CowFileCreation("cancelled".into())))
                })
            });
            (Self { requests }, spawner)
        }

        fn take_request(&self) -> oneshot::Sender<Result<PrewarmedSlot, CowPoolError>> {
            self.requests
                .lock()
                .unwrap()
                .pop_front()
                .expect("missing slot creation request")
        }

        fn request_count(&self) -> usize {
            self.requests.lock().unwrap().len()
        }
    }

    async fn wait_for_snapshot<F>(handle: &CowPoolHandle, predicate: F) -> CowPoolSnapshot
    where
        F: Fn(&CowPoolSnapshot) -> bool,
    {
        let deadline = StdInstant::now() + Duration::from_secs(1);
        loop {
            let snapshot = handle.snapshot().await;
            if predicate(&snapshot) {
                return snapshot;
            }
            assert!(
                StdInstant::now() < deadline,
                "condition not reached; last snapshot: {snapshot:?}"
            );
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn warmup_creates_ready_slots() {
        let tmp = tempfile::tempdir().unwrap();
        let handle = CowPoolHandle::new(test_config(tmp.path()));

        handle.warmup().await;

        let snapshot = handle.snapshot().await;
        assert_eq!(snapshot.ready, BUFFER_SIZE);
        assert_eq!(snapshot.pending, 0);
        assert_eq!(snapshot.pipeline_slots, BUFFER_SIZE);
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn pipeline_slots_include_ready_and_pending_slots() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool =
            test_pool_with_spawner(test_config(tmp.path()), 2, 1, 4, Duration::ZERO, spawner);
        let handle = CowPoolHandle::new_for_test(pool);

        let warmup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.warmup().await }
        });
        wait_for_snapshot(&handle, |snapshot| {
            snapshot.ready == 0 && snapshot.pending == 1 && snapshot.pipeline_slots == 1
        })
        .await;

        controller
            .take_request()
            .send(Ok(test_slot(tmp.path(), "ready")))
            .unwrap();
        wait_for_snapshot(&handle, |snapshot| {
            snapshot.ready == 1 && snapshot.pending == 1 && snapshot.pipeline_slots == 2
        })
        .await;

        controller
            .take_request()
            .send(Ok(test_slot(tmp.path(), "pending")))
            .unwrap();
        warmup.await.unwrap();
        let snapshot = handle.snapshot().await;
        assert_eq!(snapshot.ready, 2);
        assert_eq!(snapshot.pending, 0);
        assert_eq!(snapshot.pipeline_slots, 2);
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn acquire_after_cleanup_returns_error() {
        let tmp = tempfile::tempdir().unwrap();
        let handle = CowPoolHandle::new(test_config(tmp.path()));

        handle.cleanup().await;

        let err = handle.acquire().await.unwrap_err();
        assert!(
            matches!(err, CowPoolError::ActorStopped | CowPoolError::NotActive),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn burst_acquire_starts_bounded_slot_creations() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool =
            test_pool_with_spawner(test_config(tmp.path()), 0, 2, 10, Duration::ZERO, spawner);
        let handle = CowPoolHandle::new_for_test(pool);

        let mut acquires = Vec::new();
        for _ in 0..5 {
            let handle = handle.clone();
            acquires.push(tokio::spawn(async move { handle.acquire().await }));
        }

        wait_for_snapshot(&handle, |snapshot| {
            snapshot.waiters == 5 && snapshot.pending == 2 && snapshot.pipeline_slots == 2
        })
        .await;
        assert_eq!(controller.request_count(), 2);

        for i in 0..5 {
            controller
                .take_request()
                .send(Ok(test_slot(tmp.path(), &format!("slot-{i}"))))
                .unwrap();
            if i < 3 {
                wait_for_snapshot(&handle, |snapshot| snapshot.pending > 0).await;
            }
        }

        for acquire in acquires {
            drop(acquire.await.unwrap().unwrap());
        }
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn checked_out_slot_stops_consuming_pipeline_capacity() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool =
            test_pool_with_spawner(test_config(tmp.path()), 0, 1, 1, Duration::ZERO, spawner);
        let handle = CowPoolHandle::new_for_test(pool);

        let first = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
        controller
            .take_request()
            .send(Ok(test_slot(tmp.path(), "first")))
            .unwrap();
        let first_slot = first.await.unwrap().unwrap();

        wait_for_snapshot(&handle, |snapshot| snapshot.pipeline_slots == 0).await;
        let second = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
        controller
            .take_request()
            .send(Ok(test_slot(tmp.path(), "second")))
            .unwrap();
        let second_slot = second.await.unwrap().unwrap();

        drop(first_slot);
        drop(second_slot);
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn cancelled_acquire_does_not_lose_completed_slot() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool =
            test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
        let handle = CowPoolHandle::new_for_test(pool);

        let first = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
        first.abort();

        let second = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        controller
            .take_request()
            .send(Ok(test_slot(tmp.path(), "survives-cancel")))
            .unwrap();

        let slot = second.await.unwrap().unwrap();
        assert_eq!(slot.id(), "survives-cancel");
        drop(slot);
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn creation_failure_fails_one_waiter_and_retries_remaining_waiter() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool =
            test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
        let handle = CowPoolHandle::new_for_test(pool);

        let first = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        let second = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        wait_for_snapshot(&handle, |snapshot| {
            snapshot.waiters == 2 && snapshot.pending == 1
        })
        .await;

        controller
            .take_request()
            .send(Err(CowPoolError::CowFileCreation("boom".into())))
            .unwrap();

        assert!(matches!(
            first.await.unwrap(),
            Err(CowPoolError::CowFileCreation(_))
        ));
        wait_for_snapshot(&handle, |snapshot| {
            snapshot.waiters == 1 && snapshot.pending == 1
        })
        .await;
        controller
            .take_request()
            .send(Ok(test_slot(tmp.path(), "second")))
            .unwrap();
        drop(second.await.unwrap().unwrap());
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn creation_failure_skips_cancelled_waiter() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool =
            test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
        let handle = CowPoolHandle::new_for_test(pool);

        let cancelled = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        let active = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        wait_for_snapshot(&handle, |snapshot| {
            snapshot.waiters == 2 && snapshot.pending == 1
        })
        .await;
        cancelled.abort();
        assert!(cancelled.await.unwrap_err().is_cancelled());

        controller
            .take_request()
            .send(Err(CowPoolError::CowFileCreation("boom".into())))
            .unwrap();

        assert!(matches!(
            active.await.unwrap(),
            Err(CowPoolError::CowFileCreation(_))
        ));
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn single_demand_failure_backs_off_warm_retry_until_next_demand() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool = test_pool_with_spawner(
            test_config(tmp.path()),
            1,
            1,
            4,
            Duration::from_secs(60),
            spawner,
        );
        let handle = CowPoolHandle::new_for_test(pool);

        let first = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
        controller
            .take_request()
            .send(Err(CowPoolError::CowFileCreation("demand failed".into())))
            .unwrap();
        assert!(matches!(
            first.await.unwrap(),
            Err(CowPoolError::CowFileCreation(_))
        ));
        wait_for_snapshot(&handle, |snapshot| {
            snapshot.pending == 0 && snapshot.warm_retry_scheduled
        })
        .await;
        assert_eq!(controller.request_count(), 0);

        let second = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
        controller
            .take_request()
            .send(Ok(test_slot(tmp.path(), "demand-success")))
            .unwrap();
        drop(second.await.unwrap().unwrap());
        wait_for_snapshot(&handle, |snapshot| {
            snapshot.pending == 1 && !snapshot.warm_retry_scheduled
        })
        .await;
        controller
            .take_request()
            .send(Ok(test_slot(tmp.path(), "warm-after-success")))
            .unwrap();
        wait_for_snapshot(&handle, |snapshot| {
            snapshot.pending == 0 && snapshot.ready == 1
        })
        .await;
        handle.cleanup().await;
    }

    #[tokio::test(start_paused = true)]
    async fn warm_replenishment_failure_uses_backoff() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool = test_pool_with_spawner(
            test_config(tmp.path()),
            1,
            1,
            4,
            Duration::from_secs(10),
            spawner,
        );
        let handle = CowPoolHandle::new_for_test(pool);

        let warmup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.warmup().await }
        });
        wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
        controller
            .take_request()
            .send(Err(CowPoolError::CowFileCreation("missing golden".into())))
            .unwrap();
        warmup.await.unwrap();
        wait_for_snapshot(&handle, |snapshot| {
            snapshot.pending == 0 && snapshot.warm_retry_scheduled
        })
        .await;
        assert_eq!(controller.request_count(), 0);

        tokio::time::advance(Duration::from_secs(10)).await;
        wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
        controller
            .take_request()
            .send(Err(CowPoolError::CowFileCreation("still missing".into())))
            .unwrap();
        wait_for_snapshot(&handle, |snapshot| snapshot.pending == 0).await;
        handle.cleanup().await;
    }

    #[tokio::test(start_paused = true)]
    async fn due_warm_retry_runs_before_snapshot_command() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool = test_pool_with_spawner(
            test_config(tmp.path()),
            1,
            1,
            4,
            Duration::from_secs(10),
            spawner,
        );
        let handle = CowPoolHandle::new_for_test(pool);

        let warmup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.warmup().await }
        });
        wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
        controller
            .take_request()
            .send(Err(CowPoolError::CowFileCreation("missing golden".into())))
            .unwrap();
        warmup.await.unwrap();
        wait_for_snapshot(&handle, |snapshot| {
            snapshot.pending == 0 && snapshot.warm_retry_scheduled
        })
        .await;

        tokio::time::advance(Duration::from_secs(10)).await;

        let snapshot = handle.snapshot().await;
        assert_eq!(snapshot.pending, 1);
        assert!(!snapshot.warm_retry_scheduled);

        controller
            .take_request()
            .send(Ok(test_slot(tmp.path(), "retry-before-snapshot")))
            .unwrap();
        wait_for_snapshot(&handle, |snapshot| {
            snapshot.pending == 0 && snapshot.ready == 1
        })
        .await;
        handle.cleanup().await;
    }

    #[tokio::test(start_paused = true)]
    async fn cleanup_cancels_scheduled_warm_retry() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool = test_pool_with_spawner(
            test_config(tmp.path()),
            1,
            1,
            4,
            Duration::from_secs(10),
            spawner,
        );
        let handle = CowPoolHandle::new_for_test(pool);

        let warmup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.warmup().await }
        });
        wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
        controller
            .take_request()
            .send(Err(CowPoolError::CowFileCreation("missing golden".into())))
            .unwrap();
        warmup.await.unwrap();
        wait_for_snapshot(&handle, |snapshot| {
            snapshot.pending == 0 && snapshot.warm_retry_scheduled
        })
        .await;

        handle.cleanup().await;
        tokio::time::advance(Duration::from_secs(10)).await;

        assert_eq!(controller.request_count(), 0);
        assert!(matches!(
            handle.acquire().await,
            Err(CowPoolError::ActorStopped | CowPoolError::NotActive)
        ));
    }

    #[tokio::test]
    async fn cleanup_waits_for_ready_slot_teardown() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool =
            test_pool_with_spawner(test_config(tmp.path()), 1, 1, 4, Duration::ZERO, spawner);
        let handle = CowPoolHandle::new_for_test(pool);

        let warmup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.warmup().await }
        });
        wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;

        let (slot, teardown_started, release_teardown, dropped) =
            test_slot_with_teardown_gate(tmp.path(), "ready-cleanup-waits");
        let workspace = slot.workspace().to_owned();
        controller.take_request().send(Ok(slot)).unwrap();
        warmup.await.unwrap();
        assert!(workspace.exists());

        let cleanup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.cleanup().await }
        });
        assert_eq!(teardown_started.await.unwrap(), workspace);
        assert!(workspace.exists());
        assert!(!cleanup.is_finished());

        release_teardown.send(()).unwrap();
        cleanup.await.unwrap();
        assert_eq!(dropped.await.unwrap(), workspace);
        assert!(!workspace.exists());
    }

    #[tokio::test]
    async fn cleanup_rejects_waiters_and_drops_late_pending_slot() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool =
            test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
        let handle = CowPoolHandle::new_for_test(pool);

        let acquire = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        wait_for_snapshot(&handle, |snapshot| {
            snapshot.waiters == 1 && snapshot.pending == 1
        })
        .await;

        let cleanup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.cleanup().await }
        });
        let result = acquire.await.unwrap();
        assert!(matches!(result, Err(CowPoolError::NotActive)));

        let (late_slot, teardown_started, release_teardown, dropped) =
            test_slot_with_teardown_gate(tmp.path(), "late");
        let late_workspace = late_slot.workspace().to_owned();
        controller.take_request().send(Ok(late_slot)).unwrap();
        assert_eq!(teardown_started.await.unwrap(), late_workspace);
        assert!(late_workspace.exists());
        assert!(!cleanup.is_finished());

        release_teardown.send(()).unwrap();
        cleanup.await.unwrap();
        assert_eq!(dropped.await.unwrap(), late_workspace);
        assert!(!late_workspace.exists());
        assert!(matches!(
            handle.acquire().await,
            Err(CowPoolError::ActorStopped | CowPoolError::NotActive)
        ));
    }

    #[tokio::test]
    async fn cleanup_is_not_starved_by_queued_acquires() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool =
            test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
        let handle = CowPoolHandle::new_for_test(pool);

        let mut acquires = Vec::new();
        for _ in 0..20 {
            let handle = handle.clone();
            acquires.push(tokio::spawn(async move { handle.acquire().await }));
        }
        wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;

        let cleanup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.cleanup().await }
        });
        controller
            .take_request()
            .send(Ok(test_slot(tmp.path(), "cleanup")))
            .unwrap();
        cleanup.await.unwrap();

        for acquire in acquires {
            match acquire.await.unwrap() {
                Err(CowPoolError::NotActive | CowPoolError::ActorStopped) => {}
                other => panic!("unexpected acquire result after cleanup: {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn dropping_handle_cleans_ready_slots() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool =
            test_pool_with_spawner(test_config(tmp.path()), 1, 1, 4, Duration::ZERO, spawner);
        let handle = CowPoolHandle::new_for_test(pool);

        let warmup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.warmup().await }
        });
        wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;

        let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), "ready-drop");
        let workspace = slot.workspace().to_owned();
        controller.take_request().send(Ok(slot)).unwrap();
        warmup.await.unwrap();
        assert!(workspace.exists());

        drop(handle);

        assert_eq!(dropped.await.unwrap(), workspace);
        assert!(!workspace.exists());
    }

    #[tokio::test]
    async fn dropping_handle_drains_pending_slot_creation() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool =
            test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
        let handle = CowPoolHandle::new_for_test(pool);

        let acquire = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        wait_for_snapshot(&handle, |snapshot| {
            snapshot.waiters == 1 && snapshot.pending == 1
        })
        .await;
        acquire.abort();
        assert!(acquire.await.unwrap_err().is_cancelled());

        let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), "pending-drop");
        let workspace = slot.workspace().to_owned();
        drop(handle);
        controller.take_request().send(Ok(slot)).unwrap();

        assert_eq!(dropped.await.unwrap(), workspace);
        assert!(!workspace.exists());
    }

    #[tokio::test]
    async fn concurrent_cleanup_callers_complete_after_pending_slot_drains() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool =
            test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
        let handle = CowPoolHandle::new_for_test(pool);

        let acquire = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        wait_for_snapshot(&handle, |snapshot| {
            snapshot.waiters == 1 && snapshot.pending == 1
        })
        .await;

        let cleanup_one = tokio::spawn({
            let handle = handle.clone();
            async move { handle.cleanup().await }
        });
        let cleanup_two = tokio::spawn({
            let handle = handle.clone();
            async move { handle.cleanup().await }
        });

        let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), "concurrent-cleanup");
        let workspace = slot.workspace().to_owned();
        controller.take_request().send(Ok(slot)).unwrap();

        cleanup_one.await.unwrap();
        cleanup_two.await.unwrap();
        assert_eq!(dropped.await.unwrap(), workspace);
        assert!(!workspace.exists());
        assert!(matches!(
            acquire.await.unwrap(),
            Err(CowPoolError::NotActive | CowPoolError::ActorStopped)
        ));
    }

    #[tokio::test]
    async fn cancelled_cleanup_waiter_does_not_cancel_actor_cleanup() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool =
            test_pool_with_spawner(test_config(tmp.path()), 0, 1, 4, Duration::ZERO, spawner);
        let handle = CowPoolHandle::new_for_test(pool);

        let acquire = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        wait_for_snapshot(&handle, |snapshot| {
            snapshot.waiters == 1 && snapshot.pending == 1
        })
        .await;

        let cleanup_waiter = tokio::spawn({
            let handle = handle.clone();
            async move { handle.cleanup().await }
        });
        assert!(matches!(
            acquire.await.unwrap(),
            Err(CowPoolError::NotActive)
        ));
        cleanup_waiter.abort();
        assert!(cleanup_waiter.await.unwrap_err().is_cancelled());

        let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), "cancelled-cleanup");
        let workspace = slot.workspace().to_owned();
        controller.take_request().send(Ok(slot)).unwrap();

        assert_eq!(dropped.await.unwrap(), workspace);
        assert!(!workspace.exists());
        assert!(matches!(
            handle.acquire().await,
            Err(CowPoolError::ActorStopped | CowPoolError::NotActive)
        ));
    }

    #[tokio::test]
    async fn cancelled_warmup_waiter_keeps_pending_slot_for_cleanup() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool =
            test_pool_with_spawner(test_config(tmp.path()), 1, 1, 4, Duration::ZERO, spawner);
        let handle = CowPoolHandle::new_for_test(pool);

        let warmup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.warmup().await }
        });
        wait_for_snapshot(&handle, |snapshot| snapshot.pending == 1).await;
        warmup.abort();
        assert!(warmup.await.unwrap_err().is_cancelled());

        let cleanup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.cleanup().await }
        });
        let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), "cancelled-warmup");
        let workspace = slot.workspace().to_owned();
        controller.take_request().send(Ok(slot)).unwrap();

        cleanup.await.unwrap();
        assert_eq!(dropped.await.unwrap(), workspace);
        assert!(!workspace.exists());
        assert!(matches!(
            handle.acquire().await,
            Err(CowPoolError::ActorStopped | CowPoolError::NotActive)
        ));
    }

    #[tokio::test]
    async fn slot_limit_enforced_under_concurrent_acquire() {
        let tmp = tempfile::tempdir().unwrap();
        let (controller, spawner) = ControlledSpawner::new();
        let pool =
            test_pool_with_spawner(test_config(tmp.path()), 0, 4, 2, Duration::ZERO, spawner);
        let handle = CowPoolHandle::new_for_test(pool);

        let mut acquires = Vec::new();
        for _ in 0..4 {
            let handle = handle.clone();
            acquires.push(tokio::spawn(async move { handle.acquire().await }));
        }

        wait_for_snapshot(&handle, |snapshot| {
            snapshot.waiters == 4 && snapshot.pending == 2 && snapshot.pipeline_slots == 2
        })
        .await;
        assert_eq!(controller.request_count(), 2);

        for i in 0..2 {
            controller
                .take_request()
                .send(Ok(test_slot(tmp.path(), &format!("limited-{i}"))))
                .unwrap();
        }
        wait_for_snapshot(&handle, |snapshot| snapshot.pending == 2).await;
        for i in 2..4 {
            controller
                .take_request()
                .send(Ok(test_slot(tmp.path(), &format!("limited-{i}"))))
                .unwrap();
        }
        for acquire in acquires {
            drop(acquire.await.unwrap().unwrap());
        }
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn zero_slot_limit_fails_all_waiters_without_hanging() {
        let tmp = tempfile::tempdir().unwrap();
        let (_controller, spawner) = ControlledSpawner::new();
        let pool =
            test_pool_with_spawner(test_config(tmp.path()), 0, 1, 0, Duration::ZERO, spawner);
        let handle = CowPoolHandle::new_for_test(pool);

        let first = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        let second = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });

        assert!(matches!(
            first.await.unwrap(),
            Err(CowPoolError::SlotLimitReached { max: 0 })
        ));
        assert!(matches!(
            second.await.unwrap(),
            Err(CowPoolError::SlotLimitReached { max: 0 })
        ));
        let snapshot = handle.snapshot().await;
        assert_eq!(snapshot.waiters, 0);
        assert_eq!(snapshot.pending, 0);
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn warmup_with_bad_config_does_not_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let config = CowPoolConfig {
            workspaces_dir: tmp.path().to_owned(),
            base_size: 64 * 1024 * 1024,
            golden_cow: Some(PathBuf::from("/nonexistent/golden.img")),
        };
        let handle = CowPoolHandle::new(config);

        handle.warmup().await;

        let snapshot = handle.snapshot().await;
        assert_eq!(snapshot.ready, 0);
        assert_eq!(snapshot.pending, 0);
        assert_eq!(snapshot.pipeline_slots, 0);
        handle.cleanup().await;
    }

    #[test]
    fn create_slot_with_nonexistent_golden_cow_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let config = CowPoolConfig {
            workspaces_dir: tmp.path().to_owned(),
            base_size: 64 * 1024 * 1024,
            golden_cow: Some(PathBuf::from("/nonexistent/golden.img")),
        };
        let err = create_slot(&config).unwrap_err();
        assert!(
            matches!(err, CowPoolError::CowFileCreation(_)),
            "expected CowFileCreation, got {err}"
        );
        let entries: Vec<_> = std::fs::read_dir(tmp.path()).unwrap().collect();
        assert_eq!(entries.len(), 0);
    }

    #[test]
    fn create_slot_with_bad_golden_bitmap_removes_partial_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let workspaces = tmp.path().join("workspaces");
        let golden = tmp.path().join("golden.img");
        std::fs::write(&golden, b"golden").unwrap();
        std::fs::create_dir(format!("{}.bitmap", golden.display())).unwrap();

        let config = CowPoolConfig {
            workspaces_dir: workspaces.clone(),
            base_size: 64 * 1024 * 1024,
            golden_cow: Some(golden),
        };
        let err = create_slot(&config).unwrap_err();
        assert!(
            matches!(err, CowPoolError::CowFileCreation(_)),
            "expected CowFileCreation, got {err}"
        );
        let entries: Vec<_> = std::fs::read_dir(&workspaces).unwrap().collect();
        assert_eq!(entries.len(), 0);
    }

    #[test]
    fn create_slot_with_golden_cow_without_bitmap_succeeds() {
        let tmp = tempfile::tempdir().unwrap();
        let workspaces = tmp.path().join("workspaces");
        let golden = tmp.path().join("golden.img");
        std::fs::write(&golden, b"golden").unwrap();

        let config = CowPoolConfig {
            workspaces_dir: workspaces,
            base_size: 64 * 1024 * 1024,
            golden_cow: Some(golden),
        };
        let slot = create_slot(&config).unwrap();
        assert!(slot.workspace().join("cow.img").exists());
        assert!(!PathBuf::from(format!("{}.bitmap", slot.cow_file().display())).exists());
        destroy_slot_sync(slot);
    }

    #[test]
    fn create_slot_fresh_mode_creates_cow_file() {
        let tmp = tempfile::tempdir().unwrap();
        let config = test_config(tmp.path());
        let slot = create_slot(&config).unwrap();
        let cow_file = slot.cow_file();
        assert!(cow_file.exists());
        let meta = std::fs::metadata(&cow_file).unwrap();
        assert_eq!(meta.len(), 64 * 1024 * 1024);
        destroy_slot_sync(slot);
    }

    #[test]
    fn destroy_slot_sync_removes_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let config = test_config(tmp.path());
        let slot = create_slot(&config).unwrap();
        let ws = slot.workspace().to_owned();
        assert!(ws.exists());
        destroy_slot_sync(slot);
        assert!(!ws.exists());
    }

    #[tokio::test]
    async fn prewarmed_slot_drop_fallback_removes_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let (slot, dropped) = test_slot_with_drop_notify(tmp.path(), "drop-fallback");
        let workspace = slot.workspace().to_owned();

        assert!(workspace.exists());
        drop(slot);

        assert_eq!(dropped.await.unwrap(), workspace);
        assert!(!workspace.exists());
    }

    #[tokio::test]
    async fn destroy_slot_async_starts_teardown_before_returned_future_is_polled() {
        let tmp = tempfile::tempdir().unwrap();
        let (slot, teardown_started, release_teardown, dropped) =
            test_slot_with_teardown_gate(tmp.path(), "eager-teardown");
        let workspace = slot.workspace().to_owned();

        let teardown = destroy_slot_async(slot);
        assert_eq!(teardown_started.await.unwrap(), workspace);
        assert!(workspace.exists());

        drop(teardown);
        release_teardown.send(()).unwrap();

        assert_eq!(dropped.await.unwrap(), workspace);
        assert!(!workspace.exists());
    }
}
