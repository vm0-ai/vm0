use super::super::*;
use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber, info};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;

#[derive(Clone, Default)]
struct CapturedEvents {
    events: Arc<Mutex<Vec<CapturedEvent>>>,
}

#[derive(Clone, Debug, Default)]
struct CapturedEvent {
    fields: BTreeMap<String, String>,
    field_kinds: BTreeMap<String, &'static str>,
}

impl CapturedEvents {
    fn entries(&self) -> Vec<CapturedEvent> {
        self.events.lock().unwrap().clone()
    }

    fn clear(&self) {
        self.events.lock().unwrap().clear();
    }
}

impl<S> Layer<S> for CapturedEvents
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = CapturedEvent::default();
        event.record(&mut visitor);
        self.events.lock().unwrap().push(visitor);
    }
}

impl Visit for CapturedEvent {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
        self.field_kinds.insert(field.name().to_string(), "str");
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
        self.field_kinds.insert(field.name().to_string(), "u64");
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.fields
            .insert(field.name().to_string(), format!("{value:?}"));
        self.field_kinds.insert(field.name().to_string(), "debug");
    }
}

fn event_with_message<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
    events
        .iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|value| value == message)
        })
        .unwrap_or_else(|| panic!("missing event message {message:?}; captured={events:#?}"))
}

fn register_teardown_timer_callsites() {
    let timer = TeardownTimer::start();
    let phase = timer.phase_start("warmup_phase");
    timer.phase_complete("warmup_phase", phase);
    timer.event("warmup_event");
    info!(total_teardown_ms = timer.elapsed_ms(), "runner stopped");
}

#[test]
fn teardown_timer_emits_structured_timing_fields() {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    // These callsites are also hit by parallel runner tests. Reproduce the
    // problematic shape by registering them on a thread without this
    // thread-local subscriber, then rebuild the cache for this subscriber.
    std::thread::spawn(register_teardown_timer_callsites)
        .join()
        .expect("callsite warmup thread panicked");
    tracing::callsite::rebuild_interest_cache();
    captured.clear();

    let timer = TeardownTimer::start();
    let phase = timer.phase_start("test_phase");
    timer.phase_complete("test_phase", phase);
    timer.event("drop_discover_fut");
    info!(total_teardown_ms = timer.elapsed_ms(), "runner stopped");

    let events = captured.entries();
    event_with_message(&events, "teardown started");

    let started = event_with_message(&events, "teardown phase started");
    assert_eq!(
        started.fields.get("phase").map(String::as_str),
        Some("test_phase")
    );
    assert!(started.fields.contains_key("elapsed_ms"));
    assert_eq!(started.field_kinds.get("elapsed_ms").copied(), Some("u64"));

    let complete = event_with_message(&events, "teardown phase complete");
    assert_eq!(
        complete.fields.get("phase").map(String::as_str),
        Some("test_phase")
    );
    assert!(complete.fields.contains_key("phase_ms"));
    assert_eq!(complete.field_kinds.get("phase_ms").copied(), Some("u64"));
    assert!(complete.fields.contains_key("elapsed_ms"));
    assert_eq!(complete.field_kinds.get("elapsed_ms").copied(), Some("u64"));

    let event = event_with_message(&events, "teardown phase event");
    assert_eq!(
        event.fields.get("phase").map(String::as_str),
        Some("drop_discover_fut")
    );
    assert!(event.fields.contains_key("elapsed_ms"));
    assert_eq!(event.field_kinds.get("elapsed_ms").copied(), Some("u64"));

    let stopped = event_with_message(&events, "runner stopped");
    assert!(stopped.fields.contains_key("total_teardown_ms"));
    assert_eq!(
        stopped.field_kinds.get("total_teardown_ms").copied(),
        Some("u64")
    );
}
