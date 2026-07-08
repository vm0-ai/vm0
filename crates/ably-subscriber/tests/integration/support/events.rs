use std::time::Duration;

use ably_subscriber::{Event, Subscription};
use tokio::task::JoinHandle;

use super::TEST_IO_TIMEOUT;

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
