//! Generated Rust constants for `@vm0/api-contracts`.
//! Do not edit by hand; regenerate with `cd turbo && pnpm -F @vm0/api-contracts generate:rust`.
//! These constants are shared TypeScript/Rust contract values.
//! Token-shaped placeholder values in this module are fake marker bytes, not secrets.

/// Client request contract constants shared by TypeScript and Rust.
pub mod client {
    /// HTTP header names used to identify vm0 clients in API request logs.
    pub mod headers {
        /// HTTP header carrying the per-request vm0 client request identifier.
        pub const CLIENT_REQUEST_ID_HEADER: &str = "X-Client-Request-Id";

        /// HTTP header carrying the sending vm0 client session identifier.
        pub const CLIENT_SESSION_ID_HEADER: &str = "X-Client-Session-Id";

        /// HTTP header carrying the sending vm0 client component type.
        pub const CLIENT_TYPE_HEADER: &str = "X-Client-Type";

        /// HTTP header carrying the sending vm0 client component version.
        pub const CLIENT_VERSION_HEADER: &str = "X-Client-Version";
    }

    /// Client type values used to identify vm0 API request originators.
    pub mod types {
        /// Client type value for the platform web app.
        pub const CLIENT_TYPE_APP: &str = "App";

        /// Client type value for the CLI.
        pub const CLIENT_TYPE_CLI: &str = "CLI";

        /// Client type value for the desktop client.
        pub const CLIENT_TYPE_DESKTOP: &str = "Desktop";

        /// Client type value for the guest agent.
        pub const CLIENT_TYPE_GUEST_AGENT: &str = "GuestAgent";

        /// Client type value for the mitmproxy addon.
        pub const CLIENT_TYPE_MITM_ADDON: &str = "MitmAddon";

        /// Client type value for the runner.
        pub const CLIENT_TYPE_RUNNER: &str = "Runner";
    }
}

/// Codex OAuth token contract constants shared by TypeScript and Rust.
pub mod codex_oauth_token {
    /// Fake Codex OAuth token placeholder marker values.
    /// These values are not secrets and are not usable credentials.
    pub mod placeholders {
        /// Fake marker bytes for the `CHATGPT_ACCESS_TOKEN` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const CHATGPT_ACCESS_TOKEN: &str =
            "chatgpt-token-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocal";

        /// Fake marker bytes for the `CHATGPT_ACCOUNT_ID` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const CHATGPT_ACCOUNT_ID: &str = "ws_VM0_PLACEHOLDER_DO_NOT_TRUST";

        /// Fake marker bytes for the `CHATGPT_REFRESH_TOKEN` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const CHATGPT_REFRESH_TOKEN: &str = "rt_VM0_PLACEHOLDER_DO_NOT_TRUST";
    }
}

/// Model-provider environment contract constants shared by TypeScript and Rust.
pub mod model_provider_env {
    /// Fake model-provider environment placeholder marker values.
    /// These values are not secrets and are not usable credentials.
    pub mod placeholders {
        /// Fake marker bytes for the `ANTHROPIC_API_KEY` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const ANTHROPIC_API_KEY: &str = "sk-ant-api03-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCofAA";

        /// Fake marker bytes for the `ANTHROPIC_AUTH_TOKEN` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const ANTHROPIC_AUTH_TOKEN: &str = "sk-CoffeeSafeLocalCoffeeSafeLocalCo";

        /// Fake marker bytes for the `CHATGPT_ACCESS_TOKEN` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const CHATGPT_ACCESS_TOKEN: &str =
            "chatgpt-token-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocal";

        /// Fake marker bytes for the `CHATGPT_ACCOUNT_ID` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const CHATGPT_ACCOUNT_ID: &str = "ws_VM0_PLACEHOLDER_DO_NOT_TRUST";

        /// Fake marker bytes for the `CHATGPT_REFRESH_TOKEN` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const CHATGPT_REFRESH_TOKEN: &str = "rt_VM0_PLACEHOLDER_DO_NOT_TRUST";

        /// Fake marker bytes for the `CLAUDE_CODE_OAUTH_TOKEN` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const CLAUDE_CODE_OAUTH_TOKEN: &str = "sk-ant-oat01-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCofAA";

        /// Fake marker bytes for the `OPENAI_API_KEY` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const OPENAI_API_KEY: &str = "sk-proj-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocaT3BlbkFJCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLoca";
    }
}

/// Runner contract constants shared by TypeScript and Rust.
pub mod runners {
    /// Maximum connector slugs accepted by the runner network policy refresh endpoint.
    /// Rust runners use this shared contract value to split refresh requests before calling the API.
    pub const NETWORK_POLICY_REFRESH_CONNECTOR_SLUGS_MAX: u64 = 256;

    /// Maximum resume session history blob size accepted by the API, runner, and guest verifier.
    /// Rust and TypeScript components use this shared contract value when validating resume history refs, downloads, and idle-reuse verification.
    pub const RESUME_SESSION_HISTORY_MAX_BYTES: u64 = 134217728;

    /// Maximum runner-local claim cooldown exclusions accepted by the poll endpoint.
    /// Rust runners use this shared contract value to bound local cooldown state and poll request size.
    pub const RUNNER_POLL_EXCLUDED_RUN_IDS_MAX: u64 = 128;

    /// Telemetry value for session history downloads signed with a configured S3 endpoint.
    /// Rust and TypeScript components use this shared contract value when attributing runner download latency.
    pub const SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT: &str =
        "configured_public_endpoint";

    /// Telemetry value for session history downloads signed with the default R2 endpoint.
    /// Rust and TypeScript components use this shared contract value when attributing runner download latency.
    pub const SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT: &str = "default_r2_endpoint";

    /// Wire and blob metadata value for gzip-compressed resume session history.
    /// Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.
    pub const SESSION_HISTORY_ENCODING_GZIP: &str = "gzip";

    /// Wire and blob metadata value for uncompressed resume session history.
    /// Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.
    pub const SESSION_HISTORY_ENCODING_IDENTITY: &str = "identity";

    /// Wire and blob metadata value for zstd-compressed resume session history.
    /// Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.
    pub const SESSION_HISTORY_ENCODING_ZSTD: &str = "zstd";

    /// Minimum raw resume session history size before the guest attempts gzip upload negotiation.
    /// Smaller histories stay identity-encoded to avoid gzip work when it cannot materially reduce transport size.
    pub const SESSION_HISTORY_GZIP_MIN_BYTES: u64 = 65536;

    /// Runner and guest filesystem path constants shared across Rust and TypeScript.
    pub mod paths {
        /// Canonical home directory path expected for the sandbox user inside runner guests.
        /// Rust and TypeScript components use this shared contract value when building runner guest paths.
        pub const CANONICAL_GUEST_HOME_DIR: &str = "/home/user";

        /// Canonical working directory path expected inside runner guests.
        /// Rust and TypeScript components use this shared contract value when building runner commands and paths.
        pub const CANONICAL_WORKING_DIR: &str = "/home/user/workspace";
    }
}
