use std::collections::HashMap;

use crate::ids::RunId;
use crate::test_fixtures::execution_context_for_test;
use crate::types::ExecutionContext;

pub(in crate::executor::tests) fn minimal_context() -> ExecutionContext {
    let mut ctx = execution_context_for_test(RunId::nil());
    ctx.prompt = "test prompt".into();
    ctx.sandbox_token = "tok".into();
    ctx
}

pub(in crate::executor::tests) fn context_with_env(
    environment: HashMap<String, String>,
) -> ExecutionContext {
    let mut ctx = minimal_context();
    ctx.environment = Some(environment);
    ctx
}
