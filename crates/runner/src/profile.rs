use crate::error::{RunnerError, RunnerResult};

/// A platform-defined profile specifying VM resources.
pub struct ProfileDef {
    /// Number of vCPUs for VMs using this profile.
    pub vcpu: u32,
    /// Memory in MiB for VMs using this profile.
    pub memory_mb: u32,
    /// Disk size in MiB for VMs using this profile.
    pub disk_mb: u32,
}

pub const DEFAULT_PROFILE: &str = "vm0/default";

/// Return the profile definition for a given profile name.
pub fn get(name: &str) -> RunnerResult<&'static ProfileDef> {
    static DEFAULT: ProfileDef = ProfileDef {
        vcpu: 2,
        memory_mb: 4096,
        disk_mb: 16384,
    };

    match name {
        "vm0/default" => Ok(&DEFAULT),
        _ => Err(RunnerError::Config(format!(
            "unknown profile: {name}. available profiles: vm0/default"
        ))),
    }
}

/// Validate that a profile name follows the `org/name` format.
/// Each part must be lowercase alphanumeric + hyphens.
pub fn validate_name(name: &str) -> bool {
    let Some((org, profile_name)) = name.split_once('/') else {
        return false;
    };
    if org.is_empty() || profile_name.is_empty() {
        return false;
    }
    // No additional slashes
    if profile_name.contains('/') {
        return false;
    }
    let valid_part = |s: &str| {
        s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && !s.starts_with('-')
            && !s.ends_with('-')
    };
    valid_part(org) && valid_part(profile_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_default_profile() {
        let def = get("vm0/default").unwrap();
        assert_eq!(def.vcpu, 2);
        assert_eq!(def.memory_mb, 4096);
        assert_eq!(def.disk_mb, 16384);
    }

    #[test]
    fn get_unknown_profile_fails() {
        assert!(get("unknown").is_err());
    }

    #[test]
    fn validate_name_valid() {
        assert!(validate_name("vm0/default"));
        assert!(validate_name("my-org/data-science"));
        assert!(validate_name("acme/my-profile-123"));
    }

    #[test]
    fn validate_name_invalid() {
        assert!(!validate_name("default")); // no org
        assert!(!validate_name("/default")); // empty org
        assert!(!validate_name("vm0/")); // empty name
        assert!(!validate_name("vm0/my/nested")); // extra slash
        assert!(!validate_name("VM0/default")); // uppercase
        assert!(!validate_name("vm0/Default")); // uppercase
        assert!(!validate_name("-vm0/default")); // leading hyphen
        assert!(!validate_name("vm0/default-")); // trailing hyphen
        assert!(!validate_name("vm0/def ault")); // space
    }
}
