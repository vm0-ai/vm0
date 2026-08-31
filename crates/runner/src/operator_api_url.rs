use std::ffi::OsStr;

pub(crate) const CANONICAL_ENV: &str = guest_contracts::env::CANONICAL_API_URL_ENV;
pub(crate) const LEGACY_ENV: &str = guest_contracts::env::API_URL_ENV;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EnvironmentAliasState {
    Absent,
    CanonicalOnly,
    LegacyOnly,
    EqualDual,
    ConflictingDual,
}

impl EnvironmentAliasState {
    fn label(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::CanonicalOnly => "canonical_only",
            Self::LegacyOnly => "legacy_only",
            Self::EqualDual => "equal_dual",
            Self::ConflictingDual => "conflicting_dual",
        }
    }
}

fn classify_environment_aliases(
    canonical: Option<&OsStr>,
    legacy: Option<&OsStr>,
) -> EnvironmentAliasState {
    match (canonical, legacy) {
        (None, None) => EnvironmentAliasState::Absent,
        (Some(_), None) => EnvironmentAliasState::CanonicalOnly,
        (None, Some(_)) => EnvironmentAliasState::LegacyOnly,
        (Some(canonical), Some(legacy)) if canonical == legacy => EnvironmentAliasState::EqualDual,
        (Some(_), Some(_)) => EnvironmentAliasState::ConflictingDual,
    }
}

fn environment_alias_state() -> EnvironmentAliasState {
    let canonical = std::env::var_os(CANONICAL_ENV);
    let legacy = std::env::var_os(LEGACY_ENV);
    classify_environment_aliases(canonical.as_deref(), legacy.as_deref())
}

pub(crate) fn environment_alias_state_label() -> &'static str {
    environment_alias_state().label()
}

/// Select the Runner operator environment source that Clap binds to `--api-url`.
///
/// The spellings are shared with the Runner-to-Guest contract, but this reader
/// has an independent rollout floor. External operator configuration keeps the
/// legacy alias through the deployed Runner reader floor and supported rollback
/// window. Remove it after the checked-in and supported external input inventory
/// proves there is no legacy-only use; #28914 tracks that gate.
pub(crate) fn clap_environment_name() -> &'static str {
    if std::env::var_os(CANONICAL_ENV).is_none() && std::env::var_os(LEGACY_ENV).is_some() {
        LEGACY_ENV
    } else {
        CANONICAL_ENV
    }
}

pub(crate) fn environment_aliases_conflict() -> bool {
    environment_alias_state() == EnvironmentAliasState::ConflictingDual
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_complete_environment_alias_matrix() {
        let canonical = OsStr::new("canonical");
        let legacy = OsStr::new("legacy");
        let equal = OsStr::new("equal");

        for (canonical, legacy, expected) in [
            (None, None, EnvironmentAliasState::Absent),
            (Some(canonical), None, EnvironmentAliasState::CanonicalOnly),
            (None, Some(legacy), EnvironmentAliasState::LegacyOnly),
            (Some(equal), Some(equal), EnvironmentAliasState::EqualDual),
            (
                Some(canonical),
                Some(legacy),
                EnvironmentAliasState::ConflictingDual,
            ),
        ] {
            assert_eq!(classify_environment_aliases(canonical, legacy), expected);
        }

        assert_eq!(EnvironmentAliasState::Absent.label(), "absent");
        assert_eq!(
            EnvironmentAliasState::CanonicalOnly.label(),
            "canonical_only"
        );
        assert_eq!(EnvironmentAliasState::LegacyOnly.label(), "legacy_only");
        assert_eq!(EnvironmentAliasState::EqualDual.label(), "equal_dual");
        assert_eq!(
            EnvironmentAliasState::ConflictingDual.label(),
            "conflicting_dual"
        );
    }
}
