use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Runner-owned namespace for reusable sandbox state.
///
/// API scope values originate from `agent_runs.session_id`. `Local` is an
/// internal trust marker and cannot be selected through API JSON.
#[derive(Clone, Copy, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum SandboxReuseScope {
    Api { id: Uuid },
    Local,
}

impl fmt::Debug for SandboxReuseScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Api { .. } => f.write_str("Api"),
            Self::Local => f.write_str("Local"),
        }
    }
}

impl SandboxReuseScope {
    pub(crate) fn api(raw: &str) -> Option<Self> {
        Uuid::parse_str(raw).ok().map(|id| Self::Api { id })
    }

    pub(crate) const fn local() -> Self {
        Self::Local
    }

    pub(crate) fn api_wire_value(self) -> Option<String> {
        match self {
            Self::Api { id } => Some(id.to_string()),
            Self::Local => None,
        }
    }

    pub(crate) fn cache_key_namespace(self) -> String {
        match self {
            Self::Api { id } => format!("api:{id}"),
            Self::Local => "local".to_string(),
        }
    }

    pub(crate) fn with_cli_agent_session_id(
        self,
        cli_agent_session_id: impl Into<String>,
    ) -> Option<SandboxReuseIdentity> {
        let cli_agent_session_id = cli_agent_session_id.into();
        if cli_agent_session_id.is_empty() {
            return None;
        }
        Some(SandboxReuseIdentity {
            scope: self,
            cli_agent_session_id,
        })
    }
}

/// Complete authorization identity for idle VM and workspace-cache reuse.
#[derive(Clone, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) struct SandboxReuseIdentity {
    scope: SandboxReuseScope,
    cli_agent_session_id: String,
}

impl SandboxReuseIdentity {
    pub(crate) fn scope(&self) -> SandboxReuseScope {
        self.scope
    }

    pub(crate) fn cli_agent_session_id(&self) -> &str {
        &self.cli_agent_session_id
    }

    pub(crate) fn api_scope_wire_value(&self) -> Option<String> {
        self.scope.api_wire_value()
    }

    pub(crate) fn diagnostic_fingerprint(&self) -> String {
        let scope = match self.scope {
            SandboxReuseScope::Api { id } => format!("api:{id}"),
            SandboxReuseScope::Local => "local".to_string(),
        };
        crate::paths::short_digest(&format!("{scope}\0{}", self.cli_agent_session_id))
    }
}

impl fmt::Debug for SandboxReuseIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SandboxReuseIdentity")
            .field("fingerprint", &self.diagnostic_fingerprint())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_identity_requires_valid_scope_and_non_empty_cli_id() {
        let scope = SandboxReuseScope::api("01980a13-532f-7000-8000-000000000001").unwrap();
        assert!(scope.with_cli_agent_session_id("session-1").is_some());
        assert!(scope.with_cli_agent_session_id("").is_none());
        assert!(SandboxReuseScope::api("not-a-uuid").is_none());
    }

    #[test]
    fn equal_cli_ids_in_different_scopes_are_distinct() {
        let first = SandboxReuseScope::api("01980a13-532f-7000-8000-000000000001")
            .unwrap()
            .with_cli_agent_session_id("shared-session")
            .unwrap();
        let second = SandboxReuseScope::api("01980a13-532f-7000-8000-000000000002")
            .unwrap()
            .with_cli_agent_session_id("shared-session")
            .unwrap();
        let local = SandboxReuseScope::local()
            .with_cli_agent_session_id("shared-session")
            .unwrap();

        assert_ne!(first, second);
        assert_ne!(first, local);
        assert_ne!(second, local);
    }

    #[test]
    fn local_scope_stays_internal_and_diagnostics_hide_raw_identity() {
        let raw_api_scope = "01980a13-532f-7000-8000-000000000001";
        let cli_agent_session_id = "sensitive-cli-session";
        let api_scope = SandboxReuseScope::api(raw_api_scope).unwrap();
        let local_scope = SandboxReuseScope::local();
        let api_identity = api_scope
            .with_cli_agent_session_id(cli_agent_session_id)
            .unwrap();
        let local_identity = local_scope
            .with_cli_agent_session_id(cli_agent_session_id)
            .unwrap();

        assert_eq!(api_scope.api_wire_value().as_deref(), Some(raw_api_scope));
        assert_eq!(local_scope.api_wire_value(), None);
        assert_ne!(
            api_scope.cache_key_namespace(),
            local_scope.cache_key_namespace()
        );
        assert_eq!(format!("{api_scope:?}"), "Api");
        assert_eq!(format!("{local_scope:?}"), "Local");

        for diagnostic in [format!("{api_identity:?}"), format!("{local_identity:?}")] {
            assert!(!diagnostic.contains(raw_api_scope));
            assert!(!diagnostic.contains(cli_agent_session_id));
        }
    }
}
