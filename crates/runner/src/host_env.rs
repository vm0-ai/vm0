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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostEnvSource {
    ProcessEnv,
    HostFile,
}

impl HostEnvSource {
    pub(crate) fn label_for(self, process_env_name: &'static str) -> &'static str {
        match self {
            Self::ProcessEnv => process_env_name,
            Self::HostFile => RUNNER_HOST_ENV_FILE,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HostEnvValue {
    pub(crate) value: String,
    pub(crate) source: HostEnvSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct RunnerIoEnvValues {
    pub(crate) disk_bandwidth_mib_per_sec: Option<HostEnvValue>,
    pub(crate) disk_iops: Option<HostEnvValue>,
    pub(crate) net_rx_mib_per_sec: Option<HostEnvValue>,
    pub(crate) net_tx_mib_per_sec: Option<HostEnvValue>,
    pub(crate) invalid_process_env: Option<&'static str>,
}

pub(crate) fn runner_concurrency_factor() -> RunnerResult<Option<HostEnvValue>> {
    let process_value = read_env_var(RUNNER_CONCURRENCY_FACTOR_ENV)?;
    let file_values = read_host_env_file()?;
    let file_value = file_values.get(RUNNER_CONCURRENCY_FACTOR_ENV).cloned();

    if let Some(value) = process_value {
        return Ok(Some(HostEnvValue {
            value,
            source: HostEnvSource::ProcessEnv,
        }));
    }

    Ok(file_value)
}

pub(crate) fn runner_io_env_values() -> RunnerResult<RunnerIoEnvValues> {
    let file_values = read_host_env_file()?;
    let mut invalid_process_env = None;
    let disk_bandwidth_mib_per_sec = read_io_host_env_value_with_process_override(
        RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
        &file_values,
        &mut invalid_process_env,
    );
    let disk_iops = read_io_host_env_value_with_process_override(
        RUNNER_DISK_IOPS_ENV,
        &file_values,
        &mut invalid_process_env,
    );
    let net_rx_mib_per_sec = read_io_host_env_value_with_process_override(
        RUNNER_NET_RX_MIB_PER_SEC_ENV,
        &file_values,
        &mut invalid_process_env,
    );
    let net_tx_mib_per_sec = read_io_host_env_value_with_process_override(
        RUNNER_NET_TX_MIB_PER_SEC_ENV,
        &file_values,
        &mut invalid_process_env,
    );

    Ok(RunnerIoEnvValues {
        disk_bandwidth_mib_per_sec,
        disk_iops,
        net_rx_mib_per_sec,
        net_tx_mib_per_sec,
        invalid_process_env,
    })
}

fn read_io_host_env_value_with_process_override(
    name: &'static str,
    file_values: &BTreeMap<&'static str, HostEnvValue>,
    invalid_process_env: &mut Option<&'static str>,
) -> Option<HostEnvValue> {
    match std::env::var(name) {
        Ok(value) => Some(HostEnvValue {
            value,
            source: HostEnvSource::ProcessEnv,
        }),
        Err(std::env::VarError::NotPresent) => file_values.get(name).cloned(),
        Err(std::env::VarError::NotUnicode(_)) => {
            invalid_process_env.get_or_insert(name);
            None
        }
    }
}

fn read_env_var(name: &'static str) -> RunnerResult<Option<String>> {
    match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err(RunnerError::Config(format!("{name} must be valid UTF-8")))
        }
    }
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
                source: HostEnvSource::HostFile,
            },
        );
    }

    Ok(values)
}

#[cfg(test)]
mod tests {
    use std::ffi::{OsStr, OsString};
    use std::os::unix::ffi::OsStringExt;
    use std::sync::Mutex;

    use super::*;

    static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvVarGuard {
        name: &'static str,
        previous: Option<OsString>,
    }

    impl EnvVarGuard {
        fn set(name: &'static str, value: impl AsRef<OsStr>) -> Self {
            let previous = std::env::var_os(name);
            unsafe {
                std::env::set_var(name, value);
            }
            Self { name, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            unsafe {
                if let Some(previous) = &self.previous {
                    std::env::set_var(self.name, previous);
                } else {
                    std::env::remove_var(self.name);
                }
            }
        }
    }

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
                source: HostEnvSource::HostFile,
            })
        );
        assert_eq!(
            values.get(RUNNER_DISK_IOPS_ENV),
            Some(&HostEnvValue {
                value: "200000".to_string(),
                source: HostEnvSource::HostFile,
            })
        );
    }

    #[test]
    fn parse_host_env_file_returns_empty_map_for_empty_file() {
        let values = parse_host_env_file("\n# nothing enabled\n").unwrap();

        assert!(values.is_empty());
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

    #[test]
    fn host_env_value_with_process_override_prefers_process_env() {
        let _guard = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut file_values = BTreeMap::new();
        file_values.insert(
            RUNNER_DISK_IOPS_ENV,
            HostEnvValue {
                value: "100".to_string(),
                source: HostEnvSource::HostFile,
            },
        );

        let _env = EnvVarGuard::set(RUNNER_DISK_IOPS_ENV, "200");
        let mut invalid_process_env = None;
        let value = read_io_host_env_value_with_process_override(
            RUNNER_DISK_IOPS_ENV,
            &file_values,
            &mut invalid_process_env,
        )
        .unwrap();

        assert_eq!(
            value,
            HostEnvValue {
                value: "200".to_string(),
                source: HostEnvSource::ProcessEnv,
            }
        );
        assert_eq!(invalid_process_env, None);
    }

    #[test]
    fn non_utf8_io_process_env_marks_io_env_invalid() {
        let _guard = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut file_values = BTreeMap::new();
        file_values.insert(
            RUNNER_DISK_IOPS_ENV,
            HostEnvValue {
                value: "100".to_string(),
                source: HostEnvSource::HostFile,
            },
        );

        let _env = EnvVarGuard::set(RUNNER_DISK_IOPS_ENV, OsString::from_vec(vec![0xff]));
        let mut invalid_process_env = None;
        let value = read_io_host_env_value_with_process_override(
            RUNNER_DISK_IOPS_ENV,
            &file_values,
            &mut invalid_process_env,
        );

        assert_eq!(value, None);
        assert_eq!(invalid_process_env, Some(RUNNER_DISK_IOPS_ENV));
    }
}
