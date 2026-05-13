use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use clap::Args;
use sandbox::{
    EXEC_OUTPUT_LIMIT_7_MIB, ExecRequest, ExecResult, RuntimeProvider, SandboxConfig,
    SandboxFactory, SandboxId,
};
use tracing::{info, warn};

use crate::config;
use crate::deps::MITMPROXY_VERSION;
use crate::error::{RunnerError, RunnerResult};
use crate::executor;
use crate::lock;
use crate::paths::{HomePaths, RootfsPaths, RunnerPaths};
use crate::prefetch;
use crate::proxy;

#[derive(Default)]
struct Timing {
    boot_ms: Option<u128>,
    clock_ms: Option<u128>,
    exec_ms: Option<u128>,
}

/// Reject entries missing `=` so typos like `--env FOO` fail loud instead of
/// being silently dropped.
fn parse_env_args(env: &[String]) -> RunnerResult<Vec<(String, String)>> {
    env.iter()
        .map(|s| {
            s.split_once('=')
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .ok_or_else(|| {
                    RunnerError::Config(format!(
                        "invalid --env value '{s}': expected KEY=VALUE format"
                    ))
                })
        })
        .collect()
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

    // Validate --env up front so typos fail before proxy/sandbox startup.
    let env_pairs = parse_env_args(&args.env)?;

    // 1. Load config, force concurrency=1
    let mut runner_config = config::load(&args.config).await?;
    runner_config.sandbox.max_concurrent = 1;

    let home = HomePaths::new()?;

    // Look up the profile selected via --profile.
    let profile_name = args.profile.as_str();
    let profile_config = runner_config.profiles.get(profile_name).ok_or_else(|| {
        RunnerError::Config(format!("profile '{profile_name}' not found in config"))
    })?;

    let rootfs_lock = lock::acquire_shared(home.rootfs_lock(&profile_config.rootfs_hash)).await?;
    let rootfs_paths = RootfsPaths::new(&home, &profile_config.rootfs_hash);
    let snapshot_lock =
        lock::acquire_shared(home.snapshot_lock(&profile_config.snapshot_hash)).await?;
    config::validate_profile_image_artifacts(profile_name, profile_config, &home).await?;
    let _resource_locks = (rootfs_lock, snapshot_lock);

    // Block until memory.bin is in page cache so benchmark numbers are stable.
    {
        let path = rootfs_paths
            .snapshot(&profile_config.snapshot_hash)
            .memory_bin();
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
    let factory_config = runner_config.factory_config(profile_name, profile_config, &home);

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
        id: SandboxId::new_v4(),
        resources: sandbox::ResourceLimits {
            cpu_count: profile_config.vcpu,
            memory_mb: profile_config.memory_mb,
        },
    };
    let (result, timing) = run_sandbox(&args, &env_pairs, &*factory, &mitm, sandbox_config).await;
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
                boot_ms = ?boot_ms,
                clock_ms = ?clock_ms,
                exec_ms = ?exec_ms,
                total_ms,
                exit_code = exec_result.exit_code,
                "benchmark complete"
            );
        }
        Err(e) => {
            info!(proxy_ms, factory_ms, boot_ms = ?boot_ms, clock_ms = ?clock_ms, exec_ms = ?exec_ms, total_ms, error = %e, "benchmark failed");
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
    env_pairs: &[(String, String)],
    factory: &dyn SandboxFactory,
    mitm: &proxy::MitmProxy,
    sandbox_config: SandboxConfig,
) -> (RunnerResult<ExecResult>, Timing) {
    let mut sandbox = match factory.create(sandbox_config).await {
        Ok(s) => s,
        Err(e) => return (Err(e.into()), Timing::default()),
    };

    let source_ip = sandbox.source_ip().to_string();
    let run_id = sandbox.id().to_string();
    let network_log_path = std::path::PathBuf::from("/dev/null");
    let proxy_log_path = std::path::PathBuf::from("/dev/null");
    let registration = proxy::VmRegistration {
        run_id: &run_id,
        cli_agent_type: "claude-code",
        sandbox_token: "",
        network_log_path: &network_log_path,
        proxy_log_path: &proxy_log_path,
        firewalls: None,
        network_policies: None,
        encrypted_secrets: None,
        secret_connector_map: None,
        secret_connector_metadata_map: None,
        vars: None,
        capture_network_bodies: false,
        billable_firewalls: &[],
        model_usage_provider: None,
    };
    if let Err(e) = mitm.register_vm(&source_ip, &registration).await {
        warn!(error = %e, "failed to register VM in proxy");
    }

    let (result, timing) = run_in_sandbox(args, env_pairs, sandbox.as_mut()).await;

    if let Err(e) = mitm.unregister_vm(&source_ip).await {
        warn!(error = %e, "failed to unregister VM from proxy");
    }
    if let Err(e) = sandbox.stop().await {
        warn!(error = %e, "sandbox stop failed");
    }
    factory.destroy(sandbox).await;

    (result, timing)
}

/// Images always contain a snapshot — fix guest clock drift and reseed entropy.
async fn setup_guest(sandbox: &dyn sandbox::Sandbox) -> RunnerResult<()> {
    executor::fix_guest_clock(sandbox).await?;
    executor::reseed_guest_entropy(sandbox).await?;
    Ok(())
}

/// Start sandbox, fix clock, exec command. Returns result + timing.
async fn run_in_sandbox(
    args: &BenchmarkArgs,
    env_pairs: &[(String, String)],
    sandbox: &mut dyn sandbox::Sandbox,
) -> (RunnerResult<ExecResult>, Timing) {
    let mut timing = Timing::default();

    let t_boot = Instant::now();
    let start_result = sandbox.start().await;
    timing.boot_ms = Some(t_boot.elapsed().as_millis());
    if let Err(e) = start_result {
        return (Err(e.into()), timing);
    }

    let t_clock = Instant::now();
    let clock_result = setup_guest(sandbox).await;
    timing.clock_ms = Some(t_clock.elapsed().as_millis());
    if let Err(e) = clock_result {
        return (Err(e), timing);
    }

    let env_refs: Vec<(&str, &str)> = env_pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    let t_exec = Instant::now();
    let result = sandbox
        .exec(&ExecRequest {
            cmd: &args.command,
            timeout: Duration::from_secs(args.timeout_secs),
            env: &env_refs,
            sudo: args.sudo,
            output_limits: EXEC_OUTPUT_LIMIT_7_MIB,
        })
        .await
        .map_err(Into::into);
    timing.exec_ms = Some(t_exec.elapsed().as_millis());

    (result, timing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_env_args_accepts_key_value_pairs() {
        let input = vec!["FOO=bar".to_string(), "EMPTY=".to_string()];
        let parsed = parse_env_args(&input).unwrap();
        assert_eq!(
            parsed,
            vec![
                ("FOO".to_string(), "bar".to_string()),
                ("EMPTY".to_string(), String::new()),
            ]
        );
    }

    #[test]
    fn parse_env_args_preserves_value_with_equals() {
        let input = vec!["URL=https://a?x=1&y=2".to_string()];
        let parsed = parse_env_args(&input).unwrap();
        assert_eq!(
            parsed,
            vec![("URL".to_string(), "https://a?x=1&y=2".to_string())]
        );
    }

    #[test]
    fn parse_env_args_rejects_missing_equals() {
        let input = vec!["FOO".to_string()];
        let err = parse_env_args(&input).unwrap_err();
        assert!(err.to_string().contains("expected KEY=VALUE"), "got: {err}");
    }

    #[test]
    fn parse_env_args_rejects_when_any_entry_is_invalid() {
        let input = vec!["GOOD=ok".to_string(), "BAD".to_string()];
        let err = parse_env_args(&input).unwrap_err();
        assert!(err.to_string().contains("'BAD'"), "got: {err}");
    }
}
