//! Exact failure predicates shared by structured event extraction and final
//! diagnostic classification.

use serde_json::Value;

pub(crate) const CODEX_OAUTH_TOKEN_CONNECTOR: &str = "codex-oauth-token";
const CODEX_MODEL_CAPACITY_MESSAGE: &str =
    "selected model is at capacity. please try a different model.";
const CODEX_CONTEXT_WINDOW_EXHAUSTED_PREFIX: &str =
    "codex ran out of room in the model's context window.";
const CODEX_RATE_LIMIT_RETRY_EXHAUSTED_MESSAGE: &str =
    "exceeded retry limit, last status: 429 too many requests";
const CODEX_UNSUPPORTED_MODEL_MESSAGE_SUFFIX: &str =
    "' model is not supported when using Codex with a ChatGPT account.";

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

pub(crate) fn is_codex_rate_limit_retry_exhausted_message(message: &str) -> bool {
    let normalized = message.trim().to_ascii_lowercase();
    let normalized = normalized
        .strip_prefix("codex failed:")
        .unwrap_or(&normalized)
        .trim();
    let Some(suffix) = normalized.strip_prefix(CODEX_RATE_LIMIT_RETRY_EXHAUSTED_MESSAGE) else {
        return false;
    };
    suffix.is_empty()
        || suffix
            .strip_prefix(", request id: ")
            .is_some_and(|request_id| {
                !request_id.is_empty()
                    && request_id
                        .chars()
                        .all(|character| !character.is_ascii_whitespace())
            })
}

pub(crate) fn is_codex_chatgpt_account_unsupported_model_message(message: &str) -> bool {
    let Some(model) = message
        .strip_prefix("The '")
        .and_then(|message| message.strip_suffix(CODEX_UNSUPPORTED_MODEL_MESSAGE_SUFFIX))
    else {
        return false;
    };
    !model.is_empty() && !model.contains('\'')
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

    #[test]
    fn codex_rate_limit_retry_exhausted_matcher_accepts_known_shapes() {
        for message in [
            "exceeded retry limit, last status: 429 Too Many Requests",
            "exceeded retry limit, last status: 429 Too Many Requests, request id: req_123-abc",
            " Codex failed: EXCEEDED RETRY LIMIT, LAST STATUS: 429 TOO MANY REQUESTS, REQUEST ID: req_123 ",
        ] {
            assert!(
                is_codex_rate_limit_retry_exhausted_message(message),
                "message: {message}"
            );
        }
    }

    #[test]
    fn codex_rate_limit_retry_exhausted_matcher_rejects_near_misses() {
        for message in [
            "429 Too Many Requests",
            "exceeded retry limit, last status: 503 Service Unavailable",
            "exceeded retry limit, last status: 429 Too Many Requests; try later",
            "exceeded retry limit, last status: 429 Too Many Requests, request id: ",
            "the log says exceeded retry limit, last status: 429 Too Many Requests",
        ] {
            assert!(
                !is_codex_rate_limit_retry_exhausted_message(message),
                "message: {message}"
            );
        }
    }

    #[test]
    fn codex_unsupported_model_matcher_requires_the_exact_message() {
        assert!(is_codex_chatgpt_account_unsupported_model_message(
            "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."
        ));

        for message in [
            "The '' model is not supported when using Codex with a ChatGPT account.",
            "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account",
            "the 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
            "The 'gpt-5.6-sol' model is not supported with this account.",
            "The 'gpt'5.6-sol' model is not supported when using Codex with a ChatGPT account.",
        ] {
            assert!(
                !is_codex_chatgpt_account_unsupported_model_message(message),
                "message: {message}"
            );
        }
    }
}
