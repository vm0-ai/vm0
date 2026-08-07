use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use tokio::sync::broadcast;

use crate::ids::RunId;

const PI_STANDBY_NOTIFICATION_CAPACITY: usize = 256;

/// Control actions for a claimed Pi standby run. Release is intentionally
/// distinct from cancellation: it retires unused prewarm capacity without
/// changing the run's terminal state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PiStandbySignal {
    Handoff,
    Release,
}

#[derive(Clone, Copy, Debug)]
struct PiStandbyNotification {
    run_id: RunId,
    signal: PiStandbySignal,
}

#[derive(Clone)]
pub(crate) struct PiStandbyNotifications {
    sender: broadcast::Sender<PiStandbyNotification>,
    pending: Arc<Mutex<PendingPiStandbyNotifications>>,
}

pub(crate) struct PiStandbySubscription {
    run_id: RunId,
    receiver: broadcast::Receiver<PiStandbyNotification>,
    pending: Arc<Mutex<PendingPiStandbyNotifications>>,
}

#[derive(Default)]
struct PendingPiStandbyNotifications {
    signals: HashMap<RunId, PiStandbySignal>,
    order: VecDeque<RunId>,
}

impl PendingPiStandbyNotifications {
    fn insert(&mut self, run_id: RunId, signal: PiStandbySignal) {
        if !self.signals.contains_key(&run_id) {
            self.order.push_back(run_id);
        }
        self.signals.insert(run_id, signal);
        while self.signals.len() > PI_STANDBY_NOTIFICATION_CAPACITY {
            let Some(expired_run_id) = self.order.pop_front() else {
                break;
            };
            self.signals.remove(&expired_run_id);
        }
    }

    fn take(&mut self, run_id: RunId) -> Option<PiStandbySignal> {
        let signal = self.signals.remove(&run_id)?;
        if let Some(index) = self.order.iter().position(|candidate| *candidate == run_id) {
            self.order.remove(index);
        }
        Some(signal)
    }
}

impl PiStandbyNotifications {
    pub(crate) fn new() -> Self {
        let (sender, receiver) = broadcast::channel(PI_STANDBY_NOTIFICATION_CAPACITY);
        drop(receiver);
        Self {
            sender,
            pending: Arc::new(Mutex::new(PendingPiStandbyNotifications::default())),
        }
    }

    pub(crate) fn subscribe(&self, run_id: RunId) -> PiStandbySubscription {
        PiStandbySubscription {
            run_id,
            receiver: self.sender.subscribe(),
            pending: Arc::clone(&self.pending),
        }
    }

    pub(crate) fn notify(&self, run_id: RunId, signal: PiStandbySignal) {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(run_id, signal);
        let _ = self.sender.send(PiStandbyNotification { run_id, signal });
    }
}

impl PiStandbySubscription {
    fn take_pending(&self) -> Option<PiStandbySignal> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take(self.run_id)
    }

    pub(crate) async fn wait(&mut self) -> PiStandbySignal {
        if let Some(signal) = self.take_pending() {
            return signal;
        }
        loop {
            match self.receiver.recv().await {
                Ok(notification) if notification.run_id == self.run_id => {
                    return self.take_pending().unwrap_or(notification.signal);
                }
                Ok(_) => {}
                // A lagged standby must re-read the durable transcript. Treat
                // the wakeup as handoff; the zero agent decides from API state
                // whether a pending tool batch actually exists.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    return self.take_pending().unwrap_or(PiStandbySignal::Handoff);
                }
                Err(broadcast::error::RecvError::Closed) => {
                    return self.take_pending().unwrap_or(PiStandbySignal::Release);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscription_filters_other_runs_and_preserves_release_semantics() {
        let notifications = PiStandbyNotifications::new();
        let run_id = RunId::new_v4();
        let mut subscription = notifications.subscribe(run_id);

        notifications.notify(RunId::new_v4(), PiStandbySignal::Handoff);
        notifications.notify(run_id, PiStandbySignal::Release);

        assert_eq!(subscription.wait().await, PiStandbySignal::Release);
    }

    #[tokio::test]
    async fn notification_before_subscription_is_delivered_once() {
        let notifications = PiStandbyNotifications::new();
        let run_id = RunId::new_v4();
        notifications.notify(run_id, PiStandbySignal::Handoff);

        let mut subscription = notifications.subscribe(run_id);

        assert_eq!(subscription.wait().await, PiStandbySignal::Handoff);
        assert!(subscription.take_pending().is_none());
    }
}
