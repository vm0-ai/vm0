//! Validation for runner group names.
//!
//! Group names follow the `org/name` convention (e.g. `vm0/prod`,
//! `acme/staging`). They are joined against `HomePaths::groups_dir()`
//! to form on-disk paths, so any input containing `..`, leading `/`,
//! or extra `/` could escape the intended directory. This module is
//! the single source of truth for what counts as a safe group name.
//!
//! Mirrors the server-side Zod contract `runnerGroupSchema` in
//! `turbo/packages/core/src/contracts/runners.ts`:
//!   `/^[a-z0-9-]+\/[a-z0-9-]+$/`
//! Keep the two in sync.

use crate::error::{RunnerError, RunnerResult};

/// Validate `name` and return a `RunnerError::Config` with a uniform
/// message if it fails. Use this at every callsite that takes a group
/// name from the user (CLI flags, YAML config) so the error wording
/// stays consistent.
pub fn validate_or_err(name: &str) -> RunnerResult<()> {
    if !validate_name(name) {
        return Err(RunnerError::Config(format!(
            "invalid group name: {name} (must be org/name format, lowercase alphanumeric + hyphens)"
        )));
    }
    Ok(())
}

/// Validate that a group name follows the `org/name` format.
/// Each part must be non-empty lowercase alphanumeric + hyphens.
fn validate_name(name: &str) -> bool {
    let Some((org, group_name)) = name.split_once('/') else {
        return false;
    };
    if org.is_empty() || group_name.is_empty() {
        return false;
    }
    // No additional slashes
    if group_name.contains('/') {
        return false;
    }
    let valid_part = |s: &str| {
        s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    };
    valid_part(org) && valid_part(group_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_name_valid() {
        assert!(validate_name("vm0/prod"));
        assert!(validate_name("test/group"));
        assert!(validate_name("acme/my-group-1"));
        // Mirrors TS regex `[a-z0-9-]+/[a-z0-9-]+` — leading/trailing hyphens
        // are accepted by the server contract, so we accept them here too.
        assert!(validate_name("-vm0/prod"));
        assert!(validate_name("vm0/prod-"));
    }

    #[test]
    fn validate_name_invalid_shape() {
        assert!(!validate_name("default")); // no org
        assert!(!validate_name("/default")); // empty org
        assert!(!validate_name("vm0/")); // empty name
        assert!(!validate_name("vm0/my/nested")); // extra slash
        assert!(!validate_name("")); // empty
    }

    #[test]
    fn validate_name_invalid_chars() {
        assert!(!validate_name("VM0/prod")); // uppercase
        assert!(!validate_name("vm0/Prod")); // uppercase
        assert!(!validate_name("vm0/pr od")); // space
        assert!(!validate_name("vm0/prod_1")); // underscore not allowed
    }

    #[test]
    fn validate_or_err_passes_for_valid_name() {
        assert!(validate_or_err("vm0/prod").is_ok());
    }

    #[test]
    fn validate_or_err_carries_offending_name_in_message() {
        let err = validate_or_err("/etc").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("invalid group name"), "got: {msg}");
        assert!(msg.contains("/etc"), "got: {msg}");
    }

    #[test]
    fn validate_name_rejects_path_traversal() {
        // These are the security-relevant cases the validator exists to block.
        assert!(!validate_name("..")); // bare relative
        assert!(!validate_name("../etc")); // traversal
        assert!(!validate_name("vm0/../etc")); // mid-traversal
        assert!(!validate_name("/etc")); // absolute path
        assert!(!validate_name("/etc/passwd")); // absolute, multi-segment
        assert!(!validate_name(".")); // current dir
        assert!(!validate_name("vm0/.")); // current-dir suffix
        assert!(!validate_name("vm0/..")); // parent-dir suffix
        assert!(!validate_name(r"vm0\prod")); // backslash
    }
}
