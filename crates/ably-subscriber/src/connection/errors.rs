use crate::protocol::{ErrorInfo, error_code};
use crate::types::redact_auth_query_params;

pub(super) fn error_or_unknown(error: Option<ErrorInfo>) -> ErrorInfo {
    error.unwrap_or_else(|| ErrorInfo {
        code: error_code::FAILED,
        status_code: None,
        message: "no error details from server".to_string(),
    })
}

pub(super) fn protocol_disconnect_reason(error: Option<ErrorInfo>) -> String {
    match error {
        Some(error) if !error.message.is_empty() => redact_auth_query_params(&error.message),
        Some(error) => {
            let status = error
                .status_code
                .map(|status_code| format!(" status={status_code}"))
                .unwrap_or_default();
            format!("server sent DISCONNECTED code={}{}", error.code, status)
        }
        None => "server sent DISCONNECTED without error details".to_string(),
    }
}

pub(super) fn protocol_error_message(message: String) -> String {
    redact_auth_query_params(&message)
}

pub(super) fn channel_detached_message(message: &str) -> String {
    format!("Channel detached: {}", redact_auth_query_params(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_disconnect_reason_redacts_auth_query_params_from_message() {
        let reason = protocol_disconnect_reason(Some(ErrorInfo {
            code: 80003,
            status_code: Some(500),
            message: "failed url=wss://example/?access_token=protocol-token&resume=protocol-key&format=msgpack"
                .to_string(),
        }));

        assert_eq!(
            reason,
            "failed url=wss://example/?access_token=<redacted>&resume=<redacted>&format=msgpack"
        );
        assert!(!reason.contains("protocol-token"));
        assert!(!reason.contains("protocol-key"));
    }

    #[test]
    fn event_error_helpers_redact_auth_query_params() {
        let protocol_message = protocol_error_message(
            "failed url=wss://example/?access_token=event-token&resume=event-key&format=msgpack"
                .to_string(),
        );
        let detached_message = channel_detached_message(
            "failed url=wss://example/?access_token=detached-token&resume=detached-key&format=msgpack",
        );

        assert_eq!(
            protocol_message,
            "failed url=wss://example/?access_token=<redacted>&resume=<redacted>&format=msgpack"
        );
        assert_eq!(
            detached_message,
            "Channel detached: failed url=wss://example/?access_token=<redacted>&resume=<redacted>&format=msgpack"
        );
        assert!(!protocol_message.contains("event-token"));
        assert!(!protocol_message.contains("event-key"));
        assert!(!detached_message.contains("detached-token"));
        assert!(!detached_message.contains("detached-key"));
    }
}
