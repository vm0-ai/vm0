//! Shared Codex thread ID identity contract.
//!
//! Codex thread IDs are accepted as standard UUID text, either hyphenated or
//! compact. Decorative forms accepted by `uuid::Uuid::parse_str`, such as
//! `urn:uuid:*` and brace-wrapped UUIDs, are intentionally outside this
//! runner/guest contract.

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CodexThreadId {
    canonical: String,
}

impl CodexThreadId {
    pub fn parse(raw: &str) -> Option<Self> {
        if !has_contract_shape(raw) {
            return None;
        }

        uuid::Uuid::parse_str(raw).ok().map(|uuid| Self {
            canonical: uuid.to_string(),
        })
    }

    pub fn as_str(&self) -> &str {
        &self.canonical
    }

    pub fn into_string(self) -> String {
        self.canonical
    }

    pub fn filename_key(&self) -> String {
        self.canonical.replace('-', "")
    }
}

pub fn canonical_codex_thread_id(raw: &str) -> Option<String> {
    CodexThreadId::parse(raw).map(CodexThreadId::into_string)
}

pub fn codex_thread_id_filename_key(raw: &str) -> Option<String> {
    CodexThreadId::parse(raw).map(|thread_id| thread_id.filename_key())
}

fn has_contract_shape(raw: &str) -> bool {
    match raw.len() {
        32 => raw.bytes().all(|byte| byte.is_ascii_hexdigit()),
        36 => raw.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        }),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANONICAL: &str = "019e9154-c304-70f0-adde-36efb1be1701";
    const NO_DASH: &str = "019e9154c30470f0adde36efb1be1701";

    #[test]
    fn parses_dashed_lowercase_uuid() {
        let thread_id = CodexThreadId::parse(CANONICAL).expect("valid codex thread id");

        assert_eq!(thread_id.as_str(), CANONICAL);
    }

    #[test]
    fn canonicalizes_dashed_uppercase_uuid() {
        let thread_id = CodexThreadId::parse("019E9154-C304-70F0-ADDE-36EFB1BE1701")
            .expect("valid codex thread id");

        assert_eq!(thread_id.as_str(), CANONICAL);
    }

    #[test]
    fn canonicalizes_no_dash_uppercase_uuid() {
        let thread_id =
            CodexThreadId::parse("019E9154C30470F0ADDE36EFB1BE1701").expect("valid codex id");

        assert_eq!(thread_id.as_str(), CANONICAL);
    }

    #[test]
    fn returns_filename_key() {
        let thread_id = CodexThreadId::parse(CANONICAL).expect("valid codex thread id");

        assert_eq!(thread_id.filename_key(), NO_DASH);
    }

    #[test]
    fn canonical_free_function_returns_canonical_text() {
        assert_eq!(
            canonical_codex_thread_id("019E9154C30470F0ADDE36EFB1BE1701"),
            Some(CANONICAL.to_string())
        );
    }

    #[test]
    fn filename_key_free_function_returns_no_dash_text() {
        assert_eq!(
            codex_thread_id_filename_key("019E9154-C304-70F0-ADDE-36EFB1BE1701"),
            Some(NO_DASH.to_string())
        );
    }

    #[test]
    fn rejects_non_contract_forms() {
        for raw in [
            "",
            "abc",
            "---",
            "019e9154_c304_70f0_adde_36efb1be1701",
            "019e9154-c304-70f0-adde36efb1be1701",
            "{019e9154-c304-70f0-adde-36efb1be1701}",
            "urn:uuid:019e9154-c304-70f0-adde-36efb1be1701",
            " 019e9154-c304-70f0-adde-36efb1be1701",
            "019e9154-c304-70f0-adde-36efb1be1701 ",
        ] {
            assert!(
                CodexThreadId::parse(raw).is_none(),
                "expected rejection for {raw:?}"
            );
        }
    }
}
