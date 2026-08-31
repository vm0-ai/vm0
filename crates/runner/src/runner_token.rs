pub(crate) const CANONICAL_ENV: &str = "OKOU_RUNNER_TOKEN";
pub(crate) const LEGACY_ENV: &str = "VM0_RUNNER_TOKEN";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EnvironmentAliasState {
    Absent,
    CanonicalOnly,
    LegacyOnly,
    DualPresent,
}

impl EnvironmentAliasState {
    fn label(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::CanonicalOnly => "canonical_only",
            Self::LegacyOnly => "legacy_only",
            Self::DualPresent => "dual_present",
        }
    }
}

fn classify_environment_alias_presence(
    canonical_present: bool,
    legacy_present: bool,
) -> EnvironmentAliasState {
    // Token bytes must never cross this telemetry boundary; classify presence only.
    match (canonical_present, legacy_present) {
        (false, false) => EnvironmentAliasState::Absent,
        (true, false) => EnvironmentAliasState::CanonicalOnly,
        (false, true) => EnvironmentAliasState::LegacyOnly,
        (true, true) => EnvironmentAliasState::DualPresent,
    }
}

fn environment_alias_state() -> EnvironmentAliasState {
    classify_environment_alias_presence(
        std::env::var_os(CANONICAL_ENV).is_some(),
        std::env::var_os(LEGACY_ENV).is_some(),
    )
}

pub(crate) fn environment_alias_state_label() -> &'static str {
    environment_alias_state().label()
}

/// Select the one environment source that Clap binds to the sensitive token
/// argument. This is Stage 1 compatibility for runner process configuration.
/// Remove the legacy alias only after #28914 moves CI and external secret
/// injection to the canonical name and observes zero legacy-only use through
/// the supported rollback window.
pub(crate) fn clap_environment_name() -> &'static str {
    if std::env::var_os(CANONICAL_ENV).is_none() && std::env::var_os(LEGACY_ENV).is_some() {
        LEGACY_ENV
    } else {
        CANONICAL_ENV
    }
}

pub(crate) fn environment_aliases_conflict() -> bool {
    environment_alias_state() == EnvironmentAliasState::DualPresent
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_complete_presence_only_matrix() {
        for (canonical_present, legacy_present, expected, label) in [
            (false, false, EnvironmentAliasState::Absent, "absent"),
            (
                true,
                false,
                EnvironmentAliasState::CanonicalOnly,
                "canonical_only",
            ),
            (
                false,
                true,
                EnvironmentAliasState::LegacyOnly,
                "legacy_only",
            ),
            (
                true,
                true,
                EnvironmentAliasState::DualPresent,
                "dual_present",
            ),
        ] {
            let state = classify_environment_alias_presence(canonical_present, legacy_present);
            assert_eq!(state, expected);
            assert_eq!(state.label(), label);
        }
    }
}
