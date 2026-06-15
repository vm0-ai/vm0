use std::collections::{HashSet, VecDeque};
use std::fs::File;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use nix::fcntl::Flock;
#[cfg(test)]
use nix::fcntl::FlockArg;
use tokio::sync::{mpsc, watch};
use tracing::{error, info, warn};

use crate::paths::LockPaths;

use super::super::error::{NetworkError, Result};
#[cfg(test)]
use super::host::ConntrackFlushOutcome;
use super::host::{
    NamespaceDeleteOutcome, NetnsLifecycleOps, acquire_pool_lock, create_single_namespace,
    enable_host_ip_forwarding, get_default_interface, reconcile_orphan_namespaces,
};
use super::naming::MAX_NAMESPACES;
use super::types::{
    CheckedNetnsPoolConfig, NetnsInfo, NetnsLease, NetnsPoolConfig, NetnsReleaseOutcome,
};

const BUFFER_SIZE: usize = 4;

/// Monotonic in-process identity for [`NetnsPool`] instances.
static NEXT_NETNS_POOL_INSTANCE_ID: AtomicU64 = AtomicU64::new(1);

fn next_pool_instance_id() -> u64 {
    NEXT_NETNS_POOL_INSTANCE_ID.fetch_add(1, Ordering::Relaxed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct PendingId(u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NetnsKind {
    Plain,
    Proxy,
}

struct CreationCompletion {
    id: PendingId,
    kind: NetnsKind,
    result: Result<NetnsInfo>,
}

#[derive(Clone)]
struct CreationNotifier {
    tx: mpsc::UnboundedSender<CreationCompletion>,
    generation: Arc<AtomicU64>,
    wake_tx: watch::Sender<u64>,
    ops: NetnsLifecycleOps,
}

impl CreationNotifier {
    async fn send(self, completion: CreationCompletion) {
        match self.tx.send(completion) {
            Ok(()) => self.wake(),
            Err(err) => {
                let completion = err.0;
                if let Ok(ns) = completion.result {
                    warn!(
                        name = %ns.name,
                        host_device = %ns.host_device,
                        "namespace creation completed after pool receiver dropped; deleting"
                    );
                    let outcome = (self.ops.delete_namespace)(ns.clone()).await;
                    if matches!(outcome, NamespaceDeleteOutcome::Abandoned) {
                        warn!(
                            name = %ns.name,
                            host_device = %ns.host_device,
                            "failed to delete namespace after completion delivery failed; startup orphan reconciliation will retry"
                        );
                    }
                }
                self.wake();
            }
        }
    }

    fn wake(&self) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.wake_tx.send(generation);
    }
}

#[derive(Clone)]
struct NetnsPoolInner {
    state: Arc<tokio::sync::Mutex<NetnsPoolState>>,
}

/// Pre-warmed pool of network namespaces for Firecracker VMs.
///
/// Maintains a buffer of `BUFFER_SIZE` ready namespaces per queue. After each
/// [`acquire`](Self::acquire), the pool spawns a background task to replenish
/// the buffer. Namespaces returned via [`release`](Self::release) are recycled
/// back into the queue.
pub struct NetnsPool {
    inner: NetnsPoolInner,
}

#[derive(Clone)]
pub(crate) struct NetnsPoolHandle {
    inner: NetnsPoolInner,
}

enum AcquirePlan {
    Ready(NetnsLease),
    Delete(Vec<NetnsInfo>, NetnsLifecycleOps),
    Wait(watch::Receiver<u64>),
}

struct ReleasePlan {
    info: NetnsInfo,
    kind: NetnsKind,
    active_at_prepare: bool,
    ops: NetnsLifecycleOps,
}

struct CleanupPlan {
    namespaces: Vec<NetnsInfo>,
    ops: NetnsLifecycleOps,
    wait_for_pending: Option<watch::Receiver<u64>>,
    done: bool,
}

// ---------------------------------------------------------------------------
// NetnsPool
// ---------------------------------------------------------------------------

/// Mutable state behind the namespace pool lifecycle.
struct NetnsPoolState {
    active: bool,
    plain_queue: VecDeque<NetnsInfo>,
    proxy_queue: VecDeque<NetnsInfo>,
    /// In-flight background namespace creation tasks (plain).
    pending_plain: HashSet<PendingId>,
    /// In-flight background namespace creation tasks (proxy).
    pending_proxy: HashSet<PendingId>,
    completion_tx: mpsc::UnboundedSender<CreationCompletion>,
    completion_rx: mpsc::UnboundedReceiver<CreationCompletion>,
    completion_generation: Arc<AtomicU64>,
    completion_wake_tx: watch::Sender<u64>,
    /// Namespaces checked out from this pool instance.
    in_flight: HashSet<String>,
    /// In-flight namespaces that must be deleted instead of reused.
    non_reusable: HashSet<String>,
    instance_id: u64,
    next_pending_id: u64,
    next_ns_index: u32,
    pool_index: u32,
    proxy_port: Option<u16>,
    dns_port: Option<u16>,
    default_iface: String,
    ops: NetnsLifecycleOps,
    #[cfg(test)]
    acquire_waiting_notify: Option<Arc<tokio::sync::Notify>>,
    /// Held for the lifetime of the pool to reserve the pool index.
    _lock: Flock<File>,
}

impl NetnsPoolState {
    fn completion_state() -> (
        mpsc::UnboundedSender<CreationCompletion>,
        mpsc::UnboundedReceiver<CreationCompletion>,
        Arc<AtomicU64>,
        watch::Sender<u64>,
    ) {
        let (completion_tx, completion_rx) = mpsc::unbounded_channel();
        let completion_generation = Arc::new(AtomicU64::new(0));
        let (completion_wake_tx, _) = watch::channel(0);
        (
            completion_tx,
            completion_rx,
            completion_generation,
            completion_wake_tx,
        )
    }

    #[cfg(test)]
    pub(crate) fn inactive_for_test() -> Self {
        let file = tempfile::tempfile().expect("create test netns pool lock file");
        let lock = match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => lock,
            Err((_, errno)) => panic!("lock test netns pool file: {errno}"),
        };
        let (completion_tx, completion_rx, completion_generation, completion_wake_tx) =
            Self::completion_state();

        Self {
            active: false,
            plain_queue: VecDeque::new(),
            proxy_queue: VecDeque::new(),
            pending_plain: HashSet::new(),
            pending_proxy: HashSet::new(),
            completion_tx,
            completion_rx,
            completion_generation,
            completion_wake_tx,
            in_flight: HashSet::new(),
            non_reusable: HashSet::new(),
            instance_id: next_pool_instance_id(),
            next_pending_id: 0,
            next_ns_index: 0,
            pool_index: 0,
            proxy_port: None,
            dns_port: None,
            default_iface: "test0".into(),
            ops: NetnsLifecycleOps::trusted_for_test(),
            acquire_waiting_notify: None,
            _lock: lock,
        }
    }

    #[cfg(test)]
    pub(crate) fn track_lease_for_test(&mut self, lease: &NetnsLease) {
        self.in_flight.insert(lease.name().to_string());
    }

    #[cfg(test)]
    pub(crate) fn lease_for_test(&self, name: &str) -> NetnsLease {
        NetnsLease::new(
            NetnsInfo::new(name.into(), "test-ve".into(), "10.200.0.2".into()),
            self.instance_id,
        )
    }

    async fn create_checked(config: CheckedNetnsPoolConfig) -> Result<Self> {
        let config = config.inner;
        let lock_paths = LockPaths::new();
        let (index, lock) = acquire_pool_lock(&lock_paths)?;

        info!(index, buffer = BUFFER_SIZE, "initializing namespace pool");

        // Enable host-level IP forwarding (idempotent, needed once per host).
        enable_host_ip_forwarding().await?;

        // Reconcile orphans from our own index and any idle pool index.
        // This is the correctness guarantee for kernel-side cleanup —
        // `NetnsPool::cleanup` is best-effort and cannot survive SIGKILL,
        // panic, OOM, or aborted in-flight creation tasks (issue #10625).
        reconcile_orphan_namespaces(&lock_paths, index, &lock).await;

        let default_iface = get_default_interface().await?;
        let (completion_tx, completion_rx, completion_generation, completion_wake_tx) =
            Self::completion_state();

        let mut pool = Self {
            active: true,
            plain_queue: VecDeque::with_capacity(BUFFER_SIZE),
            proxy_queue: VecDeque::with_capacity(if config.proxy_port.is_some() {
                BUFFER_SIZE
            } else {
                0
            }),
            pending_plain: HashSet::new(),
            pending_proxy: HashSet::new(),
            completion_tx,
            completion_rx,
            completion_generation,
            completion_wake_tx,
            in_flight: HashSet::new(),
            non_reusable: HashSet::new(),
            instance_id: next_pool_instance_id(),
            next_pending_id: 0,
            next_ns_index: 0,
            pool_index: index,
            proxy_port: config.proxy_port,
            dns_port: config.dns_port,
            default_iface,
            ops: NetnsLifecycleOps::default(),
            #[cfg(test)]
            acquire_waiting_notify: None,
            _lock: lock,
        };

        // Pre-warm the buffer. Warm-up starts at ns_index 0, so
        // `reconcile_orphan_namespaces` above MUST have finished
        // synchronously — otherwise `vm0-ns-{own}-00` may still exist from
        // a previous runner and `ip netns add` will fail with EEXIST.
        pool.spawn_initial_warmup();
        pool.drain_initial_warmup().await;

        info!(
            plain = pool.plain_queue.len(),
            proxy = pool.proxy_queue.len(),
            buffer = BUFFER_SIZE,
            "namespace pool initialized"
        );
        Ok(pool)
    }

    fn reserve_ns_index(&mut self) -> Result<u32> {
        let ns_index = self.next_ns_index;
        if ns_index >= MAX_NAMESPACES {
            return Err(NetworkError::NamespaceLimitReached {
                max: MAX_NAMESPACES,
            });
        }
        self.next_ns_index += 1;
        Ok(ns_index)
    }

    fn reserve_pending_id(&mut self) -> PendingId {
        let id = PendingId(self.next_pending_id);
        self.next_pending_id += 1;
        id
    }

    fn creation_notifier(&self) -> CreationNotifier {
        CreationNotifier {
            tx: self.completion_tx.clone(),
            generation: Arc::clone(&self.completion_generation),
            wake_tx: self.completion_wake_tx.clone(),
            ops: self.ops.clone(),
        }
    }

    fn spawn_plain_creation(&mut self) -> Result<()> {
        self.spawn_creation(NetnsKind::Plain)
    }

    fn spawn_proxy_creation(&mut self) -> Result<()> {
        self.spawn_creation(NetnsKind::Proxy)
    }

    fn spawn_initial_warmup(&mut self) {
        if BUFFER_SIZE == 0 {
            return;
        }

        // Plain namespaces (connectivity only). Only needed when proxy
        // is disabled; with proxy configured, `acquire()` always routes
        // to the proxy queue, so plain entries would be unreachable
        // until `cleanup()`.
        if self.proxy_port.is_none() {
            for _ in 0..BUFFER_SIZE {
                if let Err(e) = self.spawn_plain_creation() {
                    warn!(error = %e, "failed to start initial namespace creation");
                    break;
                }
            }
        }

        // Proxy namespaces (connectivity + REDIRECT rules).
        if self.proxy_port.is_some() {
            for _ in 0..BUFFER_SIZE {
                if let Err(e) = self.spawn_proxy_creation() {
                    warn!(error = %e, "failed to start initial proxy namespace creation");
                    break;
                }
            }
        }
    }

    async fn drain_initial_warmup(&mut self) {
        loop {
            let mut waiter = if self.pending_plain.is_empty() && self.pending_proxy.is_empty() {
                None
            } else {
                Some(self.completion_wake_tx.subscribe())
            };

            let delete = self.drain_completed(true);
            if !delete.is_empty() {
                delete_namespaces_with_ops(self.ops.clone(), delete).await;
            }
            if self.pending_plain.is_empty() && self.pending_proxy.is_empty() {
                return;
            }

            let Some(waiter) = waiter.as_mut() else {
                continue;
            };
            if waiter.changed().await.is_err() {
                warn!("namespace creation notifier closed during initial warmup");
                return;
            }
        }
    }

    fn spawn_creation(&mut self, kind: NetnsKind) -> Result<()> {
        let ns_index = self.reserve_ns_index()?;
        let pool_index = self.pool_index;
        let default_iface = self.default_iface.clone();
        let (proxy_port, dns_port) = match kind {
            NetnsKind::Plain => (None, None),
            NetnsKind::Proxy => {
                let Some(proxy_port) = self.proxy_port else {
                    return Err(NetworkError::Prerequisite(
                        "proxy namespace requested without proxy port".into(),
                    ));
                };
                (Some(proxy_port), self.dns_port)
            }
        };
        let id = self.reserve_pending_id();
        self.pending_set_mut(kind).insert(id);
        spawn_creation_worker(
            id,
            kind,
            self.creation_notifier(),
            create_single_namespace(pool_index, ns_index, default_iface, proxy_port, dns_port),
        );
        Ok(())
    }

    #[cfg(test)]
    fn spawn_plain_creation_for_test<F>(&mut self, future: F)
    where
        F: Future<Output = Result<NetnsInfo>> + Send + 'static,
    {
        let id = self.reserve_pending_id();
        self.pending_plain.insert(id);
        spawn_creation_worker(id, NetnsKind::Plain, self.creation_notifier(), future);
    }

    fn checkout_or_requeue(&mut self, info: NetnsInfo, kind: NetnsKind) -> Result<NetnsLease> {
        let name = info.name.clone();
        match self.checkout(info) {
            Ok(lease) => Ok(lease),
            Err(info) => {
                warn!(
                    name = %name,
                    has_proxy = matches!(kind, NetnsKind::Proxy),
                    "namespace is already checked out; returning metadata to queue"
                );
                self.target_queue_mut(kind).push_front(info);
                Err(NetworkError::InvalidLease(format!(
                    "namespace {name} is already checked out"
                )))
            }
        }
    }

    fn checkout(&mut self, info: NetnsInfo) -> std::result::Result<NetnsLease, NetnsInfo> {
        if !self.in_flight.insert(info.name.clone()) {
            return Err(info);
        }
        Ok(NetnsLease::new(info, self.instance_id))
    }

    fn drain_completed(&mut self, queue_when_inactive: bool) -> Vec<NetnsInfo> {
        let mut delete = Vec::new();
        while let Ok(completion) = self.completion_rx.try_recv() {
            self.apply_completion(completion, queue_when_inactive, &mut delete);
        }
        delete
    }

    fn apply_completion(
        &mut self,
        completion: CreationCompletion,
        queue_when_inactive: bool,
        delete: &mut Vec<NetnsInfo>,
    ) {
        if !self.pending_set_mut(completion.kind).remove(&completion.id) {
            warn!(
                id = completion.id.0,
                kind = ?completion.kind,
                "ignoring completion for unknown namespace creation task"
            );
            if let Ok(ns) = completion.result {
                delete.push(ns);
            }
            return;
        }

        match completion.result {
            Ok(ns) if self.active || queue_when_inactive => {
                self.target_queue_mut(completion.kind).push_back(ns);
            }
            Ok(ns) => delete.push(ns),
            Err(e) => {
                error!(
                    id = completion.id.0,
                    kind = ?completion.kind,
                    error = %e,
                    "background namespace creation failed"
                );
            }
        }
    }

    fn prepare_acquire(&mut self) -> Result<AcquirePlan> {
        loop {
            if !self.active {
                return Err(NetworkError::PoolNotActive);
            }
            let delete = self.drain_completed(false);
            if !delete.is_empty() {
                return Ok(AcquirePlan::Delete(delete, self.ops.clone()));
            }
            if let Some(lease) = self.try_checkout_ready()? {
                return Ok(AcquirePlan::Ready(lease));
            }

            let kind = self.acquire_kind();
            if self.pending_set(kind).is_empty() {
                self.spawn_creation(kind)?;
            }

            let waiter = self.completion_wake_tx.subscribe();

            // Subscribe before the re-check to avoid missing a completion
            // between the decision to wait and dropping the outer mutex.
            let delete = self.drain_completed(false);
            if !delete.is_empty() {
                return Ok(AcquirePlan::Delete(delete, self.ops.clone()));
            }
            if !self.active {
                return Err(NetworkError::PoolNotActive);
            }
            if let Some(lease) = self.try_checkout_ready()? {
                return Ok(AcquirePlan::Ready(lease));
            }
            if self.pending_set(kind).is_empty() {
                continue;
            }

            #[cfg(test)]
            if let Some(notify) = &self.acquire_waiting_notify {
                notify.notify_one();
            }

            return Ok(AcquirePlan::Wait(waiter));
        }
    }

    fn try_checkout_ready(&mut self) -> Result<Option<NetnsLease>> {
        let kind = self.acquire_kind();
        let (pooled, queue_len_after_pop) = {
            let queue = self.target_queue_mut(kind);
            let pooled = queue.pop_front();
            (pooled, queue.len())
        };
        let Some(pooled) = pooled else {
            return Ok(None);
        };

        info!(
            name = %pooled.name,
            remaining = queue_len_after_pop,
            has_proxy = matches!(kind, NetnsKind::Proxy),
            "acquired namespace"
        );
        let lease = self.checkout_or_requeue(pooled, kind)?;
        self.maybe_replenish_kind(kind);
        Ok(Some(lease))
    }

    fn acquire_kind(&self) -> NetnsKind {
        if self.proxy_port.is_some() {
            NetnsKind::Proxy
        } else {
            NetnsKind::Plain
        }
    }

    fn maybe_replenish_kind(&mut self, kind: NetnsKind) {
        if matches!(kind, NetnsKind::Proxy) && self.proxy_port.is_none() {
            return;
        }
        if self.target_queue(kind).len() + self.pending_set(kind).len() >= BUFFER_SIZE
            || !self.pending_set(kind).is_empty()
            || self.next_ns_index >= MAX_NAMESPACES
        {
            return;
        }
        let result = match kind {
            NetnsKind::Plain => self.spawn_plain_creation(),
            NetnsKind::Proxy => self.spawn_proxy_creation(),
        };
        if let Err(e) = result {
            warn!(kind = ?kind, error = %e, "failed to replenish namespace pool");
        }
    }

    fn prepare_release(
        &self,
        lease: &Option<NetnsLease>,
    ) -> std::result::Result<ReleasePlan, String> {
        let Some(active_lease) = lease.as_ref() else {
            return Err("missing netns lease".into());
        };
        if active_lease.pool_instance_id() != self.instance_id {
            warn!(
                name = %active_lease.name(),
                lease_pool_instance_id = active_lease.pool_instance_id(),
                pool_instance_id = self.instance_id,
                "refusing to release netns lease from a different pool instance"
            );
            return Err(format!(
                "namespace {} belongs to pool instance {}, not {}",
                active_lease.name(),
                active_lease.pool_instance_id(),
                self.instance_id
            ));
        }
        if !self.in_flight.contains(active_lease.name()) {
            warn!(
                name = %active_lease.name(),
                pool_instance_id = self.instance_id,
                "refusing to release netns lease that is not in flight"
            );
            return Err(format!(
                "namespace {} is not checked out",
                active_lease.name()
            ));
        }

        let kind = self.acquire_kind();
        let reusable = self.active && !self.non_reusable.contains(active_lease.name());
        if reusable
            && self
                .target_queue(kind)
                .iter()
                .any(|r| r.name == active_lease.name())
        {
            warn!(
                name = %active_lease.name(),
                "refusing to release netns lease already queued in pool"
            );
            return Err(format!(
                "namespace {} is already queued",
                active_lease.name()
            ));
        }

        Ok(ReleasePlan {
            info: active_lease.info().clone(),
            kind,
            active_at_prepare: reusable,
            ops: self.ops.clone(),
        })
    }

    fn mark_non_reusable(&mut self, plan: &ReleasePlan) {
        if self.in_flight.contains(&plan.info.name) {
            self.non_reusable.insert(plan.info.name.clone());
        }
    }

    fn commit_release_requeue(
        &mut self,
        lease: &mut Option<NetnsLease>,
        plan: &ReleasePlan,
    ) -> NetnsReleaseOutcome {
        let Some(lease) = lease.take() else {
            return NetnsReleaseOutcome::InvalidLease("validated netns lease disappeared".into());
        };
        self.in_flight.remove(lease.name());
        self.non_reusable.remove(lease.name());
        let ns = lease.into_info();

        let kind = plan.kind;
        let target_queue = self.target_queue_mut(kind);

        info!(
            name = %ns.name,
            available = target_queue.len() + 1,
            has_proxy = matches!(kind, NetnsKind::Proxy),
            "namespace released"
        );
        target_queue.push_back(ns);
        NetnsReleaseOutcome::Released
    }

    fn commit_release_delete(
        &mut self,
        lease: &mut Option<NetnsLease>,
        _plan: &ReleasePlan,
        delete: NamespaceDeleteOutcome,
    ) -> NetnsReleaseOutcome {
        let Some(lease) = lease.take() else {
            return NetnsReleaseOutcome::InvalidLease("validated netns lease disappeared".into());
        };
        self.in_flight.remove(lease.name());
        self.non_reusable.remove(lease.name());
        let ns = lease.into_info();
        match delete {
            NamespaceDeleteOutcome::Deleted => {
                info!(name = %ns.name, "namespace lease deleted instead of requeued");
                NetnsReleaseOutcome::Deleted
            }
            NamespaceDeleteOutcome::Abandoned => {
                warn!(
                    name = %ns.name,
                    host_device = %ns.host_device,
                    "namespace release abandoned after cleanup failure; startup orphan reconciliation will retry"
                );
                NetnsReleaseOutcome::Abandoned
            }
        }
    }

    fn target_queue(&self, kind: NetnsKind) -> &VecDeque<NetnsInfo> {
        match kind {
            NetnsKind::Plain => &self.plain_queue,
            NetnsKind::Proxy => &self.proxy_queue,
        }
    }

    fn target_queue_mut(&mut self, kind: NetnsKind) -> &mut VecDeque<NetnsInfo> {
        match kind {
            NetnsKind::Plain => &mut self.plain_queue,
            NetnsKind::Proxy => &mut self.proxy_queue,
        }
    }

    fn pending_set(&self, kind: NetnsKind) -> &HashSet<PendingId> {
        match kind {
            NetnsKind::Plain => &self.pending_plain,
            NetnsKind::Proxy => &self.pending_proxy,
        }
    }

    fn pending_set_mut(&mut self, kind: NetnsKind) -> &mut HashSet<PendingId> {
        match kind {
            NetnsKind::Plain => &mut self.pending_plain,
            NetnsKind::Proxy => &mut self.pending_proxy,
        }
    }

    fn prepare_cleanup(&mut self) -> CleanupPlan {
        self.active = false;
        if !self.in_flight.is_empty() {
            warn!(
                in_flight = self.in_flight.len(),
                "namespace pool cleanup with outstanding leases"
            );
        }

        let mut namespaces = self.drain_completed(true);
        let mut wait_for_pending = if self.pending_plain.is_empty() && self.pending_proxy.is_empty()
        {
            None
        } else {
            Some(self.completion_wake_tx.subscribe())
        };
        namespaces.extend(self.drain_completed(true));
        if self.pending_plain.is_empty() && self.pending_proxy.is_empty() {
            wait_for_pending = None;
        }

        namespaces.extend(
            self.plain_queue
                .iter()
                .chain(self.proxy_queue.iter())
                .cloned(),
        );
        CleanupPlan {
            done: namespaces.is_empty() && wait_for_pending.is_none(),
            namespaces,
            ops: self.ops.clone(),
            wait_for_pending,
        }
    }

    fn remove_queued_namespaces(&mut self, names: &HashSet<String>) {
        self.plain_queue.retain(|ns| !names.contains(&ns.name));
        self.proxy_queue.retain(|ns| !names.contains(&ns.name));
    }

    #[cfg(test)]
    async fn delete_queued_namespaces_with<F, Fut>(queue: &mut VecDeque<NetnsInfo>, mut delete: F)
    where
        F: FnMut(NetnsInfo) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        while let Some(ns) = queue.front().cloned() {
            delete(ns).await;
            queue.pop_front();
        }
    }
}

impl Drop for NetnsPoolState {
    fn drop(&mut self) {
        let queued = self.plain_queue.len() + self.proxy_queue.len();
        let pending = self.pending_plain.len() + self.pending_proxy.len();
        if self.active || queued != 0 || pending != 0 || !self.in_flight.is_empty() {
            warn!(
                active = self.active,
                queued,
                pending,
                in_flight = self.in_flight.len(),
                "NetnsPool dropped without calling cleanup()"
            );
        }
    }
}

impl NetnsPoolInner {
    fn new(state: NetnsPoolState) -> Self {
        Self {
            state: Arc::new(tokio::sync::Mutex::new(state)),
        }
    }

    async fn acquire(&self) -> Result<NetnsLease> {
        loop {
            let plan = {
                let mut state = self.state.lock().await;
                state.prepare_acquire()?
            };
            match plan {
                AcquirePlan::Ready(lease) => return Ok(lease),
                AcquirePlan::Delete(namespaces, ops) => {
                    delete_namespaces_with_ops(ops, namespaces).await;
                }
                AcquirePlan::Wait(mut waiter) => {
                    if waiter.changed().await.is_err() {
                        return Err(NetworkError::Prerequisite(
                            "namespace creation notifier closed".into(),
                        ));
                    }
                }
            }
        }
    }

    async fn release_outcome(&self, lease: &mut Option<NetnsLease>) -> NetnsReleaseOutcome {
        let plan = {
            let mut state = self.state.lock().await;
            let plan = match state.prepare_release(lease) {
                Ok(plan) => plan,
                Err(message) => return NetnsReleaseOutcome::InvalidLease(message),
            };
            if plan.active_at_prepare {
                state.mark_non_reusable(&plan);
            }
            plan
        };

        let can_requeue = if plan.active_at_prepare {
            (plan.ops.flush_conntrack)(plan.info.peer_ip.clone())
                .await
                .is_trusted()
        } else {
            false
        };

        if can_requeue {
            {
                let mut state = self.state.lock().await;
                if state.active {
                    return state.commit_release_requeue(lease, &plan);
                }
            }
        }

        let delete = (plan.ops.delete_namespace)(plan.info.clone()).await;
        let mut state = self.state.lock().await;
        state.commit_release_delete(lease, &plan, delete)
    }

    async fn cleanup(&self) -> Result<()> {
        loop {
            let plan = {
                let mut state = self.state.lock().await;
                state.prepare_cleanup()
            };
            if plan.done {
                info!("namespace pool cleanup complete");
                return Ok(());
            }

            let names = cleanup_namespace_names(&plan.namespaces);
            delete_namespaces_with_ops(plan.ops, plan.namespaces).await;
            {
                let mut state = self.state.lock().await;
                state.remove_queued_namespaces(&names);
            }

            if let Some(mut waiter) = plan.wait_for_pending
                && waiter.changed().await.is_err()
            {
                return Err(NetworkError::Prerequisite(
                    "namespace creation notifier closed".into(),
                ));
            }
        }
    }

    #[cfg(test)]
    fn with_state_for_test<R>(&self, f: impl FnOnce(&mut NetnsPoolState) -> R) -> R {
        let mut state = self
            .state
            .try_lock()
            .expect("netns pool state lock should be available in test setup");
        f(&mut state)
    }
}

impl NetnsPool {
    /// Create a new pool with a small pre-warmed buffer.
    ///
    /// Pre-warms `BUFFER_SIZE` namespaces per queue at startup.
    /// After each [`acquire`](Self::acquire), the pool replenishes to
    /// maintain the buffer level. Namespaces returned via
    /// [`release`](Self::release) are recycled back into the queue.
    ///
    /// Automatically acquires a unique pool index (0–63) via flock. Enables
    /// host IP forwarding and reconciles orphaned resources from any idle
    /// pool index before creating new namespaces.
    pub async fn create(config: NetnsPoolConfig) -> Result<Self> {
        let config = config
            .into_checked()
            .map_err(|e| NetworkError::Prerequisite(e.to_string()))?;
        Self::create_checked(config).await
    }

    pub(crate) async fn create_checked(config: CheckedNetnsPoolConfig) -> Result<Self> {
        Ok(Self {
            inner: NetnsPoolInner::new(NetnsPoolState::create_checked(config).await?),
        })
    }

    /// Acquire a namespace from the pool, or create one on-demand if empty.
    pub async fn acquire(&mut self) -> Result<NetnsLease> {
        self.inner.acquire().await
    }

    /// Return a namespace to the pool, or delete it if the pool is inactive.
    ///
    /// The caller keeps the lease in `Some` while this future awaits. Release
    /// only takes and disarms the lease at the final no-await commit point, so
    /// cancelling this future before success leaves cleanup ownership with the
    /// caller.
    pub async fn release(&mut self, lease: &mut Option<NetnsLease>) -> Result<()> {
        match self.inner.release_outcome(lease).await {
            NetnsReleaseOutcome::Released
            | NetnsReleaseOutcome::Deleted
            | NetnsReleaseOutcome::Abandoned => Ok(()),
            NetnsReleaseOutcome::InvalidLease(message) => Err(NetworkError::InvalidLease(message)),
        }
    }

    /// Delete all namespaces currently in the pool queue and wait for
    /// in-flight background creation tasks so their resources can be deleted.
    ///
    /// Namespaces that have been acquired but not yet released are **not**
    /// cleaned up here — they will be caught by orphan cleanup on the next
    /// [`NetnsPool::create`] call with the same index.
    pub async fn cleanup(&mut self) -> Result<()> {
        self.inner.cleanup().await
    }

    #[cfg(test)]
    pub(crate) fn inactive_for_test() -> Self {
        Self::from_state_for_test(NetnsPoolState::inactive_for_test())
    }

    #[cfg(test)]
    fn from_state_for_test(state: NetnsPoolState) -> Self {
        Self {
            inner: NetnsPoolInner::new(state),
        }
    }

    #[cfg(test)]
    pub(crate) fn track_lease_for_test(&mut self, lease: &NetnsLease) {
        self.inner
            .with_state_for_test(|state| state.track_lease_for_test(lease));
    }

    #[cfg(test)]
    pub(crate) fn lease_for_test(&self, name: &str) -> NetnsLease {
        self.inner
            .with_state_for_test(|state| state.lease_for_test(name))
    }
}

impl NetnsPoolHandle {
    pub(crate) async fn create_checked(config: CheckedNetnsPoolConfig) -> Result<Self> {
        Ok(Self::new(NetnsPool::create_checked(config).await?))
    }

    pub(crate) fn new(pool: NetnsPool) -> Self {
        Self { inner: pool.inner }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(pool: NetnsPool) -> Self {
        Self::new(pool)
    }

    #[cfg(test)]
    fn from_state_for_test(state: NetnsPoolState) -> Self {
        Self {
            inner: NetnsPoolInner::new(state),
        }
    }

    pub(crate) async fn acquire(&self) -> Result<NetnsLease> {
        self.inner.acquire().await
    }

    pub(crate) async fn release(&self, lease: &mut Option<NetnsLease>) -> NetnsReleaseOutcome {
        self.inner.release_outcome(lease).await
    }

    pub(crate) async fn cleanup(&self) -> Result<()> {
        self.inner.cleanup().await
    }
}

fn spawn_creation_worker<F>(id: PendingId, kind: NetnsKind, notifier: CreationNotifier, future: F)
where
    F: Future<Output = Result<NetnsInfo>> + Send + 'static,
{
    let worker = tokio::spawn(future);
    tokio::spawn(async move {
        let result = match worker.await {
            Ok(result) => result,
            Err(e) => Err(join_error_to_creation_error(e, kind)),
        };
        notifier.send(CreationCompletion { id, kind, result }).await;
    });
}

fn join_error_to_creation_error(e: tokio::task::JoinError, kind: NetnsKind) -> NetworkError {
    if e.is_panic() {
        NetworkError::Prerequisite(format!("{kind:?} namespace creation task panicked: {e}"))
    } else {
        NetworkError::Prerequisite(format!("{kind:?} namespace creation task cancelled: {e}"))
    }
}

async fn delete_namespaces_with_ops(ops: NetnsLifecycleOps, namespaces: Vec<NetnsInfo>) {
    let count = namespaces.len();
    if count > 0 {
        info!(count, "cleaning up namespace pool entries");
    }
    for ns in namespaces {
        let outcome = (ops.delete_namespace)(ns.clone()).await;
        if matches!(outcome, NamespaceDeleteOutcome::Abandoned) {
            warn!(
                name = %ns.name,
                host_device = %ns.host_device,
                "namespace cleanup was abandoned; startup orphan reconciliation will retry"
            );
        }
    }
}

fn cleanup_namespace_names(namespaces: &[NetnsInfo]) -> HashSet<String> {
    namespaces.iter().map(|ns| ns.name.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    async fn blocking_plain_creation(
        name: &'static str,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    ) -> Result<NetnsInfo> {
        entered.notify_one();
        release.notified().await;
        Ok(test_info(name))
    }

    fn test_info(name: &str) -> NetnsInfo {
        NetnsInfo::new(name.into(), "test-ve".into(), "10.200.0.2".into())
    }

    #[tokio::test]
    async fn shared_acquire_does_not_hold_mutex_while_creation_is_pending() {
        let waiting = Arc::new(tokio::sync::Notify::new());
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.next_ns_index = MAX_NAMESPACES;
        pool.acquire_waiting_notify = Some(Arc::clone(&waiting));
        pool.spawn_plain_creation_for_test(blocking_plain_creation(
            "test-ns",
            Arc::clone(&entered),
            Arc::clone(&release),
        ));
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let acquire = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        entered.notified().await;
        waiting.notified().await;

        let guard = handle
            .inner
            .state
            .try_lock()
            .expect("shared acquire must not hold netns pool mutex while waiting");
        drop(guard);

        release.notify_one();
        let mut lease = Some(acquire.await.unwrap().unwrap());
        assert_eq!(lease.as_ref().unwrap().name(), "test-ns");
        let outcome = handle.release(&mut lease).await;
        assert!(matches!(outcome, NetnsReleaseOutcome::Released));
        handle.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn shared_acquire_cancellation_preserves_completed_creation() {
        let waiting = Arc::new(tokio::sync::Notify::new());
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.next_ns_index = MAX_NAMESPACES;
        pool.acquire_waiting_notify = Some(Arc::clone(&waiting));
        pool.spawn_plain_creation_for_test(blocking_plain_creation(
            "test-ns",
            Arc::clone(&entered),
            Arc::clone(&release),
        ));
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let acquire = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });
        entered.notified().await;
        waiting.notified().await;
        acquire.abort();
        let _ = acquire.await;

        release.notify_one();
        let mut lease = Some(handle.acquire().await.unwrap());
        assert_eq!(lease.as_ref().unwrap().name(), "test-ns");

        let outcome = handle.release(&mut lease).await;
        assert!(matches!(outcome, NetnsReleaseOutcome::Released));
        handle.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn creation_worker_panic_clears_pending_during_cleanup() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.spawn_plain_creation_for_test(async {
            panic!("creation panic for test");
            #[allow(unreachable_code)]
            Ok(test_info("never"))
        });
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        handle.cleanup().await.unwrap();

        let pool = handle.inner.state.lock().await;
        assert!(pool.pending_plain.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn completion_send_failure_deletes_created_namespace() {
        let deleted = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPoolState::inactive_for_test();
        let deleted_for_ops = Arc::clone(&deleted);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_namespace: Arc::new(move |_| {
                let deleted = Arc::clone(&deleted_for_ops);
                Box::pin(async move {
                    deleted.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let notifier = pool.creation_notifier();
        drop(pool);

        notifier
            .send(CreationCompletion {
                id: PendingId(0),
                kind: NetnsKind::Plain,
                result: Ok(test_info("orphan-ns")),
            })
            .await;

        assert_eq!(deleted.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cleanup_deletes_unknown_completed_namespace() {
        let deleted = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let deleted_for_ops = Arc::clone(&deleted);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_namespace: Arc::new(move |_| {
                let deleted = Arc::clone(&deleted_for_ops);
                Box::pin(async move {
                    deleted.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        pool.completion_tx
            .send(CreationCompletion {
                id: PendingId(999),
                kind: NetnsKind::Plain,
                result: Ok(test_info("unknown-ns")),
            })
            .unwrap();

        let mut pool = NetnsPool::from_state_for_test(pool);
        pool.cleanup().await.unwrap();

        assert_eq!(deleted.load(Ordering::SeqCst), 1);
        let pool = pool.inner.state.lock().await;
        assert!(pool.plain_queue.is_empty());
        assert!(pool.proxy_queue.is_empty());
    }

    #[tokio::test]
    async fn dropped_pool_deletes_late_pending_creation() {
        let release = Arc::new(tokio::sync::Notify::new());
        let deleted = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPoolState::inactive_for_test();
        let deleted_for_ops = Arc::clone(&deleted);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_namespace: Arc::new(move |_| {
                let deleted = Arc::clone(&deleted_for_ops);
                Box::pin(async move {
                    deleted.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        pool.spawn_plain_creation_for_test({
            let release = Arc::clone(&release);
            async move {
                release.notified().await;
                Ok(test_info("late-ns"))
            }
        });

        drop(pool);
        release.notify_one();

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while deleted.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("late pending namespace should be deleted after pool drop");
    }

    #[tokio::test]
    async fn cleanup_rejects_acquire_and_deletes_late_completion() {
        let release = Arc::new(tokio::sync::Notify::new());
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    delete_count.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        pool.spawn_plain_creation_for_test({
            let release = Arc::clone(&release);
            async move {
                release.notified().await;
                Ok(test_info("late-ns"))
            }
        });
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let cleanup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.cleanup().await }
        });
        loop {
            if !handle.inner.state.lock().await.active {
                break;
            }
            tokio::task::yield_now().await;
        }

        let err = handle.acquire().await.unwrap_err();
        assert!(matches!(err, NetworkError::PoolNotActive));

        release.notify_one();
        cleanup.await.unwrap().unwrap();
        let pool = handle.inner.state.lock().await;
        assert!(pool.pending_plain.is_empty());
        assert!(pool.plain_queue.is_empty());
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn shared_release_does_not_hold_mutex_while_flush_blocks() {
        let flush_entered = Arc::new(tokio::sync::Notify::new());
        let flush_release = Arc::new(tokio::sync::Notify::new());
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let flush_entered_for_ops = Arc::clone(&flush_entered);
        let flush_release_for_ops = Arc::clone(&flush_release);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let flush_entered = Arc::clone(&flush_entered_for_ops);
                let flush_release = Arc::clone(&flush_release_for_ops);
                Box::pin(async move {
                    flush_entered.notify_one();
                    flush_release.notified().await;
                    ConntrackFlushOutcome::Trusted
                })
            }),
            delete_namespace: Arc::new(|_| Box::pin(async { NamespaceDeleteOutcome::Deleted })),
        };
        let lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let release_task = tokio::spawn({
            let handle = handle.clone();
            async move {
                let mut lease = lease;
                let outcome = handle.release(&mut lease).await;
                (outcome, lease)
            }
        });
        flush_entered.notified().await;

        let guard = handle
            .inner
            .state
            .try_lock()
            .expect("shared release must not hold netns pool mutex while flushing conntrack");
        drop(guard);

        flush_release.notify_one();
        let (outcome, lease) = release_task.await.unwrap();
        assert!(matches!(outcome, NetnsReleaseOutcome::Released));
        assert!(lease.is_none());
        handle.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn shared_release_deletes_when_cleanup_races_after_flush_started() {
        let flush_entered = Arc::new(tokio::sync::Notify::new());
        let flush_release = Arc::new(tokio::sync::Notify::new());
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let flush_entered_for_ops = Arc::clone(&flush_entered);
        let flush_release_for_ops = Arc::clone(&flush_release);
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let flush_entered = Arc::clone(&flush_entered_for_ops);
                let flush_release = Arc::clone(&flush_release_for_ops);
                Box::pin(async move {
                    flush_entered.notify_one();
                    flush_release.notified().await;
                    ConntrackFlushOutcome::Trusted
                })
            }),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    delete_count.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let release_task = tokio::spawn({
            let handle = handle.clone();
            async move {
                let mut lease = lease;
                let outcome = handle.release(&mut lease).await;
                (outcome, lease)
            }
        });
        flush_entered.notified().await;

        handle.cleanup().await.unwrap();
        flush_release.notify_one();
        let (outcome, lease) = release_task.await.unwrap();

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = handle.inner.state.lock().await;
        assert!(!pool.active);
        assert!(pool.in_flight.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn cancelled_release_during_flush_marks_namespace_non_reusable_for_retry() {
        let flush_entered = Arc::new(tokio::sync::Notify::new());
        let first_flush_release = Arc::new(tokio::sync::Notify::new());
        let flush_count = Arc::new(AtomicUsize::new(0));
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let flush_entered_for_ops = Arc::clone(&flush_entered);
        let first_flush_release_for_ops = Arc::clone(&first_flush_release);
        let flush_count_for_ops = Arc::clone(&flush_count);
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let flush_entered = Arc::clone(&flush_entered_for_ops);
                let first_flush_release = Arc::clone(&first_flush_release_for_ops);
                let flush_count = Arc::clone(&flush_count_for_ops);
                Box::pin(async move {
                    let attempt = flush_count.fetch_add(1, Ordering::SeqCst);
                    if attempt == 0 {
                        flush_entered.notify_one();
                        first_flush_release.notified().await;
                    }
                    ConntrackFlushOutcome::Trusted
                })
            }),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    delete_count.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        {
            let release = handle.release(&mut lease);
            tokio::pin!(release);
            tokio::select! {
                outcome = &mut release => panic!("release completed before flush was cancelled: {outcome:?}"),
                _ = flush_entered.notified() => {}
            }
        }

        assert!(lease.is_some());
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        {
            let pool = handle.inner.state.lock().await;
            assert!(pool.non_reusable.contains("test-ns"));
        }

        first_flush_release.notify_one();
        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(
            flush_count.load(Ordering::SeqCst),
            1,
            "cancelled flush must taint the namespace before retry"
        );
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = handle.inner.state.lock().await;
        assert!(pool.non_reusable.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn release_cancelled_after_trusted_flush_before_commit_deletes_on_retry() {
        let flush_entered = Arc::new(tokio::sync::Notify::new());
        let first_flush_release = Arc::new(tokio::sync::Notify::new());
        let flush_count = Arc::new(AtomicUsize::new(0));
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let flush_entered_for_ops = Arc::clone(&flush_entered);
        let first_flush_release_for_ops = Arc::clone(&first_flush_release);
        let flush_count_for_ops = Arc::clone(&flush_count);
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let flush_entered = Arc::clone(&flush_entered_for_ops);
                let first_flush_release = Arc::clone(&first_flush_release_for_ops);
                let flush_count = Arc::clone(&flush_count_for_ops);
                Box::pin(async move {
                    let attempt = flush_count.fetch_add(1, Ordering::SeqCst);
                    if attempt == 0 {
                        flush_entered.notify_one();
                        first_flush_release.notified().await;
                    }
                    ConntrackFlushOutcome::Trusted
                })
            }),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    delete_count.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let mut release = Box::pin(handle.release(&mut lease));
        tokio::select! {
            outcome = &mut release => panic!("release completed before flush finished: {outcome:?}"),
            _ = flush_entered.notified() => {}
        }
        let guard = handle.inner.state.lock().await;
        first_flush_release.notify_one();
        tokio::select! {
            outcome = &mut release => panic!("release completed while pool lock was held: {outcome:?}"),
            _ = tokio::task::yield_now() => {}
        }
        assert!(guard.non_reusable.contains("test-ns"));
        drop(release);

        assert!(lease.is_some());
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        drop(guard);

        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(
            flush_count.load(Ordering::SeqCst),
            1,
            "cancelled post-flush commit must not flush/requeue on retry"
        );
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = handle.inner.state.lock().await;
        assert!(pool.non_reusable.is_empty());
        assert!(pool.in_flight.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn direct_release_cancelled_during_flush_marks_namespace_non_reusable_for_retry() {
        let flush_entered = Arc::new(tokio::sync::Notify::new());
        let first_flush_release = Arc::new(tokio::sync::Notify::new());
        let flush_count = Arc::new(AtomicUsize::new(0));
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let flush_entered_for_ops = Arc::clone(&flush_entered);
        let first_flush_release_for_ops = Arc::clone(&first_flush_release);
        let flush_count_for_ops = Arc::clone(&flush_count);
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let flush_entered = Arc::clone(&flush_entered_for_ops);
                let first_flush_release = Arc::clone(&first_flush_release_for_ops);
                let flush_count = Arc::clone(&flush_count_for_ops);
                Box::pin(async move {
                    let attempt = flush_count.fetch_add(1, Ordering::SeqCst);
                    if attempt == 0 {
                        flush_entered.notify_one();
                        first_flush_release.notified().await;
                    }
                    ConntrackFlushOutcome::Trusted
                })
            }),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    delete_count.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let mut pool = NetnsPool::from_state_for_test(pool);

        {
            let release = pool.release(&mut lease);
            tokio::pin!(release);
            tokio::select! {
                result = &mut release => panic!("release completed before flush was cancelled: {result:?}"),
                _ = flush_entered.notified() => {}
            }
        }

        assert!(lease.is_some());
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        {
            let pool = pool.inner.state.lock().await;
            assert!(pool.non_reusable.contains("test-ns"));
        }

        first_flush_release.notify_one();
        pool.release(&mut lease).await.unwrap();

        assert!(lease.is_none());
        assert_eq!(
            flush_count.load(Ordering::SeqCst),
            1,
            "direct cancelled flush must taint the namespace before retry"
        );
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = pool.inner.state.lock().await;
        assert!(pool.non_reusable.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn untrusted_conntrack_flush_deletes_without_requeue() {
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Untrusted })),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    delete_count.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = handle.inner.state.lock().await;
        assert!(pool.in_flight.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn cancelled_untrusted_release_marks_namespace_non_reusable_for_retry() {
        let delete_entered = Arc::new(tokio::sync::Notify::new());
        let first_delete_release = Arc::new(tokio::sync::Notify::new());
        let flush_count = Arc::new(AtomicUsize::new(0));
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let flush_count_for_ops = Arc::clone(&flush_count);
        let delete_count_for_ops = Arc::clone(&delete_count);
        let delete_entered_for_ops = Arc::clone(&delete_entered);
        let first_delete_release_for_ops = Arc::clone(&first_delete_release);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let flush_count = Arc::clone(&flush_count_for_ops);
                Box::pin(async move {
                    flush_count.fetch_add(1, Ordering::SeqCst);
                    ConntrackFlushOutcome::Untrusted
                })
            }),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                let delete_entered = Arc::clone(&delete_entered_for_ops);
                let first_delete_release = Arc::clone(&first_delete_release_for_ops);
                Box::pin(async move {
                    let attempt = delete_count.fetch_add(1, Ordering::SeqCst);
                    delete_entered.notify_one();
                    if attempt == 0 {
                        first_delete_release.notified().await;
                    }
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        {
            let release = handle.release(&mut lease);
            tokio::pin!(release);
            tokio::select! {
                outcome = &mut release => panic!("release completed before delete was cancelled: {outcome:?}"),
                _ = delete_entered.notified() => {}
            }
        }

        assert!(lease.is_some());
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        {
            let pool = handle.inner.state.lock().await;
            assert!(pool.non_reusable.contains("test-ns"));
        }

        first_delete_release.notify_one();
        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(
            flush_count.load(Ordering::SeqCst),
            1,
            "tainted retry must not flush and requeue"
        );
        assert_eq!(delete_count.load(Ordering::SeqCst), 2);
        let pool = handle.inner.state.lock().await;
        assert!(pool.non_reusable.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn release_cancelled_after_delete_before_commit_retries_delete_without_flush() {
        let delete_entered = Arc::new(tokio::sync::Notify::new());
        let first_delete_release = Arc::new(tokio::sync::Notify::new());
        let flush_count = Arc::new(AtomicUsize::new(0));
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let flush_count_for_ops = Arc::clone(&flush_count);
        let delete_count_for_ops = Arc::clone(&delete_count);
        let delete_entered_for_ops = Arc::clone(&delete_entered);
        let first_delete_release_for_ops = Arc::clone(&first_delete_release);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(move |_| {
                let flush_count = Arc::clone(&flush_count_for_ops);
                Box::pin(async move {
                    flush_count.fetch_add(1, Ordering::SeqCst);
                    ConntrackFlushOutcome::Untrusted
                })
            }),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                let delete_entered = Arc::clone(&delete_entered_for_ops);
                let first_delete_release = Arc::clone(&first_delete_release_for_ops);
                Box::pin(async move {
                    let attempt = delete_count.fetch_add(1, Ordering::SeqCst);
                    if attempt == 0 {
                        delete_entered.notify_one();
                        first_delete_release.notified().await;
                    }
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let mut release = Box::pin(handle.release(&mut lease));
        tokio::select! {
            outcome = &mut release => panic!("release completed before delete finished: {outcome:?}"),
            _ = delete_entered.notified() => {}
        }
        let guard = handle.inner.state.lock().await;
        first_delete_release.notify_one();
        tokio::select! {
            outcome = &mut release => panic!("release completed while pool lock was held: {outcome:?}"),
            _ = tokio::task::yield_now() => {}
        }
        assert!(guard.non_reusable.contains("test-ns"));
        drop(release);

        assert!(lease.is_some());
        assert_eq!(flush_count.load(Ordering::SeqCst), 1);
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        drop(guard);

        let outcome = handle.release(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Deleted));
        assert!(lease.is_none());
        assert_eq!(
            flush_count.load(Ordering::SeqCst),
            1,
            "tainted post-delete retry must not flush/requeue"
        );
        assert_eq!(delete_count.load(Ordering::SeqCst), 2);
        let pool = handle.inner.state.lock().await;
        assert!(pool.non_reusable.is_empty());
        assert!(pool.in_flight.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn shared_cleanup_does_not_hold_mutex_while_delete_blocks() {
        let delete_entered = Arc::new(tokio::sync::Notify::new());
        let delete_release = Arc::new(tokio::sync::Notify::new());
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.plain_queue.push_back(test_info("test-ns"));
        let delete_entered_for_ops = Arc::clone(&delete_entered);
        let delete_release_for_ops = Arc::clone(&delete_release);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_namespace: Arc::new(move |_| {
                let delete_entered = Arc::clone(&delete_entered_for_ops);
                let delete_release = Arc::clone(&delete_release_for_ops);
                Box::pin(async move {
                    delete_entered.notify_one();
                    delete_release.notified().await;
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let cleanup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.cleanup().await }
        });
        delete_entered.notified().await;

        let guard = handle
            .inner
            .state
            .try_lock()
            .expect("shared cleanup must not hold netns pool mutex while deleting namespace");
        drop(guard);

        delete_release.notify_one();
        cleanup.await.unwrap().unwrap();
        let pool = handle.inner.state.lock().await;
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn shared_cleanup_retry_keeps_queue_when_cancelled_during_delete() {
        let delete_entered = Arc::new(tokio::sync::Notify::new());
        let delete_release = Arc::new(tokio::sync::Notify::new());
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.plain_queue.push_back(test_info("test-ns"));
        let delete_entered_for_ops = Arc::clone(&delete_entered);
        let delete_release_for_ops = Arc::clone(&delete_release);
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_namespace: Arc::new(move |_| {
                let delete_entered = Arc::clone(&delete_entered_for_ops);
                let delete_release = Arc::clone(&delete_release_for_ops);
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    let attempt = delete_count.fetch_add(1, Ordering::SeqCst);
                    delete_entered.notify_one();
                    if attempt == 0 {
                        delete_release.notified().await;
                    }
                    NamespaceDeleteOutcome::Deleted
                })
            }),
        };
        let handle = NetnsPoolHandle::from_state_for_test(pool);

        let cleanup = tokio::spawn({
            let handle = handle.clone();
            async move { handle.cleanup().await }
        });
        delete_entered.notified().await;
        cleanup.abort();
        let _ = cleanup.await;

        {
            let pool = handle.inner.state.lock().await;
            assert!(!pool.active);
            assert_eq!(pool.plain_queue.len(), 1);
            assert_eq!(pool.plain_queue.front().unwrap().name(), "test-ns");
        }

        delete_release.notify_one();
        handle.cleanup().await.unwrap();
        let pool = handle.inner.state.lock().await;
        assert!(pool.plain_queue.is_empty());
        assert_eq!(delete_count.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn release_disarms_lease_and_returns_info_to_queue() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let info = test_info("test-ns");
        let mut lease = Some(pool.checkout(info).unwrap());
        let mut pool = NetnsPool::from_state_for_test(pool);

        pool.release(&mut lease).await.unwrap();

        assert!(lease.is_none());
        {
            let pool = pool.inner.state.lock().await;
            assert!(pool.in_flight.is_empty());
            assert_eq!(pool.plain_queue.len(), 1);
            assert_eq!(pool.plain_queue.front().unwrap().name(), "test-ns");
        }

        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn proxy_release_disarms_lease_and_returns_info_to_proxy_queue() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.proxy_port = Some(8080);
        let info = test_info("test-ns");
        let mut lease = Some(pool.checkout(info).unwrap());
        let mut pool = NetnsPool::from_state_for_test(pool);

        pool.release(&mut lease).await.unwrap();

        assert!(lease.is_none());
        {
            let pool = pool.inner.state.lock().await;
            assert!(pool.in_flight.is_empty());
            assert!(pool.plain_queue.is_empty());
            assert_eq!(pool.proxy_queue.len(), 1);
            assert_eq!(pool.proxy_queue.front().unwrap().name(), "test-ns");
        }

        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn release_after_cleanup_deletes_outstanding_lease_without_requeueing() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let info = test_info("test-ns");
        let mut lease = Some(pool.checkout(info).unwrap());
        let mut pool = NetnsPool::from_state_for_test(pool);

        pool.cleanup().await.unwrap();

        assert!(lease.is_some());
        {
            let pool = pool.inner.state.lock().await;
            assert!(!pool.active);
            assert!(pool.in_flight.contains("test-ns"));
        }

        pool.release(&mut lease).await.unwrap();

        assert!(lease.is_none());
        {
            let pool = pool.inner.state.lock().await;
            assert!(pool.in_flight.is_empty());
            assert!(pool.plain_queue.is_empty());
            assert!(pool.proxy_queue.is_empty());
        }
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn release_abandoned_delete_consumes_lease_and_clears_tracking() {
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Untrusted })),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    delete_count.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Abandoned
                })
            }),
        };
        let mut lease = Some(pool.checkout(test_info("test-ns")).unwrap());
        let pool = NetnsPool::from_state_for_test(pool);

        let outcome = pool.inner.release_outcome(&mut lease).await;

        assert!(matches!(outcome, NetnsReleaseOutcome::Abandoned));
        assert!(lease.is_none());
        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = pool.inner.state.lock().await;
        assert!(pool.in_flight.is_empty());
        assert!(pool.non_reusable.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn cleanup_retry_drains_pending_creation_after_cancel() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let entered = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = std::sync::Arc::new(tokio::sync::Notify::new());
        let entered_task = std::sync::Arc::clone(&entered);
        let release_task = std::sync::Arc::clone(&release);
        pool.spawn_plain_creation_for_test(async move {
            entered_task.notify_one();
            release_task.notified().await;
            Ok(test_info("test-ns"))
        });
        let mut pool = NetnsPool::from_state_for_test(pool);

        {
            let cleanup = pool.cleanup();
            tokio::pin!(cleanup);
            tokio::select! {
                result = &mut cleanup => panic!("cleanup completed before pending task was released: {result:?}"),
                _ = entered.notified() => {}
            }
        }

        {
            let pool = pool.inner.state.lock().await;
            assert!(!pool.active);
            assert_eq!(pool.pending_plain.len(), 1);
        }

        release.notify_one();
        pool.cleanup().await.unwrap();

        let pool = pool.inner.state.lock().await;
        assert!(!pool.active);
        assert!(pool.pending_plain.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn acquire_cancellation_keeps_pending_creation_for_cleanup() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let entered = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = std::sync::Arc::new(tokio::sync::Notify::new());
        let entered_task = std::sync::Arc::clone(&entered);
        let release_task = std::sync::Arc::clone(&release);
        pool.spawn_plain_creation_for_test(async move {
            entered_task.notify_one();
            release_task.notified().await;
            Ok(test_info("test-ns"))
        });
        let mut pool = NetnsPool::from_state_for_test(pool);

        {
            let acquire = pool.acquire();
            tokio::pin!(acquire);
            tokio::select! {
                result = &mut acquire => panic!("acquire completed before pending task was released: {result:?}"),
                _ = entered.notified() => {}
            }
        }

        {
            let pool = pool.inner.state.lock().await;
            assert!(pool.in_flight.is_empty());
            assert_eq!(pool.pending_plain.len(), 1);
        }

        release.notify_one();
        pool.cleanup().await.unwrap();

        let pool = pool.inner.state.lock().await;
        assert!(!pool.active);
        assert!(pool.pending_plain.is_empty());
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn delete_queued_namespaces_keeps_front_entry_when_cancelled() {
        let mut queue = VecDeque::from([test_info("test-ns")]);
        let entered = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = std::sync::Arc::new(tokio::sync::Notify::new());

        let delete = {
            let entered = std::sync::Arc::clone(&entered);
            let release = std::sync::Arc::clone(&release);
            move |ns: NetnsInfo| {
                assert_eq!(ns.name(), "test-ns");
                let entered = std::sync::Arc::clone(&entered);
                let release = std::sync::Arc::clone(&release);
                async move {
                    entered.notify_one();
                    release.notified().await;
                }
            }
        };
        {
            let deletion = NetnsPoolState::delete_queued_namespaces_with(&mut queue, delete);
            tokio::pin!(deletion);
            tokio::select! {
                _ = &mut deletion => panic!("delete completed before test released it"),
                _ = entered.notified() => {}
            }
        }

        assert_eq!(queue.len(), 1);
        assert_eq!(queue.front().unwrap().name(), "test-ns");

        release.notify_one();
        NetnsPoolState::delete_queued_namespaces_with(&mut queue, |_| async {}).await;
        assert!(queue.is_empty());
    }

    #[tokio::test]
    async fn cleanup_retries_when_pool_is_inactive_but_not_drained() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.plain_queue.push_back(test_info("test-ns"));
        let mut pool = NetnsPool::from_state_for_test(pool);

        pool.cleanup().await.unwrap();

        let pool = pool.inner.state.lock().await;
        assert!(!pool.active);
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn cleanup_removes_queued_namespace_after_abandoned_delete() {
        let delete_count = Arc::new(AtomicUsize::new(0));
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.plain_queue.push_back(test_info("test-ns"));
        let delete_count_for_ops = Arc::clone(&delete_count);
        pool.ops = NetnsLifecycleOps {
            flush_conntrack: Arc::new(|_| Box::pin(async { ConntrackFlushOutcome::Trusted })),
            delete_namespace: Arc::new(move |_| {
                let delete_count = Arc::clone(&delete_count_for_ops);
                Box::pin(async move {
                    delete_count.fetch_add(1, Ordering::SeqCst);
                    NamespaceDeleteOutcome::Abandoned
                })
            }),
        };
        let mut pool = NetnsPool::from_state_for_test(pool);

        pool.cleanup().await.unwrap();

        assert_eq!(delete_count.load(Ordering::SeqCst), 1);
        let pool = pool.inner.state.lock().await;
        assert!(!pool.active);
        assert!(pool.plain_queue.is_empty());
    }

    #[tokio::test]
    async fn acquire_rejects_inactive_pool() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.plain_queue.push_back(test_info("test-ns"));
        let mut pool = NetnsPool::from_state_for_test(pool);

        let err = pool.acquire().await.unwrap_err();

        assert!(matches!(err, NetworkError::PoolNotActive));
        {
            let pool = pool.inner.state.lock().await;
            assert_eq!(pool.plain_queue.len(), 1);
            assert!(pool.in_flight.is_empty());
        }
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn acquire_requeues_namespace_when_checkout_detects_in_flight_duplicate() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.in_flight.insert("test-ns".into());
        pool.plain_queue.push_back(test_info("test-ns"));
        let mut pool = NetnsPool::from_state_for_test(pool);

        let err = pool.acquire().await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        {
            let mut pool = pool.inner.state.lock().await;
            assert_eq!(pool.plain_queue.len(), 1);
            assert_eq!(pool.plain_queue.front().unwrap().name(), "test-ns");
            assert!(pool.pending_plain.is_empty());
            assert_eq!(pool.next_ns_index, 0);

            pool.in_flight.clear();
        }
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn proxy_acquire_requeues_namespace_when_checkout_detects_in_flight_duplicate() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.proxy_port = Some(8080);
        pool.in_flight.insert("test-ns".into());
        pool.proxy_queue.push_back(test_info("test-ns"));
        let mut pool = NetnsPool::from_state_for_test(pool);

        let err = pool.acquire().await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        {
            let mut pool = pool.inner.state.lock().await;
            assert!(pool.plain_queue.is_empty());
            assert_eq!(pool.proxy_queue.len(), 1);
            assert_eq!(pool.proxy_queue.front().unwrap().name(), "test-ns");
            assert!(pool.pending_proxy.is_empty());
            assert_eq!(pool.next_ns_index, 0);

            pool.in_flight.clear();
            pool.proxy_queue.clear();
        }
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn release_keeps_lease_when_namespace_already_queued() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let info = test_info("test-ns");
        let mut lease = Some(pool.checkout(info.clone()).unwrap());
        pool.plain_queue.push_back(info);
        let mut pool = NetnsPool::from_state_for_test(pool);

        let err = pool.release(&mut lease).await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        assert!(lease.is_some());
        {
            let pool = pool.inner.state.lock().await;
            assert_eq!(pool.plain_queue.len(), 1);
            assert_eq!(pool.plain_queue.front().unwrap().name(), "test-ns");
        }

        let _ = lease.take().unwrap().into_info_for_test();
        {
            let mut pool = pool.inner.state.lock().await;
            pool.in_flight.clear();
            pool.plain_queue.clear();
        }
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn proxy_release_keeps_lease_when_namespace_already_queued() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        pool.proxy_port = Some(8080);
        let info = test_info("test-ns");
        let mut lease = Some(pool.checkout(info.clone()).unwrap());
        pool.proxy_queue.push_back(info);
        let mut pool = NetnsPool::from_state_for_test(pool);

        let err = pool.release(&mut lease).await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        assert!(lease.is_some());
        {
            let pool = pool.inner.state.lock().await;
            assert!(pool.plain_queue.is_empty());
            assert_eq!(pool.proxy_queue.len(), 1);
            assert_eq!(pool.proxy_queue.front().unwrap().name(), "test-ns");
        }

        let _ = lease.take().unwrap().into_info_for_test();
        {
            let mut pool = pool.inner.state.lock().await;
            pool.in_flight.clear();
            pool.proxy_queue.clear();
        }
        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn release_keeps_lease_on_wrong_pool_instance() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let info = test_info("test-ns");
        let mut lease = Some(NetnsLease::new(info, pool.instance_id + 1));
        let mut pool = NetnsPool::from_state_for_test(pool);

        let err = pool.release(&mut lease).await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        assert!(lease.is_some());
        let _ = lease.take().unwrap().into_info_for_test();

        pool.cleanup().await.unwrap();
    }

    #[tokio::test]
    async fn release_keeps_lease_when_not_in_flight() {
        let mut pool = NetnsPoolState::inactive_for_test();
        pool.active = true;
        let info = test_info("test-ns");
        let mut lease = Some(NetnsLease::new(info, pool.instance_id));
        let mut pool = NetnsPool::from_state_for_test(pool);

        let err = pool.release(&mut lease).await.unwrap_err();

        assert!(matches!(err, NetworkError::InvalidLease(_)));
        assert!(lease.is_some());
        let _ = lease.take().unwrap().into_info_for_test();

        pool.cleanup().await.unwrap();
    }
}
