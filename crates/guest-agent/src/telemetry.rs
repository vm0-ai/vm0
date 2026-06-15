//! Telemetry uploader — single-writer ownership of position files.
//!
//! All reads of the log files and writes to the `*_pos.txt` files happen
//! on one tokio task (`run`). The periodic tick and any caller-driven
//! flushes both flow through the same `tokio::select!`, so uploads are
//! serialized — eliminating the tick-vs-final race that used to regress
//! the position file (#11008).
//!
//! Callers interact via [`Telemetry`]: spawn the task with
//! [`Telemetry::spawn`], request uploads with [`Telemetry::flush`], and
//! release with [`Telemetry::shutdown`].

mod delta;

use self::delta::{read_file_delta, read_jsonl_delta};
use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::masker::SecretMasker;
use crate::paths;
use guest_common::log_warn;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Buffer size for the command channel. Only one flush is in flight at a
/// time during cleanup, so a small bounded queue is plenty.
const COMMAND_CHANNEL_CAPACITY: usize = 8;

/// Whether an upload pass should defer a trailing fragment to the next
/// pass, or consume it as-is because no next pass is coming.
///
/// `Live` is used while the producer is still actively writing the log
/// files — both periodic ticks and the pre-checkpoint flush. The trailing
/// bytes after the last newline are left in place so the next pass can
/// pick them up once the producer completes the line.
///
/// `Final` is the very last upload before agent exit. There is no next
/// pass, so the EOF tail is consumed verbatim when it fits in one bounded
/// read after any required line-boundary resync.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum UploadMode {
    Live,
    Final,
}

/// Persist the current read position for a file.
fn save_position(pos_path: &str, pos: u64) {
    let _ = paths::write_private(pos_path, pos.to_string());
}

/// Perform one telemetry upload cycle.
///
/// `UploadMode::Final` should be used only for the very last upload before
/// the agent exits. It consumes a trailing fragment as-is only when the
/// fragment fits inside this pass's bounded read. Every earlier upload
/// (periodic tick and the pre-checkpoint `flush(UploadMode::Live)`) must use
/// `UploadMode::Live` so a later pass can safely pick up the tail once the
/// producer completes the line.
async fn upload_telemetry(
    http: &HttpClient,
    masker: &SecretMasker,
    mode: UploadMode,
) -> Result<(), AgentError> {
    // Read deltas
    let system_log = read_file_delta(
        paths::system_log_file(),
        paths::telemetry_system_log_pos_file(),
        mode,
    );
    let metrics = read_jsonl_delta(
        paths::metrics_log_file(),
        paths::telemetry_metrics_pos_file(),
        mode,
    );
    let sandbox_ops = read_jsonl_delta(
        paths::sandbox_ops_file(),
        paths::telemetry_sandbox_ops_pos_file(),
        mode,
    );
    let log_pos = system_log.new_pos;
    let metrics_pos = metrics.new_pos;
    let sandbox_ops_pos = sandbox_ops.new_pos;
    let made_progress =
        system_log.made_progress || metrics.made_progress || sandbox_ops.made_progress;

    // Nothing new
    if system_log.content.is_empty() && metrics.entries.is_empty() && sandbox_ops.entries.is_empty()
    {
        if made_progress {
            save_position(paths::telemetry_system_log_pos_file(), log_pos);
            save_position(paths::telemetry_metrics_pos_file(), metrics_pos);
            save_position(paths::telemetry_sandbox_ops_pos_file(), sandbox_ops_pos);
        }
        return Ok(());
    }

    // Mask secrets in text content
    let masked_log = if system_log.content.is_empty() {
        String::new()
    } else {
        masker.mask_owned_string(system_log.content)
    };
    let metrics_entries = metrics.entries;
    let sandbox_ops_entries = sandbox_ops.entries;

    let payload = json!({
        "runId": env::run_id(),
        "systemLog": masked_log,
        "metrics": metrics_entries,
        "sandboxOperations": sandbox_ops_entries,
    });

    // Use 1 attempt for telemetry (non-critical, best-effort)
    let url = http.telemetry_url()?;
    match http.post_json(url, &payload, 1).await {
        Ok(_) => {
            save_position(paths::telemetry_system_log_pos_file(), log_pos);
            save_position(paths::telemetry_metrics_pos_file(), metrics_pos);
            save_position(paths::telemetry_sandbox_ops_pos_file(), sandbox_ops_pos);
            Ok(())
        }
        Err(e) => {
            log_warn!(LOG_TAG, "Telemetry upload failed (will retry): {e}");
            Err(e)
        }
    }
}

/// Commands accepted by the uploader task.
enum Cmd {
    /// Flush new telemetry now and report the result back via `reply`.
    /// `mode` is propagated to [`upload_telemetry`]; see [`UploadMode`].
    Flush {
        mode: UploadMode,
        reply: oneshot::Sender<Result<(), AgentError>>,
    },
    /// Stop the loop. Any in-flight upload completes first.
    Shutdown,
}

/// Owning handle to the uploader task.
///
/// Holds both the command channel and the spawned task's [`JoinHandle`],
/// so callers see one lifecycle object rather than juggling two.
/// Construct with [`Self::spawn`]; release with [`Self::shutdown`].
pub struct Telemetry {
    tx: mpsc::Sender<Cmd>,
    handle: JoinHandle<()>,
}

impl Telemetry {
    /// Spawn the uploader task and return an owning handle.
    ///
    /// Spawn **at most one instance per process.** The pos files
    /// (`paths::telemetry_*_pos_file`) are process-global; two uploader
    /// tasks would each call `upload_telemetry` on the same files,
    /// reintroducing the multi-writer race that the channel was built
    /// to eliminate (#11008). The type system can't enforce this — the
    /// constraint is the shared pos paths, not the channel.
    pub fn spawn(masker: Arc<SecretMasker>, http: HttpClient) -> Self {
        let (tx, rx) = mpsc::channel(COMMAND_CHANNEL_CAPACITY);
        let handle = tokio::spawn(run(rx, masker, http));
        Self { tx, handle }
    }

    /// Trigger a telemetry upload and await completion.
    ///
    /// Use [`UploadMode::Live`] for any flush while the agent is still
    /// running (the producer continues writing). Use [`UploadMode::Final`]
    /// for the very last flush before exit, which consumes the EOF tail when
    /// it fits in one bounded read.
    pub async fn flush(&self, mode: UploadMode) -> Result<(), AgentError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(Cmd::Flush {
                mode,
                reply: reply_tx,
            })
            .await
            .map_err(|_| AgentError::TelemetryUnavailable)?;
        reply_rx
            .await
            .map_err(|_| AgentError::TelemetryUnavailable)?
    }

    /// Stop the uploader and await graceful task termination.
    ///
    /// Consumes `self`, so no further commands can be sent after this
    /// call. Any commands queued before `shutdown` are processed first
    /// (the loop is FIFO); the task exits when it dequeues the
    /// `Shutdown` command.
    pub async fn shutdown(self) {
        let _ = self.tx.send(Cmd::Shutdown).await;
        let _ = self.handle.await;
    }
}

/// Single-writer task. Owns all pos-file mutations.
///
/// `biased` select ensures a queued Flush wins over a ready tick at any
/// select boundary, so a caller-driven flush is never blocked behind a
/// tick that hasn't started yet. (A tick already in its `await` cannot
/// be preempted; the worst-case wait for a flush is one in-flight tick.)
async fn run(mut rx: mpsc::Receiver<Cmd>, masker: Arc<SecretMasker>, http: HttpClient) {
    if !http.has_api() {
        // Drain commands so callers don't block on `reply_rx`. Flushes
        // are a no-op (no API to upload to); Shutdown ends the loop.
        while let Some(cmd) = rx.recv().await {
            match cmd {
                Cmd::Flush { reply, .. } => {
                    let _ = reply.send(Ok(()));
                }
                Cmd::Shutdown => break,
            }
        }
        return;
    }

    let mut interval =
        tokio::time::interval(Duration::from_secs(constants::TELEMETRY_INTERVAL_SECS));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    // `interval`'s first tick is immediately ready. Consume it so periodic
    // uploads start after the first full interval instead of racing explicit
    // startup/final flushes.
    interval.tick().await;

    loop {
        tokio::select! {
            biased;
            cmd = rx.recv() => match cmd {
                Some(Cmd::Flush { mode, reply }) => {
                    let result = upload_telemetry(&http, &masker, mode).await;
                    let _ = reply.send(result);
                }
                Some(Cmd::Shutdown) | None => break,
            },
            _ = interval.tick() => {
                let _ = upload_telemetry(&http, &masker, UploadMode::Live).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn save_position_and_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let pos = dir.path().join("test.pos");
        save_position(pos.to_str().unwrap(), 42);
        let val: u64 = fs::read_to_string(&pos).unwrap().trim().parse().unwrap();
        assert_eq!(val, 42);
    }

    #[test]
    fn save_position_overwrites_existing() {
        let dir = tempfile::tempdir().unwrap();
        let pos = dir.path().join("overwrite.pos");
        save_position(pos.to_str().unwrap(), 10);
        save_position(pos.to_str().unwrap(), 20);
        let val: u64 = fs::read_to_string(&pos).unwrap().trim().parse().unwrap();
        assert_eq!(val, 20);
    }
}
