use serde_json::Value;

use crate::masker::SecretMasker;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ChunkOut {
    pub(super) message_id: String,
    pub(super) text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum LineAction {
    Consume { chunk: Option<ChunkOut> },
    PassthroughAfterFlush { chunk: Option<ChunkOut> },
}

pub(super) struct TextChunker {
    current_message_id: Option<String>,
    accumulated: String,
    emitted_chars: usize,
    holdback_chars: usize,
}

impl TextChunker {
    pub(super) fn new(masker: &SecretMasker) -> Self {
        Self {
            current_message_id: None,
            accumulated: String::new(),
            emitted_chars: 0,
            holdback_chars: masker.max_secret_len(),
        }
    }

    pub(super) fn on_line(&mut self, line: &Value, masker: &SecretMasker) -> LineAction {
        if line.get("type").and_then(Value::as_str) != Some("stream_event") {
            let chunk = self.finish_current_message(masker);
            return LineAction::PassthroughAfterFlush { chunk };
        }

        if line
            .get("parent_tool_use_id")
            .is_some_and(|value| !value.is_null())
        {
            return LineAction::Consume { chunk: None };
        }

        let event = &line["event"];
        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                let chunk = self.finish_current_message(masker);
                self.current_message_id = event
                    .get("message")
                    .and_then(|message| message.get("id"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                self.accumulated.clear();
                self.emitted_chars = 0;
                LineAction::Consume { chunk }
            }
            Some("content_block_delta")
                if event
                    .get("delta")
                    .and_then(|delta| delta.get("type"))
                    .and_then(Value::as_str)
                    == Some("text_delta") =>
            {
                if let Some(text) = event
                    .get("delta")
                    .and_then(|delta| delta.get("text"))
                    .and_then(Value::as_str)
                    && self.current_message_id.is_some()
                {
                    self.accumulated.push_str(text);
                }
                LineAction::Consume { chunk: None }
            }
            Some("content_block_stop") => LineAction::Consume {
                chunk: self.flush(masker, true),
            },
            Some("message_stop") => LineAction::Consume {
                chunk: self.finish_current_message(masker),
            },
            _ => LineAction::Consume { chunk: None },
        }
    }

    pub(super) fn flush(&mut self, masker: &SecretMasker, finalize: bool) -> Option<ChunkOut> {
        let message_id = self.current_message_id.clone()?;
        let masked = masker.mask_string(&self.accumulated);
        let total_chars = masked.chars().count();
        let target_end = if finalize {
            total_chars
        } else {
            total_chars.saturating_sub(self.holdback_chars)
        };
        if target_end <= self.emitted_chars {
            return None;
        }

        let text = slice_chars(&masked, self.emitted_chars, target_end);
        self.emitted_chars = target_end;
        if text.is_empty() {
            None
        } else {
            Some(ChunkOut { message_id, text })
        }
    }

    fn finish_current_message(&mut self, masker: &SecretMasker) -> Option<ChunkOut> {
        let chunk = self.flush(masker, true);
        self.current_message_id = None;
        self.accumulated.clear();
        self.emitted_chars = 0;
        chunk
    }
}

fn slice_chars(value: &str, start: usize, end: usize) -> String {
    value.chars().skip(start).take(end - start).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn line(value: serde_json::Value) -> serde_json::Value {
        value
    }

    fn empty_masker() -> SecretMasker {
        SecretMasker::from_raw("")
    }

    #[test]
    fn chunker_concatenates_text_deltas_for_message() {
        let masker = empty_masker();
        let mut chunker = TextChunker::new(&masker);

        assert_eq!(
            chunker.on_line(
                &line(serde_json::json!({
                    "type": "stream_event",
                    "event": {"type": "message_start", "message": {"id": "msg_01"}}
                })),
                &masker,
            ),
            LineAction::Consume { chunk: None }
        );
        assert_eq!(
            chunker.on_line(
                &line(serde_json::json!({
                    "type": "stream_event",
                    "event": {
                        "type": "content_block_delta",
                        "delta": {"type": "text_delta", "text": "hello "}
                    }
                })),
                &masker,
            ),
            LineAction::Consume { chunk: None }
        );
        assert_eq!(
            chunker.on_line(
                &line(serde_json::json!({
                    "type": "stream_event",
                    "event": {
                        "type": "content_block_delta",
                        "delta": {"type": "text_delta", "text": "world"}
                    }
                })),
                &masker,
            ),
            LineAction::Consume { chunk: None }
        );

        assert_eq!(
            chunker.on_line(
                &line(serde_json::json!({
                    "type": "stream_event",
                    "event": {"type": "content_block_stop"}
                })),
                &masker,
            ),
            LineAction::Consume {
                chunk: Some(ChunkOut {
                    message_id: "msg_01".into(),
                    text: "hello world".into(),
                })
            }
        );
    }

    #[test]
    fn chunker_ignores_subagent_stream_events() {
        let masker = empty_masker();
        let mut chunker = TextChunker::new(&masker);

        let action = chunker.on_line(
            &line(serde_json::json!({
                "type": "stream_event",
                "parent_tool_use_id": "toolu_123",
                "event": {"type": "message_start", "message": {"id": "msg_sub"}}
            })),
            &masker,
        );

        assert_eq!(action, LineAction::Consume { chunk: None });
    }

    #[test]
    fn chunker_flushes_before_non_stream_event_passthrough() {
        let masker = empty_masker();
        let mut chunker = TextChunker::new(&masker);
        let _ = chunker.on_line(
            &line(serde_json::json!({
                "type": "stream_event",
                "event": {"type": "message_start", "message": {"id": "msg_01"}}
            })),
            &masker,
        );
        let _ = chunker.on_line(
            &line(serde_json::json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": "final text"}
                }
            })),
            &masker,
        );

        assert_eq!(
            chunker.on_line(&line(serde_json::json!({"type": "assistant"})), &masker),
            LineAction::PassthroughAfterFlush {
                chunk: Some(ChunkOut {
                    message_id: "msg_01".into(),
                    text: "final text".into(),
                })
            }
        );
    }

    #[test]
    fn chunker_holds_back_secret_sized_tail_until_final_flush() {
        let raw_secret = base64::engine::general_purpose::STANDARD.encode("secret-token");
        let masker = SecretMasker::from_raw(&raw_secret);
        let mut chunker = TextChunker::new(&masker);
        let _ = chunker.on_line(
            &line(serde_json::json!({
                "type": "stream_event",
                "event": {"type": "message_start", "message": {"id": "msg_01"}}
            })),
            &masker,
        );
        let _ = chunker.on_line(
            &line(serde_json::json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": "prefix secret"}
                }
            })),
            &masker,
        );

        assert_eq!(chunker.flush(&masker, false), None);

        let _ = chunker.on_line(
            &line(serde_json::json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": "-token suffix"}
                }
            })),
            &masker,
        );

        assert_eq!(
            chunker.flush(&masker, true),
            Some(ChunkOut {
                message_id: "msg_01".into(),
                text: "prefix *** suffix".into(),
            })
        );
    }
}
