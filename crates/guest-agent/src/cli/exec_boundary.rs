//! Process argv/env preflight guards for CLI children.

use guest_contracts::exec_limits::{ExecBoundaryValue, validate_exec_boundary_sizes};

pub(super) fn validate_process_argv_env<'a>(
    label: &str,
    bin: &str,
    args: impl IntoIterator<Item = &'a str>,
    env_values: &[(String, String)],
) -> Result<(), String> {
    let mut values = Vec::with_capacity(env_values.len() + 1);
    values.push(ExecBoundaryValue::arg("argv[0]", bin));
    for (index, arg) in args.into_iter().enumerate() {
        let name = format!("argv[{}]", index + 1);
        values.push(ExecBoundaryValue::arg(name, arg));
    }
    for (key, value) in env_values {
        values.push(ExecBoundaryValue::env(key.as_str(), value));
    }

    validate_exec_boundary_sizes(values).map_err(|error| format!("{label}: {error}"))
}
