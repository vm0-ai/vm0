//! Validation for runner directory names.
//!
//! Runner directory names are joined against `HomePaths::runners_dir()`
//! to form on-disk paths (`/var/lib/vm0-runner/runners/<name>/`), so any
//! input containing `..`, `/`, `\`, or a leading `.` could escape the
//! intended directory. This module is the single source of truth for
//! what counts as a safe runner directory name.
//!
//! Unlike `group` and `profile`, runner directory names are not persisted
//! in `runner.yaml` (only the resolved `RunnerConfig.base_dir: PathBuf`
//! is). Validation therefore happens once at the CLI boundary in
//! `runner config`; there is no config-load checkpoint to mirror.
//!
//! No matching server-side schema exists — runner directory names are
//! purely a runner-local concern.

use crate::error::{RunnerError, RunnerResult};

/// Validate `name` and return a `RunnerError::Config` with a uniform
/// message if it fails. Use this at every callsite that takes a runner
/// directory name from the user (currently only the `--runner-dirname`
/// flag of `runner config`) so the error wording stays consistent.
pub fn validate_or_err(name: &str) -> RunnerResult<()> {
    if !validate_name(name) {
        return Err(RunnerError::Config(format!(
            "invalid runner-dirname: {name} (must be a single path segment of \
             lowercase alphanumeric, hyphens, and dots; cannot start with `.` or `-`)"
        )));
    }
    Ok(())
}

/// Validate that `name` is a safe single-segment directory name.
///
/// Accepts `[a-z0-9.-]+` with these guards:
/// - non-empty
/// - not `.` or `..` (relative-path tokens)
/// - does not start with `.` (avoids hidden files / traversal anchors)
/// - does not start with `-` (avoids being parsed as a flag downstream)
///
/// Implicitly rejects `/` and `\` (not in charset). The dot allowance
/// exists for production semver dirnames produced by
/// `ansible/playbooks/deploy-runner.yml` (e.g. `v0.3.0`).
fn validate_name(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." {
        return false;
    }
    if name.starts_with('.') || name.starts_with('-') {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_name_accepts_real_world_values() {
        // All values currently in use across ansible/scripts/CI.
        assert!(validate_name("v0.3.0")); // ansible production semver
        assert!(validate_name("v1.10.1"));
        assert!(validate_name("local-alice-macbook")); // dev-runner.sh
        assert!(validate_name("alice-macbook"));
        assert!(validate_name("pr-1234-test")); // CI workflows
        assert!(validate_name("pr-1234-bench"));
        assert!(validate_name("staging-test"));
        assert!(validate_name("staging-test-balloon"));
        assert!(validate_name("a")); // minimal
    }

    #[test]
    fn validate_name_rejects_empty_and_special_segments() {
        assert!(!validate_name(""));
        assert!(!validate_name("."));
        assert!(!validate_name(".."));
    }

    #[test]
    fn validate_name_rejects_leading_dot_or_hyphen() {
        assert!(!validate_name(".hidden"));
        assert!(!validate_name(".env"));
        assert!(!validate_name("-flag"));
        assert!(!validate_name("-v0.3.0"));
    }

    #[test]
    fn validate_name_rejects_invalid_chars() {
        assert!(!validate_name("V0.3.0")); // uppercase
        assert!(!validate_name("v0.3.0_dev")); // underscore
        assert!(!validate_name("v0 3 0")); // space
        assert!(!validate_name("v0.3.0!")); // punctuation
    }

    #[test]
    fn validate_name_rejects_path_traversal() {
        // The security-relevant cases the validator exists to block.
        assert!(!validate_name("/etc"));
        assert!(!validate_name("/etc/passwd"));
        assert!(!validate_name("../etc"));
        assert!(!validate_name("../../tmp"));
        assert!(!validate_name("foo/bar"));
        assert!(!validate_name(r"foo\bar"));
    }

    #[test]
    fn validate_or_err_passes_for_valid_name() {
        assert!(validate_or_err("v0.3.0").is_ok());
    }

    #[test]
    fn validate_or_err_carries_offending_name_in_message() {
        let err = validate_or_err("/etc").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("invalid runner-dirname"), "got: {msg}");
        assert!(msg.contains("/etc"), "got: {msg}");
    }
}
