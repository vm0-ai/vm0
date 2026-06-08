use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant as StdInstant};

use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use super::api::ApiClient;
use crate::ids::RunId;
use crate::retry::{RetryState, recv_retry, sleep_until_retry};
use crate::run_cancellation::{RunCancellationHandle, SharedRunCancellationMap};

const ABLY_BACKOFF_INITIAL: Duration = Duration::from_secs(5);
const ABLY_BACKOFF_MAX: Duration = Duration::from_secs(60);
const ABLY_DISCONNECT_ERROR_AFTER: Duration = Duration::from_secs(60);
const TARGETED_RUNNER_DEFER: Duration = Duration::from_secs(2);
// Bound repeated target-other notifications so one runner is not starved forever.
const TARGETED_RUNNER_DEFER_MAX: Duration = Duration::from_secs(10);

type AblyConnectHandle =
    tokio::task::JoinHandle<Result<ably_subscriber::Subscription, ably_subscriber::Error>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PollReason {
    Immediate,
    Deferred,
    WakeupRetry,
    Slow,
    Fast,
}

impl PollReason {
    pub(super) fn is_wakeup(self) -> bool {
        matches!(self, Self::Immediate | Self::Deferred | Self::WakeupRetry)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PollDue {
    reason: PollReason,
    /// Wakeup generation observed immediately before starting the HTTP poll.
    /// Poll results must not clear wakeups that arrive while that request is in flight.
    generation: u64,
}

impl PollDue {
    pub(super) fn reason(self) -> PollReason {
        self.reason
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PollOutcome {
    JobFound,
    Empty,
    Failure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PollRecord {
    defer_job_return: bool,
}

impl PollRecord {
    pub(super) fn defer_job_return(self) -> bool {
        self.defer_job_return
    }
}

pub(super) struct PollWakeups {
    inner: Mutex<PollWakeupsInner>,
    notify: Notify,
}

#[derive(Debug)]
struct PollWakeupsInner {
    ably_connected: bool,
    poll_now: bool,
    deferred_poll_at: Option<tokio::time::Instant>,
    deferred_poll_cap_at: Option<tokio::time::Instant>,
    wakeup_retry_at: Option<tokio::time::Instant>,
    /// Bumped whenever a new wakeup is recorded. This keeps an older HTTP poll
    /// result from clearing a wakeup that arrived after the poll started.
    generation: u64,
}

impl PollWakeupsInner {
    fn bump_generation(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }
}

#[derive(Debug, Clone, Copy)]
struct ScheduledPoll {
    at: tokio::time::Instant,
    reason: PollReason,
}

impl PollWakeups {
    pub(super) fn new(ably_connected: bool) -> Self {
        Self {
            inner: Mutex::new(PollWakeupsInner {
                ably_connected,
                poll_now: true,
                deferred_poll_at: None,
                deferred_poll_cap_at: None,
                wakeup_retry_at: None,
                generation: 0,
            }),
            notify: Notify::new(),
        }
    }

    pub(super) async fn mark_ably_connected(&self) {
        self.inner.lock().await.ably_connected = true;
        self.notify.notify_waiters();
    }

    pub(super) async fn mark_ably_disconnected(&self) {
        self.inner.lock().await.ably_connected = false;
        self.notify.notify_waiters();
    }

    async fn request_immediate_poll(&self) {
        let mut inner = self.inner.lock().await;
        inner.poll_now = true;
        inner.bump_generation();
        self.notify.notify_waiters();
    }

    async fn request_deferred_poll_after(&self, delay: Duration) {
        let now = tokio::time::Instant::now();
        self.request_deferred_poll_capped_at(now + delay, now + TARGETED_RUNNER_DEFER_MAX)
            .await;
    }

    async fn request_deferred_poll_capped_at(
        &self,
        at: tokio::time::Instant,
        cap_at: tokio::time::Instant,
    ) {
        let mut inner = self.inner.lock().await;
        let cap_at = *inner.deferred_poll_cap_at.get_or_insert(cap_at);
        let at = at.min(cap_at);
        if inner.deferred_poll_at.is_none_or(|existing| at > existing) {
            inner.deferred_poll_at = Some(at);
        }
        inner.bump_generation();
        drop(inner);
        self.notify.notify_waiters();
    }

    #[cfg(test)]
    async fn request_deferred_poll_at(&self, at: tokio::time::Instant) {
        self.request_deferred_poll_capped_at(at, at).await;
    }

    #[cfg(test)]
    pub(super) async fn request_deferred_poll_after_for_test(&self, delay: Duration) {
        self.request_deferred_poll_after(delay).await;
    }

    pub(super) async fn record_poll_result(
        &self,
        due: PollDue,
        outcome: PollOutcome,
        wakeup_retry_delay: Duration,
    ) -> PollRecord {
        let mut should_notify = false;
        let mut inner = self.inner.lock().await;
        let has_new_wakeup = inner.generation != due.generation;
        let defer_job_return =
            outcome == PollOutcome::JobFound && has_new_wakeup && inner.deferred_poll_at.is_some();
        match outcome {
            PollOutcome::JobFound => {
                inner.poll_now = true;
                if !has_new_wakeup {
                    inner.deferred_poll_at = None;
                    inner.deferred_poll_cap_at = None;
                    inner.wakeup_retry_at = None;
                }
                inner.bump_generation();
                should_notify = true;
            }
            PollOutcome::Empty => {
                if !has_new_wakeup {
                    inner.deferred_poll_at = None;
                    inner.deferred_poll_cap_at = None;
                    inner.wakeup_retry_at = None;
                }
            }
            PollOutcome::Failure if due.reason.is_wakeup() => {
                inner.wakeup_retry_at = Some(tokio::time::Instant::now() + wakeup_retry_delay);
                inner.bump_generation();
                should_notify = true;
            }
            PollOutcome::Failure => {}
        }
        drop(inner);
        if should_notify {
            self.notify.notify_waiters();
        }
        PollRecord { defer_job_return }
    }

    pub(super) async fn wait_for_poll_due(
        &self,
        cancel: &CancellationToken,
        slow_interval: Duration,
        fast_interval: Duration,
    ) -> Option<PollDue> {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            let scheduled = {
                let mut inner = self.inner.lock().await;
                let now = tokio::time::Instant::now();
                if inner.deferred_poll_at.is_some_and(|at| at <= now) {
                    inner.deferred_poll_at = None;
                    inner.deferred_poll_cap_at = None;
                    inner.poll_now = false;
                    return Some(PollDue {
                        reason: PollReason::Deferred,
                        generation: inner.generation,
                    });
                }
                if inner.deferred_poll_at.is_some() {
                    Self::next_scheduled(&inner, now, slow_interval, fast_interval)
                } else if inner.poll_now {
                    inner.poll_now = false;
                    return Some(PollDue {
                        reason: PollReason::Immediate,
                        generation: inner.generation,
                    });
                } else if inner.wakeup_retry_at.is_some_and(|at| at <= now) {
                    inner.wakeup_retry_at = None;
                    return Some(PollDue {
                        reason: PollReason::WakeupRetry,
                        generation: inner.generation,
                    });
                } else {
                    Self::next_scheduled(&inner, now, slow_interval, fast_interval)
                }
            };

            tokio::select! {
                () = cancel.cancelled() => {
                    return None;
                }
                () = &mut notified => {}
                () = tokio::time::sleep_until(scheduled.at) => {
                    if let Some(due) = self.consume_scheduled(scheduled).await {
                        return Some(due);
                    }
                }
            }
        }
    }

    fn next_scheduled(
        inner: &PollWakeupsInner,
        now: tokio::time::Instant,
        slow_interval: Duration,
        fast_interval: Duration,
    ) -> ScheduledPoll {
        let mut scheduled = if let Some(at) = inner.deferred_poll_at {
            ScheduledPoll {
                at,
                reason: PollReason::Deferred,
            }
        } else if inner.ably_connected {
            ScheduledPoll {
                at: now + slow_interval,
                reason: PollReason::Slow,
            }
        } else {
            ScheduledPoll {
                at: now + fast_interval,
                reason: PollReason::Fast,
            }
        };

        if inner.deferred_poll_at.is_none()
            && let Some(at) = inner.wakeup_retry_at
            && at <= scheduled.at
        {
            scheduled = ScheduledPoll {
                at,
                reason: PollReason::WakeupRetry,
            };
        }
        scheduled
    }

    async fn consume_scheduled(&self, scheduled: ScheduledPoll) -> Option<PollDue> {
        let mut inner = self.inner.lock().await;
        let now = tokio::time::Instant::now();

        let is_due = match scheduled.reason {
            PollReason::Immediate => false,
            PollReason::WakeupRetry => {
                if inner.deferred_poll_at.is_none()
                    && inner.wakeup_retry_at.is_some_and(|at| at <= now)
                {
                    inner.wakeup_retry_at = None;
                    true
                } else {
                    false
                }
            }
            PollReason::Deferred => {
                if inner.deferred_poll_at.is_some_and(|at| at <= now) {
                    inner.deferred_poll_at = None;
                    inner.deferred_poll_cap_at = None;
                    inner.poll_now = false;
                    true
                } else {
                    false
                }
            }
            PollReason::Slow => {
                inner.deferred_poll_at.is_none()
                    && inner.ably_connected
                    && !inner.poll_now
                    && !Self::has_due_wakeup(&inner, now)
            }
            PollReason::Fast => {
                inner.deferred_poll_at.is_none()
                    && !inner.ably_connected
                    && !inner.poll_now
                    && !Self::has_due_wakeup(&inner, now)
            }
        };
        is_due.then_some(PollDue {
            reason: scheduled.reason,
            generation: inner.generation,
        })
    }

    fn has_due_wakeup(inner: &PollWakeupsInner, now: tokio::time::Instant) -> bool {
        inner.wakeup_retry_at.is_some_and(|at| at <= now)
            || inner.deferred_poll_at.is_some_and(|at| at <= now)
    }

    #[cfg(test)]
    async fn snapshot(&self) -> PollWakeupsSnapshot {
        let inner = self.inner.lock().await;
        PollWakeupsSnapshot {
            ably_connected: inner.ably_connected,
            poll_now: inner.poll_now,
            deferred_poll_at: inner.deferred_poll_at,
            deferred_poll_cap_at: inner.deferred_poll_cap_at,
            wakeup_retry_at: inner.wakeup_retry_at,
        }
    }
}

#[cfg(test)]
#[derive(Debug)]
struct PollWakeupsSnapshot {
    ably_connected: bool,
    poll_now: bool,
    deferred_poll_at: Option<tokio::time::Instant>,
    deferred_poll_cap_at: Option<tokio::time::Instant>,
    wakeup_retry_at: Option<tokio::time::Instant>,
}

pub(super) struct AblySupervisor {
    shutdown: CancellationToken,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl AblySupervisor {
    pub(super) fn spawn(
        api: ApiClient,
        group: String,
        runner_id: String,
        poll_wakeups: Arc<PollWakeups>,
        cancel_tokens: SharedRunCancellationMap,
        provider_cancel: CancellationToken,
    ) -> Self {
        let shutdown = CancellationToken::new();
        let task_shutdown = shutdown.clone();
        let task = tokio::spawn(async move {
            run_supervisor(
                api,
                group,
                runner_id,
                poll_wakeups,
                cancel_tokens,
                provider_cancel,
                task_shutdown,
            )
            .await;
        });
        Self {
            shutdown,
            task: Mutex::new(Some(task)),
        }
    }

    pub(super) async fn shutdown(&self) {
        self.shutdown.cancel();
        let task = self.task.lock().await.take();
        if let Some(task) = task
            && let Err(e) = task.await
        {
            warn!(error = %e, "ably supervisor task failed during shutdown");
        }
    }

    #[cfg(test)]
    pub(super) fn disabled() -> Self {
        Self {
            shutdown: CancellationToken::new(),
            task: Mutex::new(None),
        }
    }

    #[cfg(test)]
    fn spawn_test_task<F>(build: impl FnOnce(CancellationToken) -> F) -> Self
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        let shutdown = CancellationToken::new();
        let task = tokio::spawn(build(shutdown.clone()));
        Self {
            shutdown,
            task: Mutex::new(Some(task)),
        }
    }
}

async fn run_supervisor(
    api: ApiClient,
    group: String,
    runner_id: String,
    poll_wakeups: Arc<PollWakeups>,
    cancel_tokens: SharedRunCancellationMap,
    provider_cancel: CancellationToken,
    shutdown: CancellationToken,
) {
    let mut ably: Option<ably_subscriber::Subscription> = None;
    let mut ably_retry: RetryState<AblyConnectHandle> =
        RetryState::new(ABLY_BACKOFF_INITIAL, ABLY_BACKOFF_MAX, None);
    ably_retry.restart_at = Some(StdInstant::now());
    let mut disconnect = AblyDisconnectState::disconnected("connecting".to_string());

    loop {
        maybe_spawn_ably_connect(&mut ably, &api, &group, &mut ably_retry);
        let disconnect_error_at = disconnect.error_deadline();

        tokio::select! {
            () = shutdown.cancelled() => {
                break;
            }
            () = provider_cancel.cancelled() => {
                break;
            }
            event = recv_ably(&mut ably) => {
                match event {
                    Some(ably_subscriber::Event::Message(msg)) => {
                        handle_ably_message(&msg, &runner_id, &poll_wakeups, &cancel_tokens).await;
                    }
                    Some(ably_subscriber::Event::Connected) => {
                        if !disconnect.is_connected() {
                            info!("ably reconnected");
                        }
                        disconnect.mark_connected();
                        poll_wakeups.mark_ably_connected().await;
                    }
                    Some(ably_subscriber::Event::Disconnected { reason }) => {
                        let reason = reason.unwrap_or_else(|| "unknown".to_string());
                        disconnect.record_disconnected(reason.clone());
                        poll_wakeups.mark_ably_disconnected().await;
                        info!(reason = %reason, "ably disconnected, switching to fast poll");
                    }
                    Some(ably_subscriber::Event::Error { code, message }) => {
                        error!(code, message = %message, "ably fatal error, will reconnect");
                        disconnect.record_disconnected(message.clone());
                        poll_wakeups.mark_ably_disconnected().await;
                        ably = None;
                        ably_retry.schedule();
                    }
                    None => {
                        warn!("ably subscription closed, will reconnect");
                        disconnect.record_disconnected("subscription closed".to_string());
                        poll_wakeups.mark_ably_disconnected().await;
                        ably = None;
                        ably_retry.schedule();
                    }
                }
            }
            result = recv_retry(&mut ably_retry.handle) => {
                match handle_ably_connect_result(result, &mut ably, &mut ably_retry) {
                    Ok(()) => {
                        disconnect.mark_connected();
                        poll_wakeups.mark_ably_connected().await;
                    }
                    Err(reason) => {
                        disconnect.record_disconnected(reason);
                        poll_wakeups.mark_ably_disconnected().await;
                    }
                }
            }
            () = sleep_until_retry(&ably_retry.restart_at) => {}
            () = sleep_until_optional(disconnect_error_at), if disconnect_error_at.is_some() => {
                disconnect.mark_error_logged();
                error!(
                    reason = %disconnect.reason(),
                    disconnected_secs = disconnect.disconnected_secs(),
                    "ably disconnected for too long, continuing fast poll"
                );
            }
        }
    }

    if let Some(sub) = ably.take() {
        sub.close();
    }
    if let Some(handle) = ably_retry.handle.take() {
        handle.abort();
        let _ = handle.await;
    }
}

async fn handle_ably_message(
    msg: &ably_subscriber::Message,
    runner_id: &str,
    poll_wakeups: &PollWakeups,
    cancel_tokens: &Mutex<HashMap<RunId, RunCancellationHandle>>,
) {
    if let Some(run_id) = parse_cancel_notification(msg) {
        let handle = cancel_tokens.lock().await.get(&run_id).cloned();
        if let Some(handle) = handle {
            info!(run_id = %run_id, "ably: cancel notification, killing job");
            handle.cancel().await;
        }
        return;
    }

    if let Some(notif) = parse_job_notification(msg) {
        if notif
            .target_runner_id
            .as_deref()
            .is_some_and(|target| target != runner_id)
        {
            info!(
                run_id = %notif.run_id,
                target = notif.target_runner_id.as_deref().unwrap_or(""),
                "ably: job targeted to another runner, deferring poll"
            );
            poll_wakeups
                .request_deferred_poll_after(TARGETED_RUNNER_DEFER)
                .await;
            return;
        }

        let targeted = notif
            .target_runner_id
            .as_deref()
            .is_some_and(|target| target == runner_id);
        info!(
            run_id = %notif.run_id,
            profile = notif.profile.as_deref().unwrap_or(""),
            targeted,
            "ably: job notification, waking poll"
        );
        poll_wakeups.request_immediate_poll().await;
    }
}

struct JobNotification {
    run_id: RunId,
    profile: Option<String>,
    target_runner_id: Option<String>,
}

fn parse_cancel_notification(msg: &ably_subscriber::Message) -> Option<RunId> {
    if msg.name.as_deref() != Some("cancel") {
        return None;
    }
    let raw = msg.data.get("runId").and_then(|v| v.as_str())?;
    match raw.parse() {
        Ok(id) => Some(id),
        Err(e) => {
            warn!(value = %raw, error = %e, "ably: invalid cancel runId");
            None
        }
    }
}

fn parse_job_notification(msg: &ably_subscriber::Message) -> Option<JobNotification> {
    if msg.name.as_deref() != Some("job") {
        return None;
    }
    let raw = msg.data.get("runId").and_then(|v| v.as_str());
    let run_id = match raw {
        Some(s) => match s.parse() {
            Ok(id) => id,
            Err(e) => {
                warn!(value = %s, error = %e, "ably: invalid runId");
                return None;
            }
        },
        None => {
            warn!(data = %msg.data, "ably: job message missing runId");
            return None;
        }
    };
    let profile = msg
        .data
        .get("profile")
        .and_then(|v| v.as_str())
        .map(String::from);
    let target_runner_id = msg
        .data
        .get("targetRunnerId")
        .and_then(|v| v.as_str())
        .map(String::from);
    Some(JobNotification {
        run_id,
        profile,
        target_runner_id,
    })
}

async fn recv_ably(
    ably: &mut Option<ably_subscriber::Subscription>,
) -> Option<ably_subscriber::Event> {
    match ably {
        Some(sub) => sub.next().await,
        None => std::future::pending().await,
    }
}

async fn sleep_until_optional(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

fn make_ably_config(api: &ApiClient, group: &str) -> ably_subscriber::SubscribeConfig {
    let api = api.clone();
    let channel = format!("runner-group:{group}");
    let group = group.to_owned();
    let get_token: Box<dyn Fn() -> ably_subscriber::TokenFuture + Send + Sync> =
        Box::new(move || {
            let api = api.clone();
            let group = group.clone();
            Box::pin(async move {
                api.realtime_token(&group)
                    .await
                    .map_err(|e| Box::new(e) as ably_subscriber::BoxError)
            })
        });
    ably_subscriber::SubscribeConfig::new(get_token, channel)
}

fn maybe_spawn_ably_connect(
    ably: &mut Option<ably_subscriber::Subscription>,
    api: &ApiClient,
    group: &str,
    retry: &mut RetryState<AblyConnectHandle>,
) {
    if ably.is_some() || !retry.timer_ready() {
        return;
    }
    retry.clear_timer();
    let ably_config = make_ably_config(api, group);
    retry.handle = Some(tokio::spawn(ably_subscriber::subscribe(ably_config)));
}

fn handle_ably_connect_result(
    result: Result<ably_subscriber::Subscription, String>,
    ably: &mut Option<ably_subscriber::Subscription>,
    retry: &mut RetryState<AblyConnectHandle>,
) -> Result<(), String> {
    match result {
        Ok(sub) => {
            if retry.consecutive_failures() > 0 {
                info!(
                    attempts = retry.consecutive_failures(),
                    "ably connected after failures"
                );
            } else {
                info!("ably connected");
            }
            *ably = Some(sub);
            retry.on_success();
            Ok(())
        }
        Err(e) => {
            let next_secs = retry.backoff().as_secs();
            let _ = retry.on_failure();
            warn!(
                error = %e,
                failures = retry.consecutive_failures(),
                next_attempt_secs = next_secs,
                "ably connect failed"
            );
            Err(e)
        }
    }
}

struct AblyDisconnectState {
    connected: bool,
    disconnected_at: Option<tokio::time::Instant>,
    error_logged: bool,
    reason: Option<String>,
}

impl AblyDisconnectState {
    fn disconnected(reason: String) -> Self {
        Self {
            connected: false,
            disconnected_at: Some(tokio::time::Instant::now()),
            error_logged: false,
            reason: Some(reason),
        }
    }

    fn is_connected(&self) -> bool {
        self.connected
    }

    fn mark_connected(&mut self) {
        self.connected = true;
        self.disconnected_at = None;
        self.error_logged = false;
        self.reason = None;
    }

    fn record_disconnected(&mut self, reason: String) {
        if self.connected || self.disconnected_at.is_none() {
            self.disconnected_at = Some(tokio::time::Instant::now());
            self.error_logged = false;
        }
        self.connected = false;
        self.reason = Some(reason);
    }

    fn error_deadline(&self) -> Option<tokio::time::Instant> {
        if self.connected || self.error_logged {
            None
        } else {
            self.disconnected_at
                .map(|at| at + ABLY_DISCONNECT_ERROR_AFTER)
        }
    }

    fn mark_error_logged(&mut self) {
        self.error_logged = true;
    }

    fn disconnected_secs(&self) -> u64 {
        self.disconnected_at
            .map(|at| at.elapsed().as_secs())
            .unwrap_or_else(|| ABLY_DISCONNECT_ERROR_AFTER.as_secs())
    }

    fn reason(&self) -> &str {
        self.reason.as_deref().unwrap_or("unknown")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_message(name: Option<&str>, data: serde_json::Value) -> ably_subscriber::Message {
        ably_subscriber::Message {
            name: name.map(String::from),
            data,
            id: None,
            client_id: None,
            timestamp: None,
        }
    }

    fn poll_reason(due: Option<PollDue>) -> Option<PollReason> {
        due.map(PollDue::reason)
    }

    #[tokio::test(start_paused = true)]
    async fn wait_for_poll_due_consumes_stateful_immediate_wakeup() {
        let wakeups = PollWakeups::new(true);

        let reason = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;

        assert_eq!(poll_reason(reason), Some(PollReason::Immediate));
        let snapshot = wakeups.snapshot().await;
        assert!(snapshot.ably_connected);
        assert!(!snapshot.poll_now);
    }

    #[tokio::test(start_paused = true)]
    async fn wakeup_poll_failure_schedules_short_retry() {
        let wakeups = PollWakeups::new(true);
        let reason = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();

        wakeups
            .record_poll_result(reason, PollOutcome::Failure, Duration::from_secs(5))
            .await;
        let snapshot = wakeups.snapshot().await;
        assert!(snapshot.wakeup_retry_at.is_some());

        tokio::time::sleep(Duration::from_secs(5)).await;
        let reason = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        assert_eq!(poll_reason(reason), Some(PollReason::WakeupRetry));
    }

    #[tokio::test(start_paused = true)]
    async fn regular_poll_failure_does_not_schedule_wakeup_retry() {
        let wakeups = PollWakeups::new(false);
        let due = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        wakeups
            .record_poll_result(due, PollOutcome::Empty, Duration::from_secs(5))
            .await;

        tokio::time::sleep(Duration::from_secs(5)).await;
        let due = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert_eq!(due.reason(), PollReason::Fast);

        wakeups
            .record_poll_result(due, PollOutcome::Failure, Duration::from_secs(5))
            .await;
        assert!(wakeups.snapshot().await.wakeup_retry_at.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn disconnected_state_uses_fast_poll_interval() {
        let wakeups = Arc::new(PollWakeups::new(false));
        let due = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        wakeups
            .record_poll_result(due, PollOutcome::Empty, Duration::from_secs(5))
            .await;

        let wakeups_for_wait = Arc::clone(&wakeups);
        let cancel = CancellationToken::new();
        let wait = tokio::spawn(async move {
            wakeups_for_wait
                .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
                .await
        });
        tokio::time::sleep(Duration::from_secs(5)).await;

        assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Fast));
    }

    #[tokio::test(start_paused = true)]
    async fn connected_state_uses_slow_poll_interval() {
        let wakeups = Arc::new(PollWakeups::new(true));
        let due = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        wakeups
            .record_poll_result(due, PollOutcome::Empty, Duration::from_secs(5))
            .await;

        let wakeups_for_wait = Arc::clone(&wakeups);
        let cancel = CancellationToken::new();
        let wait = tokio::spawn(async move {
            wakeups_for_wait
                .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
                .await
        });
        tokio::time::sleep(Duration::from_secs(30)).await;

        assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Slow));
    }

    #[tokio::test]
    async fn job_found_rearms_immediate_poll_for_backlog_drain() {
        let wakeups = PollWakeups::new(true);
        let reason = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();

        wakeups
            .record_poll_result(reason, PollOutcome::JobFound, Duration::from_secs(5))
            .await;

        assert!(wakeups.snapshot().await.poll_now);
        let reason = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        assert_eq!(poll_reason(reason), Some(PollReason::Immediate));
    }

    #[tokio::test(start_paused = true)]
    async fn target_other_runner_deferred_poll_extends_until_latest_deadline() {
        let wakeups = Arc::new(PollWakeups::new(true));
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;

        wakeups
            .request_deferred_poll_after(Duration::from_secs(2))
            .await;
        let first_deadline = wakeups
            .snapshot()
            .await
            .deferred_poll_at
            .expect("first defer deadline");
        tokio::time::sleep(Duration::from_secs(1)).await;
        wakeups
            .request_deferred_poll_after(Duration::from_secs(2))
            .await;
        let extended_deadline = wakeups
            .snapshot()
            .await
            .deferred_poll_at
            .expect("extended defer deadline");

        assert!(extended_deadline > first_deadline);
        let wakeups_for_wait = Arc::clone(&wakeups);
        let cancel = CancellationToken::new();
        let wait = tokio::spawn(async move {
            wakeups_for_wait
                .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
                .await
        });
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(
            !wait.is_finished(),
            "new target-other notification should extend the defer window"
        );

        tokio::time::sleep_until(extended_deadline).await;
        assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Deferred));
    }

    #[tokio::test(start_paused = true)]
    async fn target_other_runner_deferred_poll_extension_is_bounded() {
        let wakeups = PollWakeups::new(true);
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;

        wakeups
            .request_deferred_poll_after(Duration::from_secs(2))
            .await;
        let cap = wakeups
            .snapshot()
            .await
            .deferred_poll_cap_at
            .expect("defer cap");
        for _ in 0..9 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            wakeups
                .request_deferred_poll_after(Duration::from_secs(2))
                .await;
        }

        let snapshot = wakeups.snapshot().await;
        assert_eq!(snapshot.deferred_poll_at, Some(cap));
        assert_eq!(snapshot.deferred_poll_cap_at, Some(cap));
        tokio::time::sleep_until(cap).await;
        let reason = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        assert_eq!(poll_reason(reason), Some(PollReason::Deferred));
    }

    #[tokio::test(start_paused = true)]
    async fn target_other_runner_deferred_poll_cap_resets_after_deadline() {
        let wakeups = PollWakeups::new(true);
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;

        wakeups
            .request_deferred_poll_after(Duration::from_secs(2))
            .await;
        let initial_cap = wakeups
            .snapshot()
            .await
            .deferred_poll_cap_at
            .expect("initial defer cap");
        for _ in 0..9 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            wakeups
                .request_deferred_poll_after(Duration::from_secs(2))
                .await;
        }

        tokio::time::sleep_until(initial_cap).await;
        let reason = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        assert_eq!(poll_reason(reason), Some(PollReason::Deferred));
        let snapshot = wakeups.snapshot().await;
        assert!(snapshot.deferred_poll_at.is_none());
        assert!(snapshot.deferred_poll_cap_at.is_none());

        wakeups
            .request_deferred_poll_after(Duration::from_secs(2))
            .await;
        let snapshot = wakeups.snapshot().await;
        let next_deadline = snapshot
            .deferred_poll_at
            .expect("next defer deadline should be scheduled");
        let next_cap = snapshot
            .deferred_poll_cap_at
            .expect("next defer cap should be scheduled");
        assert!(next_deadline > initial_cap);
        assert!(next_cap > next_deadline);
    }

    #[tokio::test(start_paused = true)]
    async fn target_other_runner_deferred_poll_blocks_pending_immediate_until_deadline() {
        let wakeups = Arc::new(PollWakeups::new(true));
        let initial = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        wakeups
            .record_poll_result(initial, PollOutcome::JobFound, Duration::from_secs(5))
            .await;
        assert!(wakeups.snapshot().await.poll_now);

        wakeups
            .request_deferred_poll_at(tokio::time::Instant::now() + Duration::from_secs(2))
            .await;

        let wakeups_for_wait = Arc::clone(&wakeups);
        let cancel = CancellationToken::new();
        let wait = tokio::spawn(async move {
            wakeups_for_wait
                .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
                .await
        });
        tokio::task::yield_now().await;
        assert!(
            !wait.is_finished(),
            "pending immediate must not bypass target-other defer window"
        );

        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Deferred));
        assert!(!wakeups.snapshot().await.poll_now);
    }

    #[tokio::test(start_paused = true)]
    async fn target_other_runner_deferred_poll_blocks_wakeup_retry_until_deadline() {
        let wakeups = Arc::new(PollWakeups::new(true));
        let initial = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        wakeups
            .record_poll_result(initial, PollOutcome::Failure, Duration::from_secs(1))
            .await;
        wakeups
            .request_deferred_poll_at(tokio::time::Instant::now() + Duration::from_secs(2))
            .await;

        tokio::time::sleep(Duration::from_secs(1)).await;
        let wakeups_for_wait = Arc::clone(&wakeups);
        let cancel = CancellationToken::new();
        let wait = tokio::spawn(async move {
            wakeups_for_wait
                .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
                .await
        });
        tokio::task::yield_now().await;
        assert!(
            !wait.is_finished(),
            "wakeup retry must not bypass target-other defer window"
        );

        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Deferred));
    }

    #[tokio::test(start_paused = true)]
    async fn empty_poll_keeps_deferred_wakeup_created_after_poll_started() {
        let wakeups = PollWakeups::new(true);
        let due = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();

        let deferred_at = tokio::time::Instant::now() + Duration::from_secs(2);
        wakeups.request_deferred_poll_at(deferred_at).await;
        wakeups
            .record_poll_result(due, PollOutcome::Empty, Duration::from_secs(5))
            .await;

        assert_eq!(wakeups.snapshot().await.deferred_poll_at, Some(deferred_at));
    }

    #[tokio::test(start_paused = true)]
    async fn job_found_defers_return_when_target_other_wakeup_arrived_after_poll_started() {
        let wakeups = PollWakeups::new(true);
        let due = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();

        wakeups
            .request_deferred_poll_at(tokio::time::Instant::now() + Duration::from_secs(2))
            .await;
        let record = wakeups
            .record_poll_result(due, PollOutcome::JobFound, Duration::from_secs(5))
            .await;

        assert!(record.defer_job_return());
        assert!(wakeups.snapshot().await.deferred_poll_at.is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn job_found_returns_when_target_other_defer_was_the_poll_reason() {
        let wakeups = PollWakeups::new(true);
        let initial = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        wakeups
            .record_poll_result(initial, PollOutcome::Empty, Duration::from_secs(5))
            .await;
        wakeups
            .request_deferred_poll_at(tokio::time::Instant::now() + Duration::from_secs(2))
            .await;
        tokio::time::sleep(Duration::from_secs(2)).await;
        let due = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();

        let record = wakeups
            .record_poll_result(due, PollOutcome::JobFound, Duration::from_secs(5))
            .await;

        assert!(!record.defer_job_return());
    }

    #[tokio::test(start_paused = true)]
    async fn empty_poll_clears_deferred_wakeup_seen_by_poll() {
        let wakeups = PollWakeups::new(true);
        let initial = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        wakeups
            .record_poll_result(initial, PollOutcome::Empty, Duration::from_secs(5))
            .await;

        wakeups
            .request_deferred_poll_at(tokio::time::Instant::now() + Duration::from_secs(2))
            .await;
        tokio::time::sleep(Duration::from_secs(2)).await;
        let deferred = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();

        wakeups
            .record_poll_result(deferred, PollOutcome::Empty, Duration::from_secs(5))
            .await;

        assert!(wakeups.snapshot().await.deferred_poll_at.is_none());
    }

    #[test]
    fn disconnect_state_preserves_one_shot_escalation_window() {
        let mut state = AblyDisconnectState {
            connected: true,
            disconnected_at: None,
            error_logged: false,
            reason: None,
        };

        state.record_disconnected("first disconnect".to_string());
        let first_disconnected_at = state.disconnected_at;
        state.mark_error_logged();
        state.record_disconnected("second disconnect event".to_string());

        assert!(!state.connected);
        assert_eq!(state.disconnected_at, first_disconnected_at);
        assert!(state.error_logged);
        assert_eq!(state.reason(), "second disconnect event");
        assert!(state.error_deadline().is_none());

        state.mark_connected();
        state.record_disconnected("new window".to_string());
        assert!(!state.error_logged);
        assert!(state.error_deadline().is_some());
    }

    #[tokio::test]
    async fn cancel_notification_cancels_token_without_discovery() {
        let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
        let handle = RunCancellationHandle::new();
        let token = handle.token();
        let tokens = Mutex::new(HashMap::from([(run_id, handle)]));
        let wakeups = PollWakeups::new(true);
        let msg = make_message(Some("cancel"), serde_json::json!({ "runId": run_id }));

        handle_ably_message(&msg, "runner-1", &wakeups, &tokens).await;

        assert!(token.is_cancelled());
    }

    #[tokio::test]
    async fn job_notifications_coalesce_into_poll_wakeup() {
        let tokens = Mutex::new(HashMap::new());
        let wakeups = PollWakeups::new(true);
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        let msg = make_message(
            Some("job"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000001",
                "profile": "vm0/default"
            }),
        );

        handle_ably_message(&msg, "runner-1", &wakeups, &tokens).await;
        handle_ably_message(&msg, "runner-1", &wakeups, &tokens).await;

        assert!(wakeups.snapshot().await.poll_now);
        let reason = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        assert_eq!(poll_reason(reason), Some(PollReason::Immediate));
        assert!(!wakeups.snapshot().await.poll_now);
    }

    #[tokio::test]
    async fn target_other_runner_job_notification_defers_poll() {
        let tokens = Mutex::new(HashMap::new());
        let wakeups = PollWakeups::new(true);
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        let msg = make_message(
            Some("job"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000001",
                "targetRunnerId": "runner-2"
            }),
        );

        handle_ably_message(&msg, "runner-1", &wakeups, &tokens).await;

        let snapshot = wakeups.snapshot().await;
        assert!(!snapshot.poll_now);
        assert!(snapshot.deferred_poll_at.is_some());
    }

    #[tokio::test]
    async fn invalid_job_notification_does_not_mutate_wakeup_state() {
        let tokens = Mutex::new(HashMap::new());
        let wakeups = PollWakeups::new(true);
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        let msg = make_message(Some("job"), serde_json::json!({ "runId": "not-a-uuid" }));

        handle_ably_message(&msg, "runner-1", &wakeups, &tokens).await;

        let snapshot = wakeups.snapshot().await;
        assert!(!snapshot.poll_now);
        assert!(snapshot.deferred_poll_at.is_none());
    }

    #[tokio::test]
    async fn supervisor_shutdown_awaits_task_termination() {
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let supervisor = AblySupervisor::spawn_test_task(|shutdown| async move {
            shutdown.cancelled().await;
            let _ = done_tx.send(());
        });

        supervisor.shutdown().await;

        tokio::time::timeout(Duration::from_secs(1), done_rx)
            .await
            .expect("supervisor shutdown should await task termination")
            .unwrap();
    }

    #[test]
    fn parse_job_notification_with_target_runner_id() {
        let msg = make_message(
            Some("job"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000001",
                "profile": "vm0/default",
                "targetRunnerId": "00000000-0000-0000-0000-000000000099"
            }),
        );
        let notif = parse_job_notification(&msg).unwrap();
        assert_eq!(
            notif.target_runner_id.as_deref(),
            Some("00000000-0000-0000-0000-000000000099")
        );
        assert_eq!(notif.profile.as_deref(), Some("vm0/default"));
    }

    #[test]
    fn parse_cancel_notification_valid() {
        let msg = make_message(
            Some("cancel"),
            serde_json::json!({ "runId": "00000000-0000-0000-0000-000000000002" }),
        );
        let run_id = parse_cancel_notification(&msg).unwrap();
        assert_eq!(run_id.to_string(), "00000000-0000-0000-0000-000000000002");
    }
}
