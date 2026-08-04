use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::ids::RunId;
use crate::resource_budget::{BudgetLease, ResourceBudget};
use crate::types::{HeldSandboxState, ReusableSandboxState};

use super::test_support::ParkedIdleCandidateBuilder;
use super::*;

fn make_budget_lease(vcpu: u32, memory_mb: u32) -> BudgetLease {
    let budget = Arc::new(ResourceBudget::new(1, 1, 1.0, 0));
    ResourceBudget::try_reserve_lease(&budget, vcpu, memory_mb).unwrap()
}

fn make_candidate_for(reuse_key: &str, vcpu: u32, memory_mb: u32) -> ParkedIdleCandidate {
    make_candidate_for_with_lease(reuse_key, make_budget_lease(vcpu, memory_mb))
}

fn make_candidate_for_with_lease(
    reuse_key: &str,
    budget_lease: BudgetLease,
) -> ParkedIdleCandidate {
    ParkedIdleCandidateBuilder::new(reuse_key, budget_lease)
        .with_mock_sandbox_name("test")
        .build()
}

fn park_at(
    pool: &mut IdlePool,
    reuse_key: &str,
    candidate: ParkedIdleCandidate,
    parked_at: Instant,
    idle_timeout: Duration,
) -> ParkResult {
    assert_eq!(candidate.reuse_key(), reuse_key);
    pool.park_at_for_test(candidate, parked_at, idle_timeout)
}

fn pool_config(max_idle: usize) -> IdlePoolConfig {
    IdlePoolConfig {
        default_timeout: Duration::from_secs(300),
        max_idle,
    }
}

#[test]
fn park_and_take() {
    let mut pool = IdlePool::new(pool_config(0));
    assert_eq!(pool.len(), 0);

    let result = pool.park(make_candidate_for("session-1", 2, 2048));
    assert!(matches!(result, ParkResult::Parked));
    assert_eq!(pool.len(), 1);

    let entry = pool.take("session-1").unwrap();
    assert_eq!(entry.budget_vcpu(), 2);
    assert_eq!(entry.budget_memory_mb(), 2048);
    assert_eq!(pool.len(), 0);
}

#[test]
fn reusable_reservation_is_exclusive_and_restorable() {
    let mut pool = IdlePool::new(pool_config(0));
    let candidate = make_candidate_for("session-reserved", 2, 2048);
    let sandbox_id = candidate.sandbox_id();
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let parked_revision = pool.status_snapshot().revision;

    assert!(
        pool.reserve_reusable("session-reserved", "vm0/large", &None)
            .is_none(),
        "profile mismatch must not reserve the idle entry"
    );
    let reservation = pool
        .reserve_reusable("session-reserved", "vm0/default", &None)
        .expect("matching idle entry should be reserved");
    assert_eq!(pool.len(), 0);
    assert_eq!(pool.status_snapshot().revision, parked_revision + 1);
    assert!(
        pool.reserve_reusable("session-reserved", "vm0/default", &None)
            .is_none(),
        "a removed reservation cannot be acquired twice"
    );

    assert!(matches!(
        pool.restore_reserved(reservation),
        RestoreReservedIdleResult::Restored
    ));
    assert_eq!(pool.len(), 1);
    assert_eq!(pool.status_snapshot().revision, parked_revision + 2);
    assert_eq!(pool.status_snapshot().idle_vms[0].sandbox_id, sandbox_id);
}

#[test]
fn reusable_generation_reservation_requires_exact_generation() {
    let mut pool = IdlePool::new(pool_config(0));
    let held_generation_run_id = RunId::new_v4();
    let requested_generation_run_id = RunId::new_v4();
    let candidate =
        ParkedIdleCandidateBuilder::new("session-generation", make_budget_lease(2, 2048))
            .with_history_generation_run_id(held_generation_run_id)
            .with_last_completed_at("2026-07-15T00:00:00.000Z")
            .build();
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let parked_revision = pool.status_snapshot().revision;

    assert!(
        pool.reserve_reusable_generation(
            "session-generation",
            "vm0/default",
            &None,
            requested_generation_run_id,
        )
        .is_none(),
        "a different generation must remain parked"
    );
    assert_eq!(pool.len(), 1);
    assert_eq!(pool.status_snapshot().revision, parked_revision);

    let _reservation = pool
        .reserve_reusable_generation(
            "session-generation",
            "vm0/default",
            &None,
            held_generation_run_id,
        )
        .expect("the exact generation should reserve");
    assert_eq!(pool.len(), 0);
}

#[tokio::test]
async fn reserved_restore_preserves_newer_same_session_entry() {
    let mut pool = IdlePool::new(pool_config(0));
    let old = make_candidate_for("session-collision", 2, 2048);
    let old_sandbox_id = old.sandbox_id();
    assert!(matches!(pool.park(old), ParkResult::Parked));
    let reservation = pool
        .reserve_reusable("session-collision", "vm0/default", &None)
        .expect("old entry should reserve");

    let replacement = make_candidate_for("session-collision", 2, 2048);
    let replacement_sandbox_id = replacement.sandbox_id();
    assert!(matches!(pool.park(replacement), ParkResult::Parked));
    let RestoreReservedIdleResult::Rejected(rejected) = pool.restore_reserved(reservation) else {
        panic!("collision must reject the older reservation");
    };
    assert_eq!(
        pool.status_snapshot().idle_vms[0].sandbox_id,
        replacement_sandbox_id
    );
    assert_ne!(old_sandbox_id, replacement_sandbox_id);
    rejected.run().await;
    assert_eq!(pool.len(), 1);
}

#[tokio::test]
async fn reserved_restore_rejects_after_parking_closes() {
    let mut pool = IdlePool::new(pool_config(0));
    assert!(matches!(
        pool.park(make_candidate_for("session-closed", 2, 2048)),
        ParkResult::Parked
    ));
    let reservation = pool
        .reserve_reusable("session-closed", "vm0/default", &None)
        .expect("entry should reserve");
    pool.parking_gate().close();

    let RestoreReservedIdleResult::Rejected(rejected) = pool.restore_reserved(reservation) else {
        panic!("closed parking must reject reservation restore");
    };
    rejected.run().await;
    assert_eq!(pool.len(), 0);
}

#[test]
fn park_uses_candidate_reuse_key_as_pool_key() {
    let mut pool = IdlePool::new(pool_config(0));
    let result = pool.park(make_candidate_for("candidate-session", 2, 2048));
    assert!(matches!(result, ParkResult::Parked));

    assert!(
        pool.take("caller-provided-session").is_none(),
        "park no longer accepts a separate reuse key"
    );
    assert!(pool.take("candidate-session").is_some());
}

#[test]
fn take_missing_returns_none() {
    let mut pool = IdlePool::new(pool_config(0));
    assert!(pool.take("nonexistent").is_none());
}

#[test]
fn park_same_reuse_key_evicts_previous() {
    let mut pool = IdlePool::new(pool_config(0));

    let _ = pool.park(make_candidate_for("session-1", 2, 2048));
    let result = pool.park(make_candidate_for("session-1", 4, 4096));

    match result {
        ParkResult::Replaced(evicted) => {
            assert_eq!(evicted.budget_vcpu(), 2);
            assert_eq!(evicted.budget_memory_mb(), 2048);
        }
        _ => panic!("expected Replaced"),
    }

    assert_eq!(pool.len(), 1);
    let entry = pool.take("session-1").unwrap();
    assert_eq!(entry.budget_vcpu(), 4);
}

#[test]
fn park_respects_max_idle() {
    let mut pool = IdlePool::new(pool_config(2));

    let _ = pool.park(make_candidate_for("s1", 2, 2048));
    let _ = pool.park(make_candidate_for("s2", 2, 2048));

    // Third session should fail
    let result = pool.park(make_candidate_for("s3", 2, 2048));
    assert!(matches!(result, ParkResult::Rejected(_)));
    assert_eq!(pool.len(), 2);

    // But replacing existing session should work
    let result = pool.park(make_candidate_for("s1", 4, 4096));
    assert!(matches!(result, ParkResult::Replaced(_)));
    assert_eq!(pool.len(), 2);
}

#[tokio::test]
async fn rejected_parked_idle_candidate_returns_active_owned_lease() {
    let mut pool = IdlePool::new(pool_config(1));
    let _ = pool.park(make_candidate_for("existing", 2, 2048));

    let rejected_budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
    let rejected_lease = ResourceBudget::try_reserve_lease(&rejected_budget, 2, 2048).unwrap();
    let result = pool.park(make_candidate_for_with_lease("rejected", rejected_lease));

    let ParkResult::Rejected(rejected) = result else {
        panic!("expected rejected parked idle candidate");
    };
    assert_eq!(
        rejected_budget.allocated().2,
        1,
        "rejected candidate must retain active job lease"
    );

    let (payload, lease) = rejected.into_active_destroy_parts();
    assert_eq!(
        rejected_budget.allocated().2,
        1,
        "splitting physical destroy from lease must keep active capacity"
    );
    payload.stop_and_destroy().await;
    drop(lease);
    assert_eq!(rejected_budget.allocated().2, 0);
}

#[test]
fn evict_expired() {
    let mut pool = IdlePool::new(pool_config(0));
    let now = Instant::now();

    // Entry expired 10s ago
    let _ = park_at(
        &mut pool,
        "expired",
        make_candidate_for("expired", 2, 2048),
        now - Duration::from_secs(310),
        Duration::from_secs(300),
    );
    // Entry still fresh
    let _ = park_at(
        &mut pool,
        "fresh",
        make_candidate_for("fresh", 2, 2048),
        now,
        Duration::from_secs(300),
    );

    let evicted = pool.evict_expired();
    assert_eq!(evicted.len(), 1);
    assert_eq!(pool.len(), 1);
    assert!(pool.take("fresh").is_some());
}

#[test]
fn evict_expired_with_snapshot_none_expired_keeps_revision() {
    let mut pool = IdlePool::new(pool_config(0));
    let now = Instant::now();
    let fresh = make_candidate_for("fresh", 2, 2048);
    let fresh_sandbox_id = fresh.sandbox_id();
    let _ = park_at(&mut pool, "fresh", fresh, now, Duration::from_secs(300));
    let before_revision = pool.status_snapshot().revision;

    let (evicted, snapshot) = pool.evict_expired_with_snapshot();

    assert!(evicted.is_empty());
    assert_eq!(pool.len(), 1);
    assert_eq!(snapshot.revision, before_revision);
    assert_eq!(snapshot.idle_vms.len(), 1);
    assert_eq!(snapshot.idle_vms[0].reuse_key, "fresh");
    assert_eq!(snapshot.idle_vms[0].sandbox_id, fresh_sandbox_id);
}

#[test]
fn evict_expired_with_snapshot_returns_retained_entries_sorted() {
    let mut pool = IdlePool::new(pool_config(0));
    let now = Instant::now();

    let expired = make_candidate_for("expired", 2, 2048);
    let _ = park_at(
        &mut pool,
        "expired",
        expired,
        now - Duration::from_secs(310),
        Duration::from_secs(300),
    );
    let retained_b = make_candidate_for("sess-b", 4, 4096);
    let retained_b_sandbox_id = retained_b.sandbox_id();
    let _ = park_at(
        &mut pool,
        "sess-b",
        retained_b,
        now,
        Duration::from_secs(300),
    );
    let retained_a = make_candidate_for("sess-a", 1, 1024);
    let retained_a_sandbox_id = retained_a.sandbox_id();
    let _ = park_at(
        &mut pool,
        "sess-a",
        retained_a,
        now,
        Duration::from_secs(300),
    );
    let before_revision = pool.status_snapshot().revision;

    let (evicted, snapshot) = pool.evict_expired_with_snapshot();

    assert_eq!(evicted.len(), 1);
    assert_eq!(pool.len(), 2);
    assert_eq!(snapshot.revision, before_revision + 1);
    assert_eq!(snapshot.idle_vms.len(), 2);
    assert_eq!(snapshot.idle_vms[0].reuse_key, "sess-a");
    assert_eq!(snapshot.idle_vms[0].sandbox_id, retained_a_sandbox_id);
    assert_eq!(snapshot.idle_vms[1].reuse_key, "sess-b");
    assert_eq!(snapshot.idle_vms[1].sandbox_id, retained_b_sandbox_id);
}

#[test]
fn evict_expired_with_snapshot_all_expired_returns_empty_snapshot() {
    let mut pool = IdlePool::new(pool_config(0));
    let now = Instant::now();

    let _ = park_at(
        &mut pool,
        "s1",
        make_candidate_for("s1", 2, 2048),
        now - Duration::from_secs(400),
        Duration::from_secs(300),
    );
    let _ = park_at(
        &mut pool,
        "s2",
        make_candidate_for("s2", 4, 4096),
        now - Duration::from_secs(310),
        Duration::from_secs(300),
    );
    let before_revision = pool.status_snapshot().revision;

    let (evicted, snapshot) = pool.evict_expired_with_snapshot();

    assert_eq!(evicted.len(), 2);
    assert_eq!(pool.len(), 0);
    assert_eq!(snapshot.revision, before_revision + 1);
    assert!(snapshot.idle_vms.is_empty());
}

#[test]
fn evict_oldest() {
    let mut pool = IdlePool::new(pool_config(0));
    let now = Instant::now();

    let _ = park_at(
        &mut pool,
        "old",
        make_candidate_for("old", 2, 2048),
        now - Duration::from_secs(100),
        Duration::from_secs(300),
    );
    let _ = park_at(
        &mut pool,
        "new",
        make_candidate_for("new", 4, 4096),
        now,
        Duration::from_secs(300),
    );

    let evicted = pool.evict_oldest().unwrap();
    assert_eq!(evicted.budget_vcpu(), 2); // the old one
    assert_eq!(pool.len(), 1);
    assert!(pool.take("new").is_some());
}

#[test]
fn evict_oldest_empty_returns_none() {
    let mut pool = IdlePool::new(pool_config(0));
    assert!(pool.evict_oldest().is_none());
}

#[test]
fn held_reuse_keys() {
    let mut pool = IdlePool::new(pool_config(0));
    let _ = pool.park(make_candidate_for("s1", 2, 2048));
    let _ = pool.park(make_candidate_for("s2", 2, 2048));

    let reuse_keys = pool.held_reuse_keys();
    assert_eq!(reuse_keys, vec!["s1", "s2"]);
}

#[test]
fn held_sandbox_states_include_only_entries_with_timestamps() {
    let mut pool = IdlePool::new(pool_config(0));
    let history_generation_run_id = RunId::new_v4();
    let unconfirmed = make_candidate_for("sess-unconfirmed", 2, 2048);
    let confirmed_b = make_candidate_for("sess-b", 2, 2048)
        .with_last_completed_at("2026-05-28T00:00:01.000Z".to_string());
    let confirmed_a = ParkedIdleCandidateBuilder::new("sess-a", make_budget_lease(2, 2048))
        .with_mock_sandbox_name("test")
        .with_history_generation_run_id(history_generation_run_id)
        .with_last_completed_at("2026-05-28T00:00:00.000Z")
        .build();

    let _ = pool.park(unconfirmed);
    let _ = pool.park(confirmed_b);
    let _ = pool.park(confirmed_a);

    assert_eq!(
        pool.held_sandbox_states(),
        vec![
            HeldSandboxState {
                reuse_key: "sess-a".to_string(),
                last_completed_at: "2026-05-28T00:00:00.000Z".to_string(),
                reusable_sandbox: ReusableSandboxState {
                    profile: "vm0/default".to_string(),
                    history_generation_run_id: Some(history_generation_run_id),
                },
            },
            HeldSandboxState {
                reuse_key: "sess-b".to_string(),
                last_completed_at: "2026-05-28T00:00:01.000Z".to_string(),
                reusable_sandbox: ReusableSandboxState {
                    profile: "vm0/default".to_string(),
                    history_generation_run_id: None,
                },
            },
        ],
    );
}

#[test]
fn held_snapshot_pairs_and_sorts() {
    // Park in reverse order to ensure sort kicks in.
    let mut pool = IdlePool::new(pool_config(0));
    let entry_b = make_candidate_for("sess-b", 2, 2048);
    let sid_b = entry_b.sandbox_id();
    let entry_a = make_candidate_for("sess-a", 2, 2048);
    let sid_a = entry_a.sandbox_id();
    let _ = pool.park(entry_b);
    let _ = pool.park(entry_a);

    let vms = pool.held_snapshot();
    assert_eq!(vms.len(), 2);
    assert_eq!(vms[0].reuse_key, "sess-a");
    assert_eq!(vms[0].sandbox_id, sid_a);
    assert_eq!(vms[1].reuse_key, "sess-b");
    assert_eq!(vms[1].sandbox_id, sid_b);
}

#[test]
fn held_snapshot_empty_pool() {
    let pool = IdlePool::new(pool_config(0));
    assert!(pool.held_snapshot().is_empty());
}

#[test]
fn contains_sandbox_id_tracks_current_idle_ownership() {
    let mut pool = IdlePool::new(pool_config(0));
    let candidate = make_candidate_for("s1", 2, 2048);
    let sandbox_id = candidate.sandbox_id();
    assert!(!pool.contains_sandbox_id(sandbox_id));

    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    assert!(pool.contains_sandbox_id(sandbox_id));

    assert!(pool.take("s1").is_some());
    assert!(!pool.contains_sandbox_id(sandbox_id));
}

#[test]
fn status_snapshot_revision_tracks_idle_vm_mutations() {
    let mut pool = IdlePool::new(pool_config(0));
    assert_eq!(pool.status_snapshot().revision, 0);

    let _ = pool.park(make_candidate_for("s1", 2, 2048));
    assert_eq!(pool.status_snapshot().revision, 1);

    assert!(pool.take("s1").is_some());
    assert_eq!(pool.status_snapshot().revision, 2);

    let drained = pool.drain();
    assert!(drained.is_empty());
    assert_eq!(
        pool.status_snapshot().revision,
        2,
        "empty drain must not create a fake idle_vms mutation",
    );

    let _ = pool.park(make_candidate_for("s2", 2, 2048));
    assert_eq!(pool.status_snapshot().revision, 3);

    let drained = pool.drain();
    assert_eq!(drained.len(), 1);
    assert_eq!(pool.status_snapshot().revision, 4);
}

#[test]
fn drain() {
    let mut pool = IdlePool::new(pool_config(0));
    let _ = pool.park(make_candidate_for("s1", 2, 2048));
    let _ = pool.park(make_candidate_for("s2", 4, 4096));

    let drained = pool.drain();
    assert_eq!(drained.len(), 2);
    assert_eq!(pool.len(), 0);
    assert_eq!(pool.parking_state(), ParkingState::Open);
}

#[test]
fn park_rejected_while_soft_draining() {
    let mut pool = IdlePool::new(pool_config(0));
    let gate = pool.parking_gate();
    let _ = pool.park(make_candidate_for("s1", 2, 2048));
    gate.soft_drain();
    assert_eq!(pool.parking_state(), ParkingState::SoftDraining);

    let result = pool.park(make_candidate_for("s2", 4, 4096));
    assert!(matches!(result, ParkResult::Rejected(_)));
    assert_eq!(pool.len(), 1);
}

#[test]
fn park_rejected_when_closed() {
    let mut pool = IdlePool::new(pool_config(0));
    let gate = pool.parking_gate();
    gate.close();

    let result = pool.park(make_candidate_for("s1", 2, 2048));
    assert!(matches!(result, ParkResult::Rejected(_)));
    assert_eq!(pool.len(), 0);
}

#[test]
fn soft_drain_can_reopen_parking() {
    let mut pool = IdlePool::new(pool_config(0));
    let gate = pool.parking_gate();
    gate.soft_drain();
    assert!(matches!(
        pool.park(make_candidate_for("s1", 2, 2048)),
        ParkResult::Rejected(_)
    ));

    gate.open_after_soft_drain();
    let result = pool.park(make_candidate_for("s1", 2, 2048));
    assert!(matches!(result, ParkResult::Parked));
    assert_eq!(pool.len(), 1);
}

#[test]
fn evict_expired_none_expired() {
    let mut pool = IdlePool::new(pool_config(0));
    let now = Instant::now();
    let _ = park_at(
        &mut pool,
        "fresh",
        make_candidate_for("fresh", 2, 2048),
        now,
        Duration::from_secs(300),
    );
    let evicted = pool.evict_expired();
    assert!(evicted.is_empty());
    assert_eq!(pool.len(), 1);
    assert_eq!(pool.status_snapshot().revision, 1);
}

#[test]
fn drain_empty_pool() {
    let mut pool = IdlePool::new(pool_config(0));
    let drained = pool.drain();
    assert!(drained.is_empty());
    assert_eq!(pool.parking_state(), ParkingState::Open);
}

#[test]
fn evict_expired_all_entries() {
    let mut pool = IdlePool::new(pool_config(0));
    let now = Instant::now();

    let _ = park_at(
        &mut pool,
        "s1",
        make_candidate_for("s1", 2, 2048),
        now - Duration::from_secs(400),
        Duration::from_secs(300),
    );
    let _ = park_at(
        &mut pool,
        "s2",
        make_candidate_for("s2", 4, 4096),
        now - Duration::from_secs(310),
        Duration::from_secs(300),
    );
    assert_eq!(pool.len(), 2);

    let evicted = pool.evict_expired();
    assert_eq!(evicted.len(), 2);
    assert_eq!(pool.len(), 0);
    assert_eq!(pool.status_snapshot().revision, 3);
}

#[test]
fn evict_expired_respects_per_entry_timeout() {
    let mut pool = IdlePool::new(pool_config(0));
    let now = Instant::now();

    // Short timeout (60s), parked 70s ago → expired
    let _ = park_at(
        &mut pool,
        "short",
        make_candidate_for("short", 2, 2048),
        now - Duration::from_secs(70),
        Duration::from_secs(60),
    );
    // Long timeout (300s), parked 70s ago → NOT expired
    let _ = park_at(
        &mut pool,
        "long",
        make_candidate_for("long", 4, 4096),
        now - Duration::from_secs(70),
        Duration::from_secs(300),
    );

    let evicted = pool.evict_expired();
    assert_eq!(evicted.len(), 1);
    assert_eq!(evicted[0].budget_vcpu(), 2); // only the short-timeout entry
    assert_eq!(pool.len(), 1);
    assert!(pool.take("long").is_some());
}

#[test]
fn park_max_idle_one() {
    let mut pool = IdlePool::new(pool_config(1));

    let result = pool.park(make_candidate_for("s1", 2, 2048));
    assert!(matches!(result, ParkResult::Parked));

    // Second different session rejected
    let result = pool.park(make_candidate_for("s2", 4, 4096));
    assert!(matches!(result, ParkResult::Rejected(_)));
    assert_eq!(pool.len(), 1);

    // Same session replacement still works
    let result = pool.park(make_candidate_for("s1", 8, 8192));
    assert!(matches!(result, ParkResult::Replaced(_)));
    assert_eq!(pool.len(), 1);
    let entry = pool.take("s1").unwrap();
    assert_eq!(entry.budget_vcpu(), 8);
}
