use clap::{Args, Subcommand};
use tracing::info;

use crate::error::{RunnerError, RunnerResult};
use crate::r2_cache::{R2Error, R2ImageCache};

/// Default TTL for completed R2 runner cache objects. 7 days matches the
/// previous deploy-time `runner gc` behavior while lifecycle rollout is
/// observed.
const R2_DEFAULT_KEEP_DAYS: u64 = 7;

#[derive(Args)]
pub struct R2CacheArgs {
    #[command(subcommand)]
    command: R2CacheCommand,
}

#[derive(Subcommand)]
enum R2CacheCommand {
    /// Manually delete completed R2 runner cache objects older than the TTL
    Gc(R2CacheGcArgs),
}

#[derive(Args)]
struct R2CacheGcArgs {
    /// Show intent without listing or deleting R2 objects.
    #[arg(long)]
    dry_run: bool,
    /// TTL for R2 runner cache objects in days. Objects older than this
    /// are deleted from `runner-images/` and `runner-templates/`.
    /// Minimum: 1.
    #[arg(
        long,
        default_value_t = R2_DEFAULT_KEEP_DAYS,
        value_parser = clap::value_parser!(u64).range(1..)
    )]
    keep_days: u64,
}

pub async fn run_r2_cache(args: R2CacheArgs) -> RunnerResult<()> {
    match args.command {
        R2CacheCommand::Gc(gc) => run_r2_cache_gc(gc).await,
    }
}

async fn run_r2_cache_gc(args: R2CacheGcArgs) -> RunnerResult<()> {
    let cache = R2ImageCache::from_env()
        .await
        .map_err(r2_runner_error)?
        .ok_or_else(|| {
            RunnerError::Config(
                "R2 runner cache is not configured; set R2_ACCOUNT_ID, \
                 R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and \
                 R2_RUNNER_CACHE_BUCKET_NAME"
                    .into(),
            )
        })?;

    if args.dry_run {
        info!(
            "[dry-run] would delete R2 runner cache objects older than {} days",
            args.keep_days
        );
        return Ok(());
    }

    let max_age = std::time::Duration::from_secs(args.keep_days.saturating_mul(86_400));
    match cache
        .gc_older_than(max_age)
        .await
        .map_err(r2_runner_error)?
    {
        (0, _) => info!(
            "r2: no runner cache objects older than {} days",
            args.keep_days
        ),
        (count, bytes) => {
            info!(
                "r2: deleted {count} runner cache object(s) older than {} days ({})",
                args.keep_days,
                human_bytes(bytes)
            );
        }
    }
    Ok(())
}

fn r2_runner_error(error: R2Error) -> RunnerError {
    if matches!(&error, R2Error::PartialConfig { .. }) {
        return RunnerError::Config(format!("R2 runner cache error: {error}"));
    }
    RunnerError::Internal(format!("R2 runner cache error: {error}"))
}

fn human_bytes(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let b = bytes as f64;
    if b >= GIB {
        format!("{:.1} GiB", b / GIB)
    } else if b >= MIB {
        format!("{:.1} MiB", b / MIB)
    } else if b >= KIB {
        format!("{:.1} KiB", b / KIB)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct R2CacheCli {
        #[command(flatten)]
        args: R2CacheArgs,
    }

    #[test]
    fn keep_days_zero_is_rejected() {
        let result = R2CacheCli::try_parse_from(["r2-cache", "gc", "--keep-days", "0"]);
        assert!(result.is_err(), "--keep-days 0 must be rejected");
    }

    #[test]
    fn keep_days_one_is_accepted() {
        let result = R2CacheCli::try_parse_from(["r2-cache", "gc", "--keep-days", "1"]);
        assert!(result.is_ok(), "--keep-days 1 must be accepted");
    }

    #[test]
    fn keep_days_default_when_omitted() {
        let parsed = R2CacheCli::try_parse_from(["r2-cache", "gc"]).unwrap();
        match parsed.args.command {
            R2CacheCommand::Gc(gc) => assert_eq!(gc.keep_days, R2_DEFAULT_KEEP_DAYS),
        }
    }
}
