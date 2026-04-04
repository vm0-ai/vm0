//! Secret masking for event payloads.
//!
//! Reads `VM0_SECRET_VALUES` (base64-encoded JSON array), pre-computes
//! plain / base64 / URL-encoded variants, and replaces matches in
//! `serde_json::Value` trees with `"***"`.

use crate::env;
use base64::Engine;
use serde_json::Value;

/// Minimum secret length to avoid false-positive masking.
const MIN_SECRET_LEN: usize = 5;

/// Holds pre-computed secret patterns for efficient masking.
pub struct SecretMasker {
    patterns: Vec<String>,
}

impl SecretMasker {
    /// Build a masker from the `VM0_SECRET_VALUES` environment variable.
    pub fn from_env() -> Self {
        Self::from_raw(env::secret_values())
    }

    /// Build a masker from a raw comma-separated base64-encoded secret string.
    ///
    /// For each secret ≥ 5 chars, three variants are stored:
    /// plain, base64-encoded, and percent-encoded.
    pub fn from_raw(raw: &str) -> Self {
        if raw.is_empty() {
            return Self {
                patterns: Vec::new(),
            };
        }

        // Parse comma-separated base64 values
        let engine = base64::engine::general_purpose::STANDARD;
        let secrets: Vec<String> = raw
            .split(',')
            .filter_map(|part| {
                let trimmed = part.trim();
                if trimmed.is_empty() {
                    return None;
                }
                engine
                    .decode(trimmed)
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok())
            })
            .filter(|s| !s.is_empty())
            .collect();

        let mut patterns = Vec::new();
        for secret in &secrets {
            if secret.len() < MIN_SECRET_LEN {
                continue;
            }
            // Plain
            patterns.push(secret.clone());
            // Base64-encoded
            let b64 = base64::engine::general_purpose::STANDARD.encode(secret);
            patterns.push(b64);
            // URL-encoded (percent-encode)
            let url_encoded = url_encode(secret);
            if url_encoded != *secret {
                patterns.push(url_encoded);
            }
        }

        Self { patterns }
    }

    /// Recursively mask secrets in a JSON value tree (in-place).
    pub fn mask_value(&self, val: &mut Value) {
        if self.patterns.is_empty() {
            return;
        }
        match val {
            Value::String(s) => {
                *s = self.mask_string(s);
            }
            Value::Array(arr) => {
                for item in arr {
                    self.mask_value(item);
                }
            }
            Value::Object(map) => {
                for v in map.values_mut() {
                    self.mask_value(v);
                }
            }
            _ => {}
        }
    }

    /// Replace all secret patterns in a string with `***`.
    pub fn mask_string(&self, s: &str) -> String {
        let mut result = s.to_string();
        for pattern in &self.patterns {
            result = result.replace(pattern.as_str(), "***");
        }
        result
    }
}

/// Percent-encode a string matching JS `encodeURIComponent` behavior.
///
/// Unescaped set per ECMAScript spec (uriUnescaped):
///   A-Z a-z 0-9 - _ . ! ~ * ' ( )
///
/// See: https://tc39.es/ecma262/#sec-encodeuricomponent-uricomponent
fn url_encode(s: &str) -> String {
    let mut encoded = String::with_capacity(s.len() * 3);
    // Rust &str is valid UTF-8, so iterating bytes and percent-encoding
    // non-unescaped bytes is equivalent to the spec's UTF-8 encode + escape.
    for byte in s.bytes() {
        match byte {
            // uriUnescaped: uriAlpha | DecimalDigit | uriMark
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push('%');
                encoded.push(hex_digit(byte >> 4));
                encoded.push(hex_digit(byte & 0x0f));
            }
        }
    }
    encoded
}

fn hex_digit(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        _ => (b'A' + n - 10) as char,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_masker_is_noop() {
        let masker = SecretMasker {
            patterns: Vec::new(),
        };
        let mut val = json!({"key": "value"});
        masker.mask_value(&mut val);
        assert_eq!(val, json!({"key": "value"}));
    }

    #[test]
    fn masks_plain_secret() {
        let masker = SecretMasker {
            patterns: vec!["my-secret-token".to_string()],
        };
        let result = masker.mask_string("Bearer my-secret-token here");
        assert_eq!(result, "Bearer *** here");
    }

    #[test]
    fn masks_nested_json() {
        let masker = SecretMasker {
            patterns: vec!["secret123".to_string()],
        };
        let mut val = json!({
            "outer": {
                "inner": "has secret123 inside"
            },
            "list": ["no match", "secret123"]
        });
        masker.mask_value(&mut val);
        assert_eq!(val["outer"]["inner"], "has *** inside");
        assert_eq!(val["list"][1], "***");
    }

    #[test]
    fn from_raw_with_encoded_secrets() {
        // Build comma-separated base64-encoded secrets (matching TS format)
        let engine = base64::engine::general_purpose::STANDARD;
        let s1 = engine.encode("hello-world-secret");
        let s2 = engine.encode("tiny");
        let encoded = format!("{s1},{s2}");

        let masker = SecretMasker::from_raw(&encoded);
        // "tiny" is < 5 chars, should be excluded
        // "hello-world-secret" should have 2-3 patterns (plain + base64 + url if different)
        assert!(!masker.patterns.is_empty());
        assert!(masker.patterns.contains(&"hello-world-secret".to_string()));
        // "tiny" excluded
        assert!(!masker.patterns.contains(&"tiny".to_string()));
    }

    #[test]
    fn url_encode_special_chars() {
        assert_eq!(url_encode("hello world"), "hello%20world");
        assert_eq!(url_encode("a+b=c"), "a%2Bb%3Dc");
    }

    #[test]
    fn from_raw_empty_string() {
        let masker = SecretMasker::from_raw("");
        assert!(masker.patterns.is_empty());
    }

    #[test]
    fn from_raw_invalid_base64() {
        let masker = SecretMasker::from_raw("not-valid-b64!!!");
        assert!(masker.patterns.is_empty());
    }

    #[test]
    fn from_raw_skips_short_secrets() {
        let engine = base64::engine::general_purpose::STANDARD;
        let short = engine.encode("abcd"); // 4 chars < MIN_SECRET_LEN
        let masker = SecretMasker::from_raw(&short);
        assert!(masker.patterns.is_empty());
    }

    #[test]
    fn from_raw_includes_url_encoded_variant() {
        let engine = base64::engine::general_purpose::STANDARD;
        // Secret with special chars that need URL encoding
        let secret = "key=value&token=abc123";
        let encoded = engine.encode(secret);
        let masker = SecretMasker::from_raw(&encoded);
        // Should contain plain, base64, and url-encoded variants
        assert!(masker.patterns.contains(&secret.to_string()));
        assert!(masker.patterns.contains(&encoded));
        let url = url_encode(secret);
        assert!(masker.patterns.contains(&url));
    }

    #[test]
    fn from_raw_no_url_variant_when_same() {
        let engine = base64::engine::general_purpose::STANDARD;
        // Secret with only unreserved chars — url_encode returns same string
        let secret = "simple-secret";
        let encoded = engine.encode(secret);
        let masker = SecretMasker::from_raw(&encoded);
        // Should only have plain + base64 (no duplicate url variant)
        assert_eq!(masker.patterns.len(), 2);
    }

    #[test]
    fn mask_value_mixed_json_tree() {
        let masker = SecretMasker {
            patterns: vec!["secret".to_string()],
        };
        let mut val = json!({
            "token": "my secret key",
            "num": 42,
            "bool": true,
            "null": null,
            "list": ["no match", "has secret here"],
            "nested": {"deep": "another secret value"}
        });
        masker.mask_value(&mut val);
        // Strings containing "secret" are masked
        assert_eq!(val["token"], "my *** key");
        assert_eq!(val["list"][1], "has *** here");
        assert_eq!(val["nested"]["deep"], "another *** value");
        // Non-string types and non-matching strings are untouched
        assert_eq!(val["num"], 42);
        assert_eq!(val["bool"], true);
        assert!(val["null"].is_null());
        assert_eq!(val["list"][0], "no match");
    }

    #[test]
    fn mask_string_multiple_occurrences() {
        let masker = SecretMasker {
            patterns: vec!["token".to_string()],
        };
        let result = masker.mask_string("token and token again");
        assert_eq!(result, "*** and *** again");
    }

    #[test]
    fn url_encode_preserves_unreserved() {
        // All unreserved chars per ECMAScript spec
        let unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";
        assert_eq!(url_encode(unreserved), unreserved);
    }

    #[test]
    fn url_encode_encodes_slash_and_at() {
        assert_eq!(url_encode("/"), "%2F");
        assert_eq!(url_encode("@"), "%40");
    }

    #[test]
    fn hex_digit_all_values() {
        for n in 0..=15u8 {
            let c = hex_digit(n);
            let expected = format!("{n:X}").chars().next().unwrap();
            assert_eq!(c, expected, "hex_digit({n})");
        }
    }
}
