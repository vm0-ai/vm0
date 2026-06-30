use std::path::PathBuf;

use crate::error::{RunnerError, RunnerResult};

const UNIT_PREFIX: &str = "vm0-runner-";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RunnerServiceUnit {
    suffix: String,
    unit_name: String,
    service_name: String,
    unit_file_path: PathBuf,
}

impl RunnerServiceUnit {
    /// Build a validated runner systemd unit identity from the user-supplied suffix.
    ///
    /// Validates the suffix with [`crate::runner_dirname::validate_name`] so
    /// that runner directory names and service name suffixes follow the same
    /// rules (bounded length, lowercase alphanumeric, hyphens, dots; no
    /// leading `.` or `-`).
    pub(crate) fn from_suffix(suffix: &str) -> RunnerResult<Self> {
        if !crate::runner_dirname::validate_name(suffix) {
            let diagnostic = crate::runner_dirname::invalid_name_diagnostic(suffix);
            let rules = crate::runner_dirname::validation_rules();
            return Err(RunnerError::Config(format!(
                "invalid service name suffix {diagnostic}: {rules}"
            )));
        }

        let unit_name = format!("{UNIT_PREFIX}{suffix}");
        let service_name = format!("{unit_name}.service");
        let unit_file_path = PathBuf::from(format!("/etc/systemd/system/{service_name}"));
        Ok(Self {
            suffix: suffix.to_string(),
            unit_name,
            service_name,
            unit_file_path,
        })
    }

    pub(crate) fn suffix(&self) -> &str {
        &self.suffix
    }

    pub(crate) fn unit_name(&self) -> &str {
        &self.unit_name
    }

    pub(crate) fn service_name(&self) -> &str {
        &self.service_name
    }

    pub(crate) fn unit_file_path(&self) -> &std::path::Path {
        &self.unit_file_path
    }
}

pub(super) fn all_units_pattern() -> String {
    format!("{UNIT_PREFIX}*.service")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_name(suffix: &str) -> RunnerResult<String> {
        RunnerServiceUnit::from_suffix(suffix).map(|unit| unit.unit_name().to_string())
    }

    #[test]
    fn test_unit_name() {
        assert_eq!(unit_name("v0.2.0").unwrap(), "vm0-runner-v0.2.0");
        assert_eq!(unit_name("staging").unwrap(), "vm0-runner-staging");
        assert_eq!(
            unit_name("pr-1234-test").unwrap(),
            "vm0-runner-pr-1234-test"
        );
    }

    #[test]
    fn test_unit_name_accepts_max_length_suffix() {
        let suffix = "a".repeat(crate::runner_dirname::MAX_NAME_BYTES);
        assert_eq!(unit_name(&suffix).unwrap(), format!("vm0-runner-{suffix}"));
    }

    #[test]
    fn test_unit_name_rejects_invalid() {
        assert!(unit_name("").is_err());
        assert!(unit_name("../evil").is_err());
        assert!(unit_name("has space").is_err());
        assert!(unit_name("semi;colon").is_err());
        // Now aligned with runner_dirname: reject uppercase, underscore, leading dot/hyphen
        assert!(unit_name("V0.2.0").is_err());
        assert!(unit_name("my_name-1.0").is_err());
        assert!(unit_name(".hidden").is_err());
        assert!(unit_name("-flag").is_err());
    }

    #[test]
    fn test_unit_name_rejects_over_max_length_suffix() {
        let suffix = "a".repeat(crate::runner_dirname::MAX_NAME_BYTES + 1);
        let msg = unit_name(&suffix).unwrap_err().to_string();
        assert!(msg.contains("service name suffix"), "got: {msg}");
        assert!(
            msg.contains(&format!(
                "at most {} bytes",
                crate::runner_dirname::MAX_NAME_BYTES
            )),
            "got: {msg}"
        );
        assert!(
            msg.contains(&format!(
                "{} bytes",
                crate::runner_dirname::MAX_NAME_BYTES + 1
            )),
            "got: {msg}"
        );
        assert!(
            !msg.contains(&suffix),
            "overlong suffix should be previewed, not echoed in full: {msg}"
        );
    }

    /// Guard against someone replacing the call with `validate_or_err`
    /// which would surface a "runner-dirname" message in a service context.
    #[test]
    fn test_unit_name_error_mentions_service() {
        let msg = unit_name("UPPER").unwrap_err().to_string();
        assert!(msg.contains("service name suffix"), "got: {msg}");
    }
}
