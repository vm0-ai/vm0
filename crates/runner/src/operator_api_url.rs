pub(crate) const CANONICAL_ENV: &str = guest_contracts::env::CANONICAL_API_URL_ENV;
pub(crate) const LEGACY_ENV: &str = guest_contracts::env::API_URL_ENV;

/// Select the Runner operator environment source that Clap binds to `--api-url`.
///
/// The spellings are shared with the Runner-to-Guest contract, but this reader
/// has an independent rollout floor. External operator configuration keeps the
/// legacy alias until #28914 separately proves it can be removed.
pub(crate) fn clap_environment_name() -> &'static str {
    if std::env::var_os(CANONICAL_ENV).is_none() && std::env::var_os(LEGACY_ENV).is_some() {
        LEGACY_ENV
    } else {
        CANONICAL_ENV
    }
}

pub(crate) fn environment_aliases_conflict() -> bool {
    match (
        std::env::var_os(CANONICAL_ENV),
        std::env::var_os(LEGACY_ENV),
    ) {
        (Some(canonical), Some(legacy)) => canonical != legacy,
        _ => false,
    }
}
