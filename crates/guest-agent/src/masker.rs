//! Secret masking for event payloads.
//!
//! Reads `VM0_SECRET_VALUES` (base64-encoded JSON array), pre-computes
//! plain / base64 / URL-encoded variants, and replaces matches in
//! `serde_json::Value` trees with `"***"`.

use crate::env;
use aho_corasick::{AhoCorasick, MatchKind};
use base64::Engine;
use serde_json::Value;

/// Minimum secret length to avoid false-positive masking.
const MIN_SECRET_LEN: usize = 5;

/// Holds pre-computed secret patterns for efficient masking.
///
/// Uses Aho-Corasick with leftmost-longest match semantics so that when one
/// configured secret is a substring of another, the longer match wins and no
/// partial secret survives. See issue #9778.
pub struct SecretMasker {
    matcher: Option<Matcher>,
}

struct Matcher {
    ac: AhoCorasick,
    replacements: Vec<&'static str>,
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
            return Self::empty();
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

        Self::build(patterns)
    }

    fn empty() -> Self {
        Self { matcher: None }
    }

    /// # Panics
    /// Panics if the Aho-Corasick automaton fails to build. The only
    /// documented failure mode is pattern sets too large for the state-ID
    /// type (millions of patterns); user-configured secrets never approach
    /// that bound. A hard abort is preferred over silently degrading to a
    /// pass-through masker, which would leak every subsequent event payload.
    #[allow(clippy::expect_used)]
    fn build(patterns: Vec<String>) -> Self {
        if patterns.is_empty() {
            return Self::empty();
        }
        let ac = AhoCorasick::builder()
            .match_kind(MatchKind::LeftmostLongest)
            .build(&patterns)
            .expect("AhoCorasick build failed for secret pattern set");
        let replacements = vec!["***"; patterns.len()];
        Self {
            matcher: Some(Matcher { ac, replacements }),
        }
    }

    /// Recursively mask secrets in a JSON value tree (in-place).
    pub fn mask_value(&self, val: &mut Value) {
        if self.matcher.is_none() {
            return;
        }
        match val {
            Value::String(s) => {
                self.mask_string_in_place(s);
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
    ///
    /// Uses leftmost-longest matching semantics: at each position, the
    /// longest configured pattern wins, so a shorter secret that is a
    /// substring of a longer one cannot strip a byte off the longer match.
    pub fn mask_string(&self, s: &str) -> String {
        self.masked_string(s).unwrap_or_else(|| s.to_string())
    }

    pub(crate) fn mask_owned_string(&self, s: String) -> String {
        self.masked_string(&s).unwrap_or(s)
    }

    fn mask_string_in_place(&self, s: &mut String) -> bool {
        if let Some(masked) = self.masked_string(s) {
            *s = masked;
            true
        } else {
            false
        }
    }

    fn masked_string(&self, s: &str) -> Option<String> {
        let matcher = self.matcher.as_ref()?;
        if matcher.ac.is_match(s) {
            Some(matcher.ac.replace_all(s, &matcher.replacements))
        } else {
            None
        }
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

    fn masker_with(patterns: Vec<&str>) -> SecretMasker {
        SecretMasker::build(patterns.into_iter().map(String::from).collect())
    }

    #[test]
    fn empty_masker_is_noop() {
        let masker = SecretMasker::empty();
        let mut val = json!({"key": "value"});
        masker.mask_value(&mut val);
        assert_eq!(val, json!({"key": "value"}));
    }

    #[test]
    fn masks_plain_secret() {
        let masker = masker_with(vec!["my-secret-token"]);
        let result = masker.mask_string("Bearer my-secret-token here");
        assert_eq!(result, "Bearer *** here");
    }

    #[test]
    fn masks_nested_json() {
        let masker = masker_with(vec!["secret123"]);
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
    fn mask_string_in_place_preserves_unmatched_allocation() {
        let masker = masker_with(vec!["secret123"]);
        let mut value = String::from("ordinary event field");
        let original_ptr = value.as_ptr();
        let original_capacity = value.capacity();

        assert!(!masker.mask_string_in_place(&mut value));

        assert_eq!(value, "ordinary event field");
        assert_eq!(value.as_ptr(), original_ptr);
        assert_eq!(value.capacity(), original_capacity);
    }

    #[test]
    fn mask_string_in_place_masks_matched_string() {
        let masker = masker_with(vec!["secret123"]);
        let mut value = String::from("Bearer secret123");

        assert!(masker.mask_string_in_place(&mut value));

        assert_eq!(value, "Bearer ***");
    }

    #[test]
    fn mask_owned_string_preserves_unmatched_allocation() {
        let masker = masker_with(vec!["secret123"]);
        let value = String::from("ordinary stderr line");
        let original_ptr = value.as_ptr();
        let original_capacity = value.capacity();

        let masked = masker.mask_owned_string(value);

        assert_eq!(masked, "ordinary stderr line");
        assert_eq!(masked.as_ptr(), original_ptr);
        assert_eq!(masked.capacity(), original_capacity);
    }

    #[test]
    fn mask_owned_string_masks_matched_string() {
        let masker = masker_with(vec!["secret123"]);

        assert_eq!(
            masker.mask_owned_string("stderr has secret123".to_string()),
            "stderr has ***"
        );
    }

    #[test]
    fn from_raw_with_encoded_secrets() {
        // Build comma-separated base64-encoded secrets (matching TS format)
        let engine = base64::engine::general_purpose::STANDARD;
        let s1 = engine.encode("hello-world-secret");
        let s2 = engine.encode("tiny");
        let encoded = format!("{s1},{s2}");

        let masker = SecretMasker::from_raw(&encoded);
        // "hello-world-secret" is masked (all three variants)
        assert_eq!(masker.mask_string("hello-world-secret"), "***");
        assert_eq!(masker.mask_string(&s1), "***");
        // "tiny" is < 5 chars, not masked
        assert_eq!(masker.mask_string("tiny"), "tiny");
    }

    #[test]
    fn url_encode_special_chars() {
        assert_eq!(url_encode("hello world"), "hello%20world");
        assert_eq!(url_encode("a+b=c"), "a%2Bb%3Dc");
    }

    #[test]
    fn from_raw_empty_string() {
        let masker = SecretMasker::from_raw("");
        assert_eq!(masker.mask_string("anything"), "anything");
    }

    #[test]
    fn from_raw_invalid_base64() {
        let masker = SecretMasker::from_raw("not-valid-b64!!!");
        assert_eq!(masker.mask_string("anything"), "anything");
    }

    #[test]
    fn from_raw_skips_short_secrets() {
        let engine = base64::engine::general_purpose::STANDARD;
        let short = engine.encode("abcd"); // 4 chars < MIN_SECRET_LEN
        let masker = SecretMasker::from_raw(&short);
        assert_eq!(masker.mask_string("abcd"), "abcd");
    }

    #[test]
    fn from_raw_includes_url_encoded_variant() {
        let engine = base64::engine::general_purpose::STANDARD;
        // Secret with special chars that need URL encoding
        let secret = "key=value&token=abc123";
        let encoded = engine.encode(secret);
        let masker = SecretMasker::from_raw(&encoded);
        // Plain, base64, and url-encoded variants all mask
        assert_eq!(masker.mask_string(secret), "***");
        assert_eq!(masker.mask_string(&encoded), "***");
        assert_eq!(masker.mask_string(&url_encode(secret)), "***");
    }

    #[test]
    fn mask_value_mixed_json_tree() {
        let masker = masker_with(vec!["secret"]);
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
    fn mask_value_preserves_unmatched_string_allocation() {
        let masker = masker_with(vec!["secret123"]);
        let mut val = Value::String(String::from("ordinary event field"));
        let Value::String(value) = &val else {
            panic!("test value should be a string");
        };
        let original_ptr = value.as_ptr();
        let original_capacity = value.capacity();

        masker.mask_value(&mut val);

        let Value::String(value) = &val else {
            panic!("masked value should remain a string");
        };
        assert_eq!(value, "ordinary event field");
        assert_eq!(value.as_ptr(), original_ptr);
        assert_eq!(value.capacity(), original_capacity);
    }

    #[test]
    fn mask_string_multiple_occurrences() {
        let masker = masker_with(vec!["token"]);
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

    /// Aho-Corasick matches on bytes, but `from_raw` guarantees every pattern
    /// is valid UTF-8, so multi-byte codepoints must round-trip through
    /// masking without corruption.
    #[test]
    fn masks_multibyte_utf8_secret() {
        let engine = base64::engine::general_purpose::STANDARD;
        // Mix CJK + emoji — each codepoint is 3–4 bytes.
        let secret = "北京-🔑-token";
        let encoded = engine.encode(secret);
        let masker = SecretMasker::from_raw(&encoded);

        assert_eq!(
            masker.mask_string(&format!("prefix {secret} suffix")),
            "prefix *** suffix"
        );
        // Surrounding multi-byte content that is not part of the secret is
        // preserved byte-for-byte.
        assert_eq!(masker.mask_string("北京-other"), "北京-other");
    }

    /// Regression for #9778: when one secret is a substring of another,
    /// the longer match must win so no portion of the longer secret leaks.
    #[test]
    fn substring_secret_is_fully_masked() {
        // Short secret registered BEFORE the long one — this is the ordering
        // that broke the old `str::replace` loop.
        let engine = base64::engine::general_purpose::STANDARD;
        let short = engine.encode("secret");
        let long = engine.encode("mysecret-token-xyz");
        let raw = format!("{short},{long}");
        let masker = SecretMasker::from_raw(&raw);

        // Longer pattern wins: no "my" or "-token-xyz" fragments escape.
        assert_eq!(
            masker.mask_string("mysecret-token-xyz appeared in log"),
            "*** appeared in log"
        );
        // Short secret still masks when the long one is not present.
        assert_eq!(masker.mask_string("plain secret alone"), "plain *** alone");
        // Both secrets present at different positions: both get masked.
        assert_eq!(
            masker.mask_string("secret and mysecret-token-xyz"),
            "*** and ***"
        );
    }
}
