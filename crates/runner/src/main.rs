// Trigger another runner release on 2026-07-31.
mod active_input;
mod axiom_layer;
mod bounded_command;
mod byte_size;
mod ca;
mod child_cleanup;
mod cmd;
mod config;
mod deps;
mod dns;
mod duration;
mod error;
mod executor;
mod firewall_hostname_policy;
mod group;
mod guest_timezone;
mod helper_exec;
mod host;
mod host_env;
mod host_file;
mod http;
mod idle_pool;
mod idle_reuse_preparation;
mod ids;
mod image_hash;
mod io_limits;
mod kmsg_log;
mod lifecycle;
mod live_runner_instances;
mod local_queue;
mod lock;
mod log_file;
mod network_log_drain;
mod network_log_manager;
mod network_log_process;
mod network_logs;
mod object_download_policy;
mod operator_api_url;
mod org_name;
mod parent_death;
mod paths;
mod pre_spawn_admission;
mod prefetch;
mod private_fs;
mod process;
mod profile;
mod provider;
mod proxy;
mod r2_cache;
mod resource_budget;
mod restored_session_identity;
mod retry;
mod run_cancellation;
mod run_resolution;
mod runner_dirname;
mod runner_process_identity;
mod runner_token;
mod runtime_overrides;
mod state_file;
mod status;
mod status_file;
mod storage_cache;
mod storage_fingerprints;
mod storage_manifest;
mod storage_plan;
mod telemetry;
#[cfg(test)]
mod test_fixtures;
mod types;
mod workspace_image_cache;
mod workspace_mount;
mod workspace_promotion;

use std::path::Path;
use std::process::ExitCode;

use clap::{FromArgMatches, Parser, Subcommand};
use tracing_subscriber::Layer as _;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::fmt::writer::MakeWriterExt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

const RUNNER_FMT_MAX_LEVEL: LevelFilter = LevelFilter::INFO;

#[derive(Parser)]
#[command(name = "runner", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

impl Cli {
    fn parse_with_environment_aliases() -> Self {
        Self::try_parse_with_environment_aliases_from(std::env::args_os())
            .unwrap_or_else(|error| error.exit())
    }

    fn try_parse_with_environment_aliases_from<I, T>(args: I) -> Result<Self, clap::Error>
    where
        I: IntoIterator<Item = T>,
        T: Into<std::ffi::OsString> + Clone,
    {
        let mut matches = <Self as clap::CommandFactory>::command().try_get_matches_from(args)?;
        let api_url_from_environment = matches.subcommand().is_some_and(|(name, subcommand)| {
            matches!(name, "config" | "start")
                && subcommand.value_source("api_url")
                    == Some(clap::parser::ValueSource::EnvVariable)
        });
        let cli = Self::from_arg_matches_mut(&mut matches)
            .map_err(|error| error.format(&mut <Self as clap::CommandFactory>::command()))?;
        if matches!(&cli.command, Command::Config(_) | Command::Start(_))
            && runner_token::environment_aliases_conflict()
        {
            return Err(<Self as clap::CommandFactory>::command().error(
                clap::error::ErrorKind::ArgumentConflict,
                format!(
                    "{} and {} cannot both be set",
                    runner_token::CANONICAL_ENV,
                    runner_token::LEGACY_ENV
                ),
            ));
        }
        if api_url_from_environment && operator_api_url::environment_aliases_conflict() {
            return Err(<Self as clap::CommandFactory>::command().error(
                clap::error::ErrorKind::ArgumentConflict,
                format!(
                    "{} and {} contain conflicting values",
                    operator_api_url::CANONICAL_ENV,
                    operator_api_url::LEGACY_ENV
                ),
            ));
        }
        Ok(cli)
    }
}

#[derive(Subcommand)]
enum Command {
    /// Download Firecracker, kernel, and verify host prerequisites
    Setup,
    /// Build rootfs and snapshot into a unified image
    Build(cmd::BuildArgs),
    /// Generate runner.yaml from a pre-built image hash
    Config(cmd::ConfigArgs),
    /// Run a single bash command in a sandbox for benchmarking
    Benchmark(cmd::BenchmarkArgs),
    /// Execute a command inside a running sandbox for debugging
    Exec(cmd::ExecArgs),
    /// Start the runner and poll for jobs (must run setup + build first)
    Start(Box<cmd::StartArgs>),
    /// Manage the runner as a systemd service
    Service(cmd::ServiceArgs),
    /// Kill a running sandbox
    Kill(cmd::KillArgs),
    /// Clean up unused runner resources, artifacts, logs, and caches
    Gc(cmd::GcArgs),
    /// Inspect and clean up workspace image cache entries
    WorkspaceImageCache(cmd::WorkspaceImageCacheArgs),
    /// Runtime health diagnostics for all runners on the host
    Doctor(cmd::DoctorArgs),
    /// Local file-queue provider commands
    Local(cmd::LocalArgs),
}

/// Extract the runner `name` field from a runner config YAML.
///
/// Called before tracing is initialized, so warnings go to stderr directly.
/// The returned value is sanitized to contain only `[a-zA-Z0-9_-]` characters
/// so it is safe for use as a log file prefix.
fn runner_name_from_config(path: &Path) -> String {
    #[derive(serde::Deserialize)]
    struct Partial {
        name: String,
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "warn: could not read config for runner name: {}: {e}",
                path.display()
            );
            return "default".into();
        }
    };
    let raw = match serde_yaml_ng::from_str::<Partial>(&content) {
        Ok(p) => p.name,
        Err(e) => {
            eprintln!(
                "warn: could not parse runner name from {}: {e}",
                path.display()
            );
            return "default".into();
        }
    };
    sanitize_name(&raw)
}

/// Read the optional canonical hostname before tracing starts.
///
/// Normal config loading remains responsible for reporting read, parse, and
/// validation failures. This early read only supplies trusted common Axiom
/// dimensions when the same Runner config boundary already accepts the value.
fn runner_hostname_from_config(path: &Path) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Partial {
        hostname: Option<String>,
    }

    let content = std::fs::read_to_string(path).ok()?;
    let hostname = serde_yaml_ng::from_str::<Partial>(&content)
        .ok()?
        .hostname?;
    config::validate_runner_hostname(&hostname).ok()?;
    Some(hostname)
}

/// Replace non-`[a-zA-Z0-9_-]` characters with `-`.
/// Returns `"default"` if the result is empty.
fn sanitize_name(raw: &str) -> String {
    let sanitized: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "default".into()
    } else {
        sanitized
    }
}

/// Initialize tracing with a tee writer (stderr + rolling log file) plus an
/// optional Axiom layer.
///
/// Returns the [`tracing_appender::non_blocking::WorkerGuard`] that must be
/// held alive until the process exits so buffered logs are flushed.
fn init_tracing_with_file(
    config_path: &Path,
    axiom_layer: Option<axiom_layer::AxiomLayer>,
) -> Result<tracing_appender::non_blocking::WorkerGuard, Box<dyn std::error::Error>> {
    let home = paths::HomePaths::new()?;
    let log_dir = home.logs_dir();
    log_file::ensure_log_dir(&log_dir).map_err(|e| format!("create {}: {e}", log_dir.display()))?;

    let name = runner_name_from_config(config_path);
    let prefix = format!("runner-{name}");

    let file_appender = tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix(prefix)
        .filename_suffix("log")
        .max_log_files(7)
        .build(log_dir)?;

    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let writer = std::io::stderr.and(non_blocking);

    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_writer(writer)
        .with_ansi(false)
        .with_filter(RUNNER_FMT_MAX_LEVEL);
    let axiom_layer = axiom_layer.map(axiom_layer::with_ingest_filter);
    tracing_subscriber::registry()
        .with(fmt_layer)
        .with(axiom_layer)
        .init();

    Ok(guard)
}

/// Initialize tracing with stderr output only (no rolling log file on disk),
/// plus an optional Axiom layer.
///
/// Explicitly writes to stderr so commands like `runner exec` — which pipe the
/// guest program's stdout through verbatim — don't have tracing lines
/// interleaved into captured output. The `fmt::layer()` default writer is
/// stdout, which is the wrong sink for a CLI tool.
fn init_tracing_stderr(axiom_layer: Option<axiom_layer::AxiomLayer>) {
    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr)
        .with_filter(RUNNER_FMT_MAX_LEVEL);
    let axiom_layer = axiom_layer.map(axiom_layer::with_ingest_filter);
    tracing_subscriber::registry()
        .with(fmt_layer)
        .with(axiom_layer)
        .init();
}

#[tokio::main]
async fn main() -> ExitCode {
    // Initialize Sentry panic reporting before anything else.
    // Disabled (zero overhead) when SENTRY_DSN is not set.
    let _sentry_guard = sentry::init((
        std::env::var("SENTRY_DSN").unwrap_or_default(),
        sentry::ClientOptions::new()
            .release(env!("CARGO_PKG_VERSION"))
            .default_integrations(false)
            .add_integration(sentry::integrations::panic::PanicIntegration::default()),
    ));

    if !nix::unistd::getuid().is_root() {
        eprintln!("error: runner must be run as root");
        return ExitCode::FAILURE;
    }

    let cli = Cli::parse_with_environment_aliases();

    let runner_hostname = match &cli.command {
        Command::Start(args) => runner_hostname_from_config(&args.config),
        _ => None,
    };

    // Axiom layer (dual-write with fmt). Returns None — zero overhead — when
    // AXIOM_TOKEN_TELEMETRY / AXIOM_DATASET_SUFFIX are unset.
    let (axiom_layer, axiom_guard) = match axiom_layer::init(runner_hostname) {
        Some((layer, guard)) => (Some(layer), Some(guard)),
        None => (None, None),
    };

    let was_enabled = axiom_layer.is_some();
    let (_guard, axiom_installed) = match &cli.command {
        Command::Start(args) => match init_tracing_with_file(&args.config, axiom_layer) {
            Ok(guard) => (Some(guard), was_enabled),
            Err(e) => {
                // The failed `init_tracing_with_file` already consumed `axiom_layer`,
                // so the stderr fallback runs without Axiom — acceptable degraded
                // mode (home/log-dir setup is already broken at this point).
                init_tracing_stderr(None);
                tracing::warn!("file logging unavailable, using stderr only: {e}");
                (None, false)
            }
        },
        _ => {
            init_tracing_stderr(axiom_layer);
            (None, was_enabled)
        }
    };

    if axiom_installed {
        tracing::info!("axiom telemetry enabled");
    } else {
        tracing::info!("axiom telemetry disabled");
    }

    let result = match cli.command {
        Command::Setup => cmd::run_setup().await.map(|()| ExitCode::SUCCESS),
        Command::Build(args) => cmd::run_build(args, &sandbox_fc::FirecrackerSnapshotProvider)
            .await
            .map(|()| ExitCode::SUCCESS),
        Command::Config(args) => cmd::run_config(args).await.map(|()| ExitCode::SUCCESS),
        Command::Benchmark(args) => {
            cmd::run_benchmark(args, &sandbox_fc::FirecrackerRuntimeProvider).await
        }
        Command::Exec(args) => cmd::run_exec(args, &sandbox_fc::FirecrackerControl).await,
        Command::Kill(args) => cmd::run_kill(args, &sandbox_fc::FirecrackerControl).await,
        Command::Start(args) => cmd::run_start(*args, &sandbox_fc::FirecrackerRuntimeProvider)
            .await
            .map(|()| ExitCode::SUCCESS),
        Command::Service(args) => cmd::run_service(args).await.map(|()| ExitCode::SUCCESS),
        Command::Gc(args) => cmd::run_gc(args).await.map(|()| ExitCode::SUCCESS),
        Command::WorkspaceImageCache(args) => cmd::run_workspace_image_cache(args)
            .await
            .map(|()| ExitCode::SUCCESS),
        Command::Doctor(args) => cmd::run_doctor(args).await,
        Command::Local(args) => cmd::run_local(args).await,
    };

    let exit = match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    };

    if let Some(g) = axiom_guard {
        g.shutdown().await;
    }

    exit
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::test_fixtures::ignored_child::{
        ignored_child_test_env_guard_enabled, run_ignored_child_test,
    };
    use clap::CommandFactory;

    const HELP_TOKEN_CHILD_SCENARIO_ENV: &str = "RUNNER_HELP_TOKEN_CHILD_SCENARIO";
    const HELP_TOKEN_CHILD_TEST: &str = "tests::runner_help_hides_token_environment_values_child";
    const TOKEN_ALIAS_CHILD_SCENARIO_ENV: &str = "RUNNER_TOKEN_ALIAS_CHILD_SCENARIO";
    const TOKEN_ALIAS_CHILD_TEST: &str = "tests::runner_token_environment_aliases_child";
    const HELP_API_URL_CHILD_SCENARIO_ENV: &str = "RUNNER_HELP_API_URL_CHILD_SCENARIO";
    const HELP_API_URL_CHILD_TEST: &str =
        "tests::runner_help_hides_api_url_environment_values_child";
    const API_URL_ALIAS_CHILD_SCENARIO_ENV: &str = "RUNNER_API_URL_ALIAS_CHILD_SCENARIO";
    const API_URL_ALIAS_CHILD_TEST: &str = "tests::runner_api_url_environment_aliases_child";
    const API_URL_NORMALIZATION_CHILD_SCENARIO_ENV: &str =
        "RUNNER_API_URL_NORMALIZATION_CHILD_SCENARIO";
    const API_URL_NORMALIZATION_CHILD_TEST: &str =
        "tests::runner_api_url_environment_normalization_child";
    const CANONICAL_TOKEN_SENTINEL: &str = "canonical-sentinel-runner-token";
    const LEGACY_TOKEN_SENTINEL: &str = "legacy-sentinel-runner-token";
    const FLAG_TOKEN_SENTINEL: &str = "flag-sentinel-runner-token";
    const CANONICAL_API_URL_SENTINEL: &str =
        "https://canonical-api-url-sentinel.example.test/canonical/";
    const LEGACY_API_URL_SENTINEL: &str = "https://legacy-api-url-sentinel.example.test/legacy/";
    const EQUAL_API_URL_SENTINEL: &str = "https://equal-api-url-sentinel.example.test/equal/";
    const FLAG_API_URL_SENTINEL: &str = "https://flag-api-url-sentinel.example.test/flag/";

    fn token_alias_child_env(case: &str) -> Vec<(&'static str, Option<&'static str>)> {
        let mut env = match case.strip_prefix("flag-").unwrap_or(case) {
            "canonical" => vec![
                (runner_token::CANONICAL_ENV, Some(CANONICAL_TOKEN_SENTINEL)),
                (runner_token::LEGACY_ENV, None),
            ],
            "legacy" => vec![
                (runner_token::CANONICAL_ENV, None),
                (runner_token::LEGACY_ENV, Some(LEGACY_TOKEN_SENTINEL)),
            ],
            "conflict" => vec![
                (runner_token::CANONICAL_ENV, Some(CANONICAL_TOKEN_SENTINEL)),
                (runner_token::LEGACY_ENV, Some(LEGACY_TOKEN_SENTINEL)),
            ],
            "config-file" => vec![
                (runner_token::CANONICAL_ENV, None),
                (runner_token::LEGACY_ENV, None),
            ],
            unexpected => panic!("unexpected runner token alias case: {unexpected}"),
        };
        env.extend([
            (operator_api_url::CANONICAL_ENV, None),
            (operator_api_url::LEGACY_ENV, None),
        ]);
        env
    }

    fn api_url_alias_child_env(case: &str) -> Vec<(&'static str, Option<&'static str>)> {
        let mut env = match case.strip_prefix("flag-").unwrap_or(case) {
            "canonical" => vec![
                (
                    operator_api_url::CANONICAL_ENV,
                    Some(CANONICAL_API_URL_SENTINEL),
                ),
                (operator_api_url::LEGACY_ENV, None),
            ],
            "legacy" => vec![
                (operator_api_url::CANONICAL_ENV, None),
                (operator_api_url::LEGACY_ENV, Some(LEGACY_API_URL_SENTINEL)),
            ],
            "equal" => vec![
                (
                    operator_api_url::CANONICAL_ENV,
                    Some(EQUAL_API_URL_SENTINEL),
                ),
                (operator_api_url::LEGACY_ENV, Some(EQUAL_API_URL_SENTINEL)),
            ],
            "conflict" => vec![
                (
                    operator_api_url::CANONICAL_ENV,
                    Some(CANONICAL_API_URL_SENTINEL),
                ),
                (operator_api_url::LEGACY_ENV, Some(LEGACY_API_URL_SENTINEL)),
            ],
            "neither" => vec![
                (operator_api_url::CANONICAL_ENV, None),
                (operator_api_url::LEGACY_ENV, None),
            ],
            unexpected => panic!("unexpected Runner API URL alias case: {unexpected}"),
        };
        env.extend([
            (runner_token::CANONICAL_ENV, None),
            (runner_token::LEGACY_ENV, None),
        ]);
        env
    }

    fn api_url_source_child_env(
        source: &str,
        value: &'static str,
    ) -> Vec<(&'static str, Option<&'static str>)> {
        let mut env = match source {
            "canonical" => vec![
                (operator_api_url::CANONICAL_ENV, Some(value)),
                (operator_api_url::LEGACY_ENV, None),
            ],
            "legacy" => vec![
                (operator_api_url::CANONICAL_ENV, None),
                (operator_api_url::LEGACY_ENV, Some(value)),
            ],
            unexpected => panic!("unexpected Runner API URL source: {unexpected}"),
        };
        env.extend([
            (runner_token::CANONICAL_ENV, None),
            (runner_token::LEGACY_ENV, None),
        ]);
        env
    }

    fn api_url_normalization_input(case: &str) -> &'static str {
        match case {
            "invalid-scheme" => "ftp://scheme-api-url-sentinel.example.test",
            "missing-host" => "https://",
            "userinfo" => "https://api-user:api-password@userinfo-api-url-sentinel.example.test",
            "query" => "https://query-api-url-sentinel.example.test/path?token=query-secret",
            "fragment" => "https://fragment-api-url-sentinel.example.test/path#fragment-secret",
            "trailing-slash" => "https://Trailing-API-URL-Sentinel.Example.Test/base/",
            unexpected => panic!("unexpected Runner API URL normalization case: {unexpected}"),
        }
    }

    fn assert_api_url_alias_values_hidden(output: &str) {
        for sentinel in [
            CANONICAL_API_URL_SENTINEL,
            LEGACY_API_URL_SENTINEL,
            EQUAL_API_URL_SENTINEL,
            FLAG_API_URL_SENTINEL,
        ] {
            assert!(
                !output.contains(sentinel),
                "Runner API URL diagnostics must not expose {sentinel}: {output}"
            );
        }
    }

    fn runner_token_cli_args(subcommand: &str, case: &str) -> Vec<&'static str> {
        let mut args = match subcommand {
            "config" => vec![
                "runner",
                "config",
                "--profile",
                "vm0/default",
                "--rootfs-hash",
                "rootfs-hash",
                "--snapshot-hash",
                "snapshot-hash",
                "--name",
                "runner-test",
                "--group",
                "vm0/test",
                "--runner-dirname",
                "runner-test",
                "--api-url",
                "https://api.example.test",
            ],
            "start" => vec!["runner", "start", "--config", "/tmp/runner.yaml"],
            unexpected => panic!("unexpected runner token subcommand: {unexpected}"),
        };
        if case.starts_with("flag-") {
            args.extend(["--token", FLAG_TOKEN_SENTINEL]);
        }
        args
    }

    fn runner_api_url_cli_args(subcommand: &str, case: &str) -> Vec<&'static str> {
        let mut args = match subcommand {
            "config" => vec![
                "runner",
                "config",
                "--profile",
                "vm0/default",
                "--rootfs-hash",
                "rootfs-hash",
                "--snapshot-hash",
                "snapshot-hash",
                "--name",
                "runner-test",
                "--group",
                "vm0/test",
                "--runner-dirname",
                "runner-test",
                "--token",
                "runner-token",
            ],
            "start" => vec!["runner", "start", "--config", "/tmp/runner.yaml"],
            unexpected => panic!("unexpected Runner API URL subcommand: {unexpected}"),
        };
        if case.starts_with("flag-") {
            args.extend(["--api-url", FLAG_API_URL_SENTINEL]);
        }
        args
    }

    #[test]
    fn sanitize_name_passthrough() {
        assert_eq!(sanitize_name("my-runner_01"), "my-runner_01");
    }

    #[test]
    fn sanitize_name_replaces_slashes() {
        assert_eq!(sanitize_name("foo/bar"), "foo-bar");
    }

    #[test]
    fn sanitize_name_replaces_path_traversal() {
        assert_eq!(sanitize_name("../../etc/passwd"), "------etc-passwd");
    }

    #[test]
    fn sanitize_name_replaces_non_ascii() {
        assert_eq!(sanitize_name("runner-日本語"), "runner----");
    }

    #[test]
    fn sanitize_name_empty_returns_default() {
        assert_eq!(sanitize_name(""), "default");
    }

    #[test]
    fn runner_name_missing_file_returns_default() {
        assert_eq!(
            runner_name_from_config(Path::new("/nonexistent.yaml")),
            "default"
        );
    }

    #[test]
    fn runner_hostname_partial_read_preserves_valid_value() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("runner.yaml");
        std::fs::write(
            &config_path,
            "name: v0.174.0\nhostname: prod-1.aws.vm3.ai\n",
        )
        .unwrap();

        assert_eq!(
            runner_hostname_from_config(&config_path).as_deref(),
            Some("prod-1.aws.vm3.ai")
        );
    }

    #[test]
    fn runner_hostname_partial_read_omits_missing_or_invalid_value() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("runner.yaml");
        std::fs::write(&config_path, "name: v0.174.0\n").unwrap();
        assert_eq!(runner_hostname_from_config(&config_path), None);

        std::fs::write(&config_path, "name: v0.174.0\nhostname: ''\n").unwrap();
        assert_eq!(runner_hostname_from_config(&config_path), None);
    }

    #[test]
    fn runner_gc_help_describes_full_cleanup_scope() {
        let help = Cli::command().render_help().to_string();
        let normalized_help = help.split_whitespace().collect::<Vec<_>>().join(" ");

        assert!(
            normalized_help
                .contains("gc Clean up unused runner resources, artifacts, logs, and caches")
        );
    }

    #[test]
    fn service_drain_help_describes_bounded_coordination() {
        let error = Cli::try_parse_from(["runner", "service", "--help"])
            .err()
            .expect("service --help should exit through clap");
        assert_eq!(error.kind(), clap::error::ErrorKind::DisplayHelp);
        let normalized_help = error
            .to_string()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        assert!(normalized_help.contains(
            "drain Drain without waiting for active jobs (may wait for systemd operations and bounded signal convergence)"
        ));
    }

    #[test]
    fn service_wait_running_help_describes_stdout_contract() {
        let error = Cli::try_parse_from(["runner", "service", "wait-running", "--help"])
            .err()
            .expect("service wait-running --help should exit through clap");
        assert_eq!(error.kind(), clap::error::ErrorKind::DisplayHelp);
        let normalized_help = error
            .to_string()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        assert!(
            normalized_help.contains(
                "Wait until a runner service is active and job-admitting. On success, emit the resolved max_concurrent as one machine-readable integer line on stdout for scripts; diagnostics go to stderr"
            ),
            "unexpected help output: {normalized_help}"
        );
    }

    #[tokio::test]
    async fn runner_help_hides_token_environment_values() {
        for subcommand in ["config", "start"] {
            for case in ["canonical", "legacy", "conflict"] {
                let scenario = format!("{subcommand}:{case}");
                let child_env = token_alias_child_env(case);
                run_ignored_child_test(
                    HELP_TOKEN_CHILD_TEST,
                    (HELP_TOKEN_CHILD_SCENARIO_ENV, &scenario),
                    &child_env,
                    Duration::from_secs(5),
                )
                .await;
            }
        }
    }

    #[test]
    #[ignore = "spawned by runner_help_hides_token_environment_values"]
    fn runner_help_hides_token_environment_values_child() {
        let Ok(scenario) = std::env::var(HELP_TOKEN_CHILD_SCENARIO_ENV) else {
            return;
        };
        if !ignored_child_test_env_guard_enabled((HELP_TOKEN_CHILD_SCENARIO_ENV, &scenario)) {
            return;
        }
        let (subcommand, case) = scenario
            .split_once(':')
            .expect("runner help token scenario must contain subcommand and alias case");
        let subcommand = match subcommand {
            "config" => "config",
            "start" => "start",
            unexpected => panic!("unexpected runner help token scenario: {unexpected}"),
        };
        assert!(
            matches!(case, "canonical" | "legacy" | "conflict"),
            "unexpected runner help token alias case: {case}"
        );

        let error = Cli::try_parse_with_environment_aliases_from(["runner", subcommand, "--help"])
            .err()
            .expect("runner subcommand help should exit through clap");
        assert_eq!(
            error.kind(),
            clap::error::ErrorKind::DisplayHelp,
            "{subcommand} --help should produce clap help"
        );
        let help = error.to_string();
        assert!(
            help.contains(runner_token::CANONICAL_ENV),
            "{subcommand} help should identify the canonical token environment variable"
        );
        assert!(
            help.contains(runner_token::LEGACY_ENV),
            "{subcommand} help should identify the legacy token environment variable"
        );
        assert!(
            !help.contains(CANONICAL_TOKEN_SENTINEL) && !help.contains(LEGACY_TOKEN_SENTINEL),
            "{subcommand} help should hide both token environment values"
        );
    }

    #[tokio::test]
    async fn runner_config_and_start_resolve_token_environment_aliases() {
        for subcommand in ["config", "start"] {
            for case in [
                "canonical",
                "legacy",
                "flag-canonical",
                "flag-legacy",
                "conflict",
                "config-file",
            ] {
                if subcommand == "config" && case == "config-file" {
                    continue;
                }
                let scenario = format!("{subcommand}:{case}");
                let child_env = token_alias_child_env(case);
                run_ignored_child_test(
                    TOKEN_ALIAS_CHILD_TEST,
                    (TOKEN_ALIAS_CHILD_SCENARIO_ENV, &scenario),
                    &child_env,
                    Duration::from_secs(5),
                )
                .await;
            }
        }
    }

    #[test]
    #[ignore = "spawned by runner_config_and_start_resolve_token_environment_aliases"]
    fn runner_token_environment_aliases_child() {
        let Ok(scenario) = std::env::var(TOKEN_ALIAS_CHILD_SCENARIO_ENV) else {
            return;
        };
        if !ignored_child_test_env_guard_enabled((TOKEN_ALIAS_CHILD_SCENARIO_ENV, &scenario)) {
            return;
        }
        let (subcommand, case) = scenario
            .split_once(':')
            .expect("runner token scenario must contain subcommand and alias case");
        let parsed =
            Cli::try_parse_with_environment_aliases_from(runner_token_cli_args(subcommand, case));

        if case == "conflict" {
            let error = parsed
                .err()
                .expect("both runner token environment aliases must conflict");
            assert_eq!(error.kind(), clap::error::ErrorKind::ArgumentConflict);
            let output = error.to_string();
            assert!(output.contains(runner_token::CANONICAL_ENV));
            assert!(output.contains(runner_token::LEGACY_ENV));
            assert!(
                !output.contains(CANONICAL_TOKEN_SENTINEL)
                    && !output.contains(LEGACY_TOKEN_SENTINEL)
                    && !output.contains(FLAG_TOKEN_SENTINEL),
                "runner token alias conflict must not expose token values: {output}"
            );
            return;
        }

        let cli = parsed.unwrap_or_else(|error| panic!("parse runner {scenario}: {error}"));
        let token = match &cli.command {
            Command::Config(args) => Some(args.token_for_test()),
            Command::Start(args) => args.token_for_test(),
            _ => panic!("runner token scenario parsed an unexpected subcommand: {scenario}"),
        };
        let expected = match case {
            "canonical" => Some(CANONICAL_TOKEN_SENTINEL),
            "legacy" => Some(LEGACY_TOKEN_SENTINEL),
            "flag-canonical" | "flag-legacy" => Some(FLAG_TOKEN_SENTINEL),
            "config-file" => None,
            unexpected => panic!("unexpected runner token scenario case: {unexpected}"),
        };
        assert_eq!(token, expected, "unexpected token source for {scenario}");
    }

    #[tokio::test]
    async fn runner_help_hides_api_url_environment_values() {
        for subcommand in ["config", "start"] {
            for case in ["canonical", "legacy", "equal", "conflict"] {
                let scenario = format!("{subcommand}:{case}");
                let child_env = api_url_alias_child_env(case);
                run_ignored_child_test(
                    HELP_API_URL_CHILD_TEST,
                    (HELP_API_URL_CHILD_SCENARIO_ENV, &scenario),
                    &child_env,
                    Duration::from_secs(5),
                )
                .await;
            }
        }
    }

    #[test]
    #[ignore = "spawned by runner_help_hides_api_url_environment_values"]
    fn runner_help_hides_api_url_environment_values_child() {
        let Ok(scenario) = std::env::var(HELP_API_URL_CHILD_SCENARIO_ENV) else {
            return;
        };
        if !ignored_child_test_env_guard_enabled((HELP_API_URL_CHILD_SCENARIO_ENV, &scenario)) {
            return;
        }
        let (subcommand, case) = scenario
            .split_once(':')
            .expect("Runner API URL help scenario must contain subcommand and alias case");
        assert!(matches!(subcommand, "config" | "start"));
        assert!(matches!(
            case,
            "canonical" | "legacy" | "equal" | "conflict"
        ));

        let error = Cli::try_parse_with_environment_aliases_from(["runner", subcommand, "--help"])
            .err()
            .expect("runner subcommand help should exit through Clap");
        assert_eq!(error.kind(), clap::error::ErrorKind::DisplayHelp);
        let help = error.to_string();
        assert!(
            help.contains(operator_api_url::CANONICAL_ENV),
            "{subcommand} help should identify the canonical API URL environment variable"
        );
        assert!(
            help.contains(operator_api_url::LEGACY_ENV),
            "{subcommand} help should identify the legacy API URL environment variable"
        );
        assert_api_url_alias_values_hidden(&help);
    }

    #[tokio::test]
    async fn runner_config_and_start_resolve_api_url_environment_aliases() {
        for subcommand in ["config", "start"] {
            for case in [
                "canonical",
                "legacy",
                "equal",
                "conflict",
                "flag-canonical",
                "flag-legacy",
                "flag-conflict",
                "neither",
            ] {
                let scenario = format!("{subcommand}:{case}");
                let child_env = api_url_alias_child_env(case);
                run_ignored_child_test(
                    API_URL_ALIAS_CHILD_TEST,
                    (API_URL_ALIAS_CHILD_SCENARIO_ENV, &scenario),
                    &child_env,
                    Duration::from_secs(5),
                )
                .await;
            }
        }
    }

    #[test]
    #[ignore = "spawned by runner_config_and_start_resolve_api_url_environment_aliases"]
    fn runner_api_url_environment_aliases_child() {
        let Ok(scenario) = std::env::var(API_URL_ALIAS_CHILD_SCENARIO_ENV) else {
            return;
        };
        if !ignored_child_test_env_guard_enabled((API_URL_ALIAS_CHILD_SCENARIO_ENV, &scenario)) {
            return;
        }
        let (subcommand, case) = scenario
            .split_once(':')
            .expect("Runner API URL scenario must contain subcommand and alias case");
        let parsed =
            Cli::try_parse_with_environment_aliases_from(runner_api_url_cli_args(subcommand, case));

        if case == "conflict" {
            let error = parsed
                .err()
                .expect("unequal Runner API URL environment aliases must conflict");
            assert_eq!(error.kind(), clap::error::ErrorKind::ArgumentConflict);
            let output = error.to_string();
            assert!(output.contains(operator_api_url::CANONICAL_ENV));
            assert!(output.contains(operator_api_url::LEGACY_ENV));
            assert_api_url_alias_values_hidden(&output);
            return;
        }
        if subcommand == "config" && case == "neither" {
            let error = parsed
                .err()
                .expect("runner config should still require an API URL source");
            assert_eq!(
                error.kind(),
                clap::error::ErrorKind::MissingRequiredArgument
            );
            assert_api_url_alias_values_hidden(&error.to_string());
            return;
        }

        let cli = parsed.unwrap_or_else(|error| panic!("parse runner {scenario}: {error}"));
        let api_url = match &cli.command {
            Command::Config(args) => Some(args.api_url_for_test()),
            Command::Start(args) => args.api_url_for_test(),
            _ => panic!("Runner API URL scenario parsed an unexpected subcommand: {scenario}"),
        };
        let expected = match case {
            "canonical" => Some(CANONICAL_API_URL_SENTINEL),
            "legacy" => Some(LEGACY_API_URL_SENTINEL),
            "equal" => Some(EQUAL_API_URL_SENTINEL),
            "flag-canonical" | "flag-legacy" | "flag-conflict" => Some(FLAG_API_URL_SENTINEL),
            "neither" => None,
            unexpected => panic!("unexpected Runner API URL scenario case: {unexpected}"),
        };
        assert_eq!(
            api_url, expected,
            "unexpected API URL source for {scenario}"
        );
    }

    #[tokio::test]
    async fn runner_api_url_environment_aliases_use_existing_normalization() {
        for source in ["canonical", "legacy"] {
            for case in [
                "invalid-scheme",
                "missing-host",
                "userinfo",
                "query",
                "fragment",
                "trailing-slash",
            ] {
                let scenario = format!("{source}:{case}");
                let child_env = api_url_source_child_env(source, api_url_normalization_input(case));
                run_ignored_child_test(
                    API_URL_NORMALIZATION_CHILD_TEST,
                    (API_URL_NORMALIZATION_CHILD_SCENARIO_ENV, &scenario),
                    &child_env,
                    Duration::from_secs(5),
                )
                .await;
            }
        }
    }

    #[test]
    #[ignore = "spawned by runner_api_url_environment_aliases_use_existing_normalization"]
    fn runner_api_url_environment_normalization_child() {
        let Ok(scenario) = std::env::var(API_URL_NORMALIZATION_CHILD_SCENARIO_ENV) else {
            return;
        };
        if !ignored_child_test_env_guard_enabled((
            API_URL_NORMALIZATION_CHILD_SCENARIO_ENV,
            &scenario,
        )) {
            return;
        }
        let (source, case) = scenario
            .split_once(':')
            .expect("Runner API URL normalization scenario must contain source and case");
        assert!(matches!(source, "canonical" | "legacy"));
        let input = api_url_normalization_input(case);
        let cli = Cli::try_parse_with_environment_aliases_from(runner_api_url_cli_args(
            "config",
            "canonical",
        ))
        .unwrap_or_else(|error| panic!("parse Runner API URL normalization scenario: {error}"));
        let Command::Config(args) = cli.command else {
            panic!("Runner API URL normalization scenario parsed an unexpected subcommand");
        };
        assert_eq!(args.api_url_for_test(), input);

        let normalized = config::normalize_api_base_url(args.api_url_for_test());
        if case == "trailing-slash" {
            assert_eq!(
                normalized.unwrap(),
                "https://trailing-api-url-sentinel.example.test/base"
            );
            return;
        }

        let expected = match case {
            "invalid-scheme" => "http or https",
            "missing-host" => "absolute http(s) URL",
            "userinfo" => "credentials",
            "query" => "query string",
            "fragment" => "fragment",
            unexpected => panic!("unexpected invalid Runner API URL case: {unexpected}"),
        };
        let error = normalized.expect_err("invalid Runner API URL should fail normalization");
        let message = error.to_string();
        assert!(message.contains(expected), "unexpected error: {message}");
        assert!(
            !message.contains(input),
            "normalization error must not expose the raw API URL: {message}"
        );
    }

    #[test]
    fn workspace_image_cache_command_is_registered() {
        assert!(
            Cli::try_parse_from(["runner", "workspace-image-cache", "info"]).is_ok(),
            "workspace-image-cache info should be registered"
        );
        assert!(
            Cli::try_parse_from(["runner", "workspace-image-cache", "list", "--limit", "1"])
                .is_ok(),
            "workspace-image-cache list should be registered"
        );
        assert!(
            Cli::try_parse_from(["runner", "workspace-image-cache", "gc", "--dry-run"]).is_ok(),
            "workspace-image-cache gc should be registered"
        );
    }

    #[test]
    fn workspace_image_cache_help_documents_locked_entry_semantics() {
        let info_error = Cli::try_parse_from(["runner", "workspace-image-cache", "info", "--help"])
            .err()
            .expect("workspace-image-cache info --help should exit through clap");
        assert_eq!(info_error.kind(), clap::error::ErrorKind::DisplayHelp);
        let info_help = info_error
            .to_string()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(info_help.contains("non-blocking, best-effort"));
        assert!(info_help.contains(
            "Locked entries skip metadata, image-size, temporary-path, storage, and artifact inspection."
        ));
        assert!(
            info_help.contains("status-category, temporary-path, and size values are lower bounds")
        );

        let list_error = Cli::try_parse_from(["runner", "workspace-image-cache", "list", "--help"])
            .err()
            .expect("workspace-image-cache list --help should exit through clap");
        assert_eq!(list_error.kind(), clap::error::ErrorKind::DisplayHelp);
        let list_help = list_error
            .to_string()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(list_help.contains("non-blocking, best-effort"));
        assert!(list_help.contains(
            "zero measurements and null metadata fields on locked entries mean unavailable rather than measured zero"
        ));
        assert!(list_help.contains(
            "Status-category, temporary-path, and size summary values are lower bounds when `lockedEntries` is greater than zero."
        ));
    }

    #[test]
    fn workspace_image_cache_help_documents_gc_eviction_policy() {
        let error = Cli::try_parse_from(["runner", "workspace-image-cache", "gc", "--help"])
            .err()
            .expect("workspace-image-cache gc --help should exit through clap");
        assert_eq!(error.kind(), clap::error::ErrorKind::DisplayHelp);
        let help = error
            .to_string()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        assert!(help.contains(
            "first phase removes stale, unusable, and temporary cache contents before evaluating capacity"
        ));
        assert!(help.contains("valid reusable entries, oldest-first"));
        assert!(help.contains("maximum byte budget"));
        assert!(help.contains("minimum-free-space thresholds"));
        assert!(help.contains("post-GC target"));
        assert!(help.contains("1,024-entry cap"));
        assert!(help.contains("Locked entries are skipped during reusable-entry eviction"));
        assert!(help.contains("`--dry-run` to evaluate this same policy"));
        assert!(help.contains("without deleting data"));
    }

    #[test]
    fn service_unit_state_command_is_registered() {
        assert!(
            Cli::try_parse_from([
                "runner",
                "service",
                "unit-state",
                "--name",
                "v1.2.3",
                "--name",
                "v1.2.2",
            ])
            .is_ok(),
            "service unit-state should accept one or more --name values"
        );
        assert!(
            Cli::try_parse_from(["runner", "service", "unit-state"]).is_err(),
            "service unit-state should require at least one --name"
        );
    }

    #[test]
    fn old_gc_workspace_image_cache_command_is_removed() {
        assert!(
            Cli::try_parse_from(["runner", "gc-workspace-image-cache", "--dry-run"]).is_err(),
            "old top-level gc-workspace-image-cache command should not be accepted"
        );
    }
}
