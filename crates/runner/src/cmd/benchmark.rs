use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use clap::Args;
use sandbox::{ExecRequest, ExecResult, RuntimeProvider, SandboxConfig, SandboxFactory};
use tracing::{info, warn};
use uuid::Uuid;

use crate::config;
use crate::deps::MITMPROXY_VERSION;
use crate::error::{RunnerError, RunnerResult};
use crate::executor;
use crate::paths::{HomePaths, RunnerPaths};
use crate::prefetch;
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
    /// Environment variables to pass (KEY=VALUE), can be repeated
    #[arg(long, short)]
    env: Vec<String>,
    /// Run the command as root (sudo)
    #[arg(long)]
    sudo: bool,
    /// Profile to benchmark
    #[arg(long)]
    profile: String,
}

pub async fn run_benchmark(
    args: BenchmarkArgs,
    runtime_provider: &dyn RuntimeProvider,
) -> RunnerResult<ExitCode> {
    let total = Instant::now();

    // 1. Load config, force concurrency=1
    let mut runner_config = config::load(&args.config).await?;
    runner_config.sandbox.max_concurrent = 1;

    let home = HomePaths::new()?;

    // Use the default profile for benchmark.
    let default_profile = runner_config
        .profiles
        .get(&args.profile)
        .ok_or_else(|| {
            RunnerError::Config(format!("profile '{}' not found in config", args.profile))
        })?
        .clone();
    let is_snapshot = default_profile.snapshot_hash.is_some();

    // Block until memory.bin is in page cache so benchmark numbers are stable.
    if let Some(hash) = &default_profile.snapshot_hash {
        let path = home.snapshots_dir().join(hash).join("memory.bin");
        let _ = tokio::task::spawn_blocking(move || prefetch::prefetch_memory(&path)).await;
    }

    // 2. Start proxy (unconditional — benchmark always uses proxy)
    let t = Instant::now();
    let runner_paths = RunnerPaths::new(runner_config.base_dir.clone());
    // Benchmark runs a single short-lived sandbox; crash recovery is not needed.
    let (mut mitm, _crash_rx) = proxy::MitmProxy::new(proxy::ProxyConfig {
        mitmdump_bin: home.mitmdump_bin(MITMPROXY_VERSION),
        ca_dir: runner_config.ca_dir.clone(),
        addon_dir: runner_paths.mitm_addon_dir(),
        registry_path: runner_paths.proxy_registry(),
        registry_lock_path: runner_paths.proxy_registry_lock(),
        api_url: runner_config.server.as_ref().map(|s| s.url.clone()),
    })
    .await?;
    mitm.start().await?;
    let proxy_ms = t.elapsed().as_millis();
    info!(proxy_ms, port = mitm.port(), "proxy ready");

    // 3. Factory init (with proxy port) via sandbox runtime
    let factory_config = runner_config.factory_config(&args.profile, &default_profile, &home);

    let t = Instant::now();
    let mut runtime = runtime_provider
        .create_runtime(sandbox::RuntimeConfig {
            proxy_port: Some(mitm.port()),
            dns_port: None, // benchmark does not use custom DNS proxy
        })
        .await?;
    let mut factory = runtime.create_factory(factory_config).await?;
    let factory_ms = t.elapsed().as_millis();
    info!(factory_ms, "factory ready");

    // 4. Create + run sandbox — always shutdown factory and runtime afterwards
    let sandbox_config = SandboxConfig {
        id: Uuid::new_v4(),
        resources: sandbox::ResourceLimits {
            cpu_count: default_profile.vcpu,
            memory_mb: default_profile.memory_mb,
        },
    };
    let (result, timing) = run_sandbox(&args, &*factory, &mitm, sandbox_config, is_snapshot).await;
    let total_ms = total.elapsed().as_millis();
    // Shutdown factory first (releases COW pool, base loop handle), then runtime.
    factory.shutdown().await;
    runtime.shutdown().await;
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
    factory: &dyn SandboxFactory,
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
    let network_log_path = std::path::PathBuf::from("/dev/null");
    let registration = proxy::VmRegistration {
        run_id: &run_id,
        sandbox_token: "",
        network_log_path: &network_log_path,
        firewalls: None,
        network_policies: None,
        encrypted_secrets: None,
        secret_connector_map: None,
        vars: None,
        capture_network_bodies: false,
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
    if is_snapshot {
        if let Err(e) = executor::fix_guest_clock(sandbox).await {
            let timing = Timing {
                boot_ms,
                clock_ms: t.elapsed().as_millis(),
                exec_ms: 0,
            };
            return (Err(e), timing);
        }
        if let Err(e) = executor::reseed_guest_entropy(sandbox).await {
            let timing = Timing {
                boot_ms,
                clock_ms: t.elapsed().as_millis(),
                exec_ms: 0,
            };
            return (Err(e), timing);
        }
    }
    let clock_ms = t.elapsed().as_millis();

    // Parse KEY=VALUE env pairs
    let env_pairs: Vec<(String, String)> = args
        .env
        .iter()
        .filter_map(|s| {
            s.split_once('=')
                .map(|(k, v)| (k.to_string(), v.to_string()))
        })
        .collect();
    let env_refs: Vec<(&str, &str)> = env_pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    let t = Instant::now();
    let result = sandbox
        .exec(&ExecRequest {
            cmd: &args.command,
            timeout: Duration::from_secs(args.timeout_secs),
            env: &env_refs,
            sudo: args.sudo,
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
