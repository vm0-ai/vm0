pub(crate) const CANONICAL_ENV: &str = "OKOU_RUNNER_TOKEN";
pub(crate) const LEGACY_ENV: &str = "VM0_RUNNER_TOKEN";

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
    std::env::var_os(CANONICAL_ENV).is_some() && std::env::var_os(LEGACY_ENV).is_some()
}
