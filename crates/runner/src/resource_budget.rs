use std::sync::{Arc, Mutex, MutexGuard};

use tracing::error;

/// Resource-budget concurrency control.
///
/// Tracks running vcpu, memory, and job count against effective limits.
/// Uses a mutex for correctness — hold times are negligible (no I/O),
/// and lease reservation is called from a single async task (main loop).
///
/// Three conditions must hold for admission:
/// 1. `running_vcpu + vcpu <= effective_vcpu`
/// 2. `running_memory_mb + memory_mb <= effective_memory_mb`
/// 3. `max_concurrent == 0 || running_count < max_concurrent`
///
/// Exception: if `running_count == 0`, the first job is always admitted
/// regardless of resource limits (ensures at least 1 job can run on
/// under-provisioned hosts — matches old `.max(1)` behaviour).
pub struct ResourceBudget {
    effective_vcpu: u32,
    effective_memory_mb: u32,
    max_concurrent: usize,
    state: Mutex<BudgetState>,
}

/// Owned reservation against a [`ResourceBudget`].
///
/// The lease releases its reservation when dropped. Drop must never panic:
/// idle VM cleanup may run while unwinding from sandbox/factory failures, and
/// a panic here would turn a cleanup failure into a budget leak or task abort.
#[must_use = "dropping a BudgetLease releases the reserved resources"]
pub struct BudgetLease {
    budget: Option<Arc<ResourceBudget>>,
    vcpu: u32,
    memory_mb: u32,
}

#[derive(Debug, PartialEq, Eq)]
enum BudgetReleaseError {
    Vcpu { running: u32, release: u32 },
    Memory { running: u32, release: u32 },
    Count,
}

struct BudgetState {
    running_vcpu: u32,
    running_memory_mb: u32,
    running_count: usize,
}

impl BudgetLease {
    fn new(budget: Arc<ResourceBudget>, vcpu: u32, memory_mb: u32) -> Self {
        Self {
            budget: Some(budget),
            vcpu,
            memory_mb,
        }
    }

    /// Returns the vCPU reservation held by this lease.
    pub fn vcpu(&self) -> u32 {
        self.vcpu
    }

    /// Returns the memory reservation, in MiB, held by this lease.
    pub fn memory_mb(&self) -> u32 {
        self.memory_mb
    }

    fn release_inner(&mut self) {
        let Some(budget) = self.budget.take() else {
            return;
        };

        if let Err(error) = budget.release_reserved(self.vcpu, self.memory_mb) {
            error!(
                ?error,
                vcpu = self.vcpu,
                memory_mb = self.memory_mb,
                "failed to release resource budget lease"
            );
        }
    }
}

impl Drop for BudgetLease {
    fn drop(&mut self) {
        self.release_inner();
    }
}

impl ResourceBudget {
    /// Create a new resource budget from physical resources and config.
    ///
    /// `concurrency_factor` is applied to both CPU and memory budgets.
    /// The balloon controller reclaims unused guest memory at runtime,
    /// so memory overcommit is safe for typical workloads.
    pub fn new(
        host_cpus: u32,
        host_memory_mb: u32,
        concurrency_factor: f64,
        max_concurrent: usize,
    ) -> Self {
        let effective_vcpu = (host_cpus as f64 * concurrency_factor).floor() as u32;
        let effective_memory_mb = (host_memory_mb as f64 * concurrency_factor).floor() as u32;
        Self {
            effective_vcpu,
            effective_memory_mb,
            max_concurrent,
            state: Mutex::new(BudgetState {
                running_vcpu: 0,
                running_memory_mb: 0,
                running_count: 0,
            }),
        }
    }

    /// Try to reserve resources for a job without creating a lease.
    ///
    /// If nothing is currently running, the first job is always admitted
    /// regardless of resource limits.
    fn try_reserve_inner(&self, vcpu: u32, memory_mb: u32) -> bool {
        let mut state = self.lock();

        if !self.can_admit_locked(&state, vcpu, memory_mb) {
            return false;
        }

        Self::reserve_locked(&mut state, vcpu, memory_mb);
        true
    }

    /// Try to reserve resources and return an owned lease on success.
    pub fn try_reserve_lease(budget: &Arc<Self>, vcpu: u32, memory_mb: u32) -> Option<BudgetLease> {
        if budget.try_reserve_inner(vcpu, memory_mb) {
            Some(BudgetLease::new(Arc::clone(budget), vcpu, memory_mb))
        } else {
            None
        }
    }

    /// Release resources after a job completes.
    #[cfg(test)]
    pub fn release(&self, vcpu: u32, memory_mb: u32) {
        self.release_reserved(vcpu, memory_mb)
            .expect("release underflow");
    }

    /// Check if there is potentially enough budget for a job with the given
    /// resources. Used as a gate in the main loop to avoid blocking on
    /// discovery when resources are exhausted.
    pub fn can_afford(&self, vcpu: u32, memory_mb: u32) -> bool {
        let state = self.lock();
        self.can_admit_locked(&state, vcpu, memory_mb)
    }

    fn can_admit_locked(&self, state: &BudgetState, vcpu: u32, memory_mb: u32) -> bool {
        if state.running_count == 0 {
            return true;
        }

        let Some(next_vcpu) = state.running_vcpu.checked_add(vcpu) else {
            return false;
        };
        let Some(next_memory_mb) = state.running_memory_mb.checked_add(memory_mb) else {
            return false;
        };

        let vcpu_ok = next_vcpu <= self.effective_vcpu;
        let mem_ok = next_memory_mb <= self.effective_memory_mb;
        let count_ok = self.max_concurrent == 0 || state.running_count < self.max_concurrent;
        vcpu_ok && mem_ok && count_ok
    }

    fn reserve_locked(state: &mut BudgetState, vcpu: u32, memory_mb: u32) {
        state.running_vcpu += vcpu;
        state.running_memory_mb += memory_mb;
        state.running_count += 1;
    }

    /// Returns the vCPU admission budget after applying the concurrency factor.
    pub fn effective_vcpu(&self) -> u32 {
        self.effective_vcpu
    }

    /// Returns the memory admission budget, in MiB, after applying the concurrency factor.
    pub fn effective_memory_mb(&self) -> u32 {
        self.effective_memory_mb
    }

    /// Returns the configured concurrent job cap; `0` means no job-count cap.
    pub fn max_concurrent(&self) -> usize {
        self.max_concurrent
    }

    /// Returns (allocated_vcpu, allocated_memory_mb, running_count) for heartbeat reporting.
    pub fn allocated(&self) -> (u32, u32, usize) {
        let state = self.lock();
        (
            state.running_vcpu,
            state.running_memory_mb,
            state.running_count,
        )
    }

    /// Lock the budget state, recovering from poison if a thread panicked.
    fn lock(&self) -> MutexGuard<'_, BudgetState> {
        match self.state.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn release_reserved(&self, vcpu: u32, memory_mb: u32) -> Result<(), BudgetReleaseError> {
        let mut state = self.lock();
        if state.running_vcpu < vcpu {
            return Err(BudgetReleaseError::Vcpu {
                running: state.running_vcpu,
                release: vcpu,
            });
        }
        if state.running_memory_mb < memory_mb {
            return Err(BudgetReleaseError::Memory {
                running: state.running_memory_mb,
                release: memory_mb,
            });
        }
        if state.running_count == 0 {
            return Err(BudgetReleaseError::Count);
        }

        state.running_vcpu -= vcpu;
        state.running_memory_mb -= memory_mb;
        state.running_count -= 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct AdmissionParityCase<'a> {
        name: &'a str,
        host_vcpu: u32,
        host_memory_mb: u32,
        max_concurrent: usize,
        existing_reservations: &'a [(u32, u32)],
        request: (u32, u32),
        expected: bool,
    }

    fn budget_with_reservations(
        host_vcpu: u32,
        host_memory_mb: u32,
        max_concurrent: usize,
        reservations: &[(u32, u32)],
    ) -> ResourceBudget {
        let budget = ResourceBudget::new(host_vcpu, host_memory_mb, 1.0, max_concurrent);
        for &(vcpu, memory_mb) in reservations {
            assert!(budget.try_reserve_inner(vcpu, memory_mb));
        }
        budget
    }

    fn assert_admission_parity(case: AdmissionParityCase<'_>) {
        let (request_vcpu, request_memory_mb) = case.request;

        let can_afford_budget = budget_with_reservations(
            case.host_vcpu,
            case.host_memory_mb,
            case.max_concurrent,
            case.existing_reservations,
        );
        assert_eq!(
            can_afford_budget.can_afford(request_vcpu, request_memory_mb),
            case.expected,
            "can_afford mismatch for {}",
            case.name
        );

        let reserve_budget = budget_with_reservations(
            case.host_vcpu,
            case.host_memory_mb,
            case.max_concurrent,
            case.existing_reservations,
        );
        let before = reserve_budget.allocated();
        assert_eq!(
            reserve_budget.try_reserve_inner(request_vcpu, request_memory_mb),
            case.expected,
            "reservation mismatch for {}",
            case.name
        );

        if case.expected {
            assert_eq!(
                reserve_budget.allocated(),
                (
                    before.0 + request_vcpu,
                    before.1 + request_memory_mb,
                    before.2 + 1
                ),
                "successful reservation recorded wrong allocation for {}",
                case.name
            );
        } else {
            assert_eq!(
                reserve_budget.allocated(),
                before,
                "failed reservation mutated budget for {}",
                case.name
            );
        }
    }

    #[test]
    fn reserve_within_budget() {
        let budget = ResourceBudget::new(8, 16384, 1.0, 0);
        assert!(budget.try_reserve_inner(2, 2048));
        let state = budget.lock();
        assert_eq!(state.running_vcpu, 2);
        assert_eq!(state.running_memory_mb, 2048);
        assert_eq!(state.running_count, 1);
    }

    #[test]
    fn reserve_fails_on_vcpu_exhaustion() {
        let budget = ResourceBudget::new(4, 16384, 1.0, 0);
        assert!(budget.try_reserve_inner(2, 2048));
        assert!(budget.try_reserve_inner(2, 2048));
        assert!(!budget.try_reserve_inner(2, 2048)); // 6 > 4
        assert_eq!(budget.lock().running_count, 2);
    }

    #[test]
    fn reserve_fails_on_memory_exhaustion() {
        let budget = ResourceBudget::new(16, 4096, 1.0, 0);
        assert!(budget.try_reserve_inner(2, 2048));
        assert!(budget.try_reserve_inner(2, 2048));
        assert!(!budget.try_reserve_inner(2, 2048)); // 6144 > 4096
        // vcpu should not be consumed on memory failure
        assert_eq!(budget.lock().running_vcpu, 4);
    }

    #[test]
    fn reserve_fails_on_max_concurrent() {
        let budget = ResourceBudget::new(16, 32768, 1.0, 2);
        assert!(budget.try_reserve_inner(2, 2048));
        assert!(budget.try_reserve_inner(2, 2048));
        assert!(!budget.try_reserve_inner(2, 2048)); // count 2 >= max 2
        let state = budget.lock();
        assert_eq!(state.running_vcpu, 4);
        assert_eq!(state.running_memory_mb, 4096);
    }

    #[test]
    fn release_frees_resources() {
        let budget = ResourceBudget::new(4, 4096, 1.0, 0);
        assert!(budget.try_reserve_inner(2, 2048));
        assert!(budget.try_reserve_inner(2, 2048));
        assert!(!budget.try_reserve_inner(2, 2048));
        budget.release(2, 2048);
        assert!(budget.try_reserve_inner(2, 2048)); // works after release
    }

    #[test]
    fn lease_drop_frees_resources() {
        let budget = Arc::new(ResourceBudget::new(4, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();
        assert_eq!(budget.allocated(), (2, 2048, 1));

        drop(lease);

        assert_eq!(budget.allocated(), (0, 0, 0));
    }

    #[test]
    fn lease_reservation_failure_does_not_consume_budget() {
        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();

        assert!(ResourceBudget::try_reserve_lease(&budget, 2, 2048).is_none());
        assert_eq!(budget.allocated(), (2, 2048, 1));

        drop(lease);
        assert_eq!(budget.allocated(), (0, 0, 0));
    }

    #[test]
    fn lease_drop_does_not_panic_on_underflow() {
        let budget = Arc::new(ResourceBudget::new(4, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();

        budget.release(2, 2048);
        drop(lease);

        assert_eq!(budget.allocated(), (0, 0, 0));
    }

    #[test]
    fn can_afford_matches_reserve() {
        let cases = [
            AdmissionParityCase {
                name: "idle first-job bypass",
                host_vcpu: 1,
                host_memory_mb: 1024,
                max_concurrent: 0,
                existing_reservations: &[],
                request: (2, 2048),
                expected: true,
            },
            AdmissionParityCase {
                name: "over-budget second job",
                host_vcpu: 1,
                host_memory_mb: 1024,
                max_concurrent: 0,
                existing_reservations: &[(2, 2048)],
                request: (2, 2048),
                expected: false,
            },
            AdmissionParityCase {
                name: "within budget",
                host_vcpu: 4,
                host_memory_mb: 4096,
                max_concurrent: 0,
                existing_reservations: &[(2, 2048)],
                request: (2, 2048),
                expected: true,
            },
            AdmissionParityCase {
                name: "vcpu exhausted",
                host_vcpu: 4,
                host_memory_mb: 8192,
                max_concurrent: 0,
                existing_reservations: &[(2, 2048), (2, 2048)],
                request: (1, 1024),
                expected: false,
            },
            AdmissionParityCase {
                name: "memory exhausted",
                host_vcpu: 8,
                host_memory_mb: 4096,
                max_concurrent: 0,
                existing_reservations: &[(2, 2048), (2, 2048)],
                request: (1, 1024),
                expected: false,
            },
            AdmissionParityCase {
                name: "max concurrent exhausted",
                host_vcpu: 16,
                host_memory_mb: 32768,
                max_concurrent: 2,
                existing_reservations: &[(2, 2048), (2, 2048)],
                request: (1, 1024),
                expected: false,
            },
            AdmissionParityCase {
                name: "max concurrent zero has no count cap",
                host_vcpu: 16,
                host_memory_mb: 32768,
                max_concurrent: 0,
                existing_reservations: &[
                    (2, 2048),
                    (2, 2048),
                    (2, 2048),
                    (2, 2048),
                    (2, 2048),
                    (2, 2048),
                    (2, 2048),
                ],
                request: (2, 2048),
                expected: true,
            },
        ];

        for case in cases {
            assert_admission_parity(case);
        }
    }

    #[test]
    fn can_afford_matches_reserve_after_lease_drop() {
        let can_afford_budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&can_afford_budget, 2, 4096).unwrap();
        assert!(!can_afford_budget.can_afford(2, 4096));
        drop(lease);
        assert!(can_afford_budget.can_afford(2, 4096));

        let reserve_budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&reserve_budget, 2, 4096).unwrap();
        assert!(ResourceBudget::try_reserve_lease(&reserve_budget, 2, 4096).is_none());
        drop(lease);
        assert!(ResourceBudget::try_reserve_lease(&reserve_budget, 2, 4096).is_some());
    }

    #[test]
    fn admission_rejects_overflow_without_consuming_budget() {
        let budget = ResourceBudget::new(1, 1, 1.0, 0);
        assert!(budget.try_reserve_inner(u32::MAX, u32::MAX));

        assert!(!budget.can_afford(1, 1));
        assert!(!budget.try_reserve_inner(1, 1));
        assert_eq!(budget.allocated(), (u32::MAX, u32::MAX, 1));
    }

    #[test]
    fn concurrency_factor_increases_budget() {
        // 4 CPUs * 2.0 = 8 effective vcpu, 8 GB * 2.0 = 16 GB effective mem
        let budget = ResourceBudget::new(4, 8192, 2.0, 0);
        assert_eq!(budget.effective_vcpu(), 8);
        assert_eq!(budget.effective_memory_mb(), 16384);
        for _ in 0..4 {
            assert!(budget.try_reserve_inner(2, 2048));
        }
        assert!(!budget.try_reserve_inner(2, 2048)); // vcpu: 10 > 8
    }

    #[test]
    fn max_concurrent_zero_means_no_cap() {
        let budget = ResourceBudget::new(16, 65536, 1.0, 0);
        for _ in 0..8 {
            assert!(budget.try_reserve_inner(2, 2048));
        }
        assert_eq!(budget.lock().running_count, 8);
    }

    #[test]
    fn mixed_resource_jobs() {
        // 8 vcpu, 8GB — can fit 1 browser (4vcpu/4GB) + 2 default (2vcpu/2GB)
        let budget = ResourceBudget::new(8, 8192, 1.0, 0);
        assert!(budget.try_reserve_inner(4, 4096)); // browser
        assert!(budget.try_reserve_inner(2, 2048)); // default
        assert!(budget.try_reserve_inner(2, 2048)); // default — exactly 8/8
        assert!(!budget.try_reserve_inner(2, 2048)); // no room
    }

    #[test]
    fn first_job_admitted_even_if_exceeds_budget() {
        // 1 CPU, 1GB — job needs 2 vcpu / 2GB, exceeds both limits
        let budget = ResourceBudget::new(1, 1024, 1.0, 0);
        assert!(budget.try_reserve_inner(2, 2048)); // first job always admitted
        assert!(!budget.try_reserve_inner(2, 2048)); // second blocked
        budget.release(2, 2048);
        assert!(budget.try_reserve_inner(2, 2048)); // first again after release
    }

    #[test]
    fn first_job_bypass_respects_max_concurrent() {
        // max_concurrent=1 still limits to 1 job, but first job can exceed resource budget
        let budget = ResourceBudget::new(1, 512, 1.0, 1);
        assert!(budget.try_reserve_inner(2, 2048)); // first job: exceeds budget but admitted
        assert!(!budget.try_reserve_inner(2, 2048)); // blocked by max_concurrent
    }

    #[test]
    fn release_returns_to_zero() {
        let budget = ResourceBudget::new(8, 16384, 1.0, 0);
        assert!(budget.try_reserve_inner(2, 2048));
        assert!(budget.try_reserve_inner(4, 4096));
        budget.release(2, 2048);
        budget.release(4, 4096);
        let state = budget.lock();
        assert_eq!(state.running_vcpu, 0);
        assert_eq!(state.running_memory_mb, 0);
        assert_eq!(state.running_count, 0);
    }

    #[test]
    fn concurrent_reserves_no_overcommit() {
        use std::sync::Arc;

        let budget = Arc::new(ResourceBudget::new(4, 8192, 1.0, 0));
        let mut handles = vec![];

        // Spawn 10 threads each trying to reserve 2 vcpu / 2048 MB
        // Only 2 should succeed (4 vcpu total — first-job bypass doesn't
        // help the second thread because count > 0 after the first).
        for _ in 0..10 {
            let b = Arc::clone(&budget);
            handles.push(std::thread::spawn(move || b.try_reserve_inner(2, 2048)));
        }

        let successes: usize = handles
            .into_iter()
            .map(|h| if h.join().unwrap() { 1 } else { 0 })
            .sum();

        assert_eq!(successes, 2);
        let state = budget.lock();
        assert_eq!(state.running_vcpu, 4);
        assert_eq!(state.running_memory_mb, 4096);
        assert_eq!(state.running_count, 2);
    }

    #[test]
    fn allocated_empty() {
        let budget = ResourceBudget::new(16, 32768, 1.0, 8);
        let (vcpu, mem, count) = budget.allocated();
        assert_eq!(vcpu, 0);
        assert_eq!(mem, 0);
        assert_eq!(count, 0);
    }

    #[test]
    fn allocated_partially_used() {
        let budget = ResourceBudget::new(16, 32768, 1.0, 8);
        budget.try_reserve_inner(4, 8192);
        budget.try_reserve_inner(2, 4096);
        let (vcpu, mem, count) = budget.allocated();
        assert_eq!(vcpu, 6);
        assert_eq!(mem, 12288);
        assert_eq!(count, 2);
    }

    #[test]
    fn allocated_fully_used() {
        let budget = ResourceBudget::new(4, 4096, 1.0, 2);
        budget.try_reserve_inner(2, 2048);
        budget.try_reserve_inner(2, 2048);
        let (vcpu, mem, count) = budget.allocated();
        assert_eq!(vcpu, 4);
        assert_eq!(mem, 4096);
        assert_eq!(count, 2);
    }

    #[test]
    fn allocated_overcommitted() {
        // First-job bypass allows exceeding budget
        let budget = ResourceBudget::new(1, 1024, 1.0, 0);
        budget.try_reserve_inner(2, 2048);
        let (vcpu, mem, count) = budget.allocated();
        assert_eq!(vcpu, 2);
        assert_eq!(mem, 2048);
        assert_eq!(count, 1);
    }
}
