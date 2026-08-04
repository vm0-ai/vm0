use std::process::ExitCode;

use zero_cli::dispatch::Invocation;
use zero_cli::error::CliError;
use zero_cli::output::Output;

fn main() -> ExitCode {
    let invocation = Invocation::from_env();
    let registry = match zero_cli::handlers::registry() {
        Ok(registry) => registry,
        Err(error) => {
            return zero_cli::runtime::render_error(error.into(), Output::stdio());
        }
    };

    if registry.handler_for(&invocation).is_none() {
        let error = zero_cli::fallback::exec_npm_cli(invocation.args());
        return zero_cli::runtime::render_error(
            CliError::fallback_exec(error.kind()),
            Output::stdio(),
        );
    }

    zero_cli::runtime::run_native(registry, invocation)
}
