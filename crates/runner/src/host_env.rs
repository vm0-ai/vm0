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
pub(crate) const HOST_ENV_ALIAS_SOURCE_TARGET: &str = "runner::host_env::alias_sources";

// Deployed host.env files and retained runner rollback targets may still use VM0_*.
// Remove these aliases only after every deployed host uses OKOU_* and every supported rollback
// target reads those names; tracked by #28914.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostEnvAliasSource {
    Absent,
    Canonical,
    Legacy,
}

impl HostEnvAliasSource {
    fn label(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Canonical => "canonical",
            Self::Legacy => "legacy",
        }
    }
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
    alias_sources: BTreeMap<&'static str, HostEnvAliasSource>,
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

    fn alias_source(&self, logical_key: &'static str) -> HostEnvAliasSource {
        self.alias_sources
            .get(logical_key)
            .copied()
            .unwrap_or(HostEnvAliasSource::Absent)
    }

    fn log_alias_sources(&self) {
        tracing::info!(
            target: HOST_ENV_ALIAS_SOURCE_TARGET,
            concurrency_factor_alias_source = self
                .alias_source(RUNNER_CONCURRENCY_FACTOR_ENV)
                .label(),
            disk_bandwidth_mib_per_sec_alias_source = self
                .alias_source(RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV)
                .label(),
            disk_iops_alias_source = self.alias_source(RUNNER_DISK_IOPS_ENV).label(),
            net_rx_mib_per_sec_alias_source = self
                .alias_source(RUNNER_NET_RX_MIB_PER_SEC_ENV)
                .label(),
            net_tx_mib_per_sec_alias_source = self
                .alias_source(RUNNER_NET_TX_MIB_PER_SEC_ENV)
                .label(),
            "runner host environment loaded"
        );
    }
}

pub(crate) fn read_runner_host_env() -> RunnerResult<RunnerHostEnv> {
    finish_runner_host_env_load(read_host_env_file())
}

fn finish_runner_host_env_load(result: RunnerResult<RunnerHostEnv>) -> RunnerResult<RunnerHostEnv> {
    let host_env = result?;
    host_env.log_alias_sources();
    Ok(host_env)
}

fn read_host_env_file() -> RunnerResult<RunnerHostEnv> {
    let content = match std::fs::read_to_string(RUNNER_HOST_ENV_FILE) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(RunnerHostEnv::default()),
        Err(e) => {
            return Err(RunnerError::Config(format!(
                "failed to read {RUNNER_HOST_ENV_FILE}: {e}"
            )));
        }
    };

    parse_host_env_file(&content)
}

fn parse_host_env_file(content: &str) -> RunnerResult<RunnerHostEnv> {
    let mut values = BTreeMap::new();
    let mut provided_keys = BTreeMap::new();
    let mut alias_sources = BTreeMap::new();

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
        alias_sources.insert(
            logical_key,
            if provided_key == logical_key {
                HostEnvAliasSource::Canonical
            } else {
                HostEnvAliasSource::Legacy
            },
        );
        values.insert(
            logical_key,
            HostEnvValue {
                value: raw_value.trim().to_string(),
            },
        );
    }

    Ok(RunnerHostEnv {
        values,
        alias_sources,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing::Level;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::CapturedEvents;

    const ALIAS_PAIRS: [(&str, &str); 5] = [
        (
            RUNNER_CONCURRENCY_FACTOR_ENV,
            LEGACY_RUNNER_CONCURRENCY_FACTOR_ENV,
        ),
        (
            RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
            LEGACY_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV,
        ),
        (RUNNER_DISK_IOPS_ENV, LEGACY_RUNNER_DISK_IOPS_ENV),
        (
            RUNNER_NET_RX_MIB_PER_SEC_ENV,
            LEGACY_RUNNER_NET_RX_MIB_PER_SEC_ENV,
        ),
        (
            RUNNER_NET_TX_MIB_PER_SEC_ENV,
            LEGACY_RUNNER_NET_TX_MIB_PER_SEC_ENV,
        ),
    ];

    #[test]
    fn parse_host_env_file_accepts_allowed_keys_with_comments() {
        let host_env = parse_host_env_file(
            "\n# host-local runner overrides\nOKOU_RUNNER_CONCURRENCY_FACTOR = 1.5\nVM0_RUNNER_DISK_IOPS = 200000\n",
        )
        .unwrap();

        assert_eq!(
            host_env.values.get(RUNNER_CONCURRENCY_FACTOR_ENV),
            Some(&HostEnvValue {
                value: "1.5".to_string(),
            })
        );
        assert_eq!(
            host_env.values.get(RUNNER_DISK_IOPS_ENV),
            Some(&HostEnvValue {
                value: "200000".to_string(),
            })
        );
    }

    #[test]
    fn parse_host_env_file_returns_empty_map_for_empty_file() {
        let host_env = parse_host_env_file("\n# nothing enabled\n").unwrap();

        assert!(host_env.values.is_empty());
    }

    #[test]
    fn parse_host_env_file_classifies_every_alias_pair() {
        for (canonical, legacy) in ALIAS_PAIRS {
            let absent = parse_host_env_file("").unwrap();
            assert_eq!(
                absent.alias_source(canonical),
                HostEnvAliasSource::Absent,
                "expected {canonical} to be absent",
            );

            let canonical_config =
                parse_host_env_file(&format!("{canonical}=configured\n")).unwrap();
            assert_eq!(
                canonical_config.alias_source(canonical),
                HostEnvAliasSource::Canonical,
                "expected {canonical} to be canonical",
            );

            let legacy_config = parse_host_env_file(&format!("{legacy}=configured\n")).unwrap();
            assert_eq!(
                legacy_config.alias_source(canonical),
                HostEnvAliasSource::Legacy,
                "expected {legacy} to be legacy",
            );
        }
    }

    #[test]
    fn parse_host_env_file_preserves_legacy_only_configuration() {
        let host_env = parse_host_env_file(
            "\
VM0_RUNNER_CONCURRENCY_FACTOR=1.5
VM0_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=1000
VM0_RUNNER_DISK_IOPS=50000
VM0_RUNNER_NET_RX_MIB_PER_SEC=250
VM0_RUNNER_NET_TX_MIB_PER_SEC=125
",
        )
        .unwrap();

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

        assert_eq!(canonical_values.values, legacy_values.values);
    }

    #[test]
    fn parse_host_env_file_normalizes_mixed_io_aliases() {
        let host_env = parse_host_env_file(
            "\
OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=1000
VM0_RUNNER_DISK_IOPS=50000
OKOU_RUNNER_NET_RX_MIB_PER_SEC=250
VM0_RUNNER_NET_TX_MIB_PER_SEC=125
",
        )
        .unwrap();

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
        let host_env = parse_host_env_file(
            "\
OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC=1000
VM0_RUNNER_DISK_IOPS=50000
OKOU_RUNNER_NET_RX_MIB_PER_SEC=250
",
        )
        .unwrap();
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
    fn successful_load_emits_one_value_free_event_with_all_classifications() {
        const CONFIGURED_VALUES: [&str; 4] = [
            "concurrency-value-should-not-leak",
            "bandwidth-value-should-not-leak",
            "iops-value-should-not-leak",
            "tx-value-should-not-leak",
        ];

        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let _guard = tracing::subscriber::set_default(subscriber);
        tracing::callsite::rebuild_interest_cache();
        captured.clear();

        let host_env = finish_runner_host_env_load(parse_host_env_file(&format!(
            "{RUNNER_CONCURRENCY_FACTOR_ENV}={}\n{LEGACY_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC_ENV}={}\n{RUNNER_DISK_IOPS_ENV}={}\n{LEGACY_RUNNER_NET_TX_MIB_PER_SEC_ENV}={}\n",
            CONFIGURED_VALUES[0],
            CONFIGURED_VALUES[1],
            CONFIGURED_VALUES[2],
            CONFIGURED_VALUES[3],
        )))
        .unwrap();

        assert_eq!(
            host_env.concurrency_factor(),
            Some(&HostEnvValue {
                value: CONFIGURED_VALUES[0].to_string(),
            }),
        );
        let events = captured.entries();
        let loaded_events = events
            .iter()
            .filter(|event| {
                event
                    .fields
                    .get("message")
                    .is_some_and(|message| message == "runner host environment loaded")
            })
            .collect::<Vec<_>>();
        assert_eq!(loaded_events.len(), 1, "captured events: {events:#?}");

        let event = loaded_events[0];
        assert_eq!(event.level, Level::INFO);
        for (field, expected) in [
            ("concurrency_factor_alias_source", "canonical"),
            ("disk_bandwidth_mib_per_sec_alias_source", "legacy"),
            ("disk_iops_alias_source", "canonical"),
            ("net_rx_mib_per_sec_alias_source", "absent"),
            ("net_tx_mib_per_sec_alias_source", "legacy"),
        ] {
            assert_eq!(
                event.fields.get(field).map(String::as_str),
                Some(expected),
                "unexpected {field} in event: {event:#?}",
            );
        }
        for configured_value in CONFIGURED_VALUES {
            assert!(
                event
                    .fields
                    .values()
                    .all(|field_value| !field_value.contains(configured_value)),
                "configured value leaked into event: {event:#?}",
            );
        }
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
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let _guard = tracing::subscriber::set_default(subscriber);
        tracing::callsite::rebuild_interest_cache();
        captured.clear();

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
            let err = finish_runner_host_env_load(parse_host_env_file(&content))
                .unwrap_err()
                .to_string();

            assert!(err.contains("conflicting host env aliases"));
            assert!(err.contains(RUNNER_CONCURRENCY_FACTOR_ENV));
            assert!(!err.contains("legacy-value-should-not-leak"));
            assert!(!err.contains("canonical-value-should-not-leak"));
            assert!(!err.contains("same-value-should-not-leak"));
        }
        assert!(
            captured.entries().iter().all(|event| {
                event
                    .fields
                    .get("message")
                    .is_none_or(|message| message != "runner host environment loaded")
            }),
            "conflicting aliases must fail before the successful-load event",
        );
    }

    #[test]
    fn parse_host_env_file_rejects_malformed_lines() {
        let err = parse_host_env_file("VM0_RUNNER_CONCURRENCY_FACTOR\n")
            .unwrap_err()
            .to_string();

        assert!(err.contains("expected KEY=VALUE"));
    }
}
