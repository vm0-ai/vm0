use std::process::Stdio;

use serde_json::Value;
use tokio::process::Command as TokioCommand;

use crate::diskstats::{calculate_host_disk_iops, read_diskstats};
use crate::metrics::float_to_u64;

pub(crate) struct FioWorkload {
    pub(crate) name: &'static str,
    pub(crate) args: &'static str,
}

#[derive(Debug, Default)]
pub(crate) struct FioResult {
    /// IOPS as seen by the VM / fio
    pub(crate) vm_iops: u64,
    pub(crate) lat_p50_us: u64,
    pub(crate) lat_p99_us: u64,
    /// Actual IOPS on the host disk during the test
    pub(crate) host_disk_iops: u64,
}

/// Run fio while sampling /proc/diskstats before and after to measure actual host disk IOPS.
pub(crate) async fn run_fio_with_iostat(
    device: &str,
    workload: &FioWorkload,
    host_disk: &str,
) -> Result<FioResult, String> {
    // Snapshot disk stats before
    let before = read_diskstats(host_disk)?;

    let start = std::time::Instant::now();

    let mut cmd = TokioCommand::new("fio");
    cmd.stdin(Stdio::null())
        .arg(format!("--name={}", workload.name))
        .arg(format!("--filename={device}"))
        .args(workload.args.split_whitespace())
        .arg("--runtime=10")
        .arg("--time_based")
        .arg("--output-format=json")
        .arg("--group_reporting=1")
        .arg("--unified_rw_reporting=1")
        .kill_on_drop(true);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("fio failed to start: {e}"))?;

    let elapsed_secs = start.elapsed().as_secs_f64();

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("fio failed: {stderr}"));
    }

    // Snapshot disk stats after
    let after = read_diskstats(host_disk)?;

    let mut result = parse_fio_json(&output.stdout)?;

    result.host_disk_iops = calculate_host_disk_iops(&before, &after, elapsed_secs)?;

    eprintln!(
        "    VM IOPS: {}, Host disk IOPS: {}, Duration: {:.1}s",
        result.vm_iops, result.host_disk_iops, elapsed_secs
    );

    Ok(result)
}

fn parse_fio_json(stdout: &[u8]) -> Result<FioResult, String> {
    let root: Value = serde_json::from_slice(stdout).map_err(|e| format!("parse fio JSON: {e}"))?;
    let jobs = fio_jobs(&root)?;
    let vm_iops = fio_vm_iops(jobs)?;
    let (lat_p50_us, lat_p99_us) = fio_latency_us(jobs)?;

    Ok(FioResult {
        vm_iops: float_to_u64(vm_iops, "fio JSON VM IOPS")?,
        lat_p50_us,
        lat_p99_us,
        host_disk_iops: 0,
    })
}

fn fio_jobs(root: &Value) -> Result<&[Value], String> {
    let jobs = root
        .get("jobs")
        .and_then(Value::as_array)
        .ok_or_else(|| "fio JSON missing jobs array".to_string())?;
    if jobs.is_empty() {
        return Err("fio JSON jobs array is empty".to_string());
    }
    Ok(jobs)
}

fn fio_vm_iops(jobs: &[Value]) -> Result<f64, String> {
    let active_mixed_sections = jobs
        .iter()
        .filter_map(|job| job.get("mixed"))
        .filter(|section| section_is_active(section))
        .collect::<Vec<_>>();
    if !active_mixed_sections.is_empty() {
        return sum_section_iops(&active_mixed_sections, "mixed");
    }

    let active_direction_sections = jobs
        .iter()
        .flat_map(|job| {
            DIRECTIONS
                .iter()
                .filter_map(move |direction| job.get(*direction))
        })
        .filter(|section| section_is_active(section))
        .collect::<Vec<_>>();
    if !active_direction_sections.is_empty() {
        return sum_section_iops(&active_direction_sections, "active direction");
    }

    let mut saw_iops = false;
    let total = jobs
        .iter()
        .flat_map(|job| DIRECTIONS.iter().map(move |direction| (job, *direction)))
        .filter_map(|(job, direction)| {
            section_iops(job, direction).inspect(|_| {
                saw_iops = true;
            })
        })
        .sum::<f64>();

    if !saw_iops {
        return Err("fio JSON missing IOPS fields".to_string());
    }
    Ok(total)
}

const DIRECTIONS: [&str; 3] = ["read", "write", "trim"];

fn fio_latency_us(jobs: &[Value]) -> Result<(u64, u64), String> {
    let active_mixed_sections = jobs
        .iter()
        .filter_map(|job| job.get("mixed"))
        .filter(|section| section_is_active(section))
        .collect::<Vec<_>>();
    if !active_mixed_sections.is_empty() {
        return single_latency_section(active_mixed_sections, "mixed");
    }

    let active_directions = DIRECTIONS
        .iter()
        .copied()
        .filter(|direction| {
            jobs.iter()
                .filter_map(|job| job.get(*direction))
                .any(section_is_active)
        })
        .collect::<Vec<_>>();

    match active_directions.as_slice() {
        [] => Err("fio JSON has no active read/write/trim direction".to_string()),
        [direction] => {
            let latency_sections = jobs
                .iter()
                .filter_map(|job| job.get(*direction))
                .filter(|section| section_is_active(section))
                .collect::<Vec<_>>();
            single_latency_section(latency_sections, direction)
        }
        directions => Err(format!(
            "fio JSON has mixed directions ({}) but no unified mixed latency; rerun with --unified_rw_reporting=1",
            directions.join(",")
        )),
    }
}

fn section_iops(job: &Value, section: &str) -> Option<f64> {
    nonnegative_f64(job.get(section)?.get("iops")?)
}

fn sum_section_iops(sections: &[&Value], section_name: &str) -> Result<f64, String> {
    sections
        .iter()
        .map(|section| {
            section
                .get("iops")
                .and_then(nonnegative_f64)
                .ok_or_else(|| format!("fio JSON missing {section_name} IOPS for active section"))
        })
        .sum()
}

fn section_is_active(section: &Value) -> bool {
    section_total_ios(section).unwrap_or(0) > 0
        || section.get("iops").and_then(nonnegative_f64).unwrap_or(0.0) > 0.0
}

fn section_total_ios(section: &Value) -> Option<u64> {
    section.get("total_ios")?.as_u64()
}

fn section_latency_us(section: &Value, section_name: &str) -> Result<(u64, u64), String> {
    let p50 = percentile_us(section, "50.000000")
        .ok_or_else(|| format!("fio JSON missing {section_name} p50 latency"))?;
    let p99 = percentile_us(section, "99.000000")
        .ok_or_else(|| format!("fio JSON missing {section_name} p99 latency"))?;
    Ok((p50, p99))
}

fn single_latency_section(sections: Vec<&Value>, section_name: &str) -> Result<(u64, u64), String> {
    match sections.as_slice() {
        [] => Err(format!(
            "fio JSON missing {section_name} latency percentiles"
        )),
        [section] => section_latency_us(section, section_name),
        _ => Err(format!(
            "fio JSON has multiple {section_name} latency sections; rerun with --group_reporting=1"
        )),
    }
}

fn percentile_us(section: &Value, percentile: &str) -> Option<u64> {
    let value = section.get("clat_ns")?.get("percentile")?.get(percentile)?;
    let ns = value.as_u64().or_else(|| {
        nonnegative_f64(value)
            .filter(|value| *value < u64::MAX as f64)
            .map(|value| value as u64)
    })?;
    Some(ns / 1000)
}

fn nonnegative_f64(value: &Value) -> Option<f64> {
    let value = value.as_f64()?;
    value
        .is_finite()
        .then_some(value)
        .filter(|value| *value >= 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn parse_fio_json_sums_mixed_read_write_iops() {
        let json = br#"{
            "jobs": [{
                "read": {
                    "iops": 700.0,
                    "total_ios": 700,
                    "clat_ns": {"percentile": {"50.000000": 10000, "99.000000": 20000}}
                },
                "write": {
                    "iops": 300.0,
                    "total_ios": 300,
                    "clat_ns": {"percentile": {"50.000000": 12000, "99.000000": 22000}}
                },
                "trim": {"iops": 0.0, "total_ios": 0},
                "mixed": {
                    "iops": 1000.0,
                    "total_ios": 1000,
                    "clat_ns": {"percentile": {"50.000000": 11000, "99.000000": 21000}}
                }
            }]
        }"#;

        let result = parse_fio_json(json).unwrap();

        assert_eq!(result.vm_iops, 1000);
        assert_eq!(result.lat_p50_us, 11);
        assert_eq!(result.lat_p99_us, 21);
    }

    #[test]
    fn fio_vm_iops_sums_read_write_without_mixed() {
        let json = br#"{
            "jobs": [{
                "read": {"iops": 700.0, "total_ios": 700},
                "write": {"iops": 300.0, "total_ios": 300},
                "trim": {"iops": 0.0, "total_ios": 0}
            }]
        }"#;
        let root: Value = serde_json::from_slice(json).unwrap();
        let jobs = fio_jobs(&root).unwrap();

        assert_eq!(fio_vm_iops(jobs).unwrap() as u64, 1000);
    }

    #[test]
    fn parse_fio_json_prefers_mixed_section() {
        let json = br#"{
            "jobs": [{
                "read": {"iops": 700.0, "total_ios": 700},
                "write": {"iops": 300.0, "total_ios": 300},
                "trim": {"iops": 0.0, "total_ios": 0},
                "mixed": {
                    "iops": 950.0,
                    "total_ios": 1000,
                    "clat_ns": {"percentile": {"50.000000": 13000, "99.000000": 23000}}
                }
            }]
        }"#;

        let result = parse_fio_json(json).unwrap();

        assert_eq!(result.vm_iops, 950);
        assert_eq!(result.lat_p50_us, 13);
        assert_eq!(result.lat_p99_us, 23);
    }

    #[test]
    fn parse_fio_json_accepts_float_percentile_values() {
        let json = br#"{
            "jobs": [{
                "mixed": {
                    "iops": 1000.0,
                    "total_ios": 1000,
                    "clat_ns": {"percentile": {"50.000000": 13000.0, "99.000000": 23000.0}}
                }
            }]
        }"#;

        let result = parse_fio_json(json).unwrap();

        assert_eq!(result.lat_p50_us, 13);
        assert_eq!(result.lat_p99_us, 23);
    }

    #[test]
    fn parse_fio_json_rejects_negative_iops() {
        let json = br#"{
            "jobs": [{
                "mixed": {
                    "iops": -1.0,
                    "total_ios": 1000,
                    "clat_ns": {"percentile": {"50.000000": 13000, "99.000000": 23000}}
                }
            }]
        }"#;

        let err = parse_fio_json(json).unwrap_err();

        assert!(err.contains("mixed IOPS"), "{err}");
    }

    #[test]
    fn parse_fio_json_rejects_negative_float_percentile_values() {
        let json = br#"{
            "jobs": [{
                "mixed": {
                    "iops": 1000.0,
                    "total_ios": 1000,
                    "clat_ns": {"percentile": {"50.000000": -1.0, "99.000000": 23000.0}}
                }
            }]
        }"#;

        let err = parse_fio_json(json).unwrap_err();

        assert!(err.contains("mixed p50 latency"), "{err}");
    }

    #[test]
    fn parse_fio_json_rejects_huge_iops() {
        let json = br#"{
            "jobs": [{
                "mixed": {
                    "iops": 1e100,
                    "total_ios": 1000,
                    "clat_ns": {"percentile": {"50.000000": 13000, "99.000000": 23000}}
                }
            }]
        }"#;

        let err = parse_fio_json(json).unwrap_err();

        assert!(err.contains("VM IOPS"), "{err}");
    }

    #[test]
    fn parse_fio_json_rejects_huge_float_percentile_values() {
        let json = br#"{
            "jobs": [{
                "mixed": {
                    "iops": 1000.0,
                    "total_ios": 1000,
                    "clat_ns": {"percentile": {"50.000000": 1e100, "99.000000": 23000.0}}
                }
            }]
        }"#;

        let err = parse_fio_json(json).unwrap_err();

        assert!(err.contains("mixed p50 latency"), "{err}");
    }

    #[test]
    fn parse_fio_json_ignores_inactive_mixed_section_for_read_only() {
        let json = br#"{
            "jobs": [{
                "read": {
                    "iops": 512.0,
                    "total_ios": 512,
                    "clat_ns": {"percentile": {"50.000000": 8000, "99.000000": 16000}}
                },
                "write": {"iops": 0.0, "total_ios": 0},
                "trim": {"iops": 0.0, "total_ios": 0},
                "mixed": {"iops": 0.0, "total_ios": 0}
            }]
        }"#;

        let result = parse_fio_json(json).unwrap();

        assert_eq!(result.vm_iops, 512);
        assert_eq!(result.lat_p50_us, 8);
        assert_eq!(result.lat_p99_us, 16);
    }

    #[test]
    fn parse_fio_json_rejects_active_mixed_section_missing_latency() {
        let json = br#"{
            "jobs": [{
                "mixed": {"iops": 1000.0, "total_ios": 1000}
            }]
        }"#;

        let err = parse_fio_json(json).unwrap_err();

        assert!(err.contains("mixed p50 latency"), "{err}");
    }

    #[test]
    fn parse_fio_json_rejects_active_direction_missing_iops() {
        let json = br#"{
            "jobs": [{
                "read": {
                    "total_ios": 512,
                    "clat_ns": {"percentile": {"50.000000": 8000, "99.000000": 16000}}
                }
            }]
        }"#;

        let err = parse_fio_json(json).unwrap_err();

        assert!(err.contains("active direction IOPS"), "{err}");
    }

    #[test]
    fn fio_vm_iops_sums_multiple_jobs() {
        let json = br#"{
            "jobs": [
                {
                    "mixed": {
                        "iops": 600.0,
                        "total_ios": 600,
                        "clat_ns": {"percentile": {"50.000000": 10000, "99.000000": 20000}}
                    }
                },
                {
                    "mixed": {
                        "iops": 400.0,
                        "total_ios": 400,
                        "clat_ns": {"percentile": {"50.000000": 12000, "99.000000": 22000}}
                    }
                }
            ]
        }"#;
        let root: Value = serde_json::from_slice(json).unwrap();
        let jobs = fio_jobs(&root).unwrap();

        assert_eq!(fio_vm_iops(jobs).unwrap() as u64, 1000);
    }

    #[test]
    fn parse_fio_json_rejects_multiple_mixed_latency_sections() {
        let json = br#"{
            "jobs": [
                {
                    "mixed": {
                        "iops": 600.0,
                        "total_ios": 600,
                        "clat_ns": {"percentile": {"50.000000": 10000, "99.000000": 20000}}
                    }
                },
                {
                    "mixed": {
                        "iops": 400.0,
                        "total_ios": 400,
                        "clat_ns": {"percentile": {"50.000000": 12000, "99.000000": 22000}}
                    }
                }
            ]
        }"#;

        let err = parse_fio_json(json).unwrap_err();

        assert!(err.contains("--group_reporting=1"), "{err}");
    }

    #[test]
    fn parse_fio_json_rejects_multiple_read_latency_sections() {
        let json = br#"{
            "jobs": [
                {
                    "read": {
                        "iops": 600.0,
                        "total_ios": 600,
                        "clat_ns": {"percentile": {"50.000000": 10000, "99.000000": 20000}}
                    }
                },
                {
                    "read": {
                        "iops": 400.0,
                        "total_ios": 400,
                        "clat_ns": {"percentile": {"50.000000": 12000, "99.000000": 22000}}
                    }
                }
            ]
        }"#;

        let err = parse_fio_json(json).unwrap_err();

        assert!(err.contains("--group_reporting=1"), "{err}");
    }

    #[test]
    fn parse_fio_json_accepts_read_only_without_mixed() {
        let json = br#"{
            "jobs": [{
                "read": {
                    "iops": 512.0,
                    "total_ios": 512,
                    "clat_ns": {"percentile": {"50.000000": 8000, "99.000000": 16000}}
                },
                "write": {"iops": 0.0, "total_ios": 0},
                "trim": {"iops": 0.0, "total_ios": 0}
            }]
        }"#;

        let result = parse_fio_json(json).unwrap();

        assert_eq!(result.vm_iops, 512);
        assert_eq!(result.lat_p50_us, 8);
        assert_eq!(result.lat_p99_us, 16);
    }

    #[test]
    fn parse_fio_json_accepts_write_only_without_mixed() {
        let json = br#"{
            "jobs": [{
                "read": {"iops": 0.0, "total_ios": 0},
                "write": {
                    "iops": 256.0,
                    "total_ios": 256,
                    "clat_ns": {"percentile": {"50.000000": 9000, "99.000000": 18000}}
                },
                "trim": {"iops": 0.0, "total_ios": 0}
            }]
        }"#;

        let result = parse_fio_json(json).unwrap();

        assert_eq!(result.vm_iops, 256);
        assert_eq!(result.lat_p50_us, 9);
        assert_eq!(result.lat_p99_us, 18);
    }

    #[test]
    fn parse_fio_json_rejects_mixed_latency_without_unified_stats() {
        let json = br#"{
            "jobs": [{
                "read": {
                    "iops": 700.0,
                    "total_ios": 700,
                    "clat_ns": {"percentile": {"50.000000": 10000, "99.000000": 20000}}
                },
                "write": {
                    "iops": 300.0,
                    "total_ios": 300,
                    "clat_ns": {"percentile": {"50.000000": 12000, "99.000000": 22000}}
                },
                "trim": {"iops": 0.0, "total_ios": 0}
            }]
        }"#;

        let err = parse_fio_json(json).unwrap_err();

        assert!(err.contains("unified"), "{err}");
    }

    #[test]
    fn parse_fio_json_rejects_mixed_latency_without_unified_stats_ignoring_inactive_mixed() {
        let json = br#"{
            "jobs": [{
                "read": {
                    "iops": 700.0,
                    "total_ios": 700,
                    "clat_ns": {"percentile": {"50.000000": 10000, "99.000000": 20000}}
                },
                "write": {
                    "iops": 300.0,
                    "total_ios": 300,
                    "clat_ns": {"percentile": {"50.000000": 12000, "99.000000": 22000}}
                },
                "mixed": {"iops": 0.0, "total_ios": 0}
            }]
        }"#;

        let err = parse_fio_json(json).unwrap_err();

        assert!(err.contains("unified"), "{err}");
    }

    #[test]
    fn parse_fio_json_rejects_invalid_json() {
        let err = parse_fio_json(b"not json").unwrap_err();

        assert!(err.contains("parse fio JSON"), "{err}");
    }

    #[test]
    fn parse_fio_json_rejects_missing_or_empty_jobs() {
        let missing = parse_fio_json(br#"{}"#).unwrap_err();
        assert!(missing.contains("missing jobs array"), "{missing}");

        let empty = parse_fio_json(br#"{"jobs":[]}"#).unwrap_err();
        assert!(empty.contains("jobs array is empty"), "{empty}");
    }
}
