use super::*;
use serde_json::{Value, json};

const TEST_RUN_ID: &str = "run-1";
const TEST_INITIAL_PROMPT: &str = "initial";

fn enabled_runtime() -> ActiveInputRuntime {
    enabled_runtime_with_initial_prompt(TEST_INITIAL_PROMPT)
}

fn enabled_runtime_with_initial_prompt(initial_prompt: &str) -> ActiveInputRuntime {
    ActiveInputRuntime::new_with_initial_prompt(TEST_RUN_ID, true, initial_prompt)
}

fn active_input_payload(text: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "type": ACTIVE_INPUT_TYPE,
        "text": text,
    }))
    .expect("active input payload should serialize")
}

fn active_input_uuid(sequence: u64, message_id: &str) -> String {
    claude_active_input_uuid(TEST_RUN_ID, sequence, message_id)
}

fn accept_active_input(
    controller: &ActiveInputController,
    sequence: u64,
    message_id: &str,
    text: &str,
) -> String {
    assert_eq!(
        controller.handle_control_payload(message_id, &active_input_payload(text)),
        ActiveInputControlOutcome::Accepted
    );
    active_input_uuid(sequence, message_id)
}

fn user_event(uuid: &str, text: &str) -> Value {
    json!({
        "type": "user",
        "uuid": uuid,
        "message": {"role": "user", "content": text}
    })
}

fn uuidless_user_event(text: &str) -> Value {
    json!({
        "type": "user",
        "message": {"role": "user", "content": text}
    })
}

fn uuidless_text_block_user_event(text: &str) -> Value {
    json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": text}]
        }
    })
}

fn assert_pending(controller: &ActiveInputController, uuid: &str) {
    let state = controller
        .inner
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    assert!(state.pending_by_uuid.contains_key(uuid));
}

fn assert_not_pending(controller: &ActiveInputController, uuid: &str) {
    let state = controller
        .inner
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    assert!(!state.pending_by_uuid.contains_key(uuid));
}

#[test]
fn active_input_accepts_valid_payload_once() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();

    assert_eq!(
        controller.handle_control_payload("msg-1", br#"{"type":"active-input","text":"hello"}"#),
        ActiveInputControlOutcome::Accepted
    );
    assert!(matches!(
        controller.handle_control_payload(
            "msg-1",
            br#"{"type":"active-input","text":"hello again"}"#
        ),
        ActiveInputControlOutcome::Rejected { diagnostic }
            if diagnostic == "active input message id is duplicate"
    ));
}

#[test]
fn active_input_rejects_invalid_payloads() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();

    for (message_id, payload) in [
        ("bad-json", br#"{"type":"active-input""#.as_slice()),
        ("bad-type", br#"{"type":"other","text":"hello"}"#.as_slice()),
        ("empty", br#"{"type":"active-input","text":""}"#.as_slice()),
    ] {
        assert!(
            matches!(
                controller.handle_control_payload(message_id, payload),
                ActiveInputControlOutcome::Rejected { .. }
            ),
            "payload should reject: {message_id}"
        );
    }
}

#[test]
fn active_input_rejects_when_disabled_or_closed() {
    let disabled = ActiveInputRuntime::new_disabled("run-1");
    assert!(matches!(
        disabled
            .controller()
            .handle_control_payload("msg-1", br#"{"type":"active-input","text":"hello"}"#),
        ActiveInputControlOutcome::Rejected { diagnostic }
            if diagnostic == "active input is not supported for this agent"
    ));

    let runtime = enabled_runtime();
    let controller = runtime.controller();
    assert!(controller.close_for_result_if_idle());
    assert!(matches!(
        controller.handle_control_payload("msg-1", br#"{"type":"active-input","text":"hello"}"#),
        ActiveInputControlOutcome::Rejected { diagnostic } if diagnostic == "active input is closed"
    ));
}

#[test]
fn active_input_capacity_counts_pending_inputs() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();

    for index in 0..ACTIVE_INPUT_QUEUE_CAPACITY {
        let message_id = format!("msg-{index}");
        assert_eq!(
            controller
                .handle_control_payload(&message_id, br#"{"type":"active-input","text":"hello"}"#),
            ActiveInputControlOutcome::Accepted
        );
    }

    assert!(matches!(
        controller.handle_control_payload("overflow", br#"{"type":"active-input","text":"hello"}"#),
        ActiveInputControlOutcome::QueueFull { diagnostic } if diagnostic == "active input queue is full"
    ));
}

#[tokio::test]
async fn active_input_can_release_capacity_for_sink_without_replay() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let mut writer = runtime.into_writer();

    for index in 0..ACTIVE_INPUT_QUEUE_CAPACITY {
        let message_id = format!("msg-{index}");
        assert_eq!(
            controller
                .handle_control_payload(&message_id, br#"{"type":"active-input","text":"hello"}"#),
            ActiveInputControlOutcome::Accepted
        );
        let frame = writer
            .next_frame()
            .await
            .expect("active input frame should be queued");
        writer.mark_writing(&frame.uuid);
        writer.mark_written_without_replay(&frame.uuid);
        assert_not_pending(&controller, &frame.uuid);
    }

    assert!(matches!(
        controller.handle_control_payload("msg-0", br#"{"type":"active-input","text":"duplicate"}"#),
        ActiveInputControlOutcome::Rejected { diagnostic }
            if diagnostic == "active input message id is duplicate"
    ));
    assert_eq!(
        controller.handle_control_payload("msg-next", br#"{"type":"active-input","text":"next"}"#),
        ActiveInputControlOutcome::Accepted
    );
    let frame = writer
        .next_frame()
        .await
        .expect("new active input frame should be queued after delivered frames release capacity");
    assert_eq!(frame.message_id, "msg-next");
}

#[tokio::test]
async fn active_input_bounds_seen_message_id_cache() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let mut writer = runtime.into_writer();
    let mut first_message_uuid = None;

    for index in 0..=ACTIVE_INPUT_SEEN_MESSAGE_ID_CAPACITY {
        let message_id = format!("msg-{index}");
        let text = format!("follow-up-{index}");
        let payload = serde_json::to_vec(&json!({
            "type": ACTIVE_INPUT_TYPE,
            "text": &text,
        }))
        .expect("active input payload should serialize");
        assert_eq!(
            controller.handle_control_payload(&message_id, &payload),
            ActiveInputControlOutcome::Accepted
        );
        let frame = writer
            .next_frame()
            .await
            .expect("active input frame should be queued");
        assert_eq!(frame.message_id, message_id);
        if index == 0 {
            first_message_uuid = Some(frame.uuid.clone());
        }
        controller.mark_written(&frame.uuid);

        let active = json!({
            "type": "user",
            "uuid": frame.uuid,
            "message": {"role": "user", "content": text}
        });
        assert_eq!(
            controller.replay_user_event_action(&active),
            ReplayUserEventAction::InternalActiveInput
        );
    }

    {
        let state = controller
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        assert_eq!(
            state.seen_message_ids.len(),
            ACTIVE_INPUT_SEEN_MESSAGE_ID_CAPACITY
        );
        assert!(!state.has_seen_message_id("msg-0"));
        assert!(
            state.has_seen_message_id(&format!("msg-{}", ACTIVE_INPUT_SEEN_MESSAGE_ID_CAPACITY))
        );
    }

    assert!(matches!(
        controller.handle_control_payload(
            &format!("msg-{}", ACTIVE_INPUT_SEEN_MESSAGE_ID_CAPACITY),
            br#"{"type":"active-input","text":"duplicate"}"#
        ),
        ActiveInputControlOutcome::Rejected { diagnostic }
            if diagnostic == "active input message id is duplicate"
    ));
    assert_eq!(
        controller.handle_control_payload("msg-0", br#"{"type":"active-input","text":"old"}"#),
        ActiveInputControlOutcome::Accepted
    );
    let frame = writer
        .next_frame()
        .await
        .expect("reused active input frame should be queued");
    assert_eq!(frame.message_id, "msg-0");
    assert_ne!(
        frame.uuid,
        first_message_uuid.expect("first active input uuid should be captured")
    );
}

#[test]
fn replay_filter_consumes_initial_and_active_input_user_events() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "hello");

    let initial = json!({
        "type": "user",
        "uuid": claude_initial_prompt_uuid(TEST_RUN_ID),
        "message": {"role": "user", "content": "initial"}
    });
    assert_eq!(
        controller.replay_user_event_action(&initial),
        ReplayUserEventAction::InternalInitialPrompt
    );
    controller.mark_written(&active_uuid);

    let active = user_event(&active_uuid, "follow-up");
    assert_eq!(
        controller.replay_user_event_action(&active),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_keeps_tool_result_user_events_external() {
    let runtime = enabled_runtime();
    let event = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "tool-1"}]
        }
    });

    assert_eq!(
        runtime.controller().replay_user_event_action(&event),
        ReplayUserEventAction::External
    );
}

#[test]
fn replay_filter_keeps_multi_tool_result_user_events_external() {
    let runtime = enabled_runtime();
    let event = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "tool-1"},
                {"type": "tool_result", "tool_use_id": "tool-2"}
            ]
        }
    });

    assert_eq!(
        runtime.controller().replay_user_event_action(&event),
        ReplayUserEventAction::External
    );
}

#[test]
fn replay_filter_filters_mixed_text_and_tool_result_user_events() {
    let runtime = enabled_runtime();
    let event = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {"type": "text", "text": "prompt-like text"},
                {"type": "tool_result", "tool_use_id": "tool-1"}
            ]
        }
    });

    assert_eq!(
        runtime.controller().replay_user_event_action(&event),
        ReplayUserEventAction::UnknownPromptUser
    );
}

#[test]
fn replay_filter_consumes_matching_uuid_even_with_non_string_content() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "hello");

    let initial = json!({
        "type": "user",
        "uuid": claude_initial_prompt_uuid(TEST_RUN_ID),
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": "initial"}]
        }
    });
    assert_eq!(
        controller.replay_user_event_action(&initial),
        ReplayUserEventAction::InternalInitialPrompt
    );
    controller.mark_written(&active_uuid);

    let active = json!({
        "type": "user",
        "uuid": active_uuid,
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": "follow-up"}]
        }
    });
    assert_eq!(
        controller.replay_user_event_action(&active),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_does_not_consume_accepted_uuid_before_writer_owns_input() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    let stale = user_event(&active_uuid, "follow-up");

    assert_eq!(
        controller.replay_user_event_action(&stale),
        ReplayUserEventAction::UnknownPromptUser
    );
    assert!(!controller.close_for_result_if_idle());

    controller.mark_writing(&active_uuid);
    let replay = user_event(&active_uuid, "follow-up");
    assert_eq!(
        controller.replay_user_event_action(&replay),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_treats_text_block_user_events_without_uuid_as_unknown_prompt() {
    let runtime = enabled_runtime();
    let event = uuidless_text_block_user_event("follow-up");

    assert_eq!(
        runtime.controller().replay_user_event_action(&event),
        ReplayUserEventAction::UnknownPromptUser
    );
}

#[test]
fn replay_filter_consumes_uuidless_active_input_replay_by_text() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    controller.mark_written(&active_uuid);
    assert!(!controller.close_for_result_if_idle());

    let event = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_consumes_oldest_uuidless_text_match() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();

    for message_id in ["msg-1", "msg-2"] {
        assert_eq!(
            controller.handle_control_payload(
                message_id,
                br#"{"type":"active-input","text":"same-text"}"#
            ),
            ActiveInputControlOutcome::Accepted
        );
    }
    let first_uuid = active_input_uuid(0, "msg-1");
    let second_uuid = active_input_uuid(1, "msg-2");
    controller.mark_written(&first_uuid);
    controller.mark_written(&second_uuid);
    assert!(!controller.close_for_result_if_idle());

    let event = uuidless_user_event("same-text");
    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::InternalActiveInput
    );
    assert_not_pending(&controller, &first_uuid);
    assert_pending(&controller, &second_uuid);

    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_defers_uuidless_text_match_while_writing_until_written() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    controller.mark_writing(&active_uuid);
    assert!(!controller.close_for_result_if_idle());

    let event = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::InternalActiveInput
    );
    assert_pending(&controller, &active_uuid);

    controller.mark_written(&active_uuid);
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_clears_multiple_uuidless_writing_replays_after_writes() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();

    for (message_id, text) in [("msg-1", "first"), ("msg-2", "second")] {
        let payload = serde_json::to_vec(&json!({
            "type": ACTIVE_INPUT_TYPE,
            "text": text,
        }))
        .expect("active input payload should serialize");
        assert_eq!(
            controller.handle_control_payload(message_id, &payload),
            ActiveInputControlOutcome::Accepted
        );
    }
    let first_uuid = active_input_uuid(0, "msg-1");
    let second_uuid = active_input_uuid(1, "msg-2");
    assert!(!controller.close_for_result_if_idle());

    for (uuid, text) in [(&first_uuid, "first"), (&second_uuid, "second")] {
        controller.mark_writing(uuid);
        let event = json!({
            "type": "user",
            "message": {"role": "user", "content": text}
        });
        assert_eq!(
            controller.replay_user_event_action(&event),
            ReplayUserEventAction::InternalActiveInput
        );
        controller.mark_written(uuid);
    }

    assert!(controller.close_for_result_if_idle());
}

#[test]
fn followup_result_can_close_after_uuidless_replay_before_mark_written() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    assert!(!controller.close_for_result_if_idle());

    controller.mark_writing(&active_uuid);
    let event = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::InternalActiveInput
    );

    assert!(controller.close_for_result_if_idle());
    controller.mark_written(&active_uuid);
    assert!(matches!(
        controller.handle_control_payload("msg-2", br#"{"type":"active-input","text":"late"}"#),
        ActiveInputControlOutcome::Rejected { diagnostic } if diagnostic == "active input is closed"
    ));
}

#[test]
fn mark_writing_does_not_regress_replay_observed_pending_input() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    assert!(!controller.close_for_result_if_idle());

    controller.mark_writing(&active_uuid);
    let event = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::InternalActiveInput
    );

    controller.mark_writing(&active_uuid);
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_does_not_consume_unwritten_uuidless_text_match() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    assert_eq!(
        controller
            .handle_control_payload("msg-1", br#"{"type":"active-input","text":"same-text"}"#),
        ActiveInputControlOutcome::Accepted
    );

    let event = uuidless_user_event("same-text");
    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::UnknownPromptUser
    );
    assert!(!controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_does_not_consume_uuidless_text_match_before_first_result() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "same-text");
    controller.mark_written(&active_uuid);

    let event = uuidless_user_event("same-text");
    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::UnknownPromptUser
    );
    assert!(!controller.close_for_result_if_idle());
}

#[test]
fn followup_result_closes_writer_owned_pending_input_without_replay() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    controller.mark_written(&active_uuid);

    assert!(!controller.close_for_result_if_idle());
    assert!(controller.close_for_result_if_idle());
    assert!(matches!(
        controller.handle_control_payload("msg-2", br#"{"type":"active-input","text":"late"}"#),
        ActiveInputControlOutcome::Rejected { diagnostic } if diagnostic == "active input is closed"
    ));
}

#[test]
fn followup_result_without_replay_completes_one_written_pending_input_at_a_time() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();

    for message_id in ["msg-1", "msg-2"] {
        assert_eq!(
            controller.handle_control_payload(
                message_id,
                br#"{"type":"active-input","text":"follow-up"}"#
            ),
            ActiveInputControlOutcome::Accepted
        );
    }
    let first_uuid = active_input_uuid(0, "msg-1");
    let second_uuid = active_input_uuid(1, "msg-2");
    controller.mark_written(&first_uuid);
    controller.mark_written(&second_uuid);

    assert!(!controller.close_for_result_if_idle());
    assert!(!controller.close_for_result_if_idle());
    assert_not_pending(&controller, &first_uuid);
    assert_pending(&controller, &second_uuid);
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn followup_result_without_replay_keeps_later_unwritten_pending_input_open() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();

    for message_id in ["msg-1", "msg-2"] {
        assert_eq!(
            controller.handle_control_payload(
                message_id,
                br#"{"type":"active-input","text":"follow-up"}"#
            ),
            ActiveInputControlOutcome::Accepted
        );
    }
    let first_uuid = active_input_uuid(0, "msg-1");
    let second_uuid = active_input_uuid(1, "msg-2");
    controller.mark_written(&first_uuid);

    assert!(!controller.close_for_result_if_idle());
    assert!(!controller.close_for_result_if_idle());
    assert_not_pending(&controller, &first_uuid);
    assert_pending(&controller, &second_uuid);
    assert!(!controller.close_for_result_if_idle());

    controller.mark_written(&second_uuid);
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn followup_result_keeps_writing_pending_input_open_without_replay() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    controller.mark_writing(&active_uuid);

    assert!(!controller.close_for_result_if_idle());
    assert!(!controller.close_for_result_if_idle());
    controller.mark_written(&active_uuid);
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn followup_result_keeps_unwritten_pending_input_open_without_replay() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    assert_eq!(
        controller
            .handle_control_payload("msg-1", br#"{"type":"active-input","text":"follow-up"}"#),
        ActiveInputControlOutcome::Accepted
    );

    assert!(!controller.close_for_result_if_idle());
    assert!(!controller.close_for_result_if_idle());
    assert_eq!(
        controller
            .handle_control_payload("msg-2", br#"{"type":"active-input","text":"still-open"}"#),
        ActiveInputControlOutcome::Accepted
    );
}

#[test]
fn replay_filter_consumes_uuidless_text_match_after_initial_replay_before_first_result() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    controller.mark_written(&active_uuid);

    let initial = uuidless_user_event("initial");
    assert_eq!(
        controller.replay_user_event_action(&initial),
        ReplayUserEventAction::UnknownPromptUser
    );

    let active = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&active),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_does_not_consume_text_match_with_unknown_uuid() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    controller.mark_written(&active_uuid);
    assert!(!controller.close_for_result_if_idle());

    let unknown_uuid = json!({
        "type": "user",
        "uuid": "not-vm0-active-input",
        "message": {"role": "user", "content": "follow-up"}
    });
    assert_eq!(
        controller.replay_user_event_action(&unknown_uuid),
        ReplayUserEventAction::UnknownPromptUser
    );

    let uuidless = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&uuidless),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_does_not_consume_text_match_with_non_string_uuid() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    controller.mark_written(&active_uuid);
    assert!(!controller.close_for_result_if_idle());

    for uuid in [json!(123), Value::Null] {
        let event = json!({
            "type": "user",
            "uuid": uuid,
            "message": {"role": "user", "content": "follow-up"}
        });
        assert_eq!(
            controller.replay_user_event_action(&event),
            ReplayUserEventAction::UnknownPromptUser
        );
    }

    let uuidless = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&uuidless),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_does_not_unlock_initial_prompt_from_unknown_uuid() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    controller.mark_written(&active_uuid);

    let unknown_uuid_initial_text = json!({
        "type": "user",
        "uuid": "not-vm0-initial-prompt",
        "message": {"role": "user", "content": "initial"}
    });
    assert_eq!(
        controller.replay_user_event_action(&unknown_uuid_initial_text),
        ReplayUserEventAction::UnknownPromptUser
    );

    let active_before_initial = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&active_before_initial),
        ReplayUserEventAction::UnknownPromptUser
    );

    let initial = json!({
        "type": "user",
        "uuid": claude_initial_prompt_uuid(TEST_RUN_ID),
        "message": {"role": "user", "content": "initial"}
    });
    assert_eq!(
        controller.replay_user_event_action(&initial),
        ReplayUserEventAction::InternalInitialPrompt
    );

    let active_after_initial = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&active_after_initial),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_does_not_unlock_initial_prompt_from_non_string_uuid() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    controller.mark_written(&active_uuid);

    let malformed_initial = json!({
        "type": "user",
        "uuid": 123,
        "message": {"role": "user", "content": "initial"}
    });
    assert_eq!(
        controller.replay_user_event_action(&malformed_initial),
        ReplayUserEventAction::UnknownPromptUser
    );

    let active_before_initial = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&active_before_initial),
        ReplayUserEventAction::UnknownPromptUser
    );

    let initial = uuidless_user_event("initial");
    assert_eq!(
        controller.replay_user_event_action(&initial),
        ReplayUserEventAction::UnknownPromptUser
    );

    let active_after_initial = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&active_after_initial),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_waits_for_second_uuidless_same_text_before_first_result() {
    let runtime = enabled_runtime_with_initial_prompt("same-text");
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "same-text");
    controller.mark_written(&active_uuid);

    let initial = uuidless_user_event("same-text");
    assert_eq!(
        controller.replay_user_event_action(&initial),
        ReplayUserEventAction::UnknownPromptUser
    );

    let active = uuidless_user_event("same-text");
    assert_eq!(
        controller.replay_user_event_action(&active),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_consumes_uuidless_text_block_active_input_replay() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    controller.mark_written(&active_uuid);
    assert!(!controller.close_for_result_if_idle());

    let event = uuidless_text_block_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&event),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_filters_unknown_user_content_blocks() {
    let runtime = enabled_runtime();

    for content in [
        json!([{"type": "image", "source": "future-schema"}]),
        json!({"type": "future-schema"}),
        json!([]),
    ] {
        let event = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": content
            }
        });

        assert_eq!(
            runtime.controller().replay_user_event_action(&event),
            ReplayUserEventAction::UnknownPromptUser
        );
    }
}

#[test]
fn replay_filter_keeps_non_user_role_events_external_without_advancing_prompt_replay() {
    let runtime = enabled_runtime_with_initial_prompt("follow-up");
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    controller.mark_written(&active_uuid);

    let malformed = json!({
        "type": "user",
        "message": {"role": "assistant", "content": "follow-up"}
    });
    assert_eq!(
        controller.replay_user_event_action(&malformed),
        ReplayUserEventAction::External
    );

    let first_valid_prompt_like = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&first_valid_prompt_like),
        ReplayUserEventAction::UnknownPromptUser
    );

    let second_valid_prompt_like = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&second_valid_prompt_like),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_keeps_non_user_role_uuid_matches_external() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    controller.mark_written(&active_uuid);

    let malformed = json!({
        "type": "user",
        "uuid": active_uuid,
        "message": {"role": "assistant", "content": "follow-up"}
    });
    assert_eq!(
        controller.replay_user_event_action(&malformed),
        ReplayUserEventAction::External
    );

    let replay = json!({
        "type": "user",
        "uuid": active_input_uuid(0, "msg-1"),
        "message": {"role": "user", "content": "follow-up"}
    });
    assert_eq!(
        controller.replay_user_event_action(&replay),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_keeps_non_string_role_events_external() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    controller.mark_written(&active_uuid);

    let malformed = json!({
        "type": "user",
        "uuid": active_uuid,
        "message": {"role": 123, "content": "follow-up"}
    });
    assert_eq!(
        controller.replay_user_event_action(&malformed),
        ReplayUserEventAction::External
    );

    let replay = json!({
        "type": "user",
        "uuid": active_input_uuid(0, "msg-1"),
        "message": {"role": "user", "content": "follow-up"}
    });
    assert_eq!(
        controller.replay_user_event_action(&replay),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_keeps_child_user_events_external() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    controller.mark_written(&active_uuid);

    let child = json!({
        "type": "user",
        "uuid": active_uuid,
        "parent_tool_use_id": "tool-1",
        "message": {"role": "user", "content": "follow-up"}
    });
    assert_eq!(
        controller.replay_user_event_action(&child),
        ReplayUserEventAction::External
    );

    let replay = json!({
        "type": "user",
        "uuid": active_input_uuid(0, "msg-1"),
        "parent_tool_use_id": null,
        "message": {"role": "user", "content": "follow-up"}
    });
    assert_eq!(
        controller.replay_user_event_action(&replay),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}

#[test]
fn replay_filter_does_not_unlock_uuidless_match_from_non_initial_prompt_like_event() {
    let runtime = enabled_runtime();
    let controller = runtime.controller();
    let active_uuid = accept_active_input(&controller, 0, "msg-1", "follow-up");
    controller.mark_written(&active_uuid);

    let historical = uuidless_user_event("historical");
    assert_eq!(
        controller.replay_user_event_action(&historical),
        ReplayUserEventAction::UnknownPromptUser
    );

    let active_before_initial = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&active_before_initial),
        ReplayUserEventAction::UnknownPromptUser
    );

    let initial = uuidless_user_event("initial");
    assert_eq!(
        controller.replay_user_event_action(&initial),
        ReplayUserEventAction::UnknownPromptUser
    );

    let active_after_initial = uuidless_user_event("follow-up");
    assert_eq!(
        controller.replay_user_event_action(&active_after_initial),
        ReplayUserEventAction::InternalActiveInput
    );
    assert!(controller.close_for_result_if_idle());
}
