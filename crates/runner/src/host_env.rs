//! Host-local runner environment access.
//!
//! Keep this module at the raw process/file environment boundary. Runtime
//! parsing and validation live in higher-level modules.

use std::collections::BTreeMap;

use crate::error::{RunnerError, RunnerResult};

pub(crate) const RUNNER_HOST_ENV_FILE: &str = "/etc/vm0-runner/host.env";
pub(crate) const RUNNER_CONCURRENCY_FACTOR_ENV: &str = "VM0_RUNNER_CONCURRENCY_FACTOR";
pub(crate) const RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV: &str =
    "VM0_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC";
pub(crate) const RUNNER_DISK_IOPS_ENV: &str = "VM0_RUNNER_DISK_IOPS";
pub(crate) const RUNNER_NET_RX_MIB_PER_SEC_ENV: &str = "VM0_RUNNER_NET_RX_MIB_PER_SEC";
pub(crate) const RUNNER_NET_TX_MIB_PER_SEC_ENV: &str = "VM0_RUNNER_NET_TX_MIB_PER_SEC";

const ALLOWED_HOST_ENV_KEYS: [&str; 5] = [
    RUNNER_CONCURRENCY_FACTOR_ENV,
    RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
    RUNNER_DISK_IOPS_ENV,
    RUNNER_NET_RX_MIB_PER_SEC_ENV,
    RUNNER_NET_TX_MIB_PER_SEC_ENV,
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
        let Some(&allowed_key) = ALLOWED_HOST_ENV_KEYS
            .iter()
            .find(|&&allowed| allowed == key)
        else {
            return Err(RunnerError::Config(format!(
                "{RUNNER_HOST_ENV_FILE}:{line_number}: unsupported host env key {key:?}; allowed keys: {}",
                ALLOWED_HOST_ENV_KEYS.join(", ")
            )));
        };
        if values.contains_key(allowed_key) {
            return Err(RunnerError::Config(format!(
                "{RUNNER_HOST_ENV_FILE}:{line_number}: duplicate host env key {allowed_key}"
            )));
        }

        values.insert(
            allowed_key,
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
            "\n# host-local runner overrides\nVM0_RUNNER_CONCURRENCY_FACTOR = 1.5\nVM0_RUNNER_DISK_IOPS = 200000\n",
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
    fn runner_host_env_projects_concurrency_and_io_values() {
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
    fn parse_host_env_file_rejects_unknown_keys() {
        let err = parse_host_env_file("VM0_API_URL=https://example.test\n")
            .unwrap_err()
            .to_string();

        assert!(err.contains("unsupported host env key"));
        assert!(err.contains("VM0_API_URL"));
        assert!(err.contains(RUNNER_CONCURRENCY_FACTOR_ENV));
        assert!(err.contains(RUNNER_DISK_IOPS_ENV));
    }

    #[test]
    fn parse_host_env_file_rejects_duplicate_keys() {
        let err = parse_host_env_file(
            "VM0_RUNNER_CONCURRENCY_FACTOR=1.0\nVM0_RUNNER_CONCURRENCY_FACTOR=1.5\n",
        )
        .unwrap_err()
        .to_string();

        assert!(err.contains("duplicate host env key"));
        assert!(err.contains(RUNNER_CONCURRENCY_FACTOR_ENV));
    }

    #[test]
    fn parse_host_env_file_rejects_malformed_lines() {
        let err = parse_host_env_file("VM0_RUNNER_CONCURRENCY_FACTOR\n")
            .unwrap_err()
            .to_string();

        assert!(err.contains("expected KEY=VALUE"));
    }
}
