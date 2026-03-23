//! Monitor `/dev/kmsg` for iptables LOG entries from non-TCP VM traffic
//! and write matching entries to per-run network JSONL files.
//!
//! The iptables rule added by `sandbox-fc` logs non-TCP packets with prefix
//! `VM0:<peer_ip>:`. This module reads `/dev/kmsg`, parses those entries,
//! looks up the network log path via an in-memory IP map, and appends a
//! JSON line matching the format used by the mitmproxy addon.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::{debug, warn};

/// Prefix used in iptables `--log-prefix` to identify our log lines.
const LOG_PREFIX: &str = "VM0:";

/// Shared map from source IP → network log path, updated by executor on
/// register/unregister.
pub type IpLogMap = Arc<Mutex<HashMap<String, PathBuf>>>;

/// Create a new empty IP-to-log-path map.
pub fn new_ip_log_map() -> IpLogMap {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Spawn a background task that tails `/dev/kmsg` and writes network log
/// entries. Returns the task handle; drop or abort it to stop.
pub fn spawn(ip_log_map: IpLogMap) -> JoinHandle<()> {
    tokio::task::spawn_blocking(move || {
        if let Err(e) = run_blocking(&ip_log_map) {
            warn!(error = %e, "kmsg log monitor exited");
        }
    })
}

/// Blocking loop that reads `/dev/kmsg` message by message.
///
/// Uses `/dev/kmsg` instead of `/proc/kmsg` because `/dev/kmsg` supports
/// multiple concurrent readers (each gets an independent seek position),
/// while `/proc/kmsg` is consumptive — reading removes messages for all
/// other readers (e.g. systemd-journald).
///
/// `/dev/kmsg` is a special device where each `read()` returns exactly one
/// message. We must NOT use `BufReader` as it would buffer across message
/// boundaries. The format is: `priority,sequence,timestamp;message\n`.
fn run_blocking(ip_log_map: &IpLogMap) -> std::io::Result<()> {
    use std::io::{Seek, SeekFrom};

    let mut file = std::fs::File::open("/dev/kmsg")?;
    // Seek to end so we only process new messages, not the full ring buffer.
    file.seek(SeekFrom::End(0))?;

    // Each read() on /dev/kmsg returns one complete message.
    // Max kernel log line is 8192 bytes (PRINTK_MESSAGE_MAX).
    let mut buf = [0u8; 8192];

    loop {
        let n = match file.read(&mut buf) {
            Ok(0) => continue,
            Ok(n) => n,
            Err(e) if e.raw_os_error() == Some(32) => {
                // EPIPE (errno 32): a message was overwritten in the kernel
                // ring buffer before we read it. Skip and continue.
                continue;
            }
            Err(e) if e.raw_os_error() == Some(11) => {
                // EAGAIN (errno 11): non-blocking read with no data.
                // Shouldn't happen in blocking mode but handle gracefully.
                continue;
            }
            Err(e) => return Err(e),
        };

        let raw = match buf.get(..n).and_then(|b| std::str::from_utf8(b).ok()) {
            Some(s) => s.trim_end(),
            None => continue,
        };

        // /dev/kmsg format: "priority,sequence,timestamp;message"
        let message = match raw.find(';') {
            Some(pos) => &raw[pos + 1..],
            None => continue,
        };

        // Fast check before acquiring lock.
        if !message.contains(LOG_PREFIX) {
            continue;
        }

        if let Some(entry) = parse_log_message(message) {
            let log_path = {
                let map = ip_log_map.blocking_lock();
                map.get(&entry.source_ip).cloned()
            };
            if let Some(path) = log_path {
                write_jsonl(&path, &entry);
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

/// Parse the message portion of an iptables LOG entry.
///
/// Input is the part after the `;` in `/dev/kmsg` format, e.g.:
/// ```text
/// VM0:10.200.0.2:IN=vm0-ve-00-00 OUT=ens5 SRC=10.200.0.2 DST=8.8.8.8 LEN=64 ... PROTO=UDP SPT=12345 DPT=53
/// ```
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
/// Matches `KEY=` only at the start of the string or after a space,
/// preventing false matches on suffixes (e.g. `DSCP=` matching `SCP=`).
fn extract_field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let start = if line.starts_with(key) {
        key.len()
    } else {
        let needle = format!(" {key}");
        let pos = line.find(&needle)?;
        pos + needle.len()
    };
    let end = line
        .get(start..)?
        .find(' ')
        .map_or(line.len(), |i| start + i);
    line.get(start..end)
}

/// Append a JSON line to the network log file.
fn write_jsonl(path: &Path, entry: &LogEntry) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let json = serde_json::json!({
        "timestamp": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
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
        write_jsonl(&path, &entry);
        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(parsed["host"], "8.8.8.8");
        assert_eq!(parsed["port"], 53);
        assert_eq!(parsed["type"], "udp");
        assert_eq!(parsed["request_size"], 64);
        assert!(parsed.get("action").is_none());
        assert!(parsed["timestamp"].is_string());
    }
}
