use std::time::Duration;

use sandbox::{Sandbox, SandboxId};
use sandbox_mock::MockSandboxFactory;
use tokio_util::sync::CancellationToken;

use super::super::super::agent_run::{
    AgentExecutionResult, ProcessCancelTimeouts, RunStart,
    run_in_sandbox_with_process_cancel_timeouts,
};
use super::super::super::sandbox_run::execute_new_sandbox;
use super::super::super::{ExecutorConfig, JobParams, NewSandboxDispatch, PROCESS_CANCEL_TIMEOUTS};
use super::config::test_telemetry;
use crate::error::RunnerResult;
use crate::types::{ExecutionContext, SandboxReuseResult};

pub(in crate::executor::tests) const RUN_IN_SANDBOX_TEST_TIMEOUT: Duration = Duration::from_secs(5);

pub(in crate::executor::tests) async fn run_execute_inner(
    factory: &MockSandboxFactory,
    ctx: &ExecutionContext,
    config: &ExecutorConfig,
    params: &JobParams,
) -> RunnerResult<(i32, Option<String>)> {
    let mut telemetry = test_telemetry(config, ctx);
    let cancel = CancellationToken::new();
    let outcome = execute_new_sandbox(
        factory,
        ctx,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        config,
        params,
        &mut telemetry,
        cancel,
    )
    .await?;
    Ok((outcome.exit_code(), outcome.error().map(ToOwned::to_owned)))
}

pub(in crate::executor::tests) fn spawn_run_in_sandbox_test(
    sandbox: Box<dyn Sandbox>,
    ctx: ExecutionContext,
    config: ExecutorConfig,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<RunnerResult<AgentExecutionResult>> {
    spawn_run_in_sandbox_test_with_timeouts(sandbox, ctx, config, cancel, PROCESS_CANCEL_TIMEOUTS)
}

pub(in crate::executor::tests) fn spawn_run_in_sandbox_test_with_timeouts(
    sandbox: Box<dyn Sandbox>,
    ctx: ExecutionContext,
    config: ExecutorConfig,
    cancel: CancellationToken,
    process_cancel_timeouts: ProcessCancelTimeouts,
) -> tokio::task::JoinHandle<RunnerResult<AgentExecutionResult>> {
    tokio::spawn(async move {
        let mut telemetry = test_telemetry(&config, &ctx);
        run_in_sandbox_with_process_cancel_timeouts(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                prev_storage: None,
            },
            &mut telemetry,
            cancel,
            process_cancel_timeouts,
        )
        .await
    })
}
