//! Telemetry uploader — incremental file reads with position tracking.
//!
//! Periodically reads new data from log files and uploads to the
//! telemetry endpoint. Position files track how far we've read so
//! we don't re-upload on the next tick.

use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::http;
use crate::masker::SecretMasker;
use crate::paths;
use crate::urls;
use guest_common::{log_info, log_warn};
use serde_json::{Value, json};
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Read new bytes from `file_path` starting at the position stored in `pos_path`.
/// Returns the new content and the updated position.
fn read_file_delta(file_path: &str, pos_path: &str) -> (String, u64) {
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
    match file.read_exact(&mut buf) {
        Ok(()) => (String::from_utf8_lossy(&buf).into_owned(), file_len),
        Err(_) => (String::new(), last_pos),
    }
}

/// Read new JSONL entries from a file, skipping invalid lines.
fn read_jsonl_delta(file_path: &str, pos_path: &str) -> (Vec<Value>, u64) {
    let (content, new_pos) = read_file_delta(file_path, pos_path);
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
async fn upload_telemetry(masker: &SecretMasker) -> Result<(), AgentError> {
    // Read deltas
    let (system_log, log_pos) =
        read_file_delta(paths::system_log_file(), paths::telemetry_log_pos_file());
    let (metrics, metrics_pos) = read_jsonl_delta(
        paths::metrics_log_file(),
        paths::telemetry_metrics_pos_file(),
    );
    let (network_logs, network_pos) = read_jsonl_delta(
        paths::network_log_file(),
        paths::telemetry_network_pos_file(),
    );
    let (sandbox_ops, sandbox_ops_pos) = read_jsonl_delta(
        guest_common::telemetry::sandbox_ops_log(),
        paths::telemetry_sandbox_ops_pos_file(),
    );

    // Nothing new
    if system_log.is_empty()
        && metrics.is_empty()
        && network_logs.is_empty()
        && sandbox_ops.is_empty()
    {
        return Ok(());
    }

    // Mask secrets in text content
    let masked_log = if system_log.is_empty() {
        String::new()
    } else {
        masker.mask_string(&system_log)
    };

    let masked_network: Vec<Value> = network_logs
        .into_iter()
        .map(|mut v| {
            masker.mask_value(&mut v);
            v
        })
        .collect();

    let payload = json!({
        "runId": env::run_id(),
        "systemLog": masked_log,
        "metrics": metrics,
        "networkLogs": masked_network,
        "sandboxOperations": sandbox_ops,
    });

    // Use 1 attempt for telemetry (non-critical, best-effort)
    match http::post_json(urls::telemetry_url(), &payload, 1).await {
        Ok(_) => {
            save_position(paths::telemetry_log_pos_file(), log_pos);
            save_position(paths::telemetry_metrics_pos_file(), metrics_pos);
            save_position(paths::telemetry_network_pos_file(), network_pos);
            save_position(paths::telemetry_sandbox_ops_pos_file(), sandbox_ops_pos);
            Ok(())
        }
        Err(e) => {
            log_warn!(LOG_TAG, "Telemetry upload failed (will retry): {e}");
            Err(e)
        }
    }
}

/// Background loop uploading telemetry every `TELEMETRY_INTERVAL_SECS`.
pub async fn telemetry_loop(shutdown: CancellationToken, masker: Arc<SecretMasker>) {
    let mut interval =
        tokio::time::interval(Duration::from_secs(constants::TELEMETRY_INTERVAL_SECS));
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = interval.tick() => {
                let _ = upload_telemetry(&masker).await;
            }
        }
    }
}

/// Final telemetry upload before agent completion.
pub async fn final_upload(masker: &SecretMasker) -> Result<(), AgentError> {
    log_info!(LOG_TAG, "Performing final telemetry upload...");
    upload_telemetry(masker).await
}
