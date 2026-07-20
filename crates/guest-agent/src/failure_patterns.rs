//! Exact failure predicates shared by structured event extraction and final
//! diagnostic classification.

use serde_json::Value;

pub(crate) const CODEX_OAUTH_TOKEN_CONNECTOR: &str = "codex-oauth-token";
const CODEX_MODEL_CAPACITY_MESSAGE: &str =
    "selected model is at capacity. please try a different model.";
const CODEX_CONTEXT_WINDOW_EXHAUSTED_PREFIX: &str =
    "codex ran out of room in the model's context window.";

pub(crate) fn is_generic_codex_failure_diagnostic(message: &str) -> bool {
    let message = message.trim().to_ascii_lowercase();
    let message = message.trim_end_matches(['.', ':', '!', '?']).trim_end();
    matches!(
        message,
        "error" | "turn failed" | "turn interrupted" | "unknown error" | "codex error"
    )
}

pub(crate) fn is_codex_model_capacity_message(message: &str) -> bool {
    message
        .to_ascii_lowercase()
        .contains(CODEX_MODEL_CAPACITY_MESSAGE)
}

pub(crate) fn is_codex_context_window_exceeded_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains(CODEX_CONTEXT_WINDOW_EXHAUSTED_PREFIX)
        && (message.contains("start a new thread") || message.contains("start a new conversation"))
        && message.contains("clear earlier history")
        && message.contains("before retrying")
}

pub(crate) fn has_exact_codex_oauth_connector(value: &Value) -> bool {
    value
        .get("connectors")
        .and_then(Value::as_array)
        .is_some_and(|connectors| {
            connectors.len() == 1
                && connectors.first().and_then(Value::as_str) == Some(CODEX_OAUTH_TOKEN_CONNECTOR)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_generic_failure_diagnostic_matcher_is_case_insensitive() {
        for message in [
            "error",
            "error:",
            "error :",
            "Turn failed",
            "Turn failed.",
            "Turn failed .",
            " turn interrupted ",
            "UNKNOWN ERROR",
            "unknown error!",
            "codex error",
            "codex error?",
        ] {
            assert!(
                is_generic_codex_failure_diagnostic(message),
                "message should be generic: {message}"
            );
        }

        assert!(!is_generic_codex_failure_diagnostic(
            "Selected model is at capacity. Please try a different model."
        ));
    }

    #[test]
    fn codex_model_capacity_matcher_accepts_wrapped_case_insensitive_message() {
        assert!(is_codex_model_capacity_message(
            "Codex failed: SELECTED MODEL IS AT CAPACITY. PLEASE TRY A DIFFERENT MODEL."
        ));
    }

    #[test]
    fn codex_model_capacity_matcher_ignores_generic_overload_text() {
        assert!(!is_codex_model_capacity_message(
            "API Error: 529 Overloaded. This is a server-side issue, usually temporary - try again in a moment."
        ));
    }

    #[test]
    fn codex_context_window_matcher_accepts_thread_and_conversation_variants() {
        for message in [
            "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
            "Codex ran out of room in the model's context window. Start a new conversation or clear earlier history before retrying.",
        ] {
            assert!(
                is_codex_context_window_exceeded_message(message),
                "message: {message}"
            );
        }
    }

    #[test]
    fn codex_context_window_matcher_ignores_generic_context_window_text() {
        assert!(!is_codex_context_window_exceeded_message(
            "The prompt mentions the model context window but did not fail."
        ));
    }
}
