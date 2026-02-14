use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use clap::Args;
use sandbox::{ExecRequest, ExecResult, SandboxConfig, SandboxFactory};
use sandbox_fc::FirecrackerFactory;
use tracing::{info, warn};
use uuid::Uuid;

use crate::config;
use crate::deps::MITMPROXY_VERSION;
use crate::error::RunnerResult;
use crate::executor;
use crate::paths::{HomePaths, RunnerPaths};
use crate::proxy;

struct Timing {
    boot_ms: u128,
    clock_ms: u128,
    exec_ms: u128,
}

#[derive(Args)]
pub struct BenchmarkArgs {
    /// The bash command to execute in the VM
    command: String,
    /// Path to runner.yaml config file
    #[arg(long, short)]
    config: PathBuf,
    /// Command timeout in seconds
    #[arg(long, default_value_t = 300)]
    timeout_secs: u64,
}

pub async fn run_benchmark(args: BenchmarkArgs) -> RunnerResult<ExitCode> {
    let total = Instant::now();

    // 1. Load config, force concurrency=1
    let mut runner_config = config::load(&args.config).await?;
    runner_config.sandbox.max_concurrent = 1;
    let is_snapshot = runner_config.firecracker.snapshot.is_some();

    // 2. Start proxy (unconditional — benchmark always uses proxy)
    let t = Instant::now();
    let home = HomePaths::new()?;
    let runner_paths = RunnerPaths::new(runner_config.base_dir.clone());
    let mut mitm = proxy::MitmProxy::new(proxy::ProxyConfig {
        mitmdump_bin: home.mitmdump_bin(MITMPROXY_VERSION),
        ca_dir: runner_config.ca_dir.clone(),
        addon_path: runner_paths.mitm_addon(),
        registry_path: runner_paths.proxy_registry(),
        api_url: runner_config.server.as_ref().map(|s| s.url.clone()),
    })
    .await?;
    mitm.start().await?;
    let proxy_ms = t.elapsed().as_millis();
    info!(proxy_ms, port = mitm.port(), "proxy ready");

    // 3. Factory init (with proxy port)
    let mut fc_config = runner_config.firecracker_config();
    fc_config.proxy_port = Some(mitm.port());

    let t = Instant::now();
    let mut factory = FirecrackerFactory::new(fc_config).await?;
    factory.startup().await?;
    let factory_ms = t.elapsed().as_millis();
    info!(factory_ms, "factory ready");

    // 4. Create + run sandbox — always shutdown factory and proxy afterwards
    let sandbox_config = SandboxConfig {
        id: Uuid::new_v4(),
        resources: sandbox::ResourceLimits {
            cpu_count: runner_config.sandbox.vcpu,
            memory_mb: runner_config.sandbox.memory_mb,
        },
        use_proxy: true,
    };
    let (result, timing) = run_sandbox(&args, &factory, &mitm, sandbox_config, is_snapshot).await;
    let total_ms = total.elapsed().as_millis();
    factory.shutdown().await;
    if let Err(e) = mitm.stop().await {
        warn!(error = %e, "proxy stop failed");
    }

    // 5. Log timing summary (always, even on error)
    let Timing {
        boot_ms,
        clock_ms,
        exec_ms,
    } = timing;
    match &result {
        Ok(exec_result) => {
            info!(
                proxy_ms,
                factory_ms,
                boot_ms,
                clock_ms,
                exec_ms,
                total_ms,
                exit_code = exec_result.exit_code,
                "benchmark complete"
            );
        }
        Err(e) => {
            info!(proxy_ms, factory_ms, boot_ms, clock_ms, exec_ms, total_ms, error = %e, "benchmark failed");
        }
    }

    let exec_result = result?;

    // 6. Print stdout/stderr directly to terminal
    let stdout = String::from_utf8_lossy(&exec_result.stdout);
    let stderr = String::from_utf8_lossy(&exec_result.stderr);
    if !stdout.is_empty() {
        print!("{stdout}");
    }
    if !stderr.is_empty() {
        eprint!("{stderr}");
    }

    // 7. Propagate exit code
    let code = match u8::try_from(exec_result.exit_code) {
        Ok(c) => c,
        Err(_) => {
            warn!(
                exit_code = exec_result.exit_code,
                "exit code out of u8 range, using 1"
            );
            1
        }
    };
    Ok(ExitCode::from(code))
}

/// Create, register, start, exec, stop, unregister, destroy.
/// Timing is always returned even on error.
/// Caller is responsible for `factory.shutdown()`.
async fn run_sandbox(
    args: &BenchmarkArgs,
    factory: &FirecrackerFactory,
    mitm: &proxy::MitmProxy,
    sandbox_config: SandboxConfig,
    is_snapshot: bool,
) -> (RunnerResult<ExecResult>, Timing) {
    let zero = Timing {
        boot_ms: 0,
        clock_ms: 0,
        exec_ms: 0,
    };
    let mut sandbox = match factory.create(sandbox_config).await {
        Ok(s) => s,
        Err(e) => return (Err(e.into()), zero),
    };

    let source_ip = sandbox.source_ip().to_string();
    let run_id = sandbox.id().to_string();
    let registration = proxy::VmRegistration {
        run_id: &run_id,
        sandbox_token: "",
        firewall_rules: &[],
        // mitm rewrites requests to the API proxy endpoint; benchmark doesn't need that.
        mitm_enabled: false,
        seal_secrets_enabled: false,
    };
    if let Err(e) = mitm.register_vm(&source_ip, &registration).await {
        warn!(error = %e, "failed to register VM in proxy");
    }

    let (result, timing) = run_in_sandbox(args, sandbox.as_mut(), is_snapshot).await;

    if let Err(e) = mitm.unregister_vm(&source_ip).await {
        warn!(error = %e, "failed to unregister VM from proxy");
    }
    if let Err(e) = sandbox.stop().await {
        warn!(error = %e, "sandbox stop failed");
    }
    factory.destroy(sandbox).await;

    (result, timing)
}

/// Start sandbox, fix clock, exec command. Returns result + timing.
async fn run_in_sandbox(
    args: &BenchmarkArgs,
    sandbox: &mut dyn sandbox::Sandbox,
    is_snapshot: bool,
) -> (RunnerResult<ExecResult>, Timing) {
    let t = Instant::now();
    if let Err(e) = sandbox.start().await {
        let timing = Timing {
            boot_ms: t.elapsed().as_millis(),
            clock_ms: 0,
            exec_ms: 0,
        };
        return (Err(e.into()), timing);
    }
    let boot_ms = t.elapsed().as_millis();
    info!(boot_ms, "sandbox started");

    let t = Instant::now();
    if is_snapshot && let Err(e) = executor::fix_guest_clock(sandbox).await {
        let timing = Timing {
            boot_ms,
            clock_ms: t.elapsed().as_millis(),
            exec_ms: 0,
        };
        return (Err(e), timing);
    }
    let clock_ms = t.elapsed().as_millis();

    let t = Instant::now();
    let result = sandbox
        .exec(&ExecRequest {
            cmd: &args.command,
            timeout: Duration::from_secs(args.timeout_secs),
            env: &[],
            sudo: false,
        })
        .await
        .map_err(Into::into);
    let exec_ms = t.elapsed().as_millis();

    let timing = Timing {
        boot_ms,
        clock_ms,
        exec_ms,
    };
    (result, timing)
}
