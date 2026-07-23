//! Session-history restore planning after discovery resolves sandbox reuse.

use std::time::Instant;

use tokio_util::sync::CancellationToken;

use super::cli_framework::effective_cli_framework;
use super::session_history_cpu::SessionHistoryCpuPool;
use super::session_history_download::{SessionHistoryMaterializer, SessionHistoryProbe};
use super::telemetry::{RunnerPreSpawnPhase, RunnerPreSpawnTiming};
use crate::http::HttpClient;
use crate::restored_session_identity::{
    RestoredSessionIdentity, RestoredSessionIdentityMismatchReason,
};
use crate::types::{ExecutionContext, SandboxReuseResult};
use crate::workspace_image_cache::WorkspaceSessionHistorySidecar;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SessionHistoryRestoreFallback {
    NonReuse,
    MissingIdleIdentity,
    UnverifiedIdleIdentity,
    StaleIdleIdentity,
    IdentityMismatch(Option<RestoredSessionIdentityMismatchReason>),
}

impl SessionHistoryRestoreFallback {
    pub(super) const fn action_type(self) -> &'static str {
        match self {
            Self::NonReuse => "session_history_restore_fallback_non_reuse",
            Self::MissingIdleIdentity => "session_history_restore_fallback_missing_idle_identity",
            Self::UnverifiedIdleIdentity => {
                "session_history_restore_fallback_unverified_idle_identity"
            }
            Self::StaleIdleIdentity => "session_history_restore_fallback_stale_idle_identity",
            Self::IdentityMismatch(_) => "session_history_restore_fallback_identity_mismatch",
        }
    }

    pub(super) const fn identity_mismatch_reason(
        self,
    ) -> Option<RestoredSessionIdentityMismatchReason> {
        match self {
            Self::IdentityMismatch(reason) => reason,
            _ => None,
        }
    }
}

#[derive(Default)]
#[must_use = "restore plans decide whether resume history download can be skipped"]
pub(crate) enum SessionHistoryRestorePlan {
    #[default]
    Default,
    DeferredHashBacked {
        fallback: Option<SessionHistoryRestoreFallback>,
    },
    Prestarted {
        materializer: SessionHistoryMaterializer,
        fallback: Option<SessionHistoryRestoreFallback>,
    },
    LocalSidecar {
        sidecar: WorkspaceSessionHistorySidecar,
        fallback: Option<SessionHistoryRestoreFallback>,
    },
    SkipVerified(RestoredSessionIdentity),
}

pub(crate) struct SessionHistoryRestorePlanInput<'a> {
    pub(crate) resume_session_valid: bool,
    pub(crate) http: &'a HttpClient,
    pub(crate) cpu: &'a SessionHistoryCpuPool,
    pub(crate) context: &'a ExecutionContext,
    pub(crate) cancel: CancellationToken,
    pub(crate) reuse_result: SandboxReuseResult,
    pub(crate) restored_identity: Option<&'a RestoredSessionIdentity>,
    pub(crate) pre_spawn_timing: &'a mut RunnerPreSpawnTiming,
    pub(crate) probe: Option<&'a SessionHistoryProbe>,
}

pub(crate) fn build_session_history_restore_plan(
    input: SessionHistoryRestorePlanInput<'_>,
) -> SessionHistoryRestorePlan {
    let SessionHistoryRestorePlanInput {
        resume_session_valid,
        http,
        cpu,
        context,
        cancel,
        reuse_result,
        restored_identity,
        pre_spawn_timing,
        probe,
    } = input;
    if !resume_session_valid {
        return SessionHistoryRestorePlan::Default;
    }
    let Some(resume_session) = context.resume_session.as_ref() else {
        return SessionHistoryRestorePlan::Default;
    };
    if resume_session.history_ref().is_none() {
        return SessionHistoryRestorePlan::Default;
    }

    let mut prefix_attribution = None;
    let fallback = match reuse_result {
        SandboxReuseResult::Reused => {
            let requested_identity = RestoredSessionIdentity::from_context(context);
            if let Some(requested_identity) = requested_identity {
                match restored_identity {
                    Some(restored_identity)
                        if restored_identity.is_verified_match_for_request(&requested_identity) =>
                    {
                        return SessionHistoryRestorePlan::SkipVerified(restored_identity.clone());
                    }
                    Some(restored_identity) if restored_identity == &requested_identity => {
                        if restored_identity.has_final_metadata_verification() {
                            Some(SessionHistoryRestoreFallback::IdentityMismatch(
                                restored_identity.mismatch_reason_for_request(&requested_identity),
                            ))
                        } else {
                            Some(SessionHistoryRestoreFallback::UnverifiedIdleIdentity)
                        }
                    }
                    Some(restored_identity) => {
                        let (mismatch_reason, attribution) = restored_identity
                            .mismatch_reason_and_prefix_attribution(&requested_identity);
                        prefix_attribution = attribution;
                        Some(SessionHistoryRestoreFallback::IdentityMismatch(
                            mismatch_reason,
                        ))
                    }
                    None => Some(SessionHistoryRestoreFallback::MissingIdleIdentity),
                }
            } else {
                Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                    RestoredSessionIdentityMismatchReason::MissingRequestedIdentity,
                )))
            }
        }
        SandboxReuseResult::NoSessionId
        | SandboxReuseResult::PoolMiss
        | SandboxReuseResult::ProfileMismatch
        | SandboxReuseResult::DeviceLimitMismatch
        | SandboxReuseResult::UnparkFailed => Some(SessionHistoryRestoreFallback::NonReuse),
    };

    if reuse_result != SandboxReuseResult::Reused {
        return SessionHistoryRestorePlan::DeferredHashBacked { fallback };
    }

    let started_at = Instant::now();
    let materializer = match prefix_attribution {
        Some(prefix_attribution) => {
            SessionHistoryMaterializer::start_cancellable_with_prefix_attribution(
                http,
                cpu,
                Some(resume_session),
                effective_cli_framework(&context.cli_agent_type),
                cancel,
                probe,
                prefix_attribution,
            )
        }
        None => SessionHistoryMaterializer::start_cancellable(
            http,
            cpu,
            Some(resume_session),
            effective_cli_framework(&context.cli_agent_type),
            cancel,
            probe,
        ),
    };
    pre_spawn_timing.record_phase_elapsed(
        RunnerPreSpawnPhase::SessionHistoryMaterializerStart,
        started_at,
    );
    SessionHistoryRestorePlan::Prestarted {
        materializer,
        fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use guest_contracts::{
        codex_thread_id::canonical_codex_thread_id,
        session_history_identity::{
            FinalSessionHistoryFramework, FinalSessionHistoryIdentity, FinalSessionHistoryRefKind,
        },
    };
    use sha2::{Digest, Sha256};

    use crate::http::HttpClientConfig;
    use crate::ids::RunId;
    use crate::restored_session_identity::{
        RestoredSessionFramework, RestoredSessionHistoryHashSizeRelationship,
    };
    use crate::test_fixtures::execution_context_for_test;
    use crate::types::{
        ResumeSession, ResumeSessionHistory, ResumeSessionHistoryRef, ResumeSessionHistoryRefKind,
    };

    fn test_http_client() -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url: "http://localhost".into(),
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
        })
        .unwrap()
    }

    fn context_with_history_ref(history_hash: &str) -> ExecutionContext {
        context_with_history_ref_and_size(history_hash, 12)
    }

    fn context_with_history_ref_and_size(history_hash: &str, size: u64) -> ExecutionContext {
        let mut context = execution_context_for_test(RunId::new_v4());
        context.resume_session = Some(ResumeSession {
            cli_agent_session_id: "sess-restore-plan".into(),
            codex_rollout_path: None,
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: ResumeSessionHistoryRefKind::Blob,
                    hash: history_hash.into(),
                    url: "http://127.0.0.1:9/history.blob".into(),
                    encoding: None,
                    raw_size: size,
                    encoded_size: size,
                    download_source: None,
                },
            },
        });
        context
    }

    fn final_metadata_identity(history_hash: String, size: u64) -> RestoredSessionIdentity {
        let metadata = FinalSessionHistoryIdentity::new(
            FinalSessionHistoryFramework::ClaudeCode,
            hex::encode(Sha256::digest(b"sess-restore-plan")),
            FinalSessionHistoryRefKind::Blob,
            history_hash,
            size,
            "/home/user/.claude/projects/-home-user-workspace/session.jsonl",
        )
        .unwrap();
        RestoredSessionIdentity::from_final_metadata(
            metadata,
            "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json",
            "/home/user/.vm0/guest-agent/runs/previous",
        )
        .expect("checkpointed final identity")
    }

    fn build_plan(
        resume_session_valid: bool,
        context: &ExecutionContext,
        reuse_result: SandboxReuseResult,
        restored_identity: Option<&RestoredSessionIdentity>,
    ) -> SessionHistoryRestorePlan {
        let http = test_http_client();
        let cpu = SessionHistoryCpuPool::with_capacity(1);
        let mut pre_spawn_timing = RunnerPreSpawnTiming::start_after_claim();
        build_session_history_restore_plan(SessionHistoryRestorePlanInput {
            resume_session_valid,
            http: &http,
            cpu: &cpu,
            context,
            cancel: CancellationToken::new(),
            reuse_result,
            restored_identity,
            pre_spawn_timing: &mut pre_spawn_timing,
            probe: None,
        })
    }

    #[test]
    fn restore_plan_defaults_for_invalid_resume_session() {
        let context = context_with_history_ref("history-hash-a");

        let plan = build_plan(false, &context, SandboxReuseResult::Reused, None);

        assert!(matches!(plan, SessionHistoryRestorePlan::Default));
    }

    #[test]
    fn restore_plan_defaults_without_hash_backed_history() {
        let mut context_without_resume = execution_context_for_test(RunId::new_v4());
        context_without_resume.resume_session = None;
        let mut context_with_inline_history = execution_context_for_test(RunId::new_v4());
        context_with_inline_history.resume_session = Some(ResumeSession::inline(
            "sess-restore-plan".into(),
            "session history".into(),
        ));

        for context in [&context_without_resume, &context_with_inline_history] {
            let plan = build_plan(true, context, SandboxReuseResult::Reused, None);

            assert!(matches!(plan, SessionHistoryRestorePlan::Default));
        }
    }

    #[test]
    fn restore_plan_skips_matching_checkpointed_final_identity() {
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref_and_size(&history_hash, 12);
        let metadata_path =
            "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json";
        let restored_identity = final_metadata_identity(history_hash, 12);

        let plan = build_plan(
            true,
            &context,
            SandboxReuseResult::Reused,
            Some(&restored_identity),
        );

        match plan {
            SessionHistoryRestorePlan::SkipVerified(identity) => {
                assert_eq!(identity, restored_identity);
                assert_eq!(identity.history_size_bytes(), Some(12));
                assert_eq!(identity.final_metadata_path(), Some(metadata_path));
            }
            _ => panic!("matching checkpointed final identity should skip restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_uses_codex_rollout_path_in_reuse_identity() {
        const ROLLOUT_PATH: &str = concat!(
            "2026/07/23/rollout-2026-07-23T04-01-04-",
            "019e9154-c304-70f0-adde-36efb1be1701.jsonl"
        );
        const OTHER_ROLLOUT_PATH: &str = concat!(
            "2026/07/23/rollout-2026-07-23T05-02-05-",
            "019e9154-c304-70f0-adde-36efb1be1701.jsonl"
        );
        let history_hash = "a".repeat(64);
        let mut context = execution_context_for_test(RunId::new_v4());
        context.cli_agent_type = "codex".into();
        context.resume_session = Some(ResumeSession {
            cli_agent_session_id: "019E9154C30470F0ADDE36EFB1BE1701".into(),
            codex_rollout_path: Some(ROLLOUT_PATH.into()),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: ResumeSessionHistoryRefKind::Blob,
                    hash: history_hash.clone(),
                    url: "http://127.0.0.1:9/history.blob".into(),
                    encoding: None,
                    raw_size: 12,
                    encoded_size: 12,
                    download_source: None,
                },
            },
        });
        let canonical_thread_id =
            canonical_codex_thread_id("019E9154C30470F0ADDE36EFB1BE1701").unwrap();
        let metadata_path =
            "/home/user/.vm0/guest-agent/runs/previous/final-session-history-identity.json";
        let runtime_dir = "/home/user/.vm0/guest-agent/runs/previous";
        let metadata = FinalSessionHistoryIdentity::new_with_codex_rollout_path_hash(
            FinalSessionHistoryFramework::Codex,
            hex::encode(Sha256::digest(canonical_thread_id.as_bytes())),
            FinalSessionHistoryRefKind::Blob,
            history_hash,
            12,
            format!("CODEX_SEARCH:26:/home/user/.codex/sessions:{canonical_thread_id}"),
            Some(hex::encode(Sha256::digest(ROLLOUT_PATH.as_bytes()))),
        )
        .unwrap();
        let restored_identity =
            RestoredSessionIdentity::from_final_metadata(metadata, metadata_path, runtime_dir)
                .expect("checkpointed final identity");

        let plan = build_plan(
            true,
            &context,
            SandboxReuseResult::Reused,
            Some(&restored_identity),
        );

        match plan {
            SessionHistoryRestorePlan::SkipVerified(identity) => {
                assert_eq!(identity, restored_identity);
                assert_eq!(identity.history_size_bytes(), Some(12));
                assert_eq!(identity.final_metadata_path(), Some(metadata_path));
            }
            _ => panic!("matching Codex checkpointed final identity should skip restore"),
        }

        context.resume_session.as_mut().unwrap().codex_rollout_path =
            Some(OTHER_ROLLOUT_PATH.into());
        let plan = build_plan(
            true,
            &context,
            SandboxReuseResult::Reused,
            Some(&restored_identity),
        );
        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                        RestoredSessionIdentityMismatchReason::CodexRolloutPath
                    )))
                );
            }
            _ => panic!("different Codex rollout paths must restore history"),
        }

        context.resume_session.as_mut().unwrap().codex_rollout_path = None;
        let plan = build_plan(
            true,
            &context,
            SandboxReuseResult::Reused,
            Some(&restored_identity),
        );
        assert!(
            matches!(plan, SessionHistoryRestorePlan::SkipVerified(_)),
            "legacy pathless requests should retain reuse compatibility"
        );
    }

    #[tokio::test]
    async fn restore_plan_falls_back_when_matching_reused_identity_is_unverified() {
        let context = context_with_history_ref("history-hash-a");
        let restored_identity = RestoredSessionIdentity::from_context(&context).unwrap();

        let plan = build_plan(
            true,
            &context,
            SandboxReuseResult::Reused,
            Some(&restored_identity),
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::UnverifiedIdleIdentity)
                );
            }
            _ => panic!("unverified reused identity should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_falls_back_when_matching_reused_identity_size_mismatches() {
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref(&history_hash);
        let restored_identity = final_metadata_identity(history_hash, 13);

        let plan = build_plan(
            true,
            &context,
            SandboxReuseResult::Reused,
            Some(&restored_identity),
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                        RestoredSessionIdentityMismatchReason::HistorySize
                    )))
                );
            }
            _ => panic!("reused identity with mismatched size should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_falls_back_when_reused_identity_is_missing() {
        let context = context_with_history_ref("history-hash-a");

        let plan = build_plan(true, &context, SandboxReuseResult::Reused, None);

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::MissingIdleIdentity)
                );
            }
            _ => panic!("missing reused identity should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_classifies_history_hash_size_relationships() {
        let requested_hash = "a".repeat(64);
        let restored_hash = "b".repeat(64);
        let cases = [
            (
                11,
                RestoredSessionHistoryHashSizeRelationship::RequestedSmaller,
            ),
            (
                12,
                RestoredSessionHistoryHashSizeRelationship::RequestedEqual,
            ),
            (
                13,
                RestoredSessionHistoryHashSizeRelationship::RequestedLarger,
            ),
            (0, RestoredSessionHistoryHashSizeRelationship::SizeUnknown),
            (
                api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES + 1,
                RestoredSessionHistoryHashSizeRelationship::SizeUnknown,
            ),
        ];

        for (requested_size, expected_relationship) in cases {
            let context = context_with_history_ref_and_size(&requested_hash, requested_size);
            let restored_identity = final_metadata_identity(restored_hash.clone(), 12);

            let plan = build_plan(
                true,
                &context,
                SandboxReuseResult::Reused,
                Some(&restored_identity),
            );

            match plan {
                SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                    assert_eq!(
                        fallback,
                        Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                            RestoredSessionIdentityMismatchReason::HistoryHash(
                                expected_relationship
                            )
                        )))
                    );
                }
                _ => panic!("history hash mismatch should keep the prestarted restore plan"),
            }
        }
    }

    #[tokio::test]
    async fn restore_plan_classifies_unverified_history_hash_size_as_unknown() {
        let context = context_with_history_ref("history-hash-a");
        let restored_identity = RestoredSessionIdentity::claude_code_for_test("history-hash-b");

        let plan = build_plan(
            true,
            &context,
            SandboxReuseResult::Reused,
            Some(&restored_identity),
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                        RestoredSessionIdentityMismatchReason::HistoryHash(
                            RestoredSessionHistoryHashSizeRelationship::SizeUnknown
                        )
                    )))
                );
            }
            _ => panic!("unverified history hash mismatch should fall back to restore"),
        }
    }

    #[test]
    fn restore_plan_defers_hash_backed_history_for_non_reuse() {
        let context = context_with_history_ref("history-hash-a");

        let plan = build_plan(true, &context, SandboxReuseResult::PoolMiss, None);

        match plan {
            SessionHistoryRestorePlan::DeferredHashBacked { fallback } => {
                assert_eq!(fallback, Some(SessionHistoryRestoreFallback::NonReuse));
            }
            _ => panic!("non-reuse hash-backed history should defer materialization"),
        }
    }

    #[tokio::test]
    async fn restore_plan_classifies_session_identity_mismatch() {
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref(&history_hash);
        let restored_identity = RestoredSessionIdentity::new(
            RestoredSessionFramework::ClaudeCode,
            "sess-other",
            ResumeSessionHistoryRefKind::Blob,
            history_hash,
            Some(12),
        );

        let plan = build_plan(
            true,
            &context,
            SandboxReuseResult::Reused,
            Some(&restored_identity),
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                        RestoredSessionIdentityMismatchReason::SessionIdentity
                    )))
                );
            }
            _ => panic!("mismatched session identity should fall back to restore"),
        }
    }

    #[tokio::test]
    async fn restore_plan_classifies_framework_mismatch() {
        let history_hash = "a".repeat(64);
        let context = context_with_history_ref(&history_hash);
        let restored_identity = RestoredSessionIdentity::new(
            RestoredSessionFramework::Codex,
            "sess-restore-plan",
            ResumeSessionHistoryRefKind::Blob,
            history_hash,
            Some(12),
        );

        let plan = build_plan(
            true,
            &context,
            SandboxReuseResult::Reused,
            Some(&restored_identity),
        );

        match plan {
            SessionHistoryRestorePlan::Prestarted { fallback, .. } => {
                assert_eq!(
                    fallback,
                    Some(SessionHistoryRestoreFallback::IdentityMismatch(Some(
                        RestoredSessionIdentityMismatchReason::Framework
                    )))
                );
            }
            _ => panic!("mismatched framework should fall back to restore"),
        }
    }
}
