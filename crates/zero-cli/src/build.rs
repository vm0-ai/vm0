//! Compile-time identity for the native CLI runtime.

/// Package and build identity attached to native API requests and diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuildInfo {
    /// Cargo package version for this bundled binary.
    pub version: &'static str,
    /// Build identifier supplied by the runner build, or a deterministic local fallback.
    pub build_id: &'static str,
}

impl BuildInfo {
    /// Return the identity compiled into this binary.
    #[must_use]
    pub const fn current() -> Self {
        const BUILD_ID: &str = match option_env!("ZERO_CLI_BUILD_ID") {
            Some(value) => value,
            None => concat!(env!("CARGO_PKG_NAME"), "@", env!("CARGO_PKG_VERSION")),
        };

        Self {
            version: env!("CARGO_PKG_VERSION"),
            build_id: BUILD_ID,
        }
    }
}
