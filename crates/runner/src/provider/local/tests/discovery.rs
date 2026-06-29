use super::support::*;

#[tokio::test]
async fn discover_claim_complete() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let job_id = RunId::new_v4();
    write_job(dir.path(), job_id, "hello world");
    let job_path =
        local_queue::job_path(dir.path(), crate::profile::DEFAULT_PROFILE, job_id).unwrap();

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.run_id(), job_id);
    assert_eq!(candidate.profile_name(), crate::profile::DEFAULT_PROFILE);

    let claimed = provider.claim(candidate).await.unwrap();
    assert!(claimed.active_input_source().is_none());
    let ctx = claimed.context();
    assert_eq!(ctx.run_id, job_id);
    assert_eq!(ctx.prompt, "hello world");

    provider
        .complete(job_id, 0, None, None, None, CompletionAuth::local())
        .await;

    let resp = read_result(dir.path(), job_id);
    assert_eq!(resp.exit_code, 0);
    assert!(resp.error.is_none());
    assert!(
        !job_path.exists(),
        "complete() should remove the completed local job file"
    );
}

#[tokio::test]
async fn shutdown_returns_none() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel.clone(), empty_cancel_tokens());

    cancel.cancel();
    assert!(provider.discover().await.is_none());
}

#[tokio::test]
async fn skips_already_claimed_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let job1 = RunId::new_v4();
    let job2 = RunId::new_v4();
    write_job(dir.path(), job1, "claimed");
    write_job(dir.path(), job2, "available");
    std::fs::create_dir_all(local_queue::claims_dir(dir.path())).unwrap();
    std::fs::write(local_queue::claim_path(dir.path(), job1), b"").unwrap();

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.run_id(), job2);
}

#[test]
fn skips_jobs_with_existing_result() {
    let dir = tempfile::tempdir().unwrap();
    let provider = default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());

    let job_id = RunId::new_v4();
    write_job(dir.path(), job_id, "already done");
    assert!(provider.write_result(job_id, 0, None));

    assert!(
        provider.find_unclaimed_job().is_none(),
        "a durable result should prevent a completed job from being rediscovered"
    );
}

#[test]
fn ignores_tmp_and_invalid_job_files() {
    let dir = tempfile::tempdir().unwrap();
    let provider = default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());

    let profile_dir =
        local_queue::profile_jobs_dir(dir.path(), crate::profile::DEFAULT_PROFILE).unwrap();
    std::fs::create_dir_all(&profile_dir).unwrap();
    std::fs::write(
        profile_dir.join(format!("{}.job.tmp", RunId::new_v4())),
        b"{}",
    )
    .unwrap();
    std::fs::write(profile_dir.join("not-a-run-id.job"), b"{}").unwrap();

    assert!(
        provider.find_unclaimed_job().is_none(),
        "tmp and invalid job files must not be discovered"
    );
}

#[tokio::test]
async fn empty_result_does_not_hide_retryable_job() {
    let dir = tempfile::tempdir().unwrap();
    let provider = default_provider(dir.path(), CancellationToken::new(), empty_cancel_tokens());

    let job_id = RunId::new_v4();
    write_job(dir.path(), job_id, "retry me");
    let result_path = local_queue::result_path(dir.path(), job_id);
    std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
    std::fs::write(&result_path, b"").unwrap();

    let candidate = provider.discover().await.unwrap();
    assert_eq!(candidate.run_id(), job_id);
    let claimed = provider.claim(candidate).await.unwrap();
    let ctx = claimed.context();
    assert_eq!(ctx.prompt, "retry me");

    provider
        .complete(job_id, 0, None, None, None, CompletionAuth::local())
        .await;
    let resp = read_result(dir.path(), job_id);
    assert_eq!(resp.exit_code, 0);
}

#[tokio::test]
async fn concurrent_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let provider = default_provider(dir.path(), cancel, empty_cancel_tokens());

    let job1 = RunId::new_v4();
    let job2 = RunId::new_v4();
    write_job(dir.path(), job1, "job1");

    let candidate1 = provider.discover().await.unwrap();
    let run_id1 = candidate1.run_id();
    let claimed1 = provider.claim(candidate1).await.unwrap();
    let ctx1 = claimed1.context();
    assert_eq!(ctx1.prompt, "job1");

    write_job(dir.path(), job2, "job2");

    let candidate2 = provider.discover().await.unwrap();
    let run_id2 = candidate2.run_id();
    let claimed2 = provider.claim(candidate2).await.unwrap();
    let ctx2 = claimed2.context();
    assert_eq!(ctx2.prompt, "job2");
    assert_ne!(run_id1, run_id2);

    provider
        .complete(run_id1, 0, None, None, None, CompletionAuth::local())
        .await;
    provider
        .complete(
            run_id2,
            1,
            Some("test error"),
            None,
            None,
            CompletionAuth::local(),
        )
        .await;

    let resp1 = read_result(dir.path(), job1);
    assert_eq!(resp1.exit_code, 0);
    assert!(resp1.error.is_none());

    let resp2 = read_result(dir.path(), job2);
    assert_eq!(resp2.exit_code, 1);
    assert_eq!(resp2.error.as_deref(), Some("test error"));
}

#[tokio::test]
async fn group_claim_only_one_winner() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();

    let tokens = empty_cancel_tokens();
    let provider_a = default_provider(dir.path(), cancel.clone(), Arc::clone(&tokens));
    let provider_b = default_provider(dir.path(), cancel, tokens);

    let job_id = RunId::new_v4();
    write_job(dir.path(), job_id, "shared");

    let candidate_a = provider_a.discover().await.unwrap();
    let candidate_b = provider_b.discover().await.unwrap();
    assert_eq!(candidate_a.run_id(), job_id);
    assert_eq!(candidate_b.run_id(), job_id);

    let claim_a = provider_a.claim(candidate_a).await;
    let claim_b = provider_b.claim(candidate_b).await;

    assert!(
        claim_a.is_some() ^ claim_b.is_some(),
        "exactly one runner should win the claim"
    );
}
