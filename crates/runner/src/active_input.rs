use std::io::{self, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::sync::broadcast;

use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::local_queue::{ActiveInputEntry, LocalQueue};
use crate::provider::ApiClient;

/// Exec-control payloads are bounded by the guest-side process-control IPC
/// frame limit.
pub(crate) const ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES: usize = 1024 * 1024;

#[derive(serde::Serialize)]
pub(crate) struct ActiveInputPayload<'a> {
    #[serde(rename = "type")]
    payload_type: &'static str,
    text: &'a str,
}

impl<'a> ActiveInputPayload<'a> {
    pub(crate) fn new(text: &'a str) -> Self {
        Self {
            payload_type: "active-input",
            text,
        }
    }

    pub(crate) fn to_vec(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(self)
    }
}

#[derive(Default)]
struct CountingWriter {
    len: usize,
}

impl CountingWriter {
    fn len(&self) -> usize {
        self.len
    }
}

impl Write for CountingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.len = self
            .len
            .checked_add(buf.len())
            .ok_or_else(|| io::Error::other("serialized active-input payload length overflow"))?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn active_input_payload_len(text: &str) -> Result<usize, serde_json::Error> {
    let mut counter = CountingWriter::default();
    serde_json::to_writer(&mut counter, &ActiveInputPayload::new(text))?;
    Ok(counter.len())
}

pub(crate) enum ActiveInputSource {
    LocalQueue(LocalQueueActiveInputSource),
    Api(ApiActiveInputSource),
}

#[derive(Clone)]
pub(crate) struct LocalQueueActiveInputSource {
    pub(crate) queue: LocalQueue,
    pub(crate) run_id: RunId,
}

pub(crate) struct ApiActiveInputSource {
    api: ApiClient,
    run_id: RunId,
    sandbox_token: String,
    ably_subscription: Option<ActiveInputAblySubscription>,
}

const ACTIVE_INPUT_ABLY_NOTIFICATION_CAPACITY: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ActiveInputAblyNotification {
    Run(RunId),
    Resync,
}

#[derive(Clone, Debug)]
pub(crate) struct ActiveInputAblyNotifications {
    sender: broadcast::Sender<ActiveInputAblyNotification>,
    connected: Arc<AtomicBool>,
}

pub(crate) struct ActiveInputAblySubscription {
    run_id: RunId,
    receiver: broadcast::Receiver<ActiveInputAblyNotification>,
    connected: Arc<AtomicBool>,
}

impl ActiveInputAblyNotifications {
    pub(crate) fn new() -> Self {
        let (sender, receiver) = broadcast::channel(ACTIVE_INPUT_ABLY_NOTIFICATION_CAPACITY);
        drop(receiver);
        Self {
            sender,
            connected: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn subscribe(&self, run_id: RunId) -> ActiveInputAblySubscription {
        ActiveInputAblySubscription {
            run_id,
            receiver: self.sender.subscribe(),
            connected: Arc::clone(&self.connected),
        }
    }

    pub(crate) fn notify_run(&self, run_id: RunId) {
        let _ = self.sender.send(ActiveInputAblyNotification::Run(run_id));
    }

    pub(crate) fn mark_connected(&self) {
        self.connected.store(true, Ordering::Release);
        self.notify_resync();
    }

    pub(crate) fn mark_disconnected(&self) {
        self.connected.store(false, Ordering::Release);
        self.notify_resync();
    }

    fn notify_resync(&self) {
        let _ = self.sender.send(ActiveInputAblyNotification::Resync);
    }
}

impl ActiveInputAblySubscription {
    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Acquire)
    }

    pub(crate) async fn wait(&mut self) -> bool {
        loop {
            match self.receiver.recv().await {
                Ok(ActiveInputAblyNotification::Run(run_id)) if run_id == self.run_id => {
                    return true;
                }
                Ok(ActiveInputAblyNotification::Run(_)) => {}
                Ok(ActiveInputAblyNotification::Resync)
                | Err(broadcast::error::RecvError::Lagged(_)) => return true,
                Err(broadcast::error::RecvError::Closed) => return false,
            }
        }
    }

    async fn wait_or_reconcile(&mut self, max_wait: Duration) -> bool {
        tokio::select! {
            open = self.wait() => open,
            () = tokio::time::sleep(max_wait) => true,
        }
    }
}

impl ActiveInputSource {
    pub(crate) fn local_queue(queue: LocalQueue, run_id: RunId) -> Self {
        Self::LocalQueue(LocalQueueActiveInputSource { queue, run_id })
    }

    pub(crate) fn api_polling(api: ApiClient, run_id: RunId, sandbox_token: String) -> Self {
        Self::Api(ApiActiveInputSource {
            api,
            run_id,
            sandbox_token,
            ably_subscription: None,
        })
    }

    pub(crate) fn api_ably(
        api: ApiClient,
        run_id: RunId,
        sandbox_token: String,
        ably_subscription: ActiveInputAblySubscription,
    ) -> Self {
        Self::Api(ApiActiveInputSource {
            api,
            run_id,
            sandbox_token,
            ably_subscription: Some(ably_subscription),
        })
    }

    pub(crate) fn idle_max_interval(&self) -> Duration {
        match self {
            Self::LocalQueue(_) => Duration::from_millis(250),
            Self::Api(_) => Duration::from_secs(1),
        }
    }

    pub(crate) fn uses_ably_notifications(&self) -> bool {
        matches!(self, Self::Api(source) if source.ably_subscription.is_some())
    }

    pub(crate) fn ably_notifications_connected(&self) -> bool {
        matches!(self, Self::Api(source) if source
            .ably_subscription
            .as_ref()
            .is_some_and(ActiveInputAblySubscription::is_connected))
    }

    pub(crate) async fn wait_for_ably_notification_or_reconcile(&mut self, max_wait: Duration) {
        let closed = match self {
            Self::Api(source) => match source.ably_subscription.as_mut() {
                Some(subscription) => !subscription.wait_or_reconcile(max_wait).await,
                None => false,
            },
            Self::LocalQueue(_) => false,
        };
        if closed && let Self::Api(source) = self {
            source.ably_subscription = None;
        }
    }

    pub(crate) async fn read_entries_from_sequence(
        &self,
        min_sequence: u64,
    ) -> RunnerResult<Vec<ActiveInputEntry>> {
        match self {
            Self::LocalQueue(source) => {
                let source = source.clone();
                tokio::task::spawn_blocking(move || {
                    source
                        .queue
                        .read_active_input_entries_from_sequence_sync(source.run_id, min_sequence)
                })
                .await
                .map_err(|error| RunnerError::Internal(error.to_string()))
            }
            Self::Api(source) => {
                source
                    .api
                    .active_inputs(&source.sandbox_token, source.run_id, min_sequence)
                    .await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_input_payload_len_matches_serialized_payload_len() {
        let texts = [
            "plain ascii".to_string(),
            "quotes \" backslash \\ newline \n tab \t carriage \r".to_string(),
            "unicode café 你好 🚀".to_string(),
            "x".repeat(ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES - 128),
        ];

        for text in texts {
            let counted = active_input_payload_len(&text).unwrap();
            let serialized = ActiveInputPayload::new(&text).to_vec().unwrap();
            assert_eq!(counted, serialized.len(), "text len={}", text.len());
        }
    }

    #[tokio::test]
    async fn ably_subscription_filters_other_runs_and_wakes_for_its_run() {
        let notifications = ActiveInputAblyNotifications::new();
        let run_id = RunId::new_v4();
        let mut subscription = notifications.subscribe(run_id);

        notifications.notify_run(RunId::new_v4());
        notifications.notify_run(run_id);

        assert!(subscription.wait().await);
    }

    #[tokio::test]
    async fn ably_resync_wakes_every_active_input_subscription() {
        let notifications = ActiveInputAblyNotifications::new();
        let mut first = notifications.subscribe(RunId::new_v4());
        let mut second = notifications.subscribe(RunId::new_v4());

        notifications.mark_connected();

        assert!(first.is_connected());
        assert!(second.is_connected());
        assert!(first.wait().await);
        assert!(second.wait().await);

        notifications.mark_disconnected();

        assert!(!first.is_connected());
        assert!(!second.is_connected());
        assert!(first.wait().await);
        assert!(second.wait().await);
    }

    #[tokio::test(start_paused = true)]
    async fn ably_subscription_reconciles_without_a_notification() {
        let notifications = ActiveInputAblyNotifications::new();
        let mut subscription = notifications.subscribe(RunId::new_v4());

        assert!(
            subscription
                .wait_or_reconcile(Duration::from_secs(30))
                .await
        );
    }
}
