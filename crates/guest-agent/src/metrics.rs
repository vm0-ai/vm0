//! System metrics collection: CPU, memory, disk.
//!
//! Reads `/proc/stat` for CPU, `/proc/meminfo` for memory, and uses
//! `libc::statvfs` for disk. Writes JSONL to the metrics log file.

use crate::constants;
use crate::paths;
use serde::Serialize;
use std::io::Write;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Serialize)]
struct MetricsEntry {
    ts: String,
    cpu: f64,
    mem_used: u64,
    mem_total: u64,
    disk_used: u64,
    disk_total: u64,
}

/// Tracks previous `/proc/stat` counters for delta-based CPU measurement.
struct CpuTracker {
    prev_idle: u64,
    prev_total: u64,
}

impl CpuTracker {
    fn new() -> Self {
        Self {
            prev_idle: 0,
            prev_total: 0,
        }
    }

    /// Read `/proc/stat` and compute CPU usage over the interval since the
    /// last call. The first call returns the cumulative average since boot
    /// (acceptable); subsequent calls return the delta-based percentage.
    fn get_cpu_percent(&mut self) -> f64 {
        let content = match std::fs::read_to_string("/proc/stat") {
            Ok(c) => c,
            Err(_) => return 0.0,
        };
        let first_line = match content.lines().next() {
            Some(l) => l,
            None => return 0.0,
        };
        let (idle, total) = match parse_cpu_stat_line(first_line) {
            Some(cpu_stat) => cpu_stat,
            None => return 0.0,
        };

        let delta_idle = idle.saturating_sub(self.prev_idle);
        let delta_total = total.saturating_sub(self.prev_total);

        self.prev_idle = idle;
        self.prev_total = total;

        if delta_total == 0 {
            return 0.0;
        }
        let pct = 100.0 * (1.0 - delta_idle as f64 / delta_total as f64);
        (pct * 100.0).round() / 100.0
    }
}

fn parse_cpu_stat_line(line: &str) -> Option<(u64, u64)> {
    let mut fields = line.split_whitespace();
    if fields.next()? != "cpu" {
        return None;
    }

    let values: Vec<u64> = fields.map(|v| v.parse()).collect::<Result<_, _>>().ok()?;

    // idle and iowait are zero-based fields 3 and 4 after the cpu label.
    let [_, _, _, idle_ticks, iowait_ticks, ..] = values.as_slice() else {
        return None;
    };
    let idle = *idle_ticks + *iowait_ticks;
    let total = values.iter().sum();

    Some((idle, total))
}

/// Parse `/proc/meminfo` to get (used, total) in bytes.
fn get_memory_info() -> (u64, u64) {
    let content = match std::fs::read_to_string("/proc/meminfo") {
        Ok(c) => c,
        Err(_) => return (0, 0),
    };
    let mut total_kb = 0u64;
    let mut available_kb = 0u64;
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            total_kb = parse_meminfo_value(rest);
        } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
            available_kb = parse_meminfo_value(rest);
        }
    }
    let total = total_kb * 1024;
    let used = total.saturating_sub(available_kb * 1024);
    (used, total)
}

fn parse_meminfo_value(s: &str) -> u64 {
    // Format: "     12345 kB"
    s.split_whitespace()
        .next()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// Get disk usage for `/` via `libc::statvfs`. Returns (used, total) in bytes.
fn get_disk_info() -> (u64, u64) {
    let path = c"/";
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let ret = unsafe { libc::statvfs(path.as_ptr(), &mut stat) };
    if ret != 0 {
        return (0, 0);
    }
    let block_size = stat.f_frsize;
    let total = stat.f_blocks * block_size;
    let free = stat.f_bfree * block_size;
    let used = total.saturating_sub(free);
    (used, total)
}

/// Collect one snapshot of system metrics.
fn collect_metrics(cpu_tracker: &mut CpuTracker) -> MetricsEntry {
    let cpu = cpu_tracker.get_cpu_percent();
    let (mem_used, mem_total) = get_memory_info();
    let (disk_used, disk_total) = get_disk_info();
    MetricsEntry {
        ts: guest_common::log::timestamp(),
        cpu,
        mem_used,
        mem_total,
        disk_used,
        disk_total,
    }
}

/// Background loop writing metrics JSONL every `METRICS_INTERVAL_SECS`.
pub async fn metrics_loop(shutdown: CancellationToken) {
    let mut interval = tokio::time::interval(Duration::from_secs(constants::METRICS_INTERVAL_SECS));
    let mut cpu_tracker = CpuTracker::new();
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = interval.tick() => {
                let entry = collect_metrics(&mut cpu_tracker);
                if let Ok(json) = serde_json::to_string(&entry) {
                    let path = paths::metrics_log_file();
                    if let Ok(mut f) = guest_runtime_paths::open_private_append(path) {
                        let _ = writeln!(f, "{json}");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_tracker_returns_valid_range() {
        // First call returns cumulative average, subsequent calls return delta
        let mut tracker = CpuTracker::new();
        let pct1 = tracker.get_cpu_percent();
        assert!((0.0..=100.0).contains(&pct1));
        let pct2 = tracker.get_cpu_percent();
        assert!((0.0..=100.0).contains(&pct2));
    }

    #[test]
    fn parse_cpu_stat_line_accepts_valid_aggregate_line() {
        assert_eq!(parse_cpu_stat_line("cpu 1 2 3 4 5 6 7 8"), Some((9, 36)));
    }

    #[test]
    fn parse_cpu_stat_line_accepts_whitespace_separated_fields() {
        assert_eq!(parse_cpu_stat_line("cpu\t1 2 3 4 5 6"), Some((9, 21)));
    }

    #[test]
    fn parse_cpu_stat_line_rejects_short_line() {
        assert_eq!(parse_cpu_stat_line("cpu 1 2 3 4"), None);
    }

    #[test]
    fn parse_cpu_stat_line_rejects_wrong_prefix() {
        assert_eq!(parse_cpu_stat_line("cpu0 1 2 3 4 5"), None);
    }

    #[test]
    fn parse_cpu_stat_line_rejects_malformed_field() {
        assert_eq!(parse_cpu_stat_line("cpu 1 2 bad 4 5 6"), None);
    }

    #[test]
    fn parse_meminfo_value_basic() {
        assert_eq!(parse_meminfo_value("  12345 kB"), 12345);
        assert_eq!(parse_meminfo_value("  0 kB"), 0);
        assert_eq!(parse_meminfo_value(""), 0);
    }

    #[test]
    fn parse_meminfo_value_large_values() {
        assert_eq!(parse_meminfo_value("  16384000 kB"), 16384000);
        assert_eq!(parse_meminfo_value("1 kB"), 1);
    }

    #[test]
    fn parse_meminfo_value_non_numeric() {
        assert_eq!(parse_meminfo_value("  abc kB"), 0);
    }

    #[test]
    fn cpu_tracker_multiple_reads_are_consistent() {
        let mut tracker = CpuTracker::new();
        for i in 0..5 {
            let pct = tracker.get_cpu_percent();
            assert!(
                (0.0..=100.0).contains(&pct),
                "read {i}: pct={pct} out of range"
            );
        }
    }

    #[test]
    fn get_memory_info_returns_valid_values() {
        let (used, total) = get_memory_info();
        // On Linux with /proc, total > 0
        if std::path::Path::new("/proc/meminfo").exists() {
            assert!(total > 0, "total memory should be > 0");
            assert!(used <= total, "used should be <= total");
        }
    }

    #[test]
    fn get_disk_info_returns_valid_values() {
        let (used, total) = get_disk_info();
        assert!(total > 0, "total disk should be > 0");
        assert!(used <= total, "used should be <= total");
    }

    #[test]
    fn collect_metrics_returns_complete_entry() {
        let mut tracker = CpuTracker::new();
        let entry = collect_metrics(&mut tracker);
        assert!(!entry.ts.is_empty());
        assert!((0.0..=100.0).contains(&entry.cpu));
        assert!(entry.mem_total > 0);
        assert!(entry.disk_total > 0);
    }

    #[test]
    fn collect_metrics_serializes_to_valid_jsonl() {
        let mut tracker = CpuTracker::new();
        let entry = collect_metrics(&mut tracker);
        let json = serde_json::to_string(&entry).unwrap();
        // Verify it round-trips through the same path metrics_loop uses.
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(parsed["ts"].is_string());
        assert!(parsed["cpu"].is_f64());
        assert!(parsed["mem_total"].is_u64());
        assert!(parsed["disk_total"].is_u64());
    }
}
