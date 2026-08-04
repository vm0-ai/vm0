//! Secret-bearing string primitives with redacted formatting.

use std::fmt;

/// Owned secret text that never exposes its value through `Debug` or `Display`.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretString(String);

impl SecretString {
    /// Wrap secret text.
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretString([REDACTED])")
    }
}

/// Replace exact secret values before untrusted text crosses an error boundary.
#[must_use]
pub fn redact_secrets(text: &str, secrets: &[&SecretString]) -> String {
    secrets.iter().fold(text.to_string(), |redacted, secret| {
        if secret.expose().is_empty() {
            redacted
        } else {
            redacted.replace(secret.expose(), "[REDACTED]")
        }
    })
}
