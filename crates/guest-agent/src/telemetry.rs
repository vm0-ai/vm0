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

use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::masker::SecretMasker;
use crate::paths;
use guest_common::log_warn;
use serde_json::{Value, json};
use std::io::{Read, Seek, SeekFrom, Write};
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
/// pass, so the EOF tail is consumed verbatim.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum UploadMode {
    Live,
    Final,
}

/// Read new bytes from `file_path` starting at the position stored in `pos_path`.
/// Returns the new content and the updated position.
///
/// In `Live` mode, the read is aligned to the last newline: any trailing
/// bytes after the last `\n` are treated as an in-progress write by the
/// producer and left for the next pass. This prevents the producer-consumer
/// race from splitting a log line mid-write, which would corrupt UTF-8
/// multibyte characters via `from_utf8_lossy` (the broken byte is replaced
/// by U+FFFD and permanently lost, since the position has already advanced
/// past it).
///
/// In `Final` mode, the tail is consumed as-is — there will be no subsequent
/// pass to pick it up. Any trailing fragment without a newline is uploaded
/// verbatim.
fn read_file_delta(file_path: &str, pos_path: &str, mode: UploadMode) -> (String, u64) {
    let last_pos: u64 = std::fs::read_to_string(pos_path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);

    let mut file = match std::fs::File::open(file_path) {
        Ok(f) => f,
        Err(_) => return (String::new(), last_pos),
    };

    let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if file_len <= last_pos {
        return (String::new(), last_pos);
    }

    if file.seek(SeekFrom::Start(last_pos)).is_err() {
        return (String::new(), last_pos);
    }

    let to_read = (file_len - last_pos) as usize;
    let mut buf = vec![0u8; to_read];
    if file.read_exact(&mut buf).is_err() {
        return (String::new(), last_pos);
    }

    if mode == UploadMode::Final {
        return (String::from_utf8_lossy(&buf).into_owned(), file_len);
    }

    match buf.iter().rposition(|&b| b == b'\n') {
        Some(idx) => {
            let consumed = idx + 1;
            let new_pos = last_pos + consumed as u64;
            // `consumed <= buf.len()` by construction (rposition returns
            // a valid index into buf, so idx + 1 <= buf.len()), so this
            // `get` always returns Some. The let-else exists only to
            // satisfy `clippy::indexing_slicing = "deny"` without an
            // explicit suppression or `expect`.
            let Some(slice) = buf.get(..consumed) else {
                return (String::new(), last_pos);
            };
            (String::from_utf8_lossy(slice).into_owned(), new_pos)
        }
        None => (String::new(), last_pos),
    }
}

/// Read new JSONL entries from a file, skipping invalid lines.
fn read_jsonl_delta(file_path: &str, pos_path: &str, mode: UploadMode) -> (Vec<Value>, u64) {
    let (content, new_pos) = read_file_delta(file_path, pos_path, mode);
    if content.is_empty() {
        return (Vec::new(), new_pos);
    }
    let entries: Vec<Value> = content
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    (entries, new_pos)
}

/// Persist the current read position for a file.
fn save_position(pos_path: &str, pos: u64) {
    if let Ok(mut f) = std::fs::File::create(pos_path) {
        let _ = write!(f, "{pos}");
    }
}

/// Perform one telemetry upload cycle.
///
/// `UploadMode::Final` should be used only for the very last upload before
/// the agent exits — any trailing fragment after the last newline is then
/// consumed as-is, accepting a small mid-write race window in exchange for
/// not losing the tail. Every earlier upload (periodic tick and the
/// pre-checkpoint `flush(UploadMode::Live)`) must use `UploadMode::Live`
/// so a later pass can safely pick up the tail once the producer
/// completes the line.
async fn upload_telemetry(
    http: &HttpClient,
    masker: &SecretMasker,
    mode: UploadMode,
) -> Result<(), AgentError> {
    // Read deltas
    let (system_log, log_pos) = read_file_delta(
        paths::system_log_file(),
        paths::telemetry_system_log_pos_file(),
        mode,
    );
    let (metrics, metrics_pos) = read_jsonl_delta(
        paths::metrics_log_file(),
        paths::telemetry_metrics_pos_file(),
        mode,
    );
    let (sandbox_ops, sandbox_ops_pos) = read_jsonl_delta(
        paths::sandbox_ops_file(),
        paths::telemetry_sandbox_ops_pos_file(),
        mode,
    );

    // Nothing new
    if system_log.is_empty() && metrics.is_empty() && sandbox_ops.is_empty() {
        return Ok(());
    }

    // Mask secrets in text content
    let masked_log = if system_log.is_empty() {
        String::new()
    } else {
        masker.mask_string(&system_log)
    };

    let payload = json!({
        "runId": env::run_id(),
        "systemLog": masked_log,
        "metrics": metrics,
        "sandboxOperations": sandbox_ops,
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
    /// for the very last flush before exit, which consumes the EOF tail.
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
    fn read_file_delta_from_start() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("log.txt");
        let pos = dir.path().join("log.pos");
        fs::write(&file, "hello world\n").unwrap();

        let (content, new_pos) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert_eq!(content, "hello world\n");
        assert_eq!(new_pos, 12);
    }

    #[test]
    fn read_file_delta_incremental() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("log.txt");
        let pos = dir.path().join("log.pos");
        fs::write(&file, "hello world\n").unwrap();
        // Simulate having already read 6 bytes
        fs::write(&pos, "6").unwrap();

        let (content, new_pos) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert_eq!(content, "world\n");
        assert_eq!(new_pos, 12);
    }

    #[test]
    fn read_file_delta_no_new_data() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("log.txt");
        let pos = dir.path().join("log.pos");
        fs::write(&file, "done").unwrap();
        fs::write(&pos, "4").unwrap();

        let (content, new_pos) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert!(content.is_empty());
        assert_eq!(new_pos, 4);
    }

    #[test]
    fn read_file_delta_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("missing.txt");
        let pos = dir.path().join("missing.pos");

        let (content, new_pos) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert!(content.is_empty());
        assert_eq!(new_pos, 0);
    }

    #[test]
    fn read_jsonl_delta_parses_valid_lines() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("data.jsonl");
        let pos = dir.path().join("data.pos");
        fs::write(&file, "{\"a\":1}\n{\"b\":2}\ninvalid\n").unwrap();

        let (entries, new_pos) = read_jsonl_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["a"], 1);
        assert_eq!(entries[1]["b"], 2);
        assert!(new_pos > 0);
    }

    #[test]
    fn save_position_and_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let pos = dir.path().join("test.pos");
        save_position(pos.to_str().unwrap(), 42);
        let val: u64 = fs::read_to_string(&pos).unwrap().trim().parse().unwrap();
        assert_eq!(val, 42);
    }

    #[test]
    fn read_file_delta_truncated_file() {
        // Position file says we read 100 bytes, but file is shorter → no new data.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("log.txt");
        let pos = dir.path().join("log.pos");
        fs::write(&file, "short").unwrap();
        fs::write(&pos, "100").unwrap();

        let (content, new_pos) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert!(content.is_empty());
        assert_eq!(new_pos, 100);
    }

    #[test]
    fn read_file_delta_corrupt_pos_file() {
        // Corrupt position file → starts from 0.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("log.txt");
        let pos = dir.path().join("log.pos");
        fs::write(&file, "data\n").unwrap();
        fs::write(&pos, "notanumber").unwrap();

        let (content, new_pos) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert_eq!(content, "data\n");
        assert_eq!(new_pos, 5);
    }

    #[test]
    fn read_jsonl_delta_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("empty.jsonl");
        let pos = dir.path().join("empty.pos");
        fs::write(&file, "").unwrap();

        let (entries, new_pos) = read_jsonl_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert!(entries.is_empty());
        assert_eq!(new_pos, 0);
    }

    #[test]
    fn read_jsonl_delta_all_invalid_lines() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("bad.jsonl");
        let pos = dir.path().join("bad.pos");
        fs::write(&file, "bad1\nbad2\nbad3\n").unwrap();

        let (entries, new_pos) = read_jsonl_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert!(entries.is_empty());
        assert!(new_pos > 0);
    }

    /// Live mode: an in-progress line (no trailing \n) must be deferred
    /// to the next pass instead of being uploaded half-written.
    #[test]
    fn read_file_delta_defers_trailing_fragment() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("log.txt");
        let pos = dir.path().join("log.pos");
        // Two complete lines followed by a partial write.
        fs::write(&file, "line1\nline2\npartial").unwrap();

        // First pass: read up to the last newline, leave "partial" behind.
        let (content, new_pos) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert_eq!(content, "line1\nline2\n");
        assert_eq!(new_pos, 12);

        // Simulate the producer completing the line.
        fs::write(&file, "line1\nline2\npartial done\n").unwrap();
        fs::write(&pos, "12").unwrap();

        // Second pass: now "partial done\n" is complete.
        let (content2, new_pos2) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert_eq!(content2, "partial done\n");
        assert_eq!(new_pos2, 25);
    }

    /// Final pass: trailing fragment without a newline must be consumed,
    /// since there will be no subsequent pass to pick it up.
    #[test]
    fn read_file_delta_final_pass_consumes_fragment() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("log.txt");
        let pos = dir.path().join("log.pos");
        fs::write(&file, "line1\npartial").unwrap();

        let (content, new_pos) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Final,
        );
        assert_eq!(content, "line1\npartial");
        assert_eq!(new_pos, 13);
    }

    /// Regression: a multibyte UTF-8 character split across two passes
    /// must survive intact. Before the fix, `from_utf8_lossy` replaced
    /// each split byte with U+FFFD and the broken char was permanently
    /// lost because `save_position` had advanced past it.
    #[test]
    fn read_file_delta_utf8_multibyte_survives_split() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("log.txt");
        let pos = dir.path().join("log.pos");
        // "中" is 3 bytes (0xE4 0xB8 0xAD). Simulate the producer having
        // written only the first byte mid-line: "prefix\n\xE4".
        let mut partial = Vec::from("prefix\n");
        partial.push(0xE4);
        fs::write(&file, &partial).unwrap();

        // First pass: stops at the newline, leaves the orphan 0xE4 behind.
        let (content, new_pos) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert_eq!(content, "prefix\n");
        assert_eq!(new_pos, 7);
        fs::write(&pos, new_pos.to_string()).unwrap();

        // Producer finishes writing the character and terminates the line.
        let mut complete = partial.clone();
        complete.extend_from_slice(&[0xB8, 0xAD]); // rest of "中"
        complete.extend_from_slice(b"\n");
        fs::write(&file, &complete).unwrap();

        // Second pass: reads the complete multibyte character.
        let (content2, new_pos2) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert_eq!(content2, "中\n");
        assert_eq!(new_pos2, complete.len() as u64);
        // No U+FFFD anywhere — the character is intact.
        assert!(!content2.contains('\u{FFFD}'));
    }

    /// A JSONL file with a partially-written trailing record must not have
    /// that record silently dropped. The half line is deferred to the next
    /// pass, and once the producer completes it, the entry is uploaded.
    #[test]
    fn read_jsonl_delta_defers_partial_line() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("data.jsonl");
        let pos = dir.path().join("data.pos");
        fs::write(&file, "{\"a\":1}\n{\"b\":2").unwrap();

        // First pass: only {"a":1} is complete.
        let (entries, new_pos) = read_jsonl_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["a"], 1);
        assert_eq!(new_pos, 8);
        fs::write(&pos, new_pos.to_string()).unwrap();

        // Producer completes the record.
        fs::write(&file, "{\"a\":1}\n{\"b\":2}\n").unwrap();
        let (entries2, new_pos2) = read_jsonl_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert_eq!(entries2.len(), 1);
        assert_eq!(entries2[0]["b"], 2);
        assert_eq!(new_pos2, 16);
    }

    /// Live mode, first pass, delta contains no newline at all. Must
    /// return empty without advancing the position so the data is
    /// picked up intact once the producer writes the terminating \n.
    #[test]
    fn read_file_delta_live_no_newline_at_all() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("log.txt");
        let pos = dir.path().join("log.pos");
        fs::write(&file, "partial").unwrap();

        let (content, new_pos) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert!(content.is_empty());
        assert_eq!(new_pos, 0);

        // Producer completes the line — the next pass picks up everything.
        fs::write(&file, "partial done\n").unwrap();
        let (content2, new_pos2) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert_eq!(content2, "partial done\n");
        assert_eq!(new_pos2, 13);
    }

    /// Final pass must consume the whole buffer even when the file contains
    /// no newlines at all — otherwise the tail is silently dropped.
    #[test]
    fn read_file_delta_final_pass_all_no_newline() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("log.txt");
        let pos = dir.path().join("log.pos");
        fs::write(&file, "no_newline").unwrap();

        let (content, new_pos) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Final,
        );
        assert_eq!(content, "no_newline");
        assert_eq!(new_pos, 10);
    }

    /// Same guarantee as the 3-byte multibyte test, but with a 4-byte
    /// emoji — the most common case in real Claude Code output. A split
    /// in the middle of the 4-byte sequence must not corrupt the char.
    #[test]
    fn read_file_delta_utf8_4byte_emoji_survives_split() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("log.txt");
        let pos = dir.path().join("log.pos");
        // "😀" is 4 bytes (0xF0 0x9F 0x98 0x80). Producer wrote the first
        // two bytes mid-line: "prefix\n\xF0\x9F".
        let mut partial = Vec::from("prefix\n");
        partial.extend_from_slice(&[0xF0, 0x9F]);
        fs::write(&file, &partial).unwrap();

        // First pass stops at \n, defers the orphan bytes.
        let (content, new_pos) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert_eq!(content, "prefix\n");
        assert_eq!(new_pos, 7);
        fs::write(&pos, new_pos.to_string()).unwrap();

        // Producer finishes the emoji and terminates the line.
        let mut complete = partial.clone();
        complete.extend_from_slice(&[0x98, 0x80]);
        complete.extend_from_slice(b"\n");
        fs::write(&file, &complete).unwrap();

        let (content2, new_pos2) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert_eq!(content2, "😀\n");
        assert_eq!(new_pos2, complete.len() as u64);
        assert!(!content2.contains('\u{FFFD}'));
    }

    /// Documents the `Final` mode behavior under the residual mid-chunk
    /// race tracked in #11010: if vsock-guest's chunk boundary split a
    /// UTF-8 character, the final flush sees invalid bytes. The code
    /// must replace them with U+FFFD and advance the position — not
    /// panic, not truncate the tail. Guards against accidental
    /// replacement of `from_utf8_lossy` with the stricter `from_utf8`.
    #[test]
    fn read_file_delta_final_pass_invalid_utf8_replaces_with_fffd() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("log.txt");
        let pos = dir.path().join("log.pos");
        // Complete "log\n" followed by a lone 0xE4 (first byte of a
        // 3-byte UTF-8 char, the rest never arrived).
        let mut torn = Vec::from("log\n");
        torn.push(0xE4);
        fs::write(&file, &torn).unwrap();

        let (content, new_pos) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Final,
        );
        assert_eq!(content, "log\n\u{FFFD}");
        assert_eq!(new_pos, 5);
    }

    /// Regression for the pre-checkpoint flush UTF-8 bug: the
    /// pre-checkpoint flush (`UploadMode::Live`) must not consume an
    /// in-flight UTF-8 byte sequence. Simulates the real sequence — Live
    /// flush (newline-aligned), producer continues writing, Final
    /// catch-up flush (consumes EOF).
    #[test]
    fn live_pass_then_final_catch_up_preserves_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("log.txt");
        let pos = dir.path().join("log.pos");
        // Producer state at the moment the Live flush fires: "log\n"
        // plus the first byte of "中" (0xE4).
        let mut partial = Vec::from("log\n");
        partial.push(0xE4);
        fs::write(&file, &partial).unwrap();

        // Pre-checkpoint Live flush: newline-aligned, defers the orphan byte.
        let (content, new_pos) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Live,
        );
        assert_eq!(content, "log\n");
        assert_eq!(new_pos, 4);
        fs::write(&pos, new_pos.to_string()).unwrap();

        // Producer finishes "中" and appends a final line.
        let mut complete = partial.clone();
        complete.extend_from_slice(&[0xB8, 0xAD]);
        complete.extend_from_slice(b"\ntail");
        fs::write(&file, &complete).unwrap();

        // Catch-up final pass: consumes the rest including the no-newline tail.
        let (content2, new_pos2) = read_file_delta(
            file.to_str().unwrap(),
            pos.to_str().unwrap(),
            UploadMode::Final,
        );
        assert_eq!(content2, "中\ntail");
        assert_eq!(new_pos2, complete.len() as u64);
        assert!(!content2.contains('\u{FFFD}'));
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
