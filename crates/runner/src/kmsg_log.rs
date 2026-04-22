//! Monitor kernel log for iptables LOG entries from non-TCP VM traffic
//! and write matching entries to per-run network JSONL files.
//!
//! The iptables rule added by `sandbox-fc` logs non-TCP packets with prefix
//! `VM0:<peer_ip>:`. This module tails `dmesg -w`, parses those entries,
//! looks up the network log path via an in-memory IP map, and appends a
//! JSON line matching the format used by the mitmproxy addon.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use tokio::io::AsyncBufReadExt;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

/// Prefix used in iptables `--log-prefix` to identify our log lines.
const LOG_PREFIX: &str = "VM0:";

/// Shared map from source IP → network log path, updated by executor on
/// register/unregister.
pub type IpLogMap = Arc<Mutex<HashMap<String, PathBuf>>>;

/// Create a new empty IP-to-log-path map.
pub fn new_ip_log_map() -> IpLogMap {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Handle to the background kmsg monitor. Call [`KmsgHandle::stop`] during
/// shutdown to cancel the async task and kill the `dmesg -w` child process.
pub struct KmsgHandle {
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
    child: Option<tokio::process::Child>,
}

impl KmsgHandle {
    /// Stop the kmsg monitor and wait for cleanup.
    pub async fn stop(mut self) {
        self.cancel.cancel();
        if let Some(ref mut child) = self.child {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        let _ = (&mut self.task).await;
        info!("kmsg monitor stopped");
    }

    /// Create a noop handle for testing. No `dmesg` process is spawned.
    #[cfg(test)]
    pub fn noop() -> Self {
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        Self {
            cancel,
            task: tokio::spawn(async move { token.cancelled().await }),
            child: None,
        }
    }
}

impl Drop for KmsgHandle {
    /// Kill dmesg and abort the log task if `stop()` was never called.
    ///
    /// Prevents a leaked `dmesg -w` process when `run()` returns early
    /// (e.g., factory creation failure). Harmless if `stop()` already ran —
    /// `start_kill` on an exited child is a no-op.
    fn drop(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.start_kill();
        }
        self.cancel.cancel();
        self.task.abort();
    }
}

/// Spawn a background async task that tails `dmesg -w` and writes
/// network log entries. Returns a handle; call [`KmsgHandle::stop`] during
/// shutdown so the tokio runtime can exit cleanly.
pub fn spawn(ip_log_map: IpLogMap) -> std::io::Result<KmsgHandle> {
    let mut child = tokio::process::Command::new("dmesg")
        .args(["-w"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("failed to capture dmesg stdout"))?;

    let cancel = CancellationToken::new();
    let token = cancel.clone();

    // Log stderr in a background task so dmesg errors are visible.
    // Shares the cancel token so the task exits promptly on shutdown.
    if let Some(stderr) = child.stderr.take() {
        let stderr_cancel = cancel.clone();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            loop {
                tokio::select! {
                    _ = stderr_cancel.cancelled() => break,
                    result = lines.next_line() => {
                        match result {
                            Ok(Some(line)) if !line.is_empty() => {
                                warn!(target: "dmesg", "stderr: {line}");
                            }
                            Ok(None) | Err(_) => break,
                            _ => {}
                        }
                    }
                }
            }
        });
    }

    let task = tokio::spawn(async move {
        run_loop(&ip_log_map, token, stdout).await;
    });
    Ok(KmsgHandle {
        cancel,
        task,
        child: Some(child),
    })
}

/// Read kernel log lines from `dmesg -w` stdout, parse iptables LOG
/// entries, and write matching entries to per-run network JSONL files.
async fn run_loop(
    ip_log_map: &IpLogMap,
    cancel: CancellationToken,
    stdout: tokio::process::ChildStdout,
) {
    let mut lines = tokio::io::BufReader::new(stdout).lines();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            result = lines.next_line() => {
                let line = match result {
                    Ok(Some(l)) => l,
                    Ok(None) | Err(_) => break,
                };

                // Fast check before acquiring lock.
                if !line.contains(LOG_PREFIX) {
                    continue;
                }

                if let Some(entry) = parse_log_message(&line) {
                    let log_path = {
                        let map = ip_log_map.lock().await;
                        map.get(&entry.source_ip).cloned()
                    };
                    if let Some(path) = log_path {
                        // Move the blocking file I/O off the tokio worker thread.
                        // Capture the timestamp *before* the spawn so it reflects
                        // observation time, not write time (which may lag under load).
                        let timestamp = Utc::now();
                        tokio::task::spawn_blocking(move || {
                            write_jsonl(&path, &entry, timestamp);
                        });
                    }
                }
            }
        }
    }
}

/// Parsed fields from a single iptables LOG line.
struct LogEntry {
    source_ip: String,
    dst_ip: String,
    dst_port: u16,
    protocol: String,
    packet_size: u16,
}

/// Parse an iptables LOG message from a `dmesg -w` output line.
///
/// `dmesg -w` outputs lines like:
/// ```text
/// [12345.678901] VM0:10.200.0.2:IN=vm0-ve-00-00 OUT=ens5 SRC=10.200.0.2 DST=8.8.8.8 LEN=64 ... PROTO=UDP SPT=12345 DPT=53
/// ```
/// The parser finds `VM0:` anywhere in the line, so the `[timestamp]` prefix is ignored.
fn parse_log_message(message: &str) -> Option<LogEntry> {
    // Find our prefix
    let prefix_pos = message.find(LOG_PREFIX)?;
    let after_prefix = &message[prefix_pos + LOG_PREFIX.len()..];

    // Extract the source IP from the prefix (VM0:<ip>:...)
    let colon_pos = after_prefix.find(':')?;
    let source_ip = &after_prefix[..colon_pos];

    // Parse key=value fields from the rest of the line
    let fields = &after_prefix[colon_pos + 1..];
    let src = extract_field(fields, "SRC=")?;
    let dst = extract_field(fields, "DST=")?;
    let len = extract_field(fields, "LEN=")?;
    let proto = extract_field(fields, "PROTO=")?;

    // DPT may not exist for ICMP
    let dst_port = extract_field(fields, "DPT=")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let packet_size = len.parse().unwrap_or(0);

    // Sanity check: SRC from fields should match prefix IP
    if src != source_ip {
        return None;
    }

    Some(LogEntry {
        source_ip: source_ip.to_string(),
        dst_ip: dst.to_string(),
        dst_port,
        protocol: proto.to_ascii_lowercase(),
        packet_size,
    })
}

/// Extract a value for a `KEY=value` field from an iptables log line.
///
/// Matches `KEY=` only at a whitespace-delimited token boundary, preventing
/// false matches on suffixes (e.g. `DSCP=` matching `SCP=`).
fn extract_field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    line.split_whitespace()
        .find_map(|tok| tok.strip_prefix(key))
}

/// Append a JSON line to the network log file.
///
/// `timestamp` is captured by the caller (on the tokio worker) so the recorded
/// time reflects when the packet was observed, not when this function — which
/// runs on a tokio blocking thread — finally executes.
fn write_jsonl(path: &Path, entry: &LogEntry, timestamp: DateTime<Utc>) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    // [NETWORK_LOG_FIELDS] — keep in sync with all network log schemas
    let json = serde_json::json!({
        "timestamp": timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "type": entry.protocol,
        "host": entry.dst_ip,
        "port": entry.dst_port,
        "request_size": entry.packet_size,
    });

    let mut line = serde_json::to_string(&json).unwrap_or_default();
    line.push('\n');

    let result = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o644)
        .open(path)
        .and_then(|mut f| f.write_all(line.as_bytes()));

    if let Err(e) = result {
        debug!(path = %path.display(), error = %e, "failed to write non-TCP network log");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_udp_log_message() {
        let msg = "VM0:10.200.0.2:IN=vm0-ve-00-00 OUT=ens5 MAC=00:00:00:00:00:00 SRC=10.200.0.2 DST=8.8.8.8 LEN=64 TOS=0x00 PREC=0x00 TTL=64 ID=12345 PROTO=UDP SPT=45678 DPT=53";
        let entry = parse_log_message(msg).unwrap();
        assert_eq!(entry.source_ip, "10.200.0.2");
        assert_eq!(entry.dst_ip, "8.8.8.8");
        assert_eq!(entry.dst_port, 53);
        assert_eq!(entry.protocol, "udp");
        assert_eq!(entry.packet_size, 64);
    }

    #[test]
    fn parse_icmp_log_message() {
        let msg = "VM0:10.200.0.2:IN=vm0-ve-00-00 OUT=ens5 SRC=10.200.0.2 DST=1.1.1.1 LEN=84 PROTO=ICMP TYPE=8 CODE=0";
        let entry = parse_log_message(msg).unwrap();
        assert_eq!(entry.source_ip, "10.200.0.2");
        assert_eq!(entry.dst_ip, "1.1.1.1");
        assert_eq!(entry.dst_port, 0);
        assert_eq!(entry.protocol, "icmp");
        assert_eq!(entry.packet_size, 84);
    }

    #[test]
    fn parse_dmesg_format_with_timestamp_prefix() {
        // dmesg -w prefixes lines with [seconds.microseconds]
        let msg = "[411967.804921] VM0:10.200.12.26:IN=vm0-ve-03-06 OUT=enP2p4s0 MAC=f6:59:f1:28:35:36:de:8b:c8:2e:7b:88:08:00 SRC=10.200.12.26 DST=8.8.8.8 LEN=63 TOS=0x00 PREC=0x00 TTL=125 ID=50938 DF PROTO=UDP SPT=44793 DPT=53 LEN=43";
        let entry = parse_log_message(msg).unwrap();
        assert_eq!(entry.source_ip, "10.200.12.26");
        assert_eq!(entry.dst_ip, "8.8.8.8");
        assert_eq!(entry.dst_port, 53);
        assert_eq!(entry.protocol, "udp");
        assert_eq!(entry.packet_size, 63);
    }

    #[test]
    fn ignores_unrelated_message() {
        let msg = "audit: something happened";
        assert!(parse_log_message(msg).is_none());
    }

    #[test]
    fn ignores_mismatched_src_ip() {
        // SRC field doesn't match the prefix IP — should be rejected
        let msg = "VM0:10.200.0.2:IN=vm0-ve-00-00 OUT=ens5 SRC=10.200.0.99 DST=8.8.8.8 LEN=64 PROTO=UDP SPT=1234 DPT=53";
        assert!(parse_log_message(msg).is_none());
    }

    #[test]
    fn extract_field_works() {
        let fields = "SRC=10.0.0.1 DST=8.8.8.8 LEN=64 PROTO=UDP";
        assert_eq!(extract_field(fields, "SRC="), Some("10.0.0.1"));
        assert_eq!(extract_field(fields, "DST="), Some("8.8.8.8"));
        assert_eq!(extract_field(fields, "LEN="), Some("64"));
        assert_eq!(extract_field(fields, "PROTO="), Some("UDP"));
        assert_eq!(extract_field(fields, "DPT="), None);
    }

    #[test]
    fn extract_field_last_field_no_trailing_space() {
        let fields = "SRC=10.0.0.1 PROTO=UDP";
        assert_eq!(extract_field(fields, "PROTO="), Some("UDP"));
    }

    #[test]
    fn extract_field_no_substring_match() {
        // "XSRC=foo" should not match when searching for "SRC="
        let fields = "XSRC=foo SRC=10.0.0.1";
        assert_eq!(extract_field(fields, "SRC="), Some("10.0.0.1"));
    }

    #[test]
    fn extract_field_returns_first_match_for_duplicate_key() {
        // dmesg iptables lines emit LEN= twice for UDP (outer packet then
        // inner UDP payload). We rely on first-wins to pick the outer length.
        let fields = "LEN=63 TOS=0x00 LEN=43";
        assert_eq!(extract_field(fields, "LEN="), Some("63"));
    }

    #[test]
    fn parse_malformed_len_defaults_to_zero() {
        let msg = "VM0:10.200.0.2:IN=vm0-ve-00-00 OUT=ens5 SRC=10.200.0.2 DST=8.8.8.8 LEN=abc PROTO=UDP SPT=1234 DPT=53";
        let entry = parse_log_message(msg).unwrap();
        assert_eq!(entry.packet_size, 0);
    }

    #[test]
    fn parse_malformed_dpt_defaults_to_zero() {
        let msg = "VM0:10.200.0.2:IN=vm0-ve-00-00 OUT=ens5 SRC=10.200.0.2 DST=8.8.8.8 LEN=64 PROTO=UDP SPT=1234 DPT=99999";
        let entry = parse_log_message(msg).unwrap();
        assert_eq!(entry.dst_port, 0); // u16 overflow → parse fails → default 0
    }

    #[test]
    fn parse_missing_proto_returns_none() {
        let msg = "VM0:10.200.0.2:IN=vm0-ve-00-00 OUT=ens5 SRC=10.200.0.2 DST=8.8.8.8 LEN=64";
        assert!(parse_log_message(msg).is_none());
    }

    #[test]
    fn write_jsonl_serializes_provided_timestamp() {
        // Locks the contract that `write_jsonl` must use the `timestamp`
        // parameter rather than calling `Utc::now()` internally — the whole
        // point of the parameter is to record observation time, not the
        // delayed write time after spawn_blocking.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.jsonl");
        let entry = LogEntry {
            source_ip: "10.200.0.2".to_string(),
            dst_ip: "8.8.8.8".to_string(),
            dst_port: 53,
            protocol: "udp".to_string(),
            packet_size: 64,
        };
        let ts = DateTime::parse_from_rfc3339("2024-01-15T10:30:45.123Z")
            .unwrap()
            .with_timezone(&Utc);
        write_jsonl(&path, &entry, ts);
        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(parsed["timestamp"], "2024-01-15T10:30:45.123Z");
    }

    #[test]
    fn write_jsonl_creates_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.jsonl");
        let entry = LogEntry {
            source_ip: "10.200.0.2".to_string(),
            dst_ip: "8.8.8.8".to_string(),
            dst_port: 53,
            protocol: "udp".to_string(),
            packet_size: 64,
        };
        write_jsonl(&path, &entry, Utc::now());
        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(parsed["host"], "8.8.8.8");
        assert_eq!(parsed["port"], 53);
        assert_eq!(parsed["type"], "udp");
        assert_eq!(parsed["request_size"], 64);
        assert!(parsed.get("action").is_none());
        assert!(parsed["timestamp"].is_string());
    }

    #[test]
    fn write_jsonl_icmp_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("icmp.jsonl");
        let entry = LogEntry {
            source_ip: "10.200.0.2".to_string(),
            dst_ip: "1.1.1.1".to_string(),
            dst_port: 0,
            protocol: "icmp".to_string(),
            packet_size: 84,
        };
        write_jsonl(&path, &entry, Utc::now());
        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(parsed["type"], "icmp");
        assert_eq!(parsed["port"], 0);
        assert_eq!(parsed["request_size"], 84);
    }

    #[test]
    fn write_jsonl_appends_multiple_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("multi.jsonl");
        for dst in ["8.8.8.8", "1.1.1.1", "9.9.9.9"] {
            write_jsonl(
                &path,
                &LogEntry {
                    source_ip: "10.0.0.1".to_string(),
                    dst_ip: dst.to_string(),
                    dst_port: 53,
                    protocol: "udp".to_string(),
                    packet_size: 64,
                },
                Utc::now(),
            );
        }
        let content = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 3);
        for (i, dst) in ["8.8.8.8", "1.1.1.1", "9.9.9.9"].iter().enumerate() {
            let parsed: serde_json::Value = serde_json::from_str(lines[i]).unwrap();
            assert_eq!(parsed["host"], *dst);
        }
    }

    #[test]
    fn extract_field_at_start_of_line() {
        let fields = "SRC=10.0.0.1 DST=8.8.8.8";
        assert_eq!(extract_field(fields, "SRC="), Some("10.0.0.1"));
    }

    #[test]
    fn extract_field_missing_key() {
        let fields = "SRC=10.0.0.1 DST=8.8.8.8";
        assert_eq!(extract_field(fields, "PROTO="), None);
    }

    #[test]
    fn extract_field_empty_value() {
        let fields = "KEY= NEXT=val";
        assert_eq!(extract_field(fields, "KEY="), Some(""));
    }

    #[test]
    fn parse_log_empty_string() {
        assert!(parse_log_message("").is_none());
    }

    #[test]
    fn parse_log_prefix_only() {
        assert!(parse_log_message("VM0:").is_none());
    }

    #[test]
    fn parse_log_missing_fields() {
        // Has prefix and IP but missing DST/LEN/PROTO
        let msg = "VM0:10.200.0.2:IN=eth0 SRC=10.200.0.2";
        assert!(parse_log_message(msg).is_none());
    }
}
