#[path = "parity/compare.rs"]
mod compare;
#[path = "parity/execution.rs"]
mod execution;
#[path = "parity/http.rs"]
mod http;
#[path = "parity/model.rs"]
mod model;

use std::env;
use std::ffi::OsStr;
use std::fmt::{self, Display};
use std::fs;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use clap::Parser;

use compare::compare_observations;
use execution::{Implementation, observe};
use model::load_cases;

const NPX_TARGET_ENV: &str = "ZERO_CLI_PARITY_NPX_TARGET";
const NPX_MARKER_ENV: &str = "ZERO_CLI_PARITY_NPX_MARKER";
const RUST_EXECUTION_ENV: &str = "ZERO_CLI_PARITY_RUST_EXECUTION";

type Result<T> = std::result::Result<T, HarnessError>;

#[derive(Debug)]
struct HarnessError(String);

impl HarnessError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for HarnessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for HarnessError {}

#[derive(Debug, Parser)]
#[command(about = "Compare the TypeScript and Rust Zero CLI executables")]
struct Arguments {
    /// Public TypeScript Zero CLI executable (the built dist/zero.js artifact).
    #[arg(long)]
    typescript: PathBuf,

    /// Runner-bundled Rust zero-cli executable.
    #[arg(long)]
    rust: PathBuf,

    /// Directory containing version 1 JSON parity cases.
    #[arg(
        long,
        default_value = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/parity/v1/cases"
        )
    )]
    cases: PathBuf,
}

fn main() -> ExitCode {
    if executable_name().is_some_and(|name| name == OsStr::new("npx")) {
        return run_npx_shim();
    }

    match run(Arguments::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn executable_name() -> Option<std::ffi::OsString> {
    env::args_os()
        .next()
        .and_then(|path| Path::new(&path).file_name().map(OsStr::to_os_string))
}

fn run_npx_shim() -> ExitCode {
    match exec_typescript_from_npx() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("zero-cli parity npx shim: {error}");
            ExitCode::FAILURE
        }
    }
}

fn exec_typescript_from_npx() -> Result<()> {
    let marker = env::var_os(NPX_MARKER_ENV)
        .ok_or_else(|| HarnessError::new(format!("{NPX_MARKER_ENV} is not set")))?;
    fs::write(&marker, b"npm fallback invoked\n").map_err(|error| {
        HarnessError::new(format!("write npm fallback marker {marker:?}: {error}"))
    })?;
    let expected_execution = env::var(RUST_EXECUTION_ENV)
        .map_err(|error| HarnessError::new(format!("read {RUST_EXECUTION_ENV}: {error}")))?;
    if expected_execution == "native" {
        return Err(HarnessError::new(
            "fixture requires native Rust execution, but zero-cli invoked npm fallback",
        ));
    }
    if expected_execution != "fallback" {
        return Err(HarnessError::new(format!(
            "{RUST_EXECUTION_ENV} must be \"native\" or \"fallback\", received {expected_execution:?}"
        )));
    }
    let target = env::var_os(NPX_TARGET_ENV)
        .ok_or_else(|| HarnessError::new(format!("{NPX_TARGET_ENV} is not set")))?;
    let mut arguments = env::args_os().skip(1);

    for expected in ["-p", "@vm0/cli", "zero"] {
        let actual = arguments
            .next()
            .ok_or_else(|| HarnessError::new(format!("missing expected argument {expected:?}")))?;
        if actual != OsStr::new(expected) {
            return Err(HarnessError::new(format!(
                "expected argument {expected:?}, received {actual:?}"
            )));
        }
    }

    let error = Command::new(target).args(arguments).exec();
    Err(HarnessError::new(format!(
        "failed to execute TypeScript Zero CLI: {error}"
    )))
}

fn run(arguments: Arguments) -> Result<()> {
    let typescript = canonical_executable(&arguments.typescript, "TypeScript")?;
    let rust = canonical_executable(&arguments.rust, "Rust")?;
    let harness_executable = env::current_exe().map_err(|error| {
        HarnessError::new(format!("resolve parity harness executable: {error}"))
    })?;
    let cases = load_cases(&arguments.cases)?;
    let mut failures = Vec::new();

    for loaded in cases {
        let typescript_observation = observe(
            Implementation::Typescript,
            &typescript,
            &typescript,
            &harness_executable,
            &loaded.case,
        );
        let rust_observation = observe(
            Implementation::Rust,
            &rust,
            &typescript,
            &harness_executable,
            &loaded.case,
        );

        match (typescript_observation, rust_observation) {
            (Ok(typescript_observation), Ok(rust_observation)) => {
                if let Some(report) =
                    compare_observations(&loaded.case, &typescript_observation, &rust_observation)
                {
                    failures.push(report);
                } else {
                    println!("PASS {} ({})", loaded.case.name, loaded.path.display());
                }
            }
            (typescript_result, rust_result) => {
                let mut report = format!(
                    "case {:?} failed before comparison ({})",
                    loaded.case.name,
                    loaded.path.display()
                );
                if let Err(error) = typescript_result {
                    report.push_str(&format!("\n  TypeScript: {error}"));
                }
                if let Err(error) = rust_result {
                    report.push_str(&format!("\n  Rust: {error}"));
                }
                failures.push(report);
            }
        }
    }

    if failures.is_empty() {
        println!("All Zero CLI parity cases passed");
        return Ok(());
    }

    Err(HarnessError::new(format!(
        "{} Zero CLI parity case(s) failed\n\n{}",
        failures.len(),
        failures.join("\n\n")
    )))
}

fn canonical_executable(path: &Path, implementation: &str) -> Result<PathBuf> {
    let canonical = path.canonicalize().map_err(|error| {
        HarnessError::new(format!(
            "resolve {implementation} executable {}: {error}",
            path.display()
        ))
    })?;
    let metadata = canonical.metadata().map_err(|error| {
        HarnessError::new(format!(
            "inspect {implementation} executable {}: {error}",
            canonical.display()
        ))
    })?;
    if !metadata.is_file() {
        return Err(HarnessError::new(format!(
            "{implementation} executable is not a file: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}
