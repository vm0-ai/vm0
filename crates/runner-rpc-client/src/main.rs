use std::process::ExitCode;

fn main() -> ExitCode {
    if std::env::args_os().len() != 1 {
        eprintln!("runner-rpc-client takes no arguments; provide one JSON request on stdin");
        return ExitCode::FAILURE;
    }
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => return ExitCode::FAILURE,
    };
    let succeeded = runtime.block_on(runner_rpc_client::run()).unwrap_or(false);
    // Cancelled Tokio stdin/stdout work must not hold runtime shutdown open.
    // The process exits immediately afterward; no request work is detached.
    runtime.shutdown_background();
    if succeeded {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
