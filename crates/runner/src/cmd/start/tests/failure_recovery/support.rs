use super::super::support::MockRunEnv;

use crate::ids::RunId;

pub(super) fn assert_no_completion_for_run(env: &MockRunEnv, run_id: RunId, reason: &str) {
    let completions = env.handle.completions.lock().unwrap();
    assert!(
        !completions
            .iter()
            .any(|completion| completion.run_id == run_id),
        "{reason}"
    );
}
