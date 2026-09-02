use std::collections::BTreeSet;
use std::path::Path;

use nix::sched::{CpuSet, sched_getaffinity};
use nix::unistd::Pid;

use crate::error::{RunnerError, RunnerResult};

const CPU_SYSFS_ROOT: &str = "/sys/devices/system/cpu";

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PreSpawnCpuCapacity {
    ExactPhysical(u32),
    RestrictedPhysical(u32),
    ConservativeLogical(u32),
}

impl PreSpawnCpuCapacity {
    pub(crate) fn tokens(&self) -> u32 {
        match self {
            Self::ExactPhysical(tokens)
            | Self::RestrictedPhysical(tokens)
            | Self::ConservativeLogical(tokens) => *tokens,
        }
    }

    pub(crate) fn source(&self) -> &'static str {
        match self {
            Self::ExactPhysical(_) => "physical_topology",
            Self::RestrictedPhysical(_) => "restricted_physical_topology",
            Self::ConservativeLogical(_) => "logical_cpu_fallback",
        }
    }
}

/// Return the number of logical CPUs available to this process.
pub fn cpu_count() -> RunnerResult<usize> {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .map_err(|e| RunnerError::Internal(format!("detect CPU count: {e}")))
}

pub(crate) fn pre_spawn_cpu_capacity(
    logical_cpu_count: usize,
) -> RunnerResult<PreSpawnCpuCapacity> {
    let affinity_cpus = cpu_affinity()?;
    pre_spawn_cpu_capacity_at(Path::new(CPU_SYSFS_ROOT), logical_cpu_count, &affinity_cpus)
        .map_err(|error| RunnerError::Internal(format!("detect physical CPU topology: {error}")))
}

fn cpu_affinity() -> RunnerResult<BTreeSet<usize>> {
    let cpu_set = sched_getaffinity(Pid::from_raw(0))
        .map_err(|error| RunnerError::Internal(format!("detect CPU affinity: {error}")))?;
    let mut cpus = BTreeSet::new();
    for cpu in 0..CpuSet::count() {
        if cpu_set.is_set(cpu).map_err(|error| {
            RunnerError::Internal(format!("inspect CPU {cpu} in process affinity: {error}"))
        })? {
            cpus.insert(cpu);
        }
    }
    if cpus.is_empty() {
        return Err(RunnerError::Internal(
            "process CPU affinity contains no CPUs".into(),
        ));
    }
    Ok(cpus)
}

fn pre_spawn_cpu_capacity_at(
    cpu_root: &Path,
    logical_cpu_count: usize,
    affinity_cpus: &BTreeSet<usize>,
) -> Result<PreSpawnCpuCapacity, String> {
    if logical_cpu_count == 0 {
        return Err("available logical CPU count is zero".into());
    }

    let online_path = cpu_root.join("online");
    let online = std::fs::read_to_string(&online_path)
        .map_err(|error| format!("read {}: {error}", online_path.display()))?;
    let online_cpus = parse_cpu_list(&online)?;
    let effective_cpus = online_cpus
        .intersection(affinity_cpus)
        .copied()
        .collect::<BTreeSet<_>>();
    if effective_cpus.is_empty() {
        return Err("online CPUs and process affinity do not overlap".into());
    }
    let affinity_restricted = effective_cpus != online_cpus;

    match physical_core_count(cpu_root, &effective_cpus)? {
        Some(physical_cores) => {
            let capacity = physical_cores.min(logical_cpu_count);
            let capacity = u32::try_from(capacity).map_err(|_| {
                format!("physical CPU count {capacity} exceeds supported pre-spawn capacity")
            })?;
            if affinity_restricted || physical_cores > logical_cpu_count {
                Ok(PreSpawnCpuCapacity::RestrictedPhysical(capacity))
            } else {
                Ok(PreSpawnCpuCapacity::ExactPhysical(capacity))
            }
        }
        None => {
            let conservative_logical = (logical_cpu_count / 2).max(1);
            u32::try_from(conservative_logical)
                .map(PreSpawnCpuCapacity::ConservativeLogical)
                .map_err(|_| {
                    format!(
                        "logical CPU fallback count {conservative_logical} exceeds supported pre-spawn capacity"
                    )
                })
        }
    }
}

fn physical_core_count(
    cpu_root: &Path,
    effective_cpus: &BTreeSet<usize>,
) -> Result<Option<usize>, String> {
    let mut missing_topology = BTreeSet::new();

    for cpu in effective_cpus {
        let topology = cpu_root.join(format!("cpu{cpu}/topology"));
        match std::fs::symlink_metadata(&topology) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing_topology.insert(*cpu);
            }
            Err(error) => return Err(format!("inspect {}: {error}", topology.display())),
        }
    }

    if &missing_topology == effective_cpus {
        return Ok(None);
    }
    if !missing_topology.is_empty() {
        return Err(format!(
            "physical CPU topology is missing for effective CPUs {missing_topology:?}"
        ));
    }

    let mut cores = BTreeSet::new();

    for cpu in effective_cpus {
        let topology = cpu_root.join(format!("cpu{cpu}/topology"));
        let package_id = read_topology_id(&topology.join("physical_package_id"))?;
        let core_id = read_topology_id(&topology.join("core_id"))?;
        cores.insert((package_id, core_id));
    }

    if cores.is_empty() {
        return Err("effective CPU topology contains no physical cores".into());
    }
    Ok(Some(cores.len()))
}

fn read_topology_id(path: &Path) -> Result<i64, String> {
    let value = std::fs::read_to_string(path)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    value
        .trim()
        .parse()
        .map_err(|error| format!("parse {}: {error}", path.display()))
}

fn parse_cpu_list(value: &str) -> Result<BTreeSet<usize>, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("online CPU list is empty".into());
    }

    let mut cpus = BTreeSet::new();
    for part in value.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(format!("invalid empty entry in online CPU list {value:?}"));
        }
        if let Some((start, end)) = part.split_once('-') {
            if end.contains('-') {
                return Err(format!("invalid CPU range {part:?}"));
            }
            let start = parse_cpu_number(start, part)?;
            let end = parse_cpu_number(end, part)?;
            if start > end {
                return Err(format!("descending CPU range {part:?}"));
            }
            cpus.extend(start..=end);
        } else {
            cpus.insert(parse_cpu_number(part, part)?);
        }
    }
    Ok(cpus)
}

fn parse_cpu_number(value: &str, entry: &str) -> Result<usize, String> {
    value
        .parse()
        .map_err(|error| format!("parse CPU entry {entry:?}: {error}"))
}

/// Read total physical memory in MiB from `/proc/meminfo`.
pub fn memory_mb() -> RunnerResult<usize> {
    let content = std::fs::read_to_string("/proc/meminfo")
        .map_err(|e| RunnerError::Internal(format!("read /proc/meminfo: {e}")))?;
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            let kb: usize = rest
                .trim()
                .trim_end_matches("kB")
                .trim()
                .parse()
                .map_err(|e| RunnerError::Internal(format!("parse MemTotal: {e}")))?;
            return Ok(kb / 1024);
        }
    }
    Err(RunnerError::Internal(
        "MemTotal not found in /proc/meminfo".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cpu_set(cpus: impl IntoIterator<Item = usize>) -> BTreeSet<usize> {
        cpus.into_iter().collect()
    }

    fn write_topology(root: &Path, cpu: usize, package_id: i64, core_id: i64) {
        let topology = root.join(format!("cpu{cpu}/topology"));
        std::fs::create_dir_all(&topology).unwrap();
        std::fs::write(topology.join("physical_package_id"), package_id.to_string()).unwrap();
        std::fs::write(topology.join("core_id"), core_id.to_string()).unwrap();
    }

    #[test]
    fn cpu_count_is_positive() {
        assert!(cpu_count().unwrap() > 0);
    }

    #[test]
    fn cpu_affinity_is_nonempty() {
        assert!(!cpu_affinity().unwrap().is_empty());
    }

    #[test]
    fn parse_cpu_list_accepts_ranges_and_singletons() {
        assert_eq!(
            parse_cpu_list("0-2,4,6-7\n").unwrap(),
            BTreeSet::from([0, 1, 2, 4, 6, 7])
        );
    }

    #[test]
    fn parse_cpu_list_rejects_malformed_entries() {
        for value in ["", "1-", "3-1", "1-2-3", "0,,1", "cpu0"] {
            assert!(parse_cpu_list(value).is_err(), "accepted {value:?}");
        }
    }

    #[test]
    fn physical_core_count_deduplicates_smt_siblings_and_packages() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0-5").unwrap();
        write_topology(dir.path(), 0, 0, 0);
        write_topology(dir.path(), 1, 0, 0);
        write_topology(dir.path(), 2, 0, 1);
        write_topology(dir.path(), 3, 0, 1);
        write_topology(dir.path(), 4, 1, 0);
        write_topology(dir.path(), 5, 1, 0);

        assert_eq!(
            pre_spawn_cpu_capacity_at(dir.path(), 6, &cpu_set(0..6)).unwrap(),
            PreSpawnCpuCapacity::ExactPhysical(3)
        );
    }

    #[test]
    fn pre_spawn_cpu_capacity_restricts_topology_to_affinity() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0-5").unwrap();
        for cpu in 0..6 {
            write_topology(dir.path(), cpu, 0, cpu as i64);
        }

        assert_eq!(
            pre_spawn_cpu_capacity_at(dir.path(), 3, &BTreeSet::from([1, 3, 5])).unwrap(),
            PreSpawnCpuCapacity::RestrictedPhysical(3)
        );
    }

    #[test]
    fn pre_spawn_cpu_capacity_deduplicates_affinity_smt_siblings() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0-3").unwrap();
        write_topology(dir.path(), 0, 0, 0);
        write_topology(dir.path(), 1, 0, 0);
        write_topology(dir.path(), 2, 0, 1);
        write_topology(dir.path(), 3, 0, 1);

        assert_eq!(
            pre_spawn_cpu_capacity_at(dir.path(), 2, &BTreeSet::from([0, 1])).unwrap(),
            PreSpawnCpuCapacity::RestrictedPhysical(1)
        );
    }

    #[test]
    fn pre_spawn_cpu_capacity_is_capped_by_available_parallelism() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0-3").unwrap();
        for cpu in 0..4 {
            write_topology(dir.path(), cpu, 0, cpu as i64);
        }

        assert_eq!(
            pre_spawn_cpu_capacity_at(dir.path(), 2, &cpu_set(0..4)).unwrap(),
            PreSpawnCpuCapacity::RestrictedPhysical(2)
        );
    }

    #[test]
    fn pre_spawn_cpu_capacity_ignores_topology_outside_affinity() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0-2").unwrap();
        write_topology(dir.path(), 0, 0, 0);
        write_topology(dir.path(), 1, 0, 1);

        assert_eq!(
            pre_spawn_cpu_capacity_at(dir.path(), 2, &BTreeSet::from([0, 1])).unwrap(),
            PreSpawnCpuCapacity::RestrictedPhysical(2)
        );
    }

    #[test]
    fn pre_spawn_cpu_capacity_falls_back_when_topology_is_uniformly_missing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0-15").unwrap();

        assert_eq!(
            pre_spawn_cpu_capacity_at(dir.path(), 16, &cpu_set(0..16)).unwrap(),
            PreSpawnCpuCapacity::ConservativeLogical(8)
        );
    }

    #[test]
    fn pre_spawn_cpu_capacity_keeps_one_token_for_one_logical_cpu() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0").unwrap();

        assert_eq!(
            pre_spawn_cpu_capacity_at(dir.path(), 1, &BTreeSet::from([0])).unwrap(),
            PreSpawnCpuCapacity::ConservativeLogical(1)
        );
    }

    #[test]
    fn physical_core_count_rejects_partial_topology() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0-1").unwrap();
        write_topology(dir.path(), 0, 0, 0);

        assert_eq!(
            pre_spawn_cpu_capacity_at(dir.path(), 2, &BTreeSet::from([0, 1])).unwrap_err(),
            "physical CPU topology is missing for effective CPUs {1}"
        );
    }

    #[test]
    fn physical_core_count_accepts_single_threaded_topology() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0,2").unwrap();
        write_topology(dir.path(), 0, 0, 0);
        write_topology(dir.path(), 2, 0, 2);

        assert_eq!(
            physical_core_count(dir.path(), &BTreeSet::from([0, 2])).unwrap(),
            Some(2)
        );
    }

    #[test]
    fn physical_core_count_rejects_incomplete_and_malformed_topology() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0").unwrap();
        let topology = dir.path().join("cpu0/topology");
        std::fs::create_dir_all(&topology).unwrap();
        std::fs::write(topology.join("physical_package_id"), "0").unwrap();

        let effective_cpus = BTreeSet::from([0]);
        let error = physical_core_count(dir.path(), &effective_cpus).unwrap_err();
        assert!(error.contains("read"), "unexpected error: {error}");
        assert!(error.contains("core_id"), "unexpected error: {error}");

        std::fs::write(topology.join("core_id"), "invalid").unwrap();

        let error = physical_core_count(dir.path(), &effective_cpus).unwrap_err();
        assert!(error.contains("parse"), "unexpected error: {error}");
        assert!(error.contains("core_id"), "unexpected error: {error}");
    }

    #[test]
    fn pre_spawn_cpu_capacity_rejects_missing_or_empty_online_list() {
        let missing = tempfile::tempdir().unwrap();
        assert!(pre_spawn_cpu_capacity_at(missing.path(), 1, &BTreeSet::from([0])).is_err());

        let empty = tempfile::tempdir().unwrap();
        std::fs::write(empty.path().join("online"), "\n").unwrap();
        assert!(pre_spawn_cpu_capacity_at(empty.path(), 1, &BTreeSet::from([0])).is_err());
    }

    #[test]
    fn pre_spawn_cpu_capacity_rejects_empty_effective_capacity() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("online"), "0-1").unwrap();

        assert_eq!(
            pre_spawn_cpu_capacity_at(dir.path(), 1, &BTreeSet::from([2])).unwrap_err(),
            "online CPUs and process affinity do not overlap"
        );
        assert_eq!(
            pre_spawn_cpu_capacity_at(dir.path(), 0, &BTreeSet::from([0])).unwrap_err(),
            "available logical CPU count is zero"
        );
    }

    #[test]
    fn pre_spawn_cpu_capacity_sources_are_stable() {
        assert_eq!(
            PreSpawnCpuCapacity::ExactPhysical(1).source(),
            "physical_topology"
        );
        assert_eq!(
            PreSpawnCpuCapacity::RestrictedPhysical(1).source(),
            "restricted_physical_topology"
        );
        assert_eq!(
            PreSpawnCpuCapacity::ConservativeLogical(1).source(),
            "logical_cpu_fallback"
        );
    }

    #[test]
    fn memory_mb_is_positive() {
        // Only works on Linux with /proc
        if std::path::Path::new("/proc/meminfo").exists() {
            assert!(memory_mb().unwrap() > 0);
        }
    }
}
