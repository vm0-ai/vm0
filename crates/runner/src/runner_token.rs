pub(crate) const CANONICAL_ENV: &str = "OKOU_RUNNER_TOKEN";
pub(crate) const LEGACY_ENV: &str = "VM0_RUNNER_TOKEN";

/// Select the one environment source that Clap binds to the sensitive token
/// argument. The legacy alias is retained only for the Stage 1 migration
/// window tracked by #28921.
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
