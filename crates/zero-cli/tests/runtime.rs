use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::os::unix::ffi::OsStringExt as _;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use clap::{Arg, ArgMatches, Command};
use serde_json::{Value, json};
use zero_cli::build::BuildInfo;
use zero_cli::config::{ConfigError, DEFAULT_API_URL, RuntimeConfig, RuntimeEnvironment};
use zero_cli::dispatch::{HandlerRegistry, Invocation, NativeHandler, RegistryError};
use zero_cli::error::CliError;
use zero_cli::output::{ColorChoice, Output, OutputCapabilities};
use zero_cli::runtime::CommandContext;
use zero_cli::secret::SecretString;
use zero_cli::token::ZeroTokenPayload;

struct ExampleHandler;

#[async_trait]
impl NativeHandler for ExampleHandler {
    fn command(&self) -> Command {
        Command::new("native-example").arg(Arg::new("value").long("value").required(true))
    }

    async fn run(
        &self,
        _context: &mut CommandContext,
        _matches: ArgMatches,
    ) -> Result<(), CliError> {
        Ok(())
    }
}

fn example_registry() -> HandlerRegistry {
    HandlerRegistry::try_new(vec![Box::new(ExampleHandler) as Box<dyn NativeHandler>]).unwrap()
}

fn build_zero_token(payload: Value) -> String {
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
    format!("vm0_sandbox_e30.{payload}.test-signature")
}

#[test]
fn dispatcher_selects_only_an_exact_registered_first_argument() {
    let registry = example_registry();
    let selected = Invocation::from_args([OsString::from("native-example")]);
    let prefixed_option =
        Invocation::from_args([OsString::from("--json"), OsString::from("native-example")]);
    let help = Invocation::from_args([OsString::from("help"), OsString::from("native-example")]);
    let unknown = Invocation::from_args([OsString::from("unknown")]);
    let non_unicode = Invocation::from_args([OsString::from_vec(vec![0xff, 0xfe])]);

    assert!(registry.handler_for(&selected).is_some());
    assert!(registry.handler_for(&prefixed_option).is_none());
    assert!(registry.handler_for(&help).is_none());
    assert!(registry.handler_for(&unknown).is_none());
    assert!(registry.handler_for(&non_unicode).is_none());
}

#[test]
fn registry_builds_a_versioned_structured_command_root() {
    let registry = example_registry();
    let root = registry.command_root();
    let matches = root
        .try_get_matches_from(["zero", "native-example", "--value", "kept"])
        .unwrap();
    let (_, native_matches) = matches.subcommand().unwrap();

    assert_eq!(
        native_matches
            .get_one::<String>("value")
            .map(String::as_str),
        Some("kept")
    );
    assert_eq!(
        registry.command_root().get_version(),
        Some(BuildInfo::current().version)
    );
    assert_eq!(
        registry.command_root().get_long_version(),
        Some(BuildInfo::current().build_id)
    );
}

#[test]
fn registry_rejects_duplicate_native_command_names() {
    let result = HandlerRegistry::try_new(vec![
        Box::new(ExampleHandler) as Box<dyn NativeHandler>,
        Box::new(ExampleHandler) as Box<dyn NativeHandler>,
    ]);

    assert!(matches!(
        result,
        Err(RegistryError::DuplicateCommand { name }) if name == "native-example"
    ));
}

#[test]
fn invocation_debug_never_contains_argument_values() {
    let sensitive = "do-not-log-this-argument";
    let invocation = Invocation::from_args([OsString::from("unknown"), OsString::from(sensitive)]);
    let debug = format!("{invocation:?}");

    assert!(debug.contains("argument_count: 2"));
    assert!(!debug.contains(sensitive));
}

#[test]
fn runtime_config_resolves_defaults_protocol_and_sandbox_context() {
    let token = build_zero_token(json!({
        "userId": "user-secret-id",
        "runId": "run-secret-id",
        "orgId": "org-secret-id",
        "scope": "zero",
        "capabilities": ["agent:read", "host:write"],
        "featureSwitchOverrides": { "zeroBrowser": true },
        "iat": 100,
        "exp": 200
    }));
    let config = RuntimeConfig::from_environment(RuntimeEnvironment {
        zero_token: Some(token.clone().into()),
        api_backend_url: Some("preview.vm0.ai/".into()),
        vercel_automation_bypass_secret: Some("bypass-secret-value".into()),
        http_proxy: Some(" http://proxy-user:proxy-password@proxy.example:8080 ".into()),
        https_proxy: Some("https://secure-proxy.example:8443".into()),
        no_proxy: Some(" localhost,.vm0.ai ".into()),
        ..RuntimeEnvironment::default()
    })
    .unwrap();
    let context = config.sandbox_context().unwrap();

    assert_eq!(config.api_url(), "https://preview.vm0.ai");
    assert!(config.has_token());
    assert!(config.proxy().has_http_proxy());
    assert!(config.proxy().has_https_proxy());
    assert_eq!(context.user_id(), Some("user-secret-id"));
    assert_eq!(context.run_id(), Some("run-secret-id"));
    assert_eq!(context.org_id(), Some("org-secret-id"));
    assert!(context.has_capability("agent:read"));
    assert!(!context.has_capability("agent:write"));
    assert_eq!(context.feature_switch_override("zeroBrowser"), Some(true));
    assert_eq!(context.issued_at(), Some(100));
    assert_eq!(context.expires_at(), Some(200));

    let debug = format!("{config:?}");
    assert!(!debug.contains(&token));
    assert!(!debug.contains("bypass-secret-value"));
    assert!(!debug.contains("user-secret-id"));
    assert!(!debug.contains("run-secret-id"));
    assert!(!debug.contains("org-secret-id"));
    assert!(!debug.contains("proxy-user"));
    assert!(!debug.contains("proxy-password"));
    assert!(!debug.contains("secure-proxy.example"));
}

#[test]
fn runtime_config_defaults_to_the_production_api() {
    let config = RuntimeConfig::from_environment(RuntimeEnvironment::default()).unwrap();

    assert_eq!(config.api_url(), DEFAULT_API_URL);
    assert!(!config.has_token());
    assert!(config.sandbox_context().is_none());
}

#[test]
fn runtime_config_rejects_sensitive_or_malformed_api_urls_without_echoing_them() {
    for value in [
        "https://user:password@example.com",
        "https://example.com?token=secret-query",
        "file:///tmp/private",
        "http-not-a-url",
    ] {
        let error = RuntimeConfig::from_environment(RuntimeEnvironment {
            api_backend_url: Some(value.into()),
            ..RuntimeEnvironment::default()
        })
        .unwrap_err();
        let rendered = format!("{error:?} {error}");

        assert_eq!(error, ConfigError::InvalidApiUrl);
        assert!(!rendered.contains(value));
        assert!(!rendered.contains("password"));
        assert!(!rendered.contains("secret-query"));
    }
}

#[test]
fn runtime_config_rejects_non_unicode_secrets_without_exposing_bytes() {
    let error = RuntimeConfig::from_environment(RuntimeEnvironment {
        zero_token: Some(OsString::from_vec(vec![0xff, 0xfe])),
        ..RuntimeEnvironment::default()
    })
    .unwrap_err();

    assert_eq!(error, ConfigError::NonUnicode { name: "ZERO_TOKEN" });
    assert_eq!(error.to_string(), "ZERO_TOKEN must contain valid Unicode");
}

#[test]
fn runtime_config_rejects_non_unicode_proxy_values_without_exposing_bytes() {
    let error = RuntimeConfig::from_environment(RuntimeEnvironment {
        http_proxy: Some(OsString::from_vec(vec![0xff, 0xfe])),
        ..RuntimeEnvironment::default()
    })
    .unwrap_err();

    assert_eq!(
        error,
        ConfigError::NonUnicode {
            name: "http_proxy/HTTP_PROXY"
        }
    );
    assert_eq!(
        error.to_string(),
        "http_proxy/HTTP_PROXY must contain valid Unicode"
    );
}

#[test]
fn token_decoder_matches_zero_scope_and_rejects_malformed_inputs() {
    let valid = SecretString::new(build_zero_token(json!({
        "scope": "zero",
        "capabilities": []
    })));
    assert!(ZeroTokenPayload::decode(&valid).is_some());

    let malformed = [
        SecretString::new("not-a-zero-token"),
        SecretString::new("vm0_sandbox_only-one-part"),
        SecretString::new("vm0_sandbox_a.!!!invalid.c"),
        SecretString::new(build_zero_token(json!({
            "scope": "sandbox",
            "capabilities": []
        }))),
        SecretString::new(build_zero_token(json!({
            "scope": "zero",
            "capabilities": "not-an-array"
        }))),
    ];

    for token in malformed {
        assert!(ZeroTokenPayload::decode(&token).is_none());
    }
}

#[test]
fn secret_debug_is_always_redacted() {
    let secret = SecretString::new("top-secret-token");
    let debug = format!("{secret:?}");

    assert_eq!(debug, "SecretString([REDACTED])");
    assert!(!debug.contains("top-secret-token"));
}

#[test]
fn output_honors_non_interactive_json_and_color_boundaries() {
    let tty_output = Output::new(
        io::sink(),
        io::sink(),
        OutputCapabilities {
            stdin_terminal: false,
            stdout_terminal: true,
            stderr_terminal: true,
            color: ColorChoice::Auto,
        },
    );
    assert!(tty_output.is_interactive());
    assert!(!tty_output.stdin_is_terminal());

    let temp_dir = tempfile::tempdir().unwrap();
    let stdout_path = temp_dir.path().join("stdout");
    let stderr_path = temp_dir.path().join("stderr");
    let stdout = fs::File::create(&stdout_path).unwrap();
    let stderr = fs::File::create(&stderr_path).unwrap();
    let mut output = Output::new(
        stdout,
        stderr,
        OutputCapabilities {
            stdin_terminal: false,
            stdout_terminal: false,
            stderr_terminal: false,
            color: ColorChoice::Always,
        },
    );

    assert!(!output.is_interactive());
    assert!(!output.stdin_is_terminal());
    assert!(!output.stdout_is_terminal());
    assert!(!output.stderr_is_terminal());
    output.success("native success").unwrap();
    output.set_json(true);
    output.json(&json!({ "ok": true })).unwrap();
    output.error("FORBIDDEN", "request denied").unwrap();
    drop(output);

    let stdout = fs::read_to_string(stdout_path).unwrap();
    let stderr = fs::read_to_string(stderr_path).unwrap();
    assert!(stdout.starts_with("\u{1b}[32mnative success\u{1b}[0m\n"));
    assert!(stdout.ends_with("{\"ok\":true}\n"));
    assert_eq!(
        serde_json::from_str::<Value>(stderr.trim()).unwrap(),
        json!({ "error": { "code": "FORBIDDEN", "message": "request denied" } })
    );
    assert!(!stderr.contains('\u{1b}'));
}

struct BrokenPipeWriter;

impl Write for BrokenPipeWriter {
    fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
        Err(io::Error::from(io::ErrorKind::BrokenPipe))
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn output_classifies_epipe_for_a_clean_process_exit() {
    let mut output = Output::new(
        BrokenPipeWriter,
        io::sink(),
        OutputCapabilities {
            stdin_terminal: false,
            stdout_terminal: false,
            stderr_terminal: false,
            color: ColorChoice::Never,
        },
    );

    let error = output.line("closed downstream").unwrap_err();
    assert!(error.is_broken_pipe());
}
