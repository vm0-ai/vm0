use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

#[derive(Clone, Debug)]
pub struct CapturedEvent {
    pub level: Level,
    pub fields: BTreeMap<String, String>,
    pub field_kinds: BTreeMap<String, &'static str>,
}

#[derive(Clone, Default)]
pub struct CapturedEvents {
    events: Arc<Mutex<Vec<CapturedEvent>>>,
}

impl CapturedEvents {
    pub fn entries(&self) -> Vec<CapturedEvent> {
        self.lock_events().clone()
    }

    pub fn clear(&self) {
        self.lock_events().clear();
    }

    fn lock_events(&self) -> MutexGuard<'_, Vec<CapturedEvent>> {
        match self.events.lock() {
            Ok(events) => events,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

impl<S> Layer<S> for CapturedEvents
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = CapturedFields::default();
        event.record(&mut visitor);
        self.lock_events().push(CapturedEvent {
            level: *event.metadata().level(),
            fields: visitor.fields,
            field_kinds: visitor.field_kinds,
        });
    }
}

#[derive(Default)]
struct CapturedFields {
    fields: BTreeMap<String, String>,
    field_kinds: BTreeMap<String, &'static str>,
}

impl CapturedFields {
    fn record_value(&mut self, field: &Field, value: String, kind: &'static str) {
        let name = field.name().to_string();
        self.fields.insert(name.clone(), value);
        self.field_kinds.insert(name, kind);
    }
}

impl Visit for CapturedFields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.record_value(field, value.to_string(), "str");
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.record_value(field, value.to_string(), "i64");
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.record_value(field, value.to_string(), "u64");
    }

    fn record_i128(&mut self, field: &Field, value: i128) {
        self.record_value(field, value.to_string(), "i128");
    }

    fn record_u128(&mut self, field: &Field, value: u128) {
        self.record_value(field, value.to_string(), "u128");
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.record_value(field, value.to_string(), "bool");
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.record_value(field, format!("{value:?}"), "debug");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use tracing_subscriber::prelude::*;

    #[test]
    fn captures_event_level_fields_and_kinds() {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());

        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!(
                str_field = "text",
                i64_field = -2_i64,
                u64_field = 2_u64,
                i128_field = -3_i128,
                u128_field = 3_u128,
                bool_field = true,
                debug_field = ?vec!["debug"],
                "captured event"
            );
        });

        let events = captured.entries();
        assert_eq!(events.len(), 1, "captured events: {events:#?}");

        let event = &events[0];
        assert_eq!(event.level, Level::WARN);
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("captured event")
        );
        assert_eq!(event.field_kinds.get("message").copied(), Some("debug"));
        assert_eq!(
            event.fields.get("str_field").map(String::as_str),
            Some("text")
        );
        assert_eq!(event.field_kinds.get("str_field").copied(), Some("str"));
        assert_eq!(
            event.fields.get("i64_field").map(String::as_str),
            Some("-2")
        );
        assert_eq!(event.field_kinds.get("i64_field").copied(), Some("i64"));
        assert_eq!(event.fields.get("u64_field").map(String::as_str), Some("2"));
        assert_eq!(event.field_kinds.get("u64_field").copied(), Some("u64"));
        assert_eq!(
            event.fields.get("i128_field").map(String::as_str),
            Some("-3")
        );
        assert_eq!(event.field_kinds.get("i128_field").copied(), Some("i128"));
        assert_eq!(
            event.fields.get("u128_field").map(String::as_str),
            Some("3")
        );
        assert_eq!(event.field_kinds.get("u128_field").copied(), Some("u128"));
        assert_eq!(
            event.fields.get("bool_field").map(String::as_str),
            Some("true")
        );
        assert_eq!(event.field_kinds.get("bool_field").copied(), Some("bool"));
        assert_eq!(
            event.fields.get("debug_field").map(String::as_str),
            Some("[\"debug\"]")
        );
        assert_eq!(event.field_kinds.get("debug_field").copied(), Some("debug"));
    }

    #[test]
    fn clear_removes_captured_events() {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());

        tracing::subscriber::with_default(subscriber, || {
            tracing::info!("first");
        });
        assert_eq!(captured.entries().len(), 1);

        captured.clear();

        assert!(captured.entries().is_empty());
    }
}
