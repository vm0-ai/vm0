use std::process::Command;

use crate::metrics::float_to_u64;

/// Snapshot of /proc/diskstats for a specific device.
#[derive(Debug, Clone)]
pub(crate) struct DiskStats {
    reads_completed: u64,
    writes_completed: u64,
}

impl DiskStats {
    fn total_ios(&self) -> u64 {
        self.reads_completed.saturating_add(self.writes_completed)
    }
}

pub(crate) fn calculate_host_disk_iops(
    before: &DiskStats,
    after: &DiskStats,
    elapsed_secs: f64,
) -> Result<u64, String> {
    if !elapsed_secs.is_finite() || elapsed_secs < 0.0 {
        return Err("host disk IOPS duration is invalid".to_string());
    }
    if elapsed_secs == 0.0 {
        return Ok(0);
    }

    let before_ios = before.total_ios();
    let after_ios = after.total_ios();
    if after_ios < before_ios {
        return Err("host disk IOPS counters decreased during fio run".to_string());
    }

    let delta_ios = after_ios - before_ios;
    float_to_u64(delta_ios as f64 / elapsed_secs, "host disk IOPS")
}

/// Read /proc/diskstats for a given device name.
///
/// Format: major minor name rd_ios rd_merges rd_sectors rd_ticks
///         wr_ios wr_merges wr_sectors wr_ticks ...
pub(crate) fn read_diskstats(device_name: &str) -> Result<DiskStats, String> {
    let content =
        std::fs::read_to_string("/proc/diskstats").map_err(|e| format!("read diskstats: {e}"))?;
    parse_diskstats(&content, device_name)
}

fn parse_diskstats(content: &str, device_name: &str) -> Result<DiskStats, String> {
    for (line_number, line) in content.lines().enumerate() {
        let mut fields = line.split_whitespace();
        let _major = fields.next();
        let _minor = fields.next();
        let Some(name) = fields.next() else {
            continue;
        };

        if name == device_name {
            let Some(reads_field) = fields.next() else {
                return Err(format!(
                    "diskstats line {} for {device_name} has too few fields",
                    line_number + 1
                ));
            };
            for _ in 0..3 {
                if fields.next().is_none() {
                    return Err(format!(
                        "diskstats line {} for {device_name} has too few fields",
                        line_number + 1
                    ));
                }
            }
            let Some(writes_field) = fields.next() else {
                return Err(format!(
                    "diskstats line {} for {device_name} has too few fields",
                    line_number + 1
                ));
            };
            let reads = reads_field.parse::<u64>().map_err(|e| {
                format!(
                    "diskstats line {} has invalid read count for {device_name}: {e}",
                    line_number + 1
                )
            })?;
            let writes = writes_field.parse::<u64>().map_err(|e| {
                format!(
                    "diskstats line {} has invalid write count for {device_name}: {e}",
                    line_number + 1
                )
            })?;
            return Ok(DiskStats {
                reads_completed: reads,
                writes_completed: writes,
            });
        }
    }

    Err(format!("device {device_name} not found in /proc/diskstats"))
}

fn diskstats_contains_device(content: &str, device_name: &str) -> bool {
    content.lines().any(|line| {
        line.split_whitespace()
            .nth(2)
            .is_some_and(|name| name == device_name)
    })
}

/// Auto-detect the host disk by finding the block device backing /tmp.
pub(crate) fn detect_host_disk() -> Result<String, String> {
    let stats =
        std::fs::read_to_string("/proc/diskstats").map_err(|e| format!("read diskstats: {e}"))?;

    // Try to find the device for /tmp via df
    if let Ok(output) = Command::new("df").arg("/tmp").output() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(line) = stdout.lines().nth(1)
            && let Some(dev) = line.split_whitespace().next()
            && let Some(device) = host_disk_from_df_device(dev, &stats)
        {
            return Ok(device);
        }
    }

    known_host_disk_candidate(&stats)
        .ok_or_else(|| "failed to detect a host disk present in /proc/diskstats".to_string())
}

fn host_disk_from_df_device(dev: &str, diskstats: &str) -> Option<String> {
    if dev == "/dev/root" {
        return known_host_disk_candidate(diskstats);
    }

    let device = diskstats_device_name(dev);
    diskstats_contains_device(diskstats, &device).then_some(device)
}

fn known_host_disk_candidate(diskstats: &str) -> Option<String> {
    ["nvme0n1", "xvda", "sda", "vda"]
        .iter()
        .find(|candidate| diskstats_contains_device(diskstats, candidate))
        .map(|candidate| (*candidate).to_string())
        .or_else(|| {
            diskstats
                .lines()
                .filter_map(|line| line.split_whitespace().nth(2))
                .find(|device| is_likely_host_disk_device(device))
                .map(str::to_string)
        })
}

fn is_likely_host_disk_device(device: &str) -> bool {
    ["nvme", "mmcblk", "xvd", "sd", "vd"]
        .iter()
        .any(|prefix| device.starts_with(prefix))
        && diskstats_device_name(&format!("/dev/{device}")) == device
}

fn diskstats_device_name(path: &str) -> String {
    let name = path.trim_start_matches("/dev/");

    if let Some((base, partition)) = name.rsplit_once('p')
        && !partition.is_empty()
        && partition.chars().all(|c| c.is_ascii_digit())
        && ["nvme", "mmcblk", "nbd", "loop"]
            .iter()
            .any(|prefix| base.starts_with(prefix))
    {
        return base.to_string();
    }

    let base = name.trim_end_matches(|c: char| c.is_ascii_digit());
    if base.len() != name.len()
        && ["sd", "vd", "xvd"]
            .iter()
            .any(|prefix| base.starts_with(prefix))
    {
        return base.to_string();
    }

    name.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diskstats_total_ios_saturates() {
        let stats = DiskStats {
            reads_completed: u64::MAX,
            writes_completed: 1,
        };

        assert_eq!(stats.total_ios(), u64::MAX);
    }

    #[test]
    fn calculate_host_disk_iops_rejects_counter_resets_and_invalid_time() {
        let before = DiskStats {
            reads_completed: 100,
            writes_completed: 50,
        };
        let after = DiskStats {
            reads_completed: 125,
            writes_completed: 75,
        };

        assert_eq!(calculate_host_disk_iops(&before, &after, 2.0).unwrap(), 25);
        assert_eq!(calculate_host_disk_iops(&before, &after, 0.0).unwrap(), 0);
        assert!(calculate_host_disk_iops(&after, &before, 2.0).is_err());
        assert!(calculate_host_disk_iops(&before, &after, f64::NAN).is_err());
    }

    #[test]
    fn parse_diskstats_reads_matching_device() {
        let stats = parse_diskstats(
            "8 0 sda 1 0 0 0 2 0 0 0\n259 0 nvme0n1 12 0 0 0 34 0 0 0\n",
            "nvme0n1",
        )
        .unwrap();

        assert_eq!(stats.reads_completed, 12);
        assert_eq!(stats.writes_completed, 34);
        assert_eq!(stats.total_ios(), 46);
    }

    #[test]
    fn parse_diskstats_rejects_short_matching_line() {
        let err = parse_diskstats("259 0 nvme0n1 12 0 0 0\n", "nvme0n1").unwrap_err();

        assert!(err.contains("too few fields"), "{err}");
    }

    #[test]
    fn parse_diskstats_rejects_invalid_matching_counts() {
        let invalid_reads =
            parse_diskstats("259 0 nvme0n1 not-a-number 0 0 0 34\n", "nvme0n1").unwrap_err();
        assert!(
            invalid_reads.contains("invalid read count"),
            "{invalid_reads}"
        );

        let invalid_writes =
            parse_diskstats("259 0 nvme0n1 12 0 0 0 not-a-number\n", "nvme0n1").unwrap_err();
        assert!(
            invalid_writes.contains("invalid write count"),
            "{invalid_writes}"
        );
    }

    #[test]
    fn diskstats_contains_device_requires_exact_name_match() {
        let stats = "259 10 nvme0n10 1 0 0 0 2 0 0 0\n";

        assert!(!diskstats_contains_device(stats, "nvme0n1"));
        assert!(diskstats_contains_device(stats, "nvme0n10"));
    }

    #[test]
    fn host_disk_from_df_device_validates_diskstats_device() {
        let stats = "259 0 nvme0n1 1 0 0 0 2 0 0 0\n8 0 sda 3 0 0 0 4 0 0 0\n";

        assert_eq!(
            host_disk_from_df_device("/dev/nvme0n1p1", stats),
            Some("nvme0n1".to_string())
        );
        assert_eq!(
            host_disk_from_df_device("/dev/root", stats),
            Some("nvme0n1".to_string())
        );
        assert_eq!(host_disk_from_df_device("overlay", stats), None);
        assert_eq!(
            host_disk_from_df_device("/dev/does-not-exist1", stats),
            None
        );
    }

    #[test]
    fn known_host_disk_candidate_accepts_non_default_whole_disks() {
        let stats = "259 1 nvme1n1p1 1 0 0 0 2 0 0 0\n259 0 nvme1n1 3 0 0 0 4 0 0 0\n";

        assert_eq!(
            known_host_disk_candidate(stats),
            Some("nvme1n1".to_string())
        );
    }

    #[test]
    fn diskstats_device_name_strips_partition_suffixes() {
        assert_eq!(diskstats_device_name("/dev/nvme0n1p1"), "nvme0n1");
        assert_eq!(diskstats_device_name("/dev/mmcblk0p2"), "mmcblk0");
        assert_eq!(diskstats_device_name("/dev/nbd12p3"), "nbd12");
        assert_eq!(diskstats_device_name("/dev/sda1"), "sda");
        assert_eq!(diskstats_device_name("/dev/vda2"), "vda");
        assert_eq!(diskstats_device_name("/dev/xvdf12"), "xvdf");
    }

    #[test]
    fn diskstats_device_name_preserves_whole_disk_names() {
        assert_eq!(diskstats_device_name("/dev/nvme0n1"), "nvme0n1");
        assert_eq!(diskstats_device_name("/dev/mmcblk0"), "mmcblk0");
        assert_eq!(diskstats_device_name("/dev/nbd12"), "nbd12");
        assert_eq!(diskstats_device_name("/dev/loop0"), "loop0");
        assert_eq!(diskstats_device_name("/dev/sda"), "sda");
        assert_eq!(diskstats_device_name("vda"), "vda");
    }
}
