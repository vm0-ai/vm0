//! Host-local runner environment access.
//!
//! Keep this module at the raw process/file environment boundary. Runtime
//! parsing and validation live in `runtime_overrides`.

use crate::error::{RunnerError, RunnerResult};

pub(crate) const RUNNER_HOST_ENV_FILE: &str = "/etc/vm0-runner/host.env";
pub(crate) const RUNNER_CONCURRENCY_FACTOR_ENV: &str = "VM0_RUNNER_CONCURRENCY_FACTOR";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostEnvSource {
    ProcessEnv,
    HostFile,
}

impl HostEnvSource {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::ProcessEnv => RUNNER_CONCURRENCY_FACTOR_ENV,
            Self::HostFile => RUNNER_HOST_ENV_FILE,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HostEnvValue {
    pub(crate) value: String,
    pub(crate) source: HostEnvSource,
}

pub(crate) fn runner_concurrency_factor() -> RunnerResult<Option<HostEnvValue>> {
    let process_value = read_env_var(RUNNER_CONCURRENCY_FACTOR_ENV)?;
    let file_value = read_host_env_file_value(RUNNER_CONCURRENCY_FACTOR_ENV)?;

    if let Some(value) = process_value {
        return Ok(Some(HostEnvValue {
            value,
            source: HostEnvSource::ProcessEnv,
        }));
    }

    Ok(file_value)
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

fn read_host_env_file_value(name: &'static str) -> RunnerResult<Option<HostEnvValue>> {
    let content = match std::fs::read_to_string(RUNNER_HOST_ENV_FILE) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(RunnerError::Config(format!(
                "failed to read {RUNNER_HOST_ENV_FILE}: {e}"
            )));
        }
    };

    parse_host_env_file_value(&content, name)
}

fn parse_host_env_file_value(
    content: &str,
    name: &'static str,
) -> RunnerResult<Option<HostEnvValue>> {
    let mut value = None;

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
        if key != name {
            return Err(RunnerError::Config(format!(
                "{RUNNER_HOST_ENV_FILE}:{line_number}: unsupported host env key {key:?}; allowed key: {name}"
            )));
        }
        if value.is_some() {
            return Err(RunnerError::Config(format!(
                "{RUNNER_HOST_ENV_FILE}:{line_number}: duplicate host env key {name}"
            )));
        }

        value = Some(HostEnvValue {
            value: raw_value.trim().to_string(),
            source: HostEnvSource::HostFile,
        });
    }

    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_host_env_file_value_accepts_allowed_key_with_comments() {
        let value = parse_host_env_file_value(
            "\n# host-local runner overrides\nVM0_RUNNER_CONCURRENCY_FACTOR = 1.5\n",
            RUNNER_CONCURRENCY_FACTOR_ENV,
        )
        .unwrap()
        .unwrap();

        assert_eq!(
            value,
            HostEnvValue {
                value: "1.5".to_string(),
                source: HostEnvSource::HostFile,
            }
        );
    }

    #[test]
    fn parse_host_env_file_value_returns_none_for_empty_file() {
        let value =
            parse_host_env_file_value("\n# nothing enabled\n", RUNNER_CONCURRENCY_FACTOR_ENV)
                .unwrap();

        assert_eq!(value, None);
    }

    #[test]
    fn parse_host_env_file_value_rejects_unknown_keys() {
        let err = parse_host_env_file_value(
            "VM0_API_URL=https://example.test\n",
            RUNNER_CONCURRENCY_FACTOR_ENV,
        )
        .unwrap_err()
        .to_string();

        assert!(err.contains("unsupported host env key"));
        assert!(err.contains("VM0_API_URL"));
        assert!(err.contains(RUNNER_CONCURRENCY_FACTOR_ENV));
    }

    #[test]
    fn parse_host_env_file_value_rejects_duplicate_keys() {
        let err = parse_host_env_file_value(
            "VM0_RUNNER_CONCURRENCY_FACTOR=1.0\nVM0_RUNNER_CONCURRENCY_FACTOR=1.5\n",
            RUNNER_CONCURRENCY_FACTOR_ENV,
        )
        .unwrap_err()
        .to_string();

        assert!(err.contains("duplicate host env key"));
        assert!(err.contains(RUNNER_CONCURRENCY_FACTOR_ENV));
    }

    #[test]
    fn parse_host_env_file_value_rejects_malformed_lines() {
        let err = parse_host_env_file_value(
            "VM0_RUNNER_CONCURRENCY_FACTOR\n",
            RUNNER_CONCURRENCY_FACTOR_ENV,
        )
        .unwrap_err()
        .to_string();

        assert!(err.contains("expected KEY=VALUE"));
    }
}
