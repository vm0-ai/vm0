use std::time::Instant as StdInstant;

use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant as TokioInstant;

#[cfg(test)]
use super::CowPoolSnapshot;
use super::state::CowPool;
use super::{AcquireResult, CowPoolConfig, CowPoolError, PrewarmedSlot};

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
    pub(super) fn new_for_test(pool: CowPool) -> Self {
        Self::from_pool(pool)
    }

    #[cfg(test)]
    pub(super) async fn snapshot(&self) -> CowPoolSnapshot {
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
