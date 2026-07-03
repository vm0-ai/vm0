//! Process argv/env preflight guards for CLI children.

use guest_contracts::exec_limits::{ExecBoundaryValue, validate_exec_boundary_sizes};

pub(super) fn validate_process_argv_env<'a>(
    label: &str,
    bin: &str,
    args: impl IntoIterator<Item = &'a str>,
    env_values: &[(String, String)],
) -> Result<(), String> {
    let args = args.into_iter();
    let (lower_args, upper_args) = args.size_hint();
    let mut values = Vec::with_capacity(env_values.len() + upper_args.unwrap_or(lower_args) + 1);
    values.push(ExecBoundaryValue::arg("argv[0]", bin));
    for (index, arg) in args.enumerate() {
        let name = format!("argv[{}]", index + 1);
        values.push(ExecBoundaryValue::arg(name, arg));
    }
    for (key, value) in env_values {
        values.push(ExecBoundaryValue::env(key.as_str(), value));
    }

    validate_exec_boundary_sizes(values).map_err(|error| format!("{label}: {error}"))
}
