use std::sync::{Mutex, MutexGuard};

/// Resource-budget concurrency control.
///
/// Tracks running vcpu, memory, and job count against effective limits.
/// Uses a mutex for correctness — hold times are negligible (no I/O),
/// and `try_reserve` is called from a single async task (main loop).
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

struct BudgetState {
    running_vcpu: u32,
    running_memory_mb: u32,
    running_count: usize,
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

    /// Try to reserve resources for a job. Returns `true` if reserved.
    ///
    /// If nothing is currently running, the first job is always admitted
    /// regardless of resource limits.
    pub fn try_reserve(&self, vcpu: u32, memory_mb: u32) -> bool {
        let mut state = self.lock();

        // First-job guarantee: always admit when idle.
        if state.running_count == 0 {
            state.running_vcpu += vcpu;
            state.running_memory_mb += memory_mb;
            state.running_count += 1;
            return true;
        }

        if state.running_vcpu + vcpu > self.effective_vcpu {
            return false;
        }
        if state.running_memory_mb + memory_mb > self.effective_memory_mb {
            return false;
        }
        if self.max_concurrent > 0 && state.running_count >= self.max_concurrent {
            return false;
        }

        state.running_vcpu += vcpu;
        state.running_memory_mb += memory_mb;
        state.running_count += 1;
        true
    }

    /// Release resources after a job completes.
    pub fn release(&self, vcpu: u32, memory_mb: u32) {
        let mut state = self.lock();
        assert!(
            state.running_vcpu >= vcpu,
            "release underflow: running_vcpu ({}) < vcpu ({vcpu})",
            state.running_vcpu,
        );
        assert!(
            state.running_memory_mb >= memory_mb,
            "release underflow: running_memory_mb ({}) < memory_mb ({memory_mb})",
            state.running_memory_mb,
        );
        assert!(
            state.running_count > 0,
            "release underflow: running_count is 0"
        );
        state.running_vcpu -= vcpu;
        state.running_memory_mb -= memory_mb;
        state.running_count -= 1;
    }

    /// Check if there is potentially enough budget for a job with the given
    /// resources. Used as a gate in the main loop to avoid blocking on
    /// discovery when resources are exhausted.
    pub fn can_afford(&self, vcpu: u32, memory_mb: u32) -> bool {
        let state = self.lock();
        if state.running_count == 0 {
            return true;
        }
        let vcpu_ok = state.running_vcpu + vcpu <= self.effective_vcpu;
        let mem_ok = state.running_memory_mb + memory_mb <= self.effective_memory_mb;
        let count_ok = self.max_concurrent == 0 || state.running_count < self.max_concurrent;
        vcpu_ok && mem_ok && count_ok
    }

    pub fn effective_vcpu(&self) -> u32 {
        self.effective_vcpu
    }

    pub fn effective_memory_mb(&self) -> u32 {
        self.effective_memory_mb
    }

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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserve_within_budget() {
        let budget = ResourceBudget::new(8, 16384, 1.0, 0);
        assert!(budget.try_reserve(2, 2048));
        let state = budget.lock();
        assert_eq!(state.running_vcpu, 2);
        assert_eq!(state.running_memory_mb, 2048);
        assert_eq!(state.running_count, 1);
    }

    #[test]
    fn reserve_fails_on_vcpu_exhaustion() {
        let budget = ResourceBudget::new(4, 16384, 1.0, 0);
        assert!(budget.try_reserve(2, 2048));
        assert!(budget.try_reserve(2, 2048));
        assert!(!budget.try_reserve(2, 2048)); // 6 > 4
        assert_eq!(budget.lock().running_count, 2);
    }

    #[test]
    fn reserve_fails_on_memory_exhaustion() {
        let budget = ResourceBudget::new(16, 4096, 1.0, 0);
        assert!(budget.try_reserve(2, 2048));
        assert!(budget.try_reserve(2, 2048));
        assert!(!budget.try_reserve(2, 2048)); // 6144 > 4096
        // vcpu should not be consumed on memory failure
        assert_eq!(budget.lock().running_vcpu, 4);
    }

    #[test]
    fn reserve_fails_on_max_concurrent() {
        let budget = ResourceBudget::new(16, 32768, 1.0, 2);
        assert!(budget.try_reserve(2, 2048));
        assert!(budget.try_reserve(2, 2048));
        assert!(!budget.try_reserve(2, 2048)); // count 2 >= max 2
        let state = budget.lock();
        assert_eq!(state.running_vcpu, 4);
        assert_eq!(state.running_memory_mb, 4096);
    }

    #[test]
    fn release_frees_resources() {
        let budget = ResourceBudget::new(4, 4096, 1.0, 0);
        assert!(budget.try_reserve(2, 2048));
        assert!(budget.try_reserve(2, 2048));
        assert!(!budget.try_reserve(2, 2048));
        budget.release(2, 2048);
        assert!(budget.try_reserve(2, 2048)); // works after release
    }

    #[test]
    fn can_afford_matches_reserve() {
        let budget = ResourceBudget::new(4, 4096, 1.0, 0);
        assert!(budget.can_afford(2, 2048));
        assert!(budget.try_reserve(2, 2048));
        assert!(budget.can_afford(2, 2048));
        assert!(budget.try_reserve(2, 2048));
        assert!(!budget.can_afford(2, 2048));
    }

    #[test]
    fn concurrency_factor_increases_budget() {
        // 4 CPUs * 2.0 = 8 effective vcpu, 8 GB * 2.0 = 16 GB effective mem
        let budget = ResourceBudget::new(4, 8192, 2.0, 0);
        assert_eq!(budget.effective_vcpu(), 8);
        assert_eq!(budget.effective_memory_mb(), 16384);
        for _ in 0..4 {
            assert!(budget.try_reserve(2, 2048));
        }
        assert!(!budget.try_reserve(2, 2048)); // vcpu: 10 > 8
    }

    #[test]
    fn max_concurrent_zero_means_no_cap() {
        let budget = ResourceBudget::new(16, 65536, 1.0, 0);
        for _ in 0..8 {
            assert!(budget.try_reserve(2, 2048));
        }
        assert_eq!(budget.lock().running_count, 8);
    }

    #[test]
    fn mixed_resource_jobs() {
        // 8 vcpu, 8GB — can fit 1 browser (4vcpu/4GB) + 2 default (2vcpu/2GB)
        let budget = ResourceBudget::new(8, 8192, 1.0, 0);
        assert!(budget.try_reserve(4, 4096)); // browser
        assert!(budget.try_reserve(2, 2048)); // default
        assert!(budget.try_reserve(2, 2048)); // default — exactly 8/8
        assert!(!budget.try_reserve(2, 2048)); // no room
    }

    #[test]
    fn first_job_admitted_even_if_exceeds_budget() {
        // 1 CPU, 1GB — job needs 2 vcpu / 2GB, exceeds both limits
        let budget = ResourceBudget::new(1, 1024, 1.0, 0);
        assert!(budget.try_reserve(2, 2048)); // first job always admitted
        assert!(!budget.try_reserve(2, 2048)); // second blocked
        budget.release(2, 2048);
        assert!(budget.try_reserve(2, 2048)); // first again after release
    }

    #[test]
    fn first_job_bypass_respects_max_concurrent() {
        // max_concurrent=1 still limits to 1 job, but first job can exceed resource budget
        let budget = ResourceBudget::new(1, 512, 1.0, 1);
        assert!(budget.try_reserve(2, 2048)); // first job: exceeds budget but admitted
        assert!(!budget.try_reserve(2, 2048)); // blocked by max_concurrent
    }

    #[test]
    fn release_returns_to_zero() {
        let budget = ResourceBudget::new(8, 16384, 1.0, 0);
        assert!(budget.try_reserve(2, 2048));
        assert!(budget.try_reserve(4, 4096));
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
            handles.push(std::thread::spawn(move || b.try_reserve(2, 2048)));
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
        budget.try_reserve(4, 8192);
        budget.try_reserve(2, 4096);
        let (vcpu, mem, count) = budget.allocated();
        assert_eq!(vcpu, 6);
        assert_eq!(mem, 12288);
        assert_eq!(count, 2);
    }

    #[test]
    fn allocated_fully_used() {
        let budget = ResourceBudget::new(4, 4096, 1.0, 2);
        budget.try_reserve(2, 2048);
        budget.try_reserve(2, 2048);
        let (vcpu, mem, count) = budget.allocated();
        assert_eq!(vcpu, 4);
        assert_eq!(mem, 4096);
        assert_eq!(count, 2);
    }

    #[test]
    fn allocated_overcommitted() {
        // First-job bypass allows exceeding budget
        let budget = ResourceBudget::new(1, 1024, 1.0, 0);
        budget.try_reserve(2, 2048);
        let (vcpu, mem, count) = budget.allocated();
        assert_eq!(vcpu, 2);
        assert_eq!(mem, 2048);
        assert_eq!(count, 1);
    }
}
