use std::collections::VecDeque;
use std::ops::AsyncFnMut;
use std::time::Duration;

use ably_subscriber::{Event, Subscription};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::TEST_IO_TIMEOUT;

const EVENT_DIAGNOSTIC_LIMIT: usize = 8;

pub(crate) async fn expect_event_with_timeout(
    sub: &mut Subscription,
    timeout: Duration,
    context: &str,
) -> Result<Event, String> {
    match tokio::time::timeout(timeout, sub.next()).await {
        Ok(Some(event)) => Ok(event),
        Ok(None) => Err(format!("subscription ended while waiting for {context}")),
        Err(_) => Err(format!("timed out waiting for {context}")),
    }
}

pub(crate) async fn expect_event(sub: &mut Subscription, context: &str) -> Result<Event, String> {
    expect_event_with_timeout(sub, TEST_IO_TIMEOUT, context).await
}

pub(crate) async fn expect_event_matching_before(
    mut next_event: impl AsyncFnMut() -> Option<Event>,
    deadline: Instant,
    expected: &str,
    mut classify: impl FnMut(&Event) -> Result<bool, String>,
) -> Result<Event, String> {
    let mut event_count = 0;
    let mut recent_events = VecDeque::with_capacity(EVENT_DIAGNOSTIC_LIMIT);
    let result = tokio::time::timeout_at(deadline, async {
        loop {
            let event = next_event()
                .await
                .ok_or_else(|| format!("subscription ended while waiting for {expected}"))?;
            event_count += 1;
            if recent_events.len() == EVENT_DIAGNOSTIC_LIMIT {
                recent_events.pop_front();
            }
            recent_events.push_back(format!("{event:?}"));

            if classify(&event)? {
                return Ok::<Event, String>(event);
            }
        }
    })
    .await;

    match result {
        Ok(Ok(event)) => Ok(event),
        Ok(Err(error)) => Err(format!(
            "{error} after {event_count} event(s); recent events: {recent_events:?}"
        )),
        Err(_) => Err(format!(
            "timed out waiting for {expected} after {event_count} event(s); recent events: {recent_events:?}"
        )),
    }
}

#[tokio::test(start_paused = true)]
async fn event_match_deadline_is_not_reset_by_nonterminal_events() {
    let expected = "Connected";
    let mut nonterminal_count = 0;
    let error = expect_event_matching_before(
        async || {
            tokio::time::sleep(Duration::from_millis(100)).await;
            Some(Event::Disconnected {
                reason: Some("retrying".to_string()),
            })
        },
        Instant::now() + Duration::from_secs(1),
        expected,
        |event| match event {
            Event::Connected => Ok(true),
            Event::Disconnected { .. } => {
                nonterminal_count += 1;
                Ok(false)
            }
            other => Err(format!("expected Connected, got {other:?}")),
        },
    )
    .await
    .unwrap_err();

    assert!(
        nonterminal_count > 1,
        "expected repeated nonterminal events, got {nonterminal_count}"
    );
    assert!(error.contains(&format!("timed out waiting for {expected}")));
    assert!(error.contains(&format!("after {nonterminal_count} event(s)")));
    assert!(error.contains("Disconnected"));
    assert!(error.contains("retrying"));
}

pub(crate) async fn expect_connected(sub: &mut Subscription, context: &str) -> Result<(), String> {
    let event = expect_event(sub, context).await?;
    if matches!(event, Event::Connected) {
        Ok(())
    } else {
        Err(format!("expected Connected for {context}, got {event:?}"))
    }
}

pub(crate) async fn expect_subscription_closed(
    sub: &mut Subscription,
    context: &str,
) -> Result<(), String> {
    match tokio::time::timeout(TEST_IO_TIMEOUT, sub.next()).await {
        Ok(None) => Ok(()),
        Ok(Some(event)) => Err(format!(
            "expected subscription to close for {context}, got {event:?}"
        )),
        Err(_) => Err(format!(
            "timed out waiting for subscription close for {context}"
        )),
    }
}

pub(crate) async fn join_server_task(
    mut task: JoinHandle<()>,
    context: &str,
) -> Result<(), String> {
    match tokio::time::timeout(TEST_IO_TIMEOUT, &mut task).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(format!("{context} task panicked: {error}")),
        Err(_) => {
            task.abort();
            let _ = task.await;
            Err(format!("timed out waiting for {context} task"))
        }
    }
}

pub(crate) async fn abort_server_task(task: JoinHandle<()>, context: &str) -> Result<(), String> {
    task.abort();
    match task.await {
        Ok(()) => Ok(()),
        Err(error) if error.is_cancelled() => Ok(()),
        Err(error) => Err(format!("{context} task panicked: {error}")),
    }
}

pub(crate) async fn wait_for_test_observation(
    rx: tokio::sync::oneshot::Receiver<()>,
    context: &'static str,
) {
    let observed = tokio::time::timeout(TEST_IO_TIMEOUT, rx).await;
    assert!(
        matches!(observed, Ok(Ok(()))),
        "timed out or dropped observation signal for {context}: {observed:?}",
    );
}

// Negative waits still need a real observation window; keep them explicit so
// they are not confused with arbitrary synchronization delays.
pub(crate) async fn assert_value_stable_for<T>(
    window: Duration,
    mut current: impl FnMut() -> T,
    expected: T,
    context: &'static str,
) where
    T: std::fmt::Debug + PartialEq,
{
    tokio::time::sleep(window).await;
    assert_eq!(current(), expected, "{context}");
}
