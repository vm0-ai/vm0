use tracing::Dispatch;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

fn emit_shared_callsite(marker: &'static str) {
    tracing::warn!(marker, "shared callsite");
}

fn captured_markers(captured: &CapturedEvents) -> Vec<Option<String>> {
    captured
        .entries()
        .into_iter()
        .map(|event| event.fields.get("marker").cloned())
        .collect()
}

#[test]
fn captures_callsite_first_registered_on_uncaptured_thread() {
    let first_capture = CapturedEvents::default();
    let first_dispatch = Dispatch::new(tracing_subscriber::registry().with(first_capture.clone()));

    std::thread::spawn(|| emit_shared_callsite("uncaptured"))
        .join()
        .expect("uncaptured event thread should finish");
    tracing::dispatcher::with_default(&first_dispatch, || emit_shared_callsite("first"));

    let second_capture = CapturedEvents::default();
    let second_dispatch =
        Dispatch::new(tracing_subscriber::registry().with(second_capture.clone()));
    tracing::dispatcher::with_default(&second_dispatch, || emit_shared_callsite("second"));

    assert_eq!(
        captured_markers(&first_capture),
        vec![Some("first".to_string())]
    );
    assert_eq!(
        captured_markers(&second_capture),
        vec![Some("second".to_string())]
    );
}
