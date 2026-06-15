use serde_json::json;
use uuid::Uuid;

use crate::env::ChatStreamConfig;
use crate::error::AgentError;

use super::event_delivery::ChatStreamDelta;

const ASSISTANT_MESSAGE_ID_NAMESPACE: &str = "bfec4fb6-d5b8-43e4-a72a-9f58f87d7e01";
const TOPIC_PREFIX: &str = "chatThreadMessageDelta:";

pub(super) struct ChatStreamPublisher {
    client: reqwest::Client,
}

impl ChatStreamPublisher {
    pub(super) fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }

    pub(super) async fn publish(
        &self,
        config: &ChatStreamConfig,
        delta: &ChatStreamDelta,
    ) -> Result<(), AgentError> {
        let thread_id = thread_id_from_topic(&config.topic)?;
        let message_id =
            assistant_message_id_for_run_event(crate::env::run_id(), &delta.message_id)?;
        let url = format!(
            "{}/channels/{}/messages",
            config.ably_base.trim_end_matches('/'),
            encode_path_segment(&config.channel)
        );
        let response = self
            .client
            .post(url)
            .bearer_auth(&config.token)
            .json(&json!({
                "name": config.topic,
                "data": {
                    "messageId": message_id,
                    "runId": crate::env::run_id(),
                    "runEventId": delta.message_id,
                    "threadId": thread_id,
                    "text": delta.text,
                },
            }))
            .send()
            .await
            .map_err(|error| AgentError::Http(format!("chat stream publish: {error}")))?;

        if !response.status().is_success() {
            return Err(AgentError::Http(format!(
                "chat stream publish: HTTP {}",
                response.status()
            )));
        }

        Ok(())
    }
}

pub(super) fn assistant_message_id_for_run_event(
    run_id: &str,
    run_event_id: &str,
) -> Result<String, AgentError> {
    let namespace = Uuid::parse_str(ASSISTANT_MESSAGE_ID_NAMESPACE)
        .map_err(|error| AgentError::Execution(format!("invalid assistant namespace: {error}")))?;
    Ok(Uuid::new_v5(&namespace, format!("{run_id}:{run_event_id}").as_bytes()).to_string())
}

fn thread_id_from_topic(topic: &str) -> Result<&str, AgentError> {
    topic
        .strip_prefix(TOPIC_PREFIX)
        .filter(|thread_id| !thread_id.is_empty())
        .ok_or_else(|| AgentError::Execution(format!("invalid chat stream topic: {topic}")))
}

fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
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

    #[test]
    fn encodes_ably_channel_as_path_segment() {
        assert_eq!(encode_path_segment("user:user_123"), "user%3Auser_123");
    }

    #[test]
    fn extracts_thread_id_from_topic() {
        assert_eq!(
            thread_id_from_topic("chatThreadMessageDelta:22222222-2222-4222-8222-222222222222")
                .unwrap(),
            "22222222-2222-4222-8222-222222222222"
        );
    }

    #[test]
    fn rejects_invalid_topic() {
        let err = thread_id_from_topic("wrong:topic").unwrap_err();
        assert!(err.to_string().contains("invalid chat stream topic"));
    }

    #[test]
    fn assistant_message_id_matches_golden_vector() {
        let id =
            assistant_message_id_for_run_event("11111111-1111-4111-8111-111111111111", "msg_01")
                .unwrap();

        assert_eq!(id, "f819e443-a3fc-5990-920b-5eb8e51e038e");
    }
}
