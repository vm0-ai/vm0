//! One bounded, pre-cleanup snapshot for a storage apply containment lifetime.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::time::Instant;

use guest_contracts::storage_resources::{
    StorageCleanupMode, StorageResourceLimit, StorageResourceUsage, StorageUnlimited,
};

use super::{ProcessContainmentCleanupMode, ResourceEventFiles};

const MAX_RESOURCE_FILE_BYTES: u64 = 16 * 1024;

pub(super) struct StorageOperation {
    run_id: Option<String>,
    pub(super) sequence: u32,
    started: Instant,
}

impl StorageOperation {
    pub(super) fn new(run_id: &str, sequence: u32, started: Instant) -> Self {
        // Validate only the diagnostic identity, not RPC admission or helper env.
        let canonical_uuid = run_id.len() == 36
            && run_id.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            });
        Self {
            run_id: canonical_uuid.then(|| run_id.to_owned()),
            sequence,
            started,
        }
    }

    pub(super) fn collect(
        &self,
        group_name: &str,
        workload_path: &Path,
        mode: ProcessContainmentCleanupMode,
        snapshot_started: Instant,
        events: &ResourceEventFiles,
    ) -> StorageResourceUsage {
        let memory_stat = read_resource_file(workload_path, "memory.stat");
        let memory_current = read_resource_file(workload_path, "memory.current");
        let memory_peak = read_resource_file(workload_path, "memory.peak");
        let memory_high = read_resource_file(workload_path, "memory.high");
        let memory_max = read_resource_file(workload_path, "memory.max");
        let cpu_max = read_resource_file(workload_path, "cpu.max");
        let mut cpu_words = cpu_max.as_deref().ok().map(str::split_ascii_whitespace);
        let quota = cpu_words.as_mut().and_then(Iterator::next);
        let period = cpu_words.as_mut().and_then(Iterator::next);
        let valid_cpu_max = quota.is_some()
            && period.is_some()
            && cpu_words.as_mut().and_then(Iterator::next).is_none();
        let mut resources = StorageResourceUsage {
            run_id: self.run_id.clone(),
            request_seq: self.sequence,
            group: group_name.to_owned(),
            cleanup_mode: match mode {
                ProcessContainmentCleanupMode::Graceful => StorageCleanupMode::Graceful,
                ProcessContainmentCleanupMode::Forced => StorageCleanupMode::Forced,
            },
            containment_wall_us: micros(snapshot_started.duration_since(self.started)),
            collection_us: 0,
            cpu_usage_usec: counter(events.cpu.as_deref().ok(), "usage_usec"),
            cpu_user_usec: counter(events.cpu.as_deref().ok(), "user_usec"),
            cpu_system_usec: counter(events.cpu.as_deref().ok(), "system_usec"),
            cpu_nr_periods: counter(events.cpu.as_deref().ok(), "nr_periods"),
            cpu_nr_throttled: counter(events.cpu.as_deref().ok(), "nr_throttled"),
            cpu_throttled_usec: counter(events.cpu.as_deref().ok(), "throttled_usec"),
            memory_events_high: counter(events.memory.as_deref().ok(), "high"),
            memory_events_max: counter(events.memory.as_deref().ok(), "max"),
            memory_events_oom: counter(events.memory.as_deref().ok(), "oom"),
            memory_events_oom_kill: counter(events.memory.as_deref().ok(), "oom_kill"),
            memory_events_oom_group_kill: counter(events.memory.as_deref().ok(), "oom_group_kill"),
            pids_events_max: counter(events.pids.as_deref().ok(), "max"),
            memory_pgfault: counter(memory_stat.as_deref().ok(), "pgfault"),
            memory_pgmajfault: counter(memory_stat.as_deref().ok(), "pgmajfault"),
            memory_pgscan: counter(memory_stat.as_deref().ok(), "pgscan"),
            memory_pgsteal: counter(memory_stat.as_deref().ok(), "pgsteal"),
            memory_pgscan_kswapd: counter(memory_stat.as_deref().ok(), "pgscan_kswapd"),
            memory_pgscan_direct: counter(memory_stat.as_deref().ok(), "pgscan_direct"),
            memory_pgsteal_kswapd: counter(memory_stat.as_deref().ok(), "pgsteal_kswapd"),
            memory_pgsteal_direct: counter(memory_stat.as_deref().ok(), "pgsteal_direct"),
            memory_workingset_refault_anon: counter(
                memory_stat.as_deref().ok(),
                "workingset_refault_anon",
            ),
            memory_workingset_refault_file: counter(
                memory_stat.as_deref().ok(),
                "workingset_refault_file",
            ),
            memory_current_bytes: memory_current
                .ok()
                .and_then(|value| value.trim().parse().ok()),
            memory_peak_bytes: memory_peak.ok().and_then(|value| value.trim().parse().ok()),
            memory_high_limit_bytes: limit_value(memory_high.as_deref().ok().map(str::trim)),
            memory_max_limit_bytes: limit_value(memory_max.as_deref().ok().map(str::trim)),
            cpu_quota_us: limit_value(quota.filter(|_| valid_cpu_max)),
            cpu_period_us: period
                .filter(|_| valid_cpu_max)
                .and_then(|value| value.parse().ok()),
        };
        resources.collection_us = micros(snapshot_started.elapsed());
        resources
    }
}

fn micros(duration: std::time::Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

fn counter(contents: Option<&str>, key: &str) -> Option<u64> {
    let mut matches = contents?.lines().filter_map(|line| {
        let mut words = line.split_ascii_whitespace();
        (words.next() == Some(key)).then_some(words)
    });
    let mut words = matches.next()?;
    let value = words.next()?.parse().ok()?;
    (words.next().is_none() && matches.next().is_none()).then_some(value)
}

fn limit_value(value: Option<&str>) -> Option<StorageResourceLimit> {
    match value? {
        "max" => Some(StorageResourceLimit::Unlimited(StorageUnlimited::Max)),
        value => value.parse().ok().map(StorageResourceLimit::Value),
    }
}

pub(super) fn read_resource_file(workload_path: &Path, filename: &str) -> io::Result<String> {
    let mut contents = String::new();
    File::open(workload_path.join(filename))?
        .take(MAX_RESOURCE_FILE_BYTES + 1)
        .read_to_string(&mut contents)?;
    if contents.len() as u64 > MAX_RESOURCE_FILE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "resource file exceeds limit",
        ));
    }
    Ok(contents)
}
