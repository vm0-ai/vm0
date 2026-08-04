//! Decoding for run-scoped `ZERO_TOKEN` visibility context.

use std::collections::BTreeMap;
use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use serde::Deserialize;

use crate::secret::SecretString;

const ZERO_TOKEN_PREFIX: &str = "vm0_sandbox_";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawZeroTokenPayload {
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    org_id: Option<String>,
    scope: String,
    capabilities: Vec<String>,
    #[serde(default)]
    feature_switch_overrides: BTreeMap<String, bool>,
    #[serde(default)]
    iat: Option<i64>,
    #[serde(default)]
    exp: Option<i64>,
}

/// Unverified claims decoded from a valid run-scoped Zero token.
///
/// Signature verification remains server-owned. This type supplies only the
/// local capability, feature-visibility, and sandbox context used before an
/// authenticated API call.
#[derive(Clone, PartialEq, Eq)]
pub struct ZeroTokenPayload {
    user_id: Option<String>,
    run_id: Option<String>,
    org_id: Option<String>,
    capabilities: Vec<String>,
    feature_switch_overrides: BTreeMap<String, bool>,
    issued_at: Option<i64>,
    expires_at: Option<i64>,
}

impl ZeroTokenPayload {
    /// Decode a `vm0_sandbox_` token without verifying its signature.
    ///
    /// Missing, malformed, or non-Zero tokens return `None`, matching the npm
    /// CLI visibility behavior.
    #[must_use]
    pub fn decode(token: &SecretString) -> Option<Self> {
        let jwt = token.expose().strip_prefix(ZERO_TOKEN_PREFIX)?;
        let mut parts = jwt.split('.');
        let _header = parts.next()?;
        let payload = parts.next()?;
        let _signature = parts.next()?;
        if parts.next().is_some() {
            return None;
        }

        let payload_bytes = URL_SAFE_NO_PAD
            .decode(payload)
            .or_else(|_| URL_SAFE.decode(payload))
            .ok()?;
        let raw: RawZeroTokenPayload = serde_json::from_slice(&payload_bytes).ok()?;
        if raw.scope != "zero" {
            return None;
        }

        Some(Self {
            user_id: raw.user_id,
            run_id: raw.run_id,
            org_id: raw.org_id,
            capabilities: raw.capabilities,
            feature_switch_overrides: raw.feature_switch_overrides,
            issued_at: raw.iat,
            expires_at: raw.exp,
        })
    }

    /// User identity carried by the token, when present.
    #[must_use]
    pub fn user_id(&self) -> Option<&str> {
        self.user_id.as_deref()
    }

    /// Run identity carried by the token, when present.
    #[must_use]
    pub fn run_id(&self) -> Option<&str> {
        self.run_id.as_deref()
    }

    /// Organization identity carried by the token, when present.
    #[must_use]
    pub fn org_id(&self) -> Option<&str> {
        self.org_id.as_deref()
    }

    /// Capability strings used to decide native command visibility.
    #[must_use]
    pub fn capabilities(&self) -> &[String] {
        &self.capabilities
    }

    /// Return whether the token carries one capability.
    #[must_use]
    pub fn has_capability(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|value| value == capability)
    }

    /// Return a token-provided feature switch override, when present.
    #[must_use]
    pub fn feature_switch_override(&self, key: &str) -> Option<bool> {
        self.feature_switch_overrides.get(key).copied()
    }

    /// Issued-at timestamp carried by the token, when present.
    #[must_use]
    pub const fn issued_at(&self) -> Option<i64> {
        self.issued_at
    }

    /// Expiration timestamp carried by the token, when present.
    #[must_use]
    pub const fn expires_at(&self) -> Option<i64> {
        self.expires_at
    }
}

impl fmt::Debug for ZeroTokenPayload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ZeroTokenPayload")
            .field("has_user_id", &self.user_id.is_some())
            .field("has_run_id", &self.run_id.is_some())
            .field("has_org_id", &self.org_id.is_some())
            .field("capability_count", &self.capabilities.len())
            .field(
                "feature_switch_override_count",
                &self.feature_switch_overrides.len(),
            )
            .field("issued_at", &self.issued_at)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}
