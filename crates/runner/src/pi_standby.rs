use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::oneshot;

use crate::ids::RunId;

/// Control actions for a claimed Pi standby run. Release is intentionally
/// distinct from cancellation: it retires unused prewarm capacity without
/// changing the run's terminal state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PiStandbySignal {
    Handoff,
    Release,
}

#[derive(Clone)]
pub(crate) struct PiStandbyNotifications {
    state: Arc<Mutex<PiStandbyNotificationState>>,
}

pub(crate) struct PiStandbySubscription {
    run_id: RunId,
    receiver: oneshot::Receiver<PiStandbySignal>,
    state: Weak<Mutex<PiStandbyNotificationState>>,
}

#[derive(Default)]
struct PiStandbyNotificationState {
    active_waiters: HashMap<RunId, oneshot::Sender<PiStandbySignal>>,
}

impl PiStandbyNotifications {
    pub(crate) fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(PiStandbyNotificationState::default())),
        }
    }

    pub(crate) fn subscribe(&self, run_id: RunId) -> PiStandbySubscription {
        let (sender, receiver) = oneshot::channel();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let duplicate = match state.active_waiters.entry(run_id) {
            Entry::Vacant(entry) => {
                entry.insert(sender);
                false
            }
            Entry::Occupied(_) => true,
        };
        drop(state);
        assert!(
            !duplicate,
            "Pi standby subscription already active for run {run_id}"
        );

        PiStandbySubscription {
            run_id,
            receiver,
            state: Arc::downgrade(&self.state),
        }
    }

    pub(crate) fn notify(&self, run_id: RunId, signal: PiStandbySignal) {
        let sender = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active_waiters
            .remove(&run_id);
        if let Some(sender) = sender {
            let _ = sender.send(signal);
        }
    }
}

impl PiStandbySubscription {
    pub(crate) async fn wait(mut self) -> Option<PiStandbySignal> {
        (&mut self.receiver).await.ok()
    }
}

impl Drop for PiStandbySubscription {
    fn drop(&mut self) {
        self.receiver.close();
        let Some(state) = self.state.upgrade() else {
            return;
        };
        state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active_waiters
            .remove(&self.run_id);
    }
}

#[cfg(test)]
mod tests {
    use std::task::Poll;

    use futures_util::poll;

    use super::*;

    #[tokio::test]
    async fn unrelated_notifications_do_not_resolve_subscription() {
        let notifications = PiStandbyNotifications::new();
        let run_id = RunId::new_v4();
        let subscription = notifications.subscribe(run_id);

        notifications.notify(RunId::new_v4(), PiStandbySignal::Handoff);

        let wait = subscription.wait();
        tokio::pin!(wait);
        assert!(matches!(poll!(&mut wait), Poll::Pending));

        notifications.notify(run_id, PiStandbySignal::Release);

        assert_eq!(wait.await, Some(PiStandbySignal::Release));
    }

    #[tokio::test]
    async fn notification_before_subscription_is_not_cached() {
        let notifications = PiStandbyNotifications::new();
        let run_id = RunId::new_v4();
        notifications.notify(run_id, PiStandbySignal::Handoff);

        let subscription = notifications.subscribe(run_id);
        let wait = subscription.wait();
        tokio::pin!(wait);
        assert!(matches!(poll!(&mut wait), Poll::Pending));

        notifications.notify(run_id, PiStandbySignal::Release);

        assert_eq!(wait.await, Some(PiStandbySignal::Release));
    }

    #[tokio::test]
    async fn duplicate_subscription_panics_without_replacing_original() {
        let notifications = PiStandbyNotifications::new();
        let run_id = RunId::new_v4();
        let subscription = notifications.subscribe(run_id);

        let duplicate = std::panic::catch_unwind(|| notifications.subscribe(run_id));

        assert!(duplicate.is_err());
        notifications.notify(run_id, PiStandbySignal::Release);
        assert_eq!(subscription.wait().await, Some(PiStandbySignal::Release));
    }

    #[tokio::test]
    async fn final_notification_owner_drop_closes_subscription() {
        let notifications = PiStandbyNotifications::new();
        let subscription = notifications.subscribe(RunId::new_v4());
        drop(notifications);

        assert_eq!(subscription.wait().await, None);
    }
}
