//! Secret masking for event payloads and CLI diagnostics.
//!
//! Reads `VM0_SECRET_VALUES` (comma-separated base64 values), pre-computes
//! plain / base64 / URL-encoded variants for normal payload masking, and derives
//! diagnostic-only multiline variants for bounded CLI stderr tails.

use crate::env;
use aho_corasick::{AhoCorasick, MatchKind};
use base64::Engine;
use serde_json::Value;
use std::{collections::HashSet, ops::Range};

/// Minimum secret length to avoid false-positive masking.
const MIN_SECRET_LEN: usize = 5;

/// Holds pre-computed secret patterns for efficient masking.
///
/// Uses Aho-Corasick with leftmost-longest match semantics so that when one
/// configured secret is a substring of another, the longer match wins and no
/// partial secret survives. See issue #9778.
pub struct SecretMasker {
    matcher: Option<Matcher>,
    diagnostic_matcher: Option<Matcher>,
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
    /// For each secret ≥ 5 chars, the normal matcher stores plain,
    /// base64-encoded, and percent-encoded variants. The diagnostic matcher
    /// also stores multiline-only variants for bounded stderr masking.
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
        let mut diagnostic_patterns = Vec::new();
        for secret in &secrets {
            if secret.len() < MIN_SECRET_LEN {
                continue;
            }
            push_secret_patterns(secret, &mut patterns);
            push_secret_patterns(secret, &mut diagnostic_patterns);
            push_diagnostic_multiline_patterns(secret, &mut diagnostic_patterns);
        }

        Self::build_with_diagnostic_patterns(patterns, diagnostic_patterns)
    }

    fn empty() -> Self {
        Self {
            matcher: None,
            diagnostic_matcher: None,
        }
    }

    #[cfg(test)]
    fn build(patterns: Vec<String>) -> Self {
        Self::build_with_diagnostic_patterns(patterns.clone(), patterns)
    }

    fn build_with_diagnostic_patterns(
        patterns: Vec<String>,
        diagnostic_patterns: Vec<String>,
    ) -> Self {
        let matcher = Self::build_matcher(&patterns);
        let diagnostic_matcher = Self::build_matcher(&diagnostic_patterns);
        Self {
            matcher,
            diagnostic_matcher,
        }
    }

    /// # Panics
    /// Panics if the Aho-Corasick automaton fails to build. The only
    /// documented failure mode is pattern sets too large for the state-ID
    /// type (millions of patterns); user-configured secrets never approach
    /// that bound. A hard abort is preferred over silently degrading to a
    /// pass-through masker, which would leak every subsequent event payload.
    #[allow(clippy::expect_used)]
    fn build_matcher(patterns: &[String]) -> Option<Matcher> {
        if patterns.is_empty() {
            return None;
        }
        let mut seen = HashSet::with_capacity(patterns.len());
        let mut unique_patterns = Vec::with_capacity(patterns.len());
        for pattern in patterns {
            if seen.insert(pattern.as_str()) {
                unique_patterns.push(pattern.as_str());
            }
        }
        let ac = AhoCorasick::builder()
            .match_kind(MatchKind::LeftmostLongest)
            .build(unique_patterns.iter().copied())
            .expect("AhoCorasick build failed for secret pattern set");
        let replacements = vec!["***"; unique_patterns.len()];
        Some(Matcher { ac, replacements })
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

    /// Mask diagnostic text while preserving the caller's line boundaries.
    pub(crate) fn mask_diagnostic_lines(&self, lines: Vec<String>) -> Vec<String> {
        let Some(matcher) = self.diagnostic_matcher.as_ref() else {
            return lines;
        };
        if lines.is_empty() {
            return lines;
        }

        let joined_len = lines
            .iter()
            .map(String::len)
            .sum::<usize>()
            .saturating_add(lines.len().saturating_sub(1));
        let mut joined = String::with_capacity(joined_len);
        let mut line_starts = Vec::with_capacity(lines.len());
        let mut line_ends = Vec::with_capacity(lines.len());
        for (index, line) in lines.iter().enumerate() {
            if index > 0 {
                joined.push('\n');
            }
            line_starts.push(joined.len());
            joined.push_str(line);
            line_ends.push(joined.len());
        }
        if !matcher.ac.is_match(&joined) {
            return lines;
        }

        let mut redactions = vec![Vec::new(); lines.len()];
        for matched in matcher.ac.find_iter(&joined) {
            let match_start = matched.start();
            let match_end = matched.end();
            let first_line = line_ends.partition_point(|&line_end| line_end <= match_start);
            for ((line_start, line_end), line_redactions) in line_starts
                .iter()
                .copied()
                .zip(line_ends.iter().copied())
                .zip(redactions.iter_mut())
                .skip(first_line)
            {
                if line_start >= match_end {
                    break;
                }
                let redaction_start = match_start.max(line_start);
                let redaction_end = match_end.min(line_end);
                if redaction_start < redaction_end {
                    line_redactions
                        .push((redaction_start - line_start)..(redaction_end - line_start));
                }
            }
        }

        lines
            .into_iter()
            .zip(redactions)
            .map(|(line, ranges)| redact_ranges(line, &ranges))
            .collect()
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

fn push_secret_patterns(secret: &str, patterns: &mut Vec<String>) {
    patterns.push(secret.to_string());
    let b64 = base64::engine::general_purpose::STANDARD.encode(secret);
    patterns.push(b64);
    let url_encoded = url_encode(secret);
    if url_encoded != secret {
        patterns.push(url_encoded);
    }
}

fn push_diagnostic_multiline_patterns(secret: &str, patterns: &mut Vec<String>) {
    let normalized = secret.replace("\r\n", "\n");
    if !normalized.contains('\n') {
        return;
    }
    if normalized != secret && normalized.len() >= MIN_SECRET_LEN {
        patterns.push(normalized.clone());
    }
    if let Some(without_final_newline) = normalized.strip_suffix('\n')
        && without_final_newline.len() >= MIN_SECRET_LEN
    {
        patterns.push(without_final_newline.to_string());
    }
    for line in normalized.split('\n') {
        if line.len() >= MIN_SECRET_LEN {
            patterns.push(line.to_string());
        }
    }
}

fn redact_ranges(line: String, ranges: &[Range<usize>]) -> String {
    if ranges.is_empty() {
        return line;
    }

    let mut redacted = String::with_capacity(line.len());
    let mut cursor = 0;
    for range in ranges {
        if range.start > cursor {
            redacted.push_str(&line[cursor..range.start]);
        }
        if range.end > cursor {
            redacted.push_str("***");
            cursor = range.end;
        }
    }
    if cursor < line.len() {
        redacted.push_str(&line[cursor..]);
    }
    redacted
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
    fn diagnostic_lines_mask_multiline_secret_without_collapsing_lines() {
        let engine = base64::engine::general_purpose::STANDARD;
        let secret = "first-line\nsecond-secret-line\nthird-line\n";
        let encoded = engine.encode(secret);
        let masker = SecretMasker::from_raw(&encoded);

        let lines = vec![
            "before".to_string(),
            "first-line".to_string(),
            "second-secret-line".to_string(),
            "third-line".to_string(),
            "after".to_string(),
        ];

        assert_eq!(
            masker.mask_diagnostic_lines(lines),
            vec![
                "before".to_string(),
                "***".to_string(),
                "***".to_string(),
                "***".to_string(),
                "after".to_string(),
            ]
        );
    }

    #[test]
    fn diagnostic_lines_mask_trailing_newline_secret_at_end_with_short_lines() {
        let engine = base64::engine::general_purpose::STANDARD;
        let secret = "aa\nbb\ncc\n";
        let encoded = engine.encode(secret);
        let masker = SecretMasker::from_raw(&encoded);

        assert_eq!(
            masker.mask_diagnostic_lines(vec![
                "before".to_string(),
                "aa".to_string(),
                "bb".to_string(),
                "cc".to_string(),
            ]),
            vec![
                "before".to_string(),
                "***".to_string(),
                "***".to_string(),
                "***".to_string(),
            ]
        );
    }

    #[test]
    fn diagnostic_lines_mask_single_line_secret_with_terminal_newline() {
        let engine = base64::engine::general_purpose::STANDARD;
        let secret = "abcde\n";
        let encoded = engine.encode(secret);
        let masker = SecretMasker::from_raw(&encoded);

        assert_eq!(
            masker.mask_diagnostic_lines(vec!["abcde".to_string()]),
            vec!["***".to_string()]
        );
    }

    #[test]
    fn diagnostic_lines_mask_repeated_matches_on_same_line() {
        let engine = base64::engine::general_purpose::STANDARD;
        let secret = "abcde\n";
        let encoded = engine.encode(secret);
        let masker = SecretMasker::from_raw(&encoded);

        assert_eq!(
            masker.mask_diagnostic_lines(vec!["abcde abcde".to_string()]),
            vec!["*** ***".to_string()]
        );
    }

    #[test]
    fn diagnostic_lines_mask_only_one_missing_terminal_newline() {
        let engine = base64::engine::general_purpose::STANDARD;
        let secret = "aa\nbb\ncc\n\n";
        let encoded = engine.encode(secret);
        let masker = SecretMasker::from_raw(&encoded);

        assert_eq!(
            masker.mask_diagnostic_lines(vec![
                "before".to_string(),
                "aa".to_string(),
                "bb".to_string(),
                "cc".to_string(),
                String::new(),
            ]),
            vec![
                "before".to_string(),
                "***".to_string(),
                "***".to_string(),
                "***".to_string(),
                String::new(),
            ]
        );
    }

    #[test]
    fn normal_masking_does_not_use_multiline_fragments() {
        let engine = base64::engine::general_purpose::STANDARD;
        let secret = "first-line\nsecond-secret-line\nthird-line";
        let encoded = engine.encode(secret);
        let masker = SecretMasker::from_raw(&encoded);

        assert_eq!(
            masker.mask_string("second-secret-line"),
            "second-secret-line"
        );
        assert_eq!(
            masker.mask_diagnostic_lines(vec!["second-secret-line".to_string()]),
            vec!["***".to_string()]
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
