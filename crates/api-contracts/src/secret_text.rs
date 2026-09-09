//! Bounded, non-Debug credential text for generated private response DTOs.

use serde::{Deserialize, Deserializer, de};
use zeroize::Zeroizing;

/// Credential text has one application-owned zeroizing allocation. It cannot
/// be cloned, serialized or printed through Debug. The limit matches Zod's
/// JavaScript UTF-16 string-length bound, without trimming secret whitespace.
pub struct SecretText<const MAX: usize>(Zeroizing<String>);

impl<const MAX: usize> SecretText<MAX> {
    /// Borrow only at the credential consumer boundary.
    pub fn expose(&self) -> &str {
        self.0.as_str()
    }
}

impl<'de, const MAX: usize> Deserialize<'de> for SecretText<MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor<const MAX: usize>;
        impl<const MAX: usize> de::Visitor<'_> for Visitor<MAX> {
            type Value = SecretText<MAX>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("bounded credential text")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                if value.is_empty() || value.encode_utf16().count() > MAX {
                    return Err(E::custom("credential text outside bounds"));
                }
                Ok(SecretText(Zeroizing::new(value.to_owned())))
            }

            fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
                let value = Zeroizing::new(value);
                if value.is_empty() || value.encode_utf16().count() > MAX {
                    return Err(E::custom("credential text outside bounds"));
                }
                Ok(SecretText(value))
            }
        }
        deserializer.deserialize_string(Visitor::<MAX>)
    }
}
