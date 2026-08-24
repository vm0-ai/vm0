use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use guest_contracts::reuse_preparation::{
    ReusePreparationReport, ReusePreparationRequest, RootFilesystemCapacity,
};
use guest_contracts::session_history_identity::{
    SessionHistoryFramework, SessionHistoryIdentity, SessionHistoryRefKind, SessionHistorySourceRef,
};
use sandbox::{ResourceLimits, SandboxConfig, SandboxFactory, SandboxId};
use sandbox_mock::{MockSandboxFactory, MockSandboxOverrides};
use sha2::{Digest, Sha256};

use crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher;
use crate::ids::RunId;
use crate::resource_budget::{BudgetLease, ResourceBudget};
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};

use super::*;

fn make_budget_lease(vcpu: u32, memory_mb: u32) -> BudgetLease {
    let budget = Arc::new(ResourceBudget::new(1, 1, 1.0, 0));
    ResourceBudget::try_reserve_lease(&budget, vcpu, memory_mb).unwrap()
}

fn pool_config(max_idle: usize) -> IdlePoolConfig {
    IdlePoolConfig { max_idle }
}

async fn make_idle_park_request(
    overrides: Arc<MockSandboxOverrides>,
    reuse_key: &str,
    budget_lease: BudgetLease,
) -> IdleParkRequest {
    add_healthy_reuse_preparation_matcher(&overrides);
    let sandbox_id = SandboxId::new_v4();
    let factory: Arc<Box<dyn SandboxFactory>> =
        Arc::new(Box::new(MockSandboxFactory::with_overrides(overrides)));
    let sandbox = factory
        .create(SandboxConfig {
            id: sandbox_id,
            resources: ResourceLimits {
                cpu_count: budget_lease.vcpu(),
                memory_mb: budget_lease.memory_mb(),
            },
            device_rate_limits: None,
            workspace_drive: None,
        })
        .await
        .expect("create sandbox");
    IdleParkRequest::new(IdleParkRequestParts {
        run_id: RunId::new_v4(),
        sandbox,
        factory,
        reuse_key: reuse_key.into(),
        sandbox_id,
        profile_name: "vm0/default".into(),
        device_rate_limits: None,
        budget_lease,
        source_ip: "10.0.0.1".into(),
        storage_fingerprints: StorageFingerprints::default(),
        restored_session_identity: None,
        history_generation_run_id: None,
        guest_timezone_intent: crate::guest_timezone::GuestTimezoneIntent::Unknown,
        workspace_image_size_bytes: 0,
        workspace_promotion: None,
        handoff: None,
    })
}

#[tokio::test]
async fn idle_park_request_success_returns_parked_candidate() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let request = make_idle_park_request(
        Arc::clone(&overrides),
        "session-1",
        make_budget_lease(2, 2048),
    )
    .await;

    let candidate = match request.park_for_idle().await {
        Ok(outcome) => outcome.expect_reusable(),
        Err(_) => panic!("park should succeed"),
    };

    assert_eq!(overrides.park_call_count(), 1);
    assert_eq!(candidate.reuse_key(), "session-1");
}

#[tokio::test]
async fn idle_park_request_semantic_rejection_returns_parked_ownership() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "prepare-for-reuse".into(),
        exit_code: 0,
        stdout: b"not-json".to_vec(),
        stderr: Vec::new(),
    });
    let request = make_idle_park_request(
        Arc::clone(&overrides),
        "session-invalid-report",
        make_budget_lease(2, 2048),
    )
    .await;

    let failure = match request.park_for_idle().await {
        Ok(_) => panic!("invalid report must reject idle admission"),
        Err(failure) => failure,
    };
    let IdleParkFailureParts::Parked {
        rejected,
        reason,
        error,
        expected_capacity_rejection,
    } = failure.into_parts()
    else {
        panic!("semantic rejection after park must retain parked ownership");
    };

    assert_eq!(overrides.park_call_count(), 1);
    assert_eq!(reason, "reuse_preparation_failed");
    assert!(!expected_capacity_rejection);
    assert!(error.contains("invalid report"));
    let (payload, budget_lease) = rejected.into_active_destroy_parts();
    assert_eq!(budget_lease.vcpu(), 2);
    assert_eq!(budget_lease.memory_mb(), 2048);
    assert_eq!(payload.stop_and_destroy().await, DestroyOutcome::Completed);
    assert_eq!(overrides.destroy_call_count(), 1);
}

#[tokio::test]
async fn speculative_repark_preserves_expected_capacity_rejection() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let mut request = make_idle_park_request(
        Arc::clone(&overrides),
        "session-speculative-capacity-rejection",
        make_budget_lease(2, 2048),
    )
    .await;
    request.parts.history_generation_run_id = Some(request.parts.run_id);
    let candidate = match request.park_for_idle().await {
        Ok(outcome) => outcome.expect_reusable(),
        Err(_) => panic!("initial park should succeed"),
    };
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "prepare-for-reuse".into(),
        exit_code: 0,
        stdout: serde_json::to_vec(&ReusePreparationReport {
            before: RootFilesystemCapacity {
                available_bytes: 64 * 1024 * 1024,
                available_inodes: 4096,
            },
            after: RootFilesystemCapacity {
                available_bytes: 64 * 1024 * 1024,
                available_inodes: 4096,
            },
            removed_entries: 0,
        })
        .unwrap(),
        stderr: Vec::new(),
    });
    let reservation = ReservedIdleSandbox {
        entry: candidate.into_idle_entry(Instant::now()),
    };
    let SpeculativeIdleUnparkResult::Ready(speculative) = reservation
        .try_unpark_for_speculation(RunId::new_v4())
        .await
    else {
        panic!("speculative unpark should succeed");
    };

    let SpeculativeReparkResult::Destroy {
        destroy_job,
        expected_capacity_rejection,
        ..
    } = speculative
        .repark_for_claim_rollback(RunId::new_v4(), 0)
        .await
    else {
        panic!("low-capacity speculative repark should return destroy ownership");
    };

    assert!(expected_capacity_rejection);
    destroy_job.run().await;
    assert_eq!(overrides.destroy_call_count(), 1);
}

#[tokio::test]
async fn idle_park_request_protects_retained_identity_runtime_directory() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let session_id = "session-retained-runtime";
    let mut request = make_idle_park_request(
        Arc::clone(&overrides),
        session_id,
        make_budget_lease(2, 2048),
    )
    .await;
    let run_id = request.parts.run_id;
    let retained_runtime_dir = "/home/user/.vm0/guest-agent/runs/previous-run";
    let metadata = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(session_id.as_bytes())),
        SessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(b"history")),
        b"history".len() as u64,
        SessionHistorySourceRef::ClaudeCode {
            config_dir: "/home/user/.claude".to_string(),
            working_dir: "/home/user/workspace".to_string(),
            session_id: session_id.to_string(),
        },
    )
    .unwrap();
    request.parts.restored_session_identity = Some(
        RestoredSessionIdentity::from_final_metadata(
            metadata,
            format!("{retained_runtime_dir}/final-session-history-identity.json"),
            retained_runtime_dir,
        )
        .unwrap(),
    );

    let _candidate = request
        .park_for_idle()
        .await
        .unwrap_or_else(|_| panic!("healthy guest should park"));

    let calls = overrides.exec_calls();
    let call = calls
        .iter()
        .find(|call| call.cmd.contains("prepare-for-reuse"))
        .expect("reuse preparation call");
    let reuse_request: ReusePreparationRequest = serde_json::from_slice(
        call.stdin_bytes
            .as_deref()
            .expect("reuse request should be sent on stdin"),
    )
    .unwrap();
    assert_eq!(
        reuse_request.current_runtime_dir,
        format!("/home/user/.vm0/guest-agent/runs/{run_id}")
    );
    assert_eq!(
        reuse_request.retained_runtime_dir.as_deref(),
        Some(retained_runtime_dir)
    );
}

#[tokio::test]
async fn idle_park_request_success_preserves_reuse_metadata() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let sandbox_id = SandboxId::new_v4();
    let reuse_key = "thread:metadata";
    let profile_name = "vm0/large";
    let source_ip = "10.99.0.42";
    let history_generation_run_id = RunId::new_v4();
    let budget_lease = make_budget_lease(2, 2048);
    add_healthy_reuse_preparation_matcher(&overrides);
    let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
        MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
    ));
    let sandbox = factory
        .create(SandboxConfig {
            id: sandbox_id,
            resources: ResourceLimits {
                cpu_count: budget_lease.vcpu(),
                memory_mb: budget_lease.memory_mb(),
            },
            device_rate_limits: None,
            workspace_drive: None,
        })
        .await
        .expect("create sandbox");
    let storage_fingerprints = StorageFingerprints {
        storages: HashMap::from([(
            "/mnt/storage".into(),
            StorageFingerprint::new("storage-a", "storage-version-2"),
        )]),
        artifacts: HashMap::from([(
            "/workspace".into(),
            StorageFingerprint::new("artifact-a", "artifact-version-3"),
        )]),
    };
    let expected_storage_fingerprints = storage_fingerprints.clone();
    let restored_session_identity = RestoredSessionIdentity::claude_code_for_test("history-hash-a");
    let request = IdleParkRequest::new(IdleParkRequestParts {
        run_id: RunId::new_v4(),
        sandbox,
        factory,
        reuse_key: reuse_key.into(),
        sandbox_id,
        profile_name: profile_name.into(),
        device_rate_limits: None,
        budget_lease,
        source_ip: source_ip.into(),
        storage_fingerprints,
        restored_session_identity: Some(restored_session_identity.clone()),
        history_generation_run_id: Some(history_generation_run_id),
        guest_timezone_intent: crate::guest_timezone::GuestTimezoneIntent::Unknown,
        workspace_image_size_bytes: 0,
        workspace_promotion: None,
        handoff: None,
    });

    let candidate = match request.park_for_idle().await {
        Ok(outcome) => outcome.expect_reusable(),
        Err(_) => panic!("park should succeed"),
    };

    assert_eq!(overrides.park_call_count(), 1);
    assert_eq!(candidate.reuse_key(), reuse_key);
    assert_eq!(candidate.sandbox_id(), sandbox_id);
    assert_eq!(candidate.metadata.profile_name, profile_name);
    assert_eq!(
        candidate.metadata.history_generation_run_id,
        Some(history_generation_run_id)
    );

    let mut pool = IdlePool::new(pool_config(0));
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let reservation = pool
        .reserve_reusable(reuse_key, profile_name, &None)
        .expect("idle entry should be reserved");

    let next_run_id = RunId::new_v4();
    let IdleUnparkResult::Reused {
        sandbox,
        budget_lease,
    } = reservation.try_unpark_for_run(next_run_id).await
    else {
        panic!("unpark should succeed");
    };
    let sandbox = *sandbox;
    assert_eq!(sandbox.sandbox_id(), sandbox_id);
    assert_eq!(
        overrides.run_control_bind_calls(),
        vec![next_run_id.to_string()]
    );
    assert_eq!(
        overrides.unpark_run_control_ids(),
        vec![Some(next_run_id.to_string())]
    );
    let reused_parts = sandbox.into_parts();
    assert_eq!(reused_parts.source_ip, source_ip);
    assert_eq!(
        reused_parts.restored_session_identity,
        Some(restored_session_identity)
    );
    assert_eq!(
        reused_parts.storage_fingerprints.storages,
        expected_storage_fingerprints.storages
    );
    assert_eq!(
        reused_parts.storage_fingerprints.artifacts,
        expected_storage_fingerprints.artifacts
    );
    assert_eq!(budget_lease.vcpu(), 2);
    assert_eq!(budget_lease.memory_mb(), 2048);
}

#[tokio::test]
async fn speculative_repark_preserves_original_idle_age_and_metadata() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let reuse_key = "session-speculative-repark";
    let profile_name = "vm0/speculative";
    let device_rate_limits = sandbox::DeviceRateLimits {
        block: sandbox::BlockRateLimits {
            bandwidth_bytes_per_sec: 100 * 1024 * 1024,
            ops_per_sec: 10_000,
        },
        network: sandbox::NetworkRateLimits {
            rx_bytes_per_sec: 50 * 1024 * 1024,
            tx_bytes_per_sec: 25 * 1024 * 1024,
        },
    };
    let history_generation_run_id = RunId::new_v4();
    let mut request = make_idle_park_request(
        Arc::clone(&overrides),
        reuse_key,
        make_budget_lease(2, 2048),
    )
    .await;
    request.parts.profile_name = profile_name.into();
    request.parts.device_rate_limits = Some(device_rate_limits.clone());
    request.parts.history_generation_run_id = Some(history_generation_run_id);
    request.parts.guest_timezone_intent =
        crate::guest_timezone::GuestTimezoneIntent::Configured("Asia/Shanghai".into());
    let candidate = match request.park_for_idle().await {
        Ok(outcome) => outcome.expect_reusable(),
        Err(_) => panic!("initial park should succeed"),
    };

    let original_parked_at = Instant::now() - Duration::from_secs(120);
    let reservation = ReservedIdleSandbox {
        entry: candidate.into_idle_entry(original_parked_at),
    };
    let SpeculativeIdleUnparkResult::Ready(speculative) = reservation
        .try_unpark_for_speculation(RunId::new_v4())
        .await
    else {
        panic!("speculative unpark should succeed");
    };
    let rollback_run_id = RunId::new_v4();
    let SpeculativeReparkResult::Reparked(restored) = speculative
        .repark_for_claim_rollback(rollback_run_id, 0)
        .await
    else {
        panic!("speculative repark should succeed");
    };

    assert_eq!(restored.entry.parked_at, original_parked_at);
    assert_eq!(restored.entry.reuse_key(), reuse_key);
    assert_eq!(restored.entry.profile_name(), profile_name);
    assert_eq!(
        restored.entry.device_rate_limits(),
        &Some(device_rate_limits)
    );
    assert_eq!(restored.entry.budget_vcpu(), 2);
    assert_eq!(restored.entry.budget_memory_mb(), 2048);
    assert_eq!(
        restored.entry.metadata.history_generation_run_id,
        Some(history_generation_run_id)
    );
    assert_eq!(
        restored.guest_timezone_intent(),
        &crate::guest_timezone::GuestTimezoneIntent::Configured("Asia/Shanghai".into())
    );
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.park_call_count(), 2);
    let preparation_requests: Vec<ReusePreparationRequest> = overrides
        .exec_calls()
        .into_iter()
        .filter(|call| call.cmd.contains("guest-agent prepare-for-reuse"))
        .map(|call| {
            serde_json::from_slice(
                call.stdin_bytes
                    .as_deref()
                    .expect("reuse preparation request should use stdin"),
            )
            .expect("reuse preparation request should be valid")
        })
        .collect();
    assert_eq!(preparation_requests.len(), 2);
    assert_eq!(
        preparation_requests[1].current_runtime_dir,
        format!("/home/user/.vm0/guest-agent/runs/{history_generation_run_id}")
    );
    assert_ne!(
        preparation_requests[1].current_runtime_dir,
        format!("/home/user/.vm0/guest-agent/runs/{rollback_run_id}")
    );
}

#[tokio::test]
async fn speculative_repark_without_history_generation_returns_owned_destroy_job() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let request = make_idle_park_request(
        Arc::clone(&overrides),
        "session-speculative-missing-generation",
        make_budget_lease(2, 2048),
    )
    .await;
    let candidate = match request.park_for_idle().await {
        Ok(outcome) => outcome.expect_reusable(),
        Err(_) => panic!("initial park should succeed"),
    };
    let reservation = ReservedIdleSandbox {
        entry: candidate.into_idle_entry(Instant::now()),
    };
    let SpeculativeIdleUnparkResult::Ready(speculative) = reservation
        .try_unpark_for_speculation(RunId::new_v4())
        .await
    else {
        panic!("speculative unpark should succeed");
    };

    let SpeculativeReparkResult::Destroy {
        destroy_job,
        reason,
        error,
        expected_capacity_rejection,
    } = speculative
        .repark_for_claim_rollback(RunId::new_v4(), 0)
        .await
    else {
        panic!("missing generation should destroy speculative ownership");
    };

    assert_eq!(reason, "speculative_repark_missing_history_generation");
    assert!(!expected_capacity_rejection);
    assert_eq!(
        error,
        "speculative exact-reuse entry is missing a history generation"
    );
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.park_call_count(), 1);
    destroy_job.run().await;
    assert_eq!(overrides.destroy_call_count(), 1);
}

#[tokio::test]
async fn idle_park_request_error_returns_owned_failure_parts() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_park_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Park,
        message: "simulated park error".into(),
    }));
    let request = make_idle_park_request(
        Arc::clone(&overrides),
        "session-1",
        make_budget_lease(2, 2048),
    )
    .await;

    let failure = match request.park_for_idle().await {
        Ok(_) => panic!("park should fail"),
        Err(failure) => failure,
    };
    let IdleParkFailureParts::Active { active, error, .. } = failure.into_parts() else {
        panic!("park operation errors must retain active ownership");
    };

    assert_eq!(overrides.park_call_count(), 1);
    assert!(error.contains("simulated park error"));
    assert_eq!(active.budget_lease.vcpu(), 2);
    assert_eq!(active.budget_lease.memory_mb(), 2048);
}

#[tokio::test]
async fn idle_park_request_panic_returns_owned_failure_parts() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_park_panic("simulated park panic");
    let request = make_idle_park_request(
        Arc::clone(&overrides),
        "session-1",
        make_budget_lease(2, 2048),
    )
    .await;

    let failure = match request.park_for_idle().await {
        Ok(_) => panic!("park should panic"),
        Err(failure) => failure,
    };
    let IdleParkFailureParts::Active { active, error, .. } = failure.into_parts() else {
        panic!("park panics must retain active ownership");
    };

    assert_eq!(overrides.park_call_count(), 1);
    assert_eq!(error, "sandbox park panicked");
    assert_eq!(active.budget_lease.vcpu(), 2);
    assert_eq!(active.budget_lease.memory_mb(), 2048);
}
