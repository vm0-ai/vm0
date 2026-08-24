//! Host-local runner environment access.
//!
//! Keep this module at the raw process/file environment boundary. Runtime
//! parsing and validation live in higher-level modules.

use std::collections::BTreeMap;

use crate::error::{RunnerError, RunnerResult};

pub(crate) const RUNNER_HOST_ENV_FILE: &str = "/etc/vm0-runner/host.env";
pub(crate) const RUNNER_CONCURRENCY_FACTOR_ENV: &str = "OKOU_RUNNER_CONCURRENCY_FACTOR";
pub(crate) const RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV: &str =
    "OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC";
pub(crate) const RUNNER_DISK_IOPS_ENV: &str = "OKOU_RUNNER_DISK_IOPS";
pub(crate) const RUNNER_NET_RX_MIB_PER_SEC_ENV: &str = "OKOU_RUNNER_NET_RX_MIB_PER_SEC";
pub(crate) const RUNNER_NET_TX_MIB_PER_SEC_ENV: &str = "OKOU_RUNNER_NET_TX_MIB_PER_SEC";

pub(crate) const LEGACY_RUNNER_CONCURRENCY_FACTOR_ENV: &str = "VM0_RUNNER_CONCURRENCY_FACTOR";
pub(crate) const LEGACY_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV: &str =
    "VM0_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC";
pub(crate) const LEGACY_RUNNER_DISK_IOPS_ENV: &str = "VM0_RUNNER_DISK_IOPS";
pub(crate) const LEGACY_RUNNER_NET_RX_MIB_PER_SEC_ENV: &str = "VM0_RUNNER_NET_RX_MIB_PER_SEC";
pub(crate) const LEGACY_RUNNER_NET_TX_MIB_PER_SEC_ENV: &str = "VM0_RUNNER_NET_TX_MIB_PER_SEC";

const HOST_ENV_KEY_ALIASES: [(&str, &str); 10] = [
    (RUNNER_CONCURRENCY_FACTOR_ENV, RUNNER_CONCURRENCY_FACTOR_ENV),
    (
        LEGACY_RUNNER_CONCURRENCY_FACTOR_ENV,
        RUNNER_CONCURRENCY_FACTOR_ENV,
    ),
    (
        RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
        RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
    ),
    (
        LEGACY_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
        RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
    ),
    (RUNNER_DISK_IOPS_ENV, RUNNER_DISK_IOPS_ENV),
    (LEGACY_RUNNER_DISK_IOPS_ENV, RUNNER_DISK_IOPS_ENV),
    (RUNNER_NET_RX_MIB_PER_SEC_ENV, RUNNER_NET_RX_MIB_PER_SEC_ENV),
    (
        LEGACY_RUNNER_NET_RX_MIB_PER_SEC_ENV,
        RUNNER_NET_RX_MIB_PER_SEC_ENV,
    ),
    (RUNNER_NET_TX_MIB_PER_SEC_ENV, RUNNER_NET_TX_MIB_PER_SEC_ENV),
    (
        LEGACY_RUNNER_NET_TX_MIB_PER_SEC_ENV,
        RUNNER_NET_TX_MIB_PER_SEC_ENV,
    ),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HostEnvValue {
    pub(crate) value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct RunnerIoEnvValues {
    pub(crate) disk_bandwidth_mib_per_sec: Option<HostEnvValue>,
    pub(crate) disk_iops: Option<HostEnvValue>,
    pub(crate) net_rx_mib_per_sec: Option<HostEnvValue>,
    pub(crate) net_tx_mib_per_sec: Option<HostEnvValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct RunnerHostEnv {
    values: BTreeMap<&'static str, HostEnvValue>,
}

impl RunnerHostEnv {
    pub(crate) fn concurrency_factor(&self) -> Option<&HostEnvValue> {
        self.values.get(RUNNER_CONCURRENCY_FACTOR_ENV)
    }

    pub(crate) fn io_values(&self) -> RunnerIoEnvValues {
        RunnerIoEnvValues {
            disk_bandwidth_mib_per_sec: self
                .values
                .get(RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV)
                .cloned(),
            disk_iops: self.values.get(RUNNER_DISK_IOPS_ENV).cloned(),
            net_rx_mib_per_sec: self.values.get(RUNNER_NET_RX_MIB_PER_SEC_ENV).cloned(),
            net_tx_mib_per_sec: self.values.get(RUNNER_NET_TX_MIB_PER_SEC_ENV).cloned(),
        }
    }
}

pub(crate) fn read_runner_host_env() -> RunnerResult<RunnerHostEnv> {
    Ok(RunnerHostEnv {
        values: read_host_env_file()?,
    })
}

fn read_host_env_file() -> RunnerResult<BTreeMap<&'static str, HostEnvValue>> {
    let content = match std::fs::read_to_string(RUNNER_HOST_ENV_FILE) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => {
            return Err(RunnerError::Config(format!(
                "failed to read {RUNNER_HOST_ENV_FILE}: {e}"
            )));
        }
    };

    parse_host_env_file(&content)
}

fn parse_host_env_file(content: &str) -> RunnerResult<BTreeMap<&'static str, HostEnvValue>> {
    let mut values = BTreeMap::new();
    let mut provided_keys = BTreeMap::new();

    for (line_number, line) in content.lines().enumerate() {
        let line_number = line_number + 1;
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let Some((key, raw_value)) = line.split_once('=') else {
            return Err(RunnerError::Config(format!(
                "{RUNNER_HOST_ENV_FILE}:{line_number}: expected KEY=VALUE"
            )));
        };
        let key = key.trim();
        let Some(&(provided_key, logical_key)) = HOST_ENV_KEY_ALIASES
            .iter()
            .find(|&&(alias, _)| alias == key)
        else {
            let allowed_keys = HOST_ENV_KEY_ALIASES
                .iter()
                .map(|(alias, _)| *alias)
                .collect::<Vec<_>>()
                .join(", ");
            return Err(RunnerError::Config(format!(
                "{RUNNER_HOST_ENV_FILE}:{line_number}: unsupported host env key {key:?}; allowed keys: {}",
                allowed_keys
            )));
        };
        if let Some(existing_key) = provided_keys.get(logical_key) {
            let message = if *existing_key == provided_key {
                format!("duplicate host env key {provided_key}")
            } else {
                format!("conflicting host env aliases for {logical_key}")
            };
            return Err(RunnerError::Config(format!(
                "{RUNNER_HOST_ENV_FILE}:{line_number}: {message}"
            )));
        }

        provided_keys.insert(logical_key, provided_key);
        values.insert(
            logical_key,
            HostEnvValue {
                value: raw_value.trim().to_string(),
            },
        );
    }

    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_host_env_file_accepts_allowed_keys_with_comments() {
        let values = parse_host_env_file(
            "\n# host-local runner overrides\nOKOU_RUNNER_CONCURRENCY_FACTOR = 1.5\nVM0_RUNNER_DISK_IOPS = 200000\n",
        )
        .unwrap();

        assert_eq!(
            values.get(RUNNER_CONCURRENCY_FACTOR_ENV),
            Some(&HostEnvValue {
                value: "1.5".to_string(),
            })
        );
        assert_eq!(
            values.get(RUNNER_DISK_IOPS_ENV),
            Some(&HostEnvValue {
                value: "200000".to_string(),
            })
        );
    }

    #[test]
    fn parse_host_env_file_returns_empty_map_for_empty_file() {
        let values = parse_host_env_file("\n# nothing enabled\n").unwrap();

        assert!(values.is_empty());
    }

    #[test]
    fn parse_host_env_file_preserves_legacy_only_configuration() {
        let values = parse_host_env_file(
            "\
VM0_RUNNER_CONCURRENCY_FACTOR=1.5
VM0_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=1000
VM0_RUNNER_DISK_IOPS=50000
VM0_RUNNER_NET_RX_MIB_PER_SEC=250
VM0_RUNNER_NET_TX_MIB_PER_SEC=125
",
        )
        .unwrap();
        let host_env = RunnerHostEnv { values };

        assert_eq!(
            host_env.concurrency_factor(),
            Some(&HostEnvValue {
                value: "1.5".to_string(),
            })
        );
        let io_values = host_env.io_values();
        assert_eq!(
            io_values.disk_bandwidth_mib_per_sec,
            Some(HostEnvValue {
                value: "1000".to_string(),
            })
        );
        assert_eq!(
            io_values.disk_iops,
            Some(HostEnvValue {
                value: "50000".to_string(),
            })
        );
        assert_eq!(
            io_values.net_rx_mib_per_sec,
            Some(HostEnvValue {
                value: "250".to_string(),
            })
        );
        assert_eq!(
            io_values.net_tx_mib_per_sec,
            Some(HostEnvValue {
                value: "125".to_string(),
            })
        );
    }

    #[test]
    fn parse_host_env_file_accepts_canonical_only_configuration() {
        let canonical_values = parse_host_env_file(
            "\
OKOU_RUNNER_CONCURRENCY_FACTOR=1.5
OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=1000
OKOU_RUNNER_DISK_IOPS=50000
OKOU_RUNNER_NET_RX_MIB_PER_SEC=250
OKOU_RUNNER_NET_TX_MIB_PER_SEC=125
",
        )
        .unwrap();
        let legacy_values = parse_host_env_file(
            "\
VM0_RUNNER_CONCURRENCY_FACTOR=1.5
VM0_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=1000
VM0_RUNNER_DISK_IOPS=50000
VM0_RUNNER_NET_RX_MIB_PER_SEC=250
VM0_RUNNER_NET_TX_MIB_PER_SEC=125
",
        )
        .unwrap();

        assert_eq!(canonical_values, legacy_values);
    }

    #[test]
    fn parse_host_env_file_normalizes_mixed_io_aliases() {
        let values = parse_host_env_file(
            "\
OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=1000
VM0_RUNNER_DISK_IOPS=50000
OKOU_RUNNER_NET_RX_MIB_PER_SEC=250
VM0_RUNNER_NET_TX_MIB_PER_SEC=125
",
        )
        .unwrap();
        let host_env = RunnerHostEnv { values };

        assert_eq!(
            host_env.io_values(),
            RunnerIoEnvValues {
                disk_bandwidth_mib_per_sec: Some(HostEnvValue {
                    value: "1000".to_string(),
                }),
                disk_iops: Some(HostEnvValue {
                    value: "50000".to_string(),
                }),
                net_rx_mib_per_sec: Some(HostEnvValue {
                    value: "250".to_string(),
                }),
                net_tx_mib_per_sec: Some(HostEnvValue {
                    value: "125".to_string(),
                }),
            }
        );
    }

    #[test]
    fn mixed_alias_partial_io_group_remains_all_or_none() {
        let values = parse_host_env_file(
            "\
OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=1000
VM0_RUNNER_DISK_IOPS=50000
OKOU_RUNNER_NET_RX_MIB_PER_SEC=250
",
        )
        .unwrap();
        let host_env = RunnerHostEnv { values };
        let profiles = BTreeMap::from([(
            "vm0/default".to_string(),
            crate::config::ProfileConfig {
                rootfs_hash: "rootfs".to_string(),
                snapshot_hash: "snapshot".to_string(),
                vcpu: 2,
                memory_mb: 4096,
                rootfs_disk_mb: 8192,
                workspace_disk_mb: 16_384,
            },
        )]);
        let budget = crate::resource_budget::ResourceBudget::new(2, 4096, 1.0, 1);

        let resolution = crate::io_limits::resolve_io_limits(&profiles, &budget, &host_env);

        let crate::io_limits::IoLimitResolution::Misconfigured { reason } = &resolution else {
            panic!("expected misconfigured resolution");
        };
        assert!(reason.contains(RUNNER_NET_TX_MIB_PER_SEC_ENV));
        assert_eq!(resolution.device_rate_limits(), None);
    }

    #[test]
    fn parse_host_env_file_rejects_unknown_keys() {
        let err = parse_host_env_file("VM0_API_BACKEND_URL=https://example.test\n")
            .unwrap_err()
            .to_string();

        assert!(err.contains("unsupported host env key"));
        assert!(err.contains("VM0_API_BACKEND_URL"));
        assert!(err.contains(RUNNER_CONCURRENCY_FACTOR_ENV));
        assert!(err.contains(LEGACY_RUNNER_CONCURRENCY_FACTOR_ENV));
        assert!(err.contains(RUNNER_DISK_IOPS_ENV));
        assert!(err.contains(LEGACY_RUNNER_DISK_IOPS_ENV));
    }

    #[test]
    fn parse_host_env_file_rejects_exact_duplicate_keys() {
        for (key, first_value, second_value) in [
            (
                RUNNER_CONCURRENCY_FACTOR_ENV,
                "canonical-first-value",
                "canonical-second-value",
            ),
            (
                LEGACY_RUNNER_CONCURRENCY_FACTOR_ENV,
                "legacy-first-value",
                "legacy-second-value",
            ),
        ] {
            let content = format!("{key}={first_value}\n{key}={second_value}\n");
            let err = parse_host_env_file(&content).unwrap_err().to_string();

            assert!(err.contains("duplicate host env key"));
            assert!(err.contains(key));
            assert!(!err.contains(first_value));
            assert!(!err.contains(second_value));
        }
    }

    #[test]
    fn parse_host_env_file_rejects_alias_conflicts_without_values() {
        for content in [
            format!(
                "{LEGACY_RUNNER_CONCURRENCY_FACTOR_ENV}=legacy-value-should-not-leak\n{RUNNER_CONCURRENCY_FACTOR_ENV}=canonical-value-should-not-leak\n"
            ),
            format!(
                "{RUNNER_CONCURRENCY_FACTOR_ENV}=canonical-value-should-not-leak\n{LEGACY_RUNNER_CONCURRENCY_FACTOR_ENV}=legacy-value-should-not-leak\n"
            ),
            format!(
                "{LEGACY_RUNNER_CONCURRENCY_FACTOR_ENV}=same-value-should-not-leak\n{RUNNER_CONCURRENCY_FACTOR_ENV}=same-value-should-not-leak\n"
            ),
        ] {
            let err = parse_host_env_file(&content).unwrap_err().to_string();

            assert!(err.contains("conflicting host env aliases"));
            assert!(err.contains(RUNNER_CONCURRENCY_FACTOR_ENV));
            assert!(!err.contains("legacy-value-should-not-leak"));
            assert!(!err.contains("canonical-value-should-not-leak"));
            assert!(!err.contains("same-value-should-not-leak"));
        }
    }

    #[test]
    fn parse_host_env_file_rejects_malformed_lines() {
        let err = parse_host_env_file("VM0_RUNNER_CONCURRENCY_FACTOR\n")
            .unwrap_err()
            .to_string();

        assert!(err.contains("expected KEY=VALUE"));
    }
}
