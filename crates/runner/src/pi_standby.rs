use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::oneshot;

use crate::ids::RunId;

const PI_STANDBY_PENDING_CAPACITY: usize = 256;

/// Control actions for a claimed Pi standby run. Release is intentionally
/// distinct from cancellation: it retires unused prewarm capacity without
/// changing the run's terminal state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PiStandbySignal {
    Handoff,
    Release,
}

enum PiStandbyDelivery {
    Signal(PiStandbySignal),
    Superseded,
}

#[derive(Clone)]
pub(crate) struct PiStandbyNotifications {
    state: Arc<Mutex<PiStandbyNotificationState>>,
}

pub(crate) struct PiStandbySubscription {
    run_id: RunId,
    registration_id: u64,
    receiver: oneshot::Receiver<PiStandbyDelivery>,
    state: Weak<Mutex<PiStandbyNotificationState>>,
}

#[derive(Default)]
struct PiStandbyNotificationState {
    active_waiters: HashMap<RunId, ActivePiStandbyWaiter>,
    pending: PendingPiStandbyNotifications,
    next_registration_id: u64,
}

struct ActivePiStandbyWaiter {
    registration_id: u64,
    sender: oneshot::Sender<PiStandbyDelivery>,
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
        while self.signals.len() > PI_STANDBY_PENDING_CAPACITY {
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

impl PiStandbyNotificationState {
    fn next_registration_id(&mut self) -> u64 {
        self.next_registration_id += 1;
        self.next_registration_id
    }

    fn deliver_or_cache(&mut self, run_id: RunId, signal: PiStandbySignal) {
        let Some(waiter) = self.active_waiters.remove(&run_id) else {
            self.pending.insert(run_id, signal);
            return;
        };
        if waiter
            .sender
            .send(PiStandbyDelivery::Signal(signal))
            .is_err()
        {
            self.pending.insert(run_id, signal);
        }
    }

    fn remove_waiter(&mut self, run_id: RunId, registration_id: u64) {
        if self
            .active_waiters
            .get(&run_id)
            .is_some_and(|waiter| waiter.registration_id == registration_id)
        {
            self.active_waiters.remove(&run_id);
        }
    }
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
        let registration_id = state.next_registration_id();
        let superseded = if let Some(signal) = state.pending.take(run_id) {
            let _ = sender.send(PiStandbyDelivery::Signal(signal));
            None
        } else {
            state.active_waiters.insert(
                run_id,
                ActivePiStandbyWaiter {
                    registration_id,
                    sender,
                },
            )
        };
        drop(state);
        if let Some(waiter) = superseded {
            let _ = waiter.sender.send(PiStandbyDelivery::Superseded);
        }

        PiStandbySubscription {
            run_id,
            registration_id,
            receiver,
            state: Arc::downgrade(&self.state),
        }
    }

    pub(crate) fn notify(&self, run_id: RunId, signal: PiStandbySignal) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .deliver_or_cache(run_id, signal);
    }
}

impl PiStandbySubscription {
    /// Returns `None` when a newer subscription replaces this registration.
    pub(crate) async fn wait(mut self) -> Option<PiStandbySignal> {
        let result = (&mut self.receiver).await;
        match result {
            Ok(PiStandbyDelivery::Signal(signal)) => Some(signal),
            Ok(PiStandbyDelivery::Superseded) => None,
            // Subscriptions hold a weak state reference, so closure means the
            // final notification owner has gone away.
            Err(_) => Some(PiStandbySignal::Release),
        }
    }
}

impl Drop for PiStandbySubscription {
    fn drop(&mut self) {
        // Close before locking so a concurrent sender either fails and caches
        // the signal or leaves it here for this subscription to recover.
        self.receiver.close();
        let delivery = self.receiver.try_recv().ok();
        let Some(state) = self.state.upgrade() else {
            return;
        };
        let mut state = state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match delivery {
            Some(PiStandbyDelivery::Signal(signal)) => {
                state.deliver_or_cache(self.run_id, signal);
            }
            Some(PiStandbyDelivery::Superseded) | None => {
                state.remove_waiter(self.run_id, self.registration_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::task::Poll;

    use futures_util::poll;

    use super::*;

    #[tokio::test]
    async fn unrelated_notifications_do_not_resolve_subscription() {
        for signal in [PiStandbySignal::Handoff, PiStandbySignal::Release] {
            let notifications = PiStandbyNotifications::new();
            let run_id = RunId::new_v4();
            let subscription = notifications.subscribe(run_id);

            for _ in 0..=PI_STANDBY_PENDING_CAPACITY {
                notifications.notify(RunId::new_v4(), PiStandbySignal::Handoff);
            }

            let wait = subscription.wait();
            tokio::pin!(wait);
            assert!(matches!(poll!(&mut wait), Poll::Pending));

            notifications.notify(run_id, signal);

            assert_eq!(wait.await, Some(signal));
        }
    }

    #[tokio::test]
    async fn subscribed_signals_survive_unrelated_notifications() {
        for signal in [PiStandbySignal::Handoff, PiStandbySignal::Release] {
            let notifications = PiStandbyNotifications::new();
            let run_id = RunId::new_v4();
            let subscription = notifications.subscribe(run_id);

            notifications.notify(run_id, signal);
            for _ in 0..=PI_STANDBY_PENDING_CAPACITY {
                notifications.notify(RunId::new_v4(), PiStandbySignal::Handoff);
            }

            assert_eq!(subscription.wait().await, Some(signal));
        }
    }

    #[tokio::test]
    async fn notification_before_subscription_is_delivered_once() {
        let notifications = PiStandbyNotifications::new();
        let run_id = RunId::new_v4();
        notifications.notify(run_id, PiStandbySignal::Handoff);

        let subscription = notifications.subscribe(run_id);

        assert_eq!(subscription.wait().await, Some(PiStandbySignal::Handoff));

        let next_subscription = notifications.subscribe(run_id);
        let wait = next_subscription.wait();
        tokio::pin!(wait);
        assert!(matches!(poll!(&mut wait), Poll::Pending));

        notifications.notify(run_id, PiStandbySignal::Release);

        assert_eq!(wait.await, Some(PiStandbySignal::Release));
    }

    #[tokio::test]
    async fn dropped_subscription_returns_later_notification_to_pending() {
        let notifications = PiStandbyNotifications::new();
        let run_id = RunId::new_v4();
        let subscription = notifications.subscribe(run_id);
        drop(subscription);

        notifications.notify(run_id, PiStandbySignal::Handoff);

        assert_eq!(
            notifications.subscribe(run_id).wait().await,
            Some(PiStandbySignal::Handoff)
        );
    }

    #[tokio::test]
    async fn dropping_superseded_subscription_preserves_replacement() {
        let notifications = PiStandbyNotifications::new();
        let run_id = RunId::new_v4();
        let subscription = notifications.subscribe(run_id);
        let replacement = notifications.subscribe(run_id);
        drop(subscription);

        notifications.notify(run_id, PiStandbySignal::Release);

        assert_eq!(replacement.wait().await, Some(PiStandbySignal::Release));
    }

    #[tokio::test]
    async fn delivered_signal_is_recovered_when_subscription_drops() {
        let notifications = PiStandbyNotifications::new();
        let run_id = RunId::new_v4();
        let subscription = notifications.subscribe(run_id);

        notifications.notify(run_id, PiStandbySignal::Release);
        drop(subscription);

        assert_eq!(
            notifications.subscribe(run_id).wait().await,
            Some(PiStandbySignal::Release)
        );
    }

    #[tokio::test]
    async fn closed_receiver_returns_failed_delivery_to_pending() {
        let notifications = PiStandbyNotifications::new();
        let run_id = RunId::new_v4();
        let mut subscription = notifications.subscribe(run_id);
        subscription.receiver.close();

        notifications.notify(run_id, PiStandbySignal::Release);
        drop(subscription);

        assert_eq!(
            notifications.subscribe(run_id).wait().await,
            Some(PiStandbySignal::Release)
        );
    }

    #[tokio::test]
    async fn superseded_subscription_finishes_without_signal() {
        let notifications = PiStandbyNotifications::new();
        let run_id = RunId::new_v4();
        let subscription = notifications.subscribe(run_id);
        let _replacement = notifications.subscribe(run_id);

        assert_eq!(subscription.wait().await, None);
    }

    #[tokio::test]
    async fn final_notification_owner_drop_releases_subscription() {
        let notifications = PiStandbyNotifications::new();
        let subscription = notifications.subscribe(RunId::new_v4());
        drop(notifications);

        assert_eq!(subscription.wait().await, Some(PiStandbySignal::Release));
    }
}
