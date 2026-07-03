use serde_json::{Value, json};

/// Build the three-event sequence the mock emits for a single turn.
pub fn build_events(thread_id: &str, prompt: &str) -> [Value; 3] {
    [
        json!({"type": "thread.started", "thread_id": thread_id}),
        json!({
            "type": "item.completed",
            "item": {"type": "agent_message", "text": prompt}
        }),
        json!({
            "type": "turn.completed",
            "usage": {"input_tokens": 10, "output_tokens": 20}
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_events_shape() {
        let evs = build_events("tid-1", "hello");
        assert_eq!(evs[0]["type"], "thread.started");
        assert_eq!(evs[0]["thread_id"], "tid-1");
        assert_eq!(evs[1]["type"], "item.completed");
        assert_eq!(evs[1]["item"]["type"], "agent_message");
        assert_eq!(evs[1]["item"]["text"], "hello");
        assert_eq!(evs[2]["type"], "turn.completed");
        assert_eq!(evs[2]["usage"]["input_tokens"], 10);
        assert_eq!(evs[2]["usage"]["output_tokens"], 20);
    }
}
