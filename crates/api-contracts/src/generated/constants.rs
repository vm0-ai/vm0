//! Generated Rust string constants for `@vm0/api-contracts`.
//! Do not edit by hand; regenerate with `cd turbo && pnpm -F @vm0/api-contracts generate:rust`.
//! These constants are shared TypeScript/Rust contract values.
//! Token-shaped placeholder values in this module are fake marker bytes, not secrets.

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
